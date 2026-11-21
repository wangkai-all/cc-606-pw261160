/**
 * Closures: normalisation, supersession of inferred records, effective
 * availability subtraction, affected-session lookup and backfill impact.
 */

import {
  fmtDate,
  fmtTime,
  intersect,
  merge,
  subtractAll,
  totalDuration,
} from "./time.js";
import { resolveClockWindow, stallAppliesToClosure } from "./calendar.js";

export function closureKindLabel(kind) {
  return kind === "mirror-inferred" ? "缺结束时刻·按恢复点推导" : "登记停业";
}

export function closureScopeLabel(closure, stallsById = new Map(), areasById = new Map()) {
  if (closure.scope === "venue") return "全场";
  if (closure.scope === "area") {
    const name = areasById instanceof Map ? areasById.get(closure.areaId) : areasById[closure.areaId];
    return `区域 ${closure.areaId}${name ? `（${name}）` : ""}`;
  }
  const stall = stallsById instanceof Map ? stallsById.get(closure.stallId) : stallsById[closure.stallId];
  return `摊位 ${closure.stallId}${stall ? `（${stall.name || stall}）` : ""}`;
}

/**
 * @param {object} raw
 * @param {object[]} sessions
 * @param {object[]} [stalls] when supplied, an inferred stop's end is clipped
 *   to the latest registered closing time of the stalls it covers (a stall
 *   that closes at 23:30 cannot be "stopped" until the venue's 00:30 close).
 */
export function normaliseClosure(raw, sessions, stalls = null) {
  if (!raw || typeof raw !== "object") throw new TypeError("停业登记必须是对象");
  const id = raw.id ? String(raw.id).trim() : "";
  if (!id) throw new TypeError("停业登记缺少 id");
  const reason = raw.reason ? String(raw.reason).trim() : "";
  if (!reason) throw new TypeError(`停业登记 ${id} 缺少停业原因`);
  const scope = raw.scope || "stall";
  if (!["venue", "area", "stall"].includes(scope)) {
    throw new TypeError(`停业登记 ${id} 的 scope 非法：${scope}`);
  }
  if (scope === "stall" && !raw.stallId) throw new TypeError(`停业登记 ${id} 未指明摊位`);
  if (scope === "area" && !raw.areaId) throw new TypeError(`停业登记 ${id} 未指明区域`);
  const nightKey = raw.nightKey ? String(raw.nightKey) : "";
  const session = sessions.find((s) => s.nightKey === nightKey);
  if (!session) {
    throw new RangeError(`停业登记 ${id} 的营业日 ${nightKey} 不在当前营业日历中`);
  }

  const kind = raw.kind === "mirror-inferred" ? "mirror-inferred" : "registered";
  let start;
  let end;
  if (kind === "mirror-inferred") {
    const resumeClock = raw.resumeClock || raw.startClock;
    if (!resumeClock) throw new TypeError(`推导型停业登记 ${id} 需要恢复营业时刻`);
    start = resolveClockWindow(nightKey, resumeClock, resumeClock, session).start;
    end = inferredEndFor(raw, session, stalls);
    if (start >= end) throw new RangeError(`停业登记 ${id} 的恢复时刻不早于当晚收市`);
  } else {
    if (!raw.startClock || !raw.endClock) throw new TypeError(`停业登记 ${id} 需要起止时刻`);
    if (String(raw.startClock) === String(raw.endClock)) {
      throw new RangeError(`停业登记 ${id} 的起止时刻不能相同`);
    }
    const win = resolveClockWindow(nightKey, raw.startClock, raw.endClock, session);
    start = win.start;
    end = win.end;
    if (end <= start) throw new RangeError(`停业登记 ${id} 的结束时刻必须晚于开始时间`);
  }

  return {
    id,
    kind,
    scope,
    stallId: scope === "stall" ? String(raw.stallId) : null,
    areaId: scope === "area" ? String(raw.areaId) : null,
    nightKey,
    start,
    end,
    window: { start, end },
    startLabel: `${fmtDate(start)} ${fmtTime(start)}`,
    endLabel: `${fmtDate(end)} ${fmtTime(end)}`,
    reason,
    recordedAt: raw.recordedAt || null,
    supersedes: Array.isArray(raw.supersedes) ? raw.supersedes.map(String) : [],
    supersededBy: null,
    source: raw.source || "登记表",
  };
}

/** A closure applies to a stall when scope covers it. */
export function closureAppliesTo(closure, stall) {
  return stallAppliesToClosure(closure, stall);
}

/**
 * Build the effective closure set.
 *
 * Later entries with the same id replace earlier ones. An explicit record
 * supersedes an inferred mirror on the same target+night when it names the
 * mirror or overlaps it — the inferred tail must not compound.
 *
 * In `lenient` mode (used when analysing a sub-window) closures registered on
 * nights outside the calendar are ignored rather than fatal; validation of a
 * backfill uses strict mode.
 */
export function effectiveClosures(rawList, sessions, { lenient = false, stalls = null } = {}) {
  const knownNights = new Set(sessions.map((s) => s.nightKey));
  const byId = new Map();
  for (const raw of rawList) {
    if (lenient && !knownNights.has(raw.nightKey)) continue;
    const closure = normaliseClosure(raw, sessions, stalls);
    byId.set(closure.id, closure);
  }
  const list = [...byId.values()];
  const superseded = new Set();
  const registered = list.filter((c) => c.kind === "registered");
  for (const mirror of list.filter((c) => c.kind === "mirror-inferred")) {
    for (const other of registered) {
      const named = other.supersedes.includes(mirror.id) || mirror.supersedes.includes(other.id);
      const sameTarget = sameClosureTarget(other, mirror);
      if (sameTarget && other.nightKey === mirror.nightKey && (named || intersect(other.window, mirror.window))) {
        superseded.add(mirror.id);
        mirror.supersededBy = other.id;
      }
    }
  }
  return {
    all: list,
    active: list.filter((c) => !superseded.has(c.id)),
    superseded: list.filter((c) => superseded.has(c.id)),
  };
}

function sameClosureTarget(a, b) {
  if (a.scope !== b.scope) return false;
  if (a.scope === "stall") return a.stallId === b.stallId;
  if (a.scope === "area") return a.areaId === b.areaId;
  return true;
}

/**
 * End of an inferred stop: the latest moment any covered stall is actually
 * registered to trade that night. Falls back to the venue session end when no
 * stall metadata is supplied.
 */
function inferredEndFor(raw, session, stalls) {
  if (!stalls || !stalls.length) return session.end;
  const covered = stalls.filter((stall) => stallAppliesToClosure(raw, stall));
  let latest = null;
  for (const stall of covered) {
    const win = typeof stall.windowFor === "function" ? stall.windowFor(session) : null;
    if (!win) continue;
    latest = latest == null ? win.end : Math.max(latest, win.end);
  }
  return latest == null ? session.end : Math.min(latest, session.end);
}

/**
 * Availability for a stall on a session: registered stall window minus the
 * union of applicable closures on that night. Interval intersection, never a
 * cached denominator — backfills are reflected exactly.
 */
export function availabilityForStall({ stall, session, stallWindow, closures }) {
  if (!stallWindow) {
    return {
      raw: null,
      available: [],
      cuts: [],
      contributors: [],
      rawSeconds: 0,
      availableSeconds: 0,
    };
  }
  const cuts = [];
  const contributors = [];
  for (const closure of closures) {
    if (closure.nightKey !== session.nightKey) continue;
    if (!closureAppliesTo(closure, stall)) continue;
    const cut = intersect(closure.window, stallWindow);
    if (!cut) continue;
    cuts.push(cut);
    contributors.push({
      id: closure.id,
      kind: closure.kind,
      reason: closure.reason,
      cut,
      cutSeconds: totalDuration([cut]),
    });
  }
  const available = subtractAll(stallWindow, cuts);
  return {
    raw: stallWindow,
    available,
    cuts: merge(cuts),
    contributors,
    rawSeconds: totalDuration([stallWindow]),
    availableSeconds: totalDuration(available),
  };
}

/**
 * Which sessions does a closure touch on its night? Returns per-stall overlaps
 * so a venue/area scope shows every affected stall.
 */
export function affectedSessions(closure, { sessions, stalls }) {
  const session = sessions.find((s) => s.nightKey === closure.nightKey);
  if (!session) {
    return {
      closure,
      session: null,
      rows: [],
      orphaned: true,
      note: "该营业日不在当前分析窗口的营业日历中",
    };
  }
  const rows = [];
  for (const stall of stalls) {
    if (!closureAppliesTo(closure, stall)) continue;
    const stallWindow = stall.windowFor(session);
    if (!stallWindow) continue;
    const overlap = intersect(closure.window, stallWindow);
    if (!overlap) continue;
    rows.push({
      stallId: stall.id,
      stallName: stall.name,
      areaId: stall.areaId,
      overlap,
      overlapSeconds: totalDuration([overlap]),
      overlapLabel: `${fmtDate(overlap.start)} ${fmtTime(overlap.start)} – ${fmtDate(overlap.end)} ${fmtTime(overlap.end)}`,
    });
  }
  return {
    closure,
    session: {
      nightKey: session.nightKey,
      weekdayLabel: session.weekdayLabel,
      crossesMidnight: session.crossesMidnight,
      range: `${fmtDate(session.start)} ${fmtTime(session.start)} – ${fmtDate(session.end)} ${fmtTime(session.end)}`,
    },
    rows,
    orphaned: rows.length === 0,
    note: rows.length === 0 ? "该营业日内没有受影响的在营摊位" : null,
  };
}

/**
 * Impact of a backfilled closure: affected sessions, the tickets now inside a
 * closed window, overlapping closures, and whether inferred records were
 * superseded. Ticket attribution itself is stable — it is reported per ticket.
 */
export function closureImpact(closure, { sessions, stalls, transactions, allClosures }) {
  const session = sessions.find((s) => s.nightKey === closure.nightKey) || null;
  const affected = stalls.filter((st) => closureAppliesTo(closure, st));
  const affectedIds = new Set(affected.map((s) => s.id));

  const tickets = transactions
    .filter(
      (tx) =>
        affectedIds.has(tx.stallId) &&
        tx.occurredAt >= closure.window.start &&
        tx.occurredAt < closure.window.end,
    )
    .map((tx) => {
      const attached = session
        ? tx.occurredAt >= session.start && tx.occurredAt < session.end
        : false;
      return {
        id: tx.id,
        stallId: tx.stallId,
        occurredLabel: `${fmtDate(tx.occurredAt)} ${fmtTime(tx.occurredAt)}`,
        ticketDate: fmtDate(tx.occurredAt),
        attributedNightKey: tx.nightKey,
        postedVia: tx.basis,
        ticketInSession: attached,
        amount: tx.amount,
        note: tx.note,
      };
    });

  const overlaps = allClosures
    .filter((c) => c.id !== closure.id && c.nightKey === closure.nightKey)
    .map((c) => {
      const covered = affected.filter((st) => closureAppliesTo(c, st));
      if (!covered.length) return null;
      const overlap = intersect(c.window, closure.window);
      if (!overlap) return null;
      return {
        id: c.id,
        kind: c.kind,
        reason: c.reason,
        overlapLabel: `${fmtDate(overlap.start)} ${fmtTime(overlap.start)} – ${fmtDate(overlap.end)} ${fmtTime(overlap.end)}`,
        overlapSeconds: totalDuration([overlap]),
      };
    })
    .filter(Boolean);

  const ticketAttributionStable = tickets.every(
    (t) => t.attributedNightKey === closure.nightKey || t.attributedNightKey === null,
  );

  return {
    closureId: closure.id,
    nightKey: closure.nightKey,
    kind: closure.kind,
    windowLabel: `${fmtDate(closure.window.start)} ${fmtTime(closure.window.start)} – ${fmtDate(closure.window.end)} ${fmtTime(closure.window.end)}`,
    session: session
      ? {
          nightKey: session.nightKey,
          weekdayLabel: session.weekdayLabel,
          crossesMidnight: session.crossesMidnight,
          range: `${fmtDate(session.start)} ${fmtTime(session.start)} – ${fmtDate(session.end)} ${fmtTime(session.end)}`,
        }
      : null,
    affectedStalls: affected.map((s) => ({
      id: s.id,
      name: s.name,
      areaId: s.areaId,
      scheduled: Boolean(s.windowFor(session)),
      window: s.windowFor(session)
        ? `${fmtDate(s.windowFor(session).start)} ${fmtTime(s.windowFor(session).start)} – ${fmtDate(s.windowFor(session).end)} ${fmtTime(s.windowFor(session).end)}`
        : null,
    })),
    tickets,
    ticketCount: tickets.length,
    ticketAttributionStable,
    overlappingClosures: overlaps,
    superseded: allClosures
      .filter((c) => c.supersededBy === closure.id)
      .map((c) => ({ id: c.id, kind: c.kind, reason: c.reason })),
  };
}
