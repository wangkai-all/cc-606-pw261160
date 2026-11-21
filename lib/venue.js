/**
 * Venue model: load + validate the register, give stalls a session-aware
 * opening window, and assemble the analysis.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DAY,
  addDays,
  fmtDate,
  fmtDuration,
  fmtPct,
  fmtTime,
  intersect,
  localDateKey,
  localMidnight,
  merge,
  parseLocalInstant,
  subtractAll,
  totalDuration,
} from "./time.js";
import { buildSessions, resolveStallWindow, weekdaySet, WEEKDAY_LABELS } from "./calendar.js";
import { availabilityForStall, effectiveClosures } from "./closures.js";
import { attributeTransaction } from "./ledger.js";

const VALID_WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

export function loadRegister(registerPath = path.join(process.cwd(), "data/venue.json")) {
  const raw = fs.readFileSync(registerPath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(`登记表 JSON 解析失败：${err.message}`);
  }
  return buildVenue(data);
}

export function buildVenue(data) {
  if (!data || typeof data !== "object") throw new TypeError("登记表根节点必须是对象");
  const site = data.site || {};
  const openingHours = data.openingHours || {};
  if (!openingHours.byWeekday || typeof openingHours.byWeekday !== "object") {
    throw new TypeError("登记表缺少 openingHours.byWeekday");
  }
  for (let d = 0; d < 7; d += 1) {
    const slot = openingHours.byWeekday[d] ?? openingHours.byWeekday[String(d)];
    if (!slot || !slot.open || !slot.close) {
      throw new TypeError(`登记表缺少 ${WEEKDAY_LABELS[d]} 的 open/close`);
    }
  }
  const byWeekday = {};
  for (let d = 0; d < 7; d += 1) {
    byWeekday[d] = openingHours.byWeekday[d] ?? openingHours.byWeekday[String(d)];
  }
  const overrides = (openingHours.overrides || []).map((o) => {
    if (!o.date || !o.open || !o.close) throw new TypeError("日期例外必须包含 date/open/close");
    return { ...o };
  });

  const areas = (data.areas || []).map((a) => {
    if (!a.id || !a.name) throw new TypeError("区域必须包含 id/name");
    return { ...a };
  });
  const areaIds = new Set(areas.map((a) => a.id));

  const stallsRaw = data.stalls || [];
  const stallIds = new Set();
  const stallsBase = stallsRaw.map((st) => {
    if (!st.id || !st.name) throw new TypeError("摊位必须包含 id/name");
    if (stallIds.has(st.id)) throw new TypeError(`摊位 id 重复：${st.id}`);
    stallIds.add(st.id);
    if (!areaIds.has(st.areaId)) throw new TypeError(`摊位 ${st.id} 的区域 ${st.areaId} 未登记`);
    if (!Array.isArray(st.weekdays) || st.weekdays.length === 0) {
      throw new TypeError(`摊位 ${st.id} 缺少排班星期`);
    }
    for (const w of st.weekdays) {
      if (!VALID_WEEKDAYS.has(Number(w))) throw new TypeError(`摊位 ${st.id} 的星期取值非法：${w}`);
    }
    for (const change of st.scheduleChanges || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(change.effective || "")) {
        throw new TypeError(`摊位 ${st.id} 的排班变更缺少生效日期`);
      }
      if (!Array.isArray(change.weekdays)) {
        throw new TypeError(`摊位 ${st.id} 的排班变更缺少 weekdays`);
      }
    }
    return { ...st, weekdays: st.weekdays.map(Number) };
  });

  const closuresRaw = (data.closures || []).map((c) => ({ ...c }));
  const expectations = data.expectations || {};

  function sessionsFor(window) {
    const sessions = buildSessions({ byWeekday, overrides }, window);
    // Enrich stalls with a session-bound window resolver; rebuilt per window
    // because a stall's clock window can be anchored on either date leg.
    const stalls = stallsBase.map((st) => ({
      ...st,
      areaName: areas.find((a) => a.id === st.areaId)?.name || st.areaId,
      windowFor(session) {
        if (!session) return null;
        const set = weekdaySet(st, session.nightKey);
        if (!set.weekdays.includes(session.weekday)) return null;
        return resolveStallWindow(st, session);
      },
      scheduledOn(session) {
        return weekdaySet(st, session.nightKey).weekdays.includes(session.weekday);
      },
    }));
    return { sessions, stalls, stallsById: new Map(stalls.map((s) => [s.id, s])) };
  }

  function areasById() {
    return new Map(areas.map((a) => [a.id, a.name]));
  }

  return {
    site,
    openingHours: { byWeekday, overrides },
    areas,
    areasById: areasById(),
    stallsBase,
    closuresRaw,
    expectations,
    sessionsFor,
  };
}

/** Normalise a JSON ticket into the internal shape, validating the essentials. */
export function normaliseTransaction(raw, index = 0) {
  if (!raw || typeof raw !== "object") throw new TypeError("交易必须是对象");
  const id = raw.id ? String(raw.id) : `TX-${index + 1}`;
  if (!raw.stallId) throw new TypeError(`交易 ${id} 缺少 stallId`);
  if (!raw.occurredAt) throw new TypeError(`交易 ${id} 缺少 occurredAt`);
  const occurredAt = parseLocalInstant(raw.occurredAt);
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TypeError(`交易 ${id} 的金额必须为正数`);
  }
  return {
    id,
    stallId: String(raw.stallId),
    occurredAt,
    sessionId: raw.sessionId ? String(raw.sessionId) : null,
    amount: Math.round(amount * 100) / 100,
    note: raw.note || null,
  };
}

/**
 * Run the full analysis for a date range. Everything (denominators, ticket
 * attribution) is recomputed from the register on each call; nothing is
 * pre-aggregated, so a backfilled closure is reflected exactly.
 */
export function analyse({ venue, transactionsRaw, closuresRaw, from, to, mirrors = [] }) {
  const window = { start: localMidnight(from), end: localMidnight(to) };
  if (window.end <= window.start) throw new RangeError("分析窗口结束必须晚于开始");
  const { sessions, stalls, stallsById } = venue.sessionsFor({ from, to });
  // A ticket belongs to this run when its attributed night is one of the
  // window's sessions. Matching on the raw instant would drop the after-
  // midnight tail of the final night, which is part of that same session.
  const nightKeys = new Set(sessions.map((s) => s.nightKey));
  const transactions = [];
  for (const [i, raw] of transactionsRaw.entries()) {
    const tx = normaliseTransaction(raw, i);
    const attribution = attributeTransaction(tx, sessions, stallsById);
    const insideWindow = tx.occurredAt >= window.start && tx.occurredAt < window.end;
    if (attribution.attributed && nightKeys.has(attribution.nightKey)) {
      transactions.push({ ...tx, ...attribution });
    } else if (!attribution.attributed && insideWindow) {
      transactions.push({ ...tx, ...attribution });
    }
  }

  const closureInput = [...closuresRaw, ...mirrors];
  const closureSet = effectiveClosures(closureInput, sessions, { lenient: true, stalls });
  const activeClosures = closureSet.active;
  const rows = [];
  for (const session of sessions) {
    for (const stall of stalls) {
      const windowForStall = stall.windowFor(session);
      // A stall's own opening window can never extend beyond the venue's
      // registered session: the true tradeable window is the intersection.
      const stallWindow = windowForStall ? intersect(windowForStall, session) : null;
      const avail = availabilityForStall({ stall, session, stallWindow, closures: activeClosures });
      rows.push({
        session,
        stall,
        stallWindow,
        stallWindowRegistered: windowForStall,
        scheduled: Boolean(stallWindow),
        ...avail,
      });
    }
  }

  const txByStallNight = new Map();
  for (const tx of transactions) {
    if (!tx.attributed) continue;
    const key = `${tx.stallId}|${tx.nightKey}`;
    if (!txByStallNight.has(key)) txByStallNight.set(key, []);
    txByStallNight.get(key).push(tx);
  }

  const annotatedRows = rows.map((row) => {
    const list = txByStallNight.get(`${row.stall.id}|${row.session.nightKey}`) || [];
    const tickets = [];
    for (const tx of list) {
      const inAvailable = row.available.some(
        (s) => tx.occurredAt >= s.start && tx.occurredAt < s.end,
      );
      const inRaw = row.raw
        ? tx.occurredAt >= row.raw.start && tx.occurredAt < row.raw.end
        : false;
      // A ticket before opening / after closing of the scheduled window is
      // attributed by the register's slot (if any) but did not trade during
      // business hours, so it is not counted in the numerator.
      const withinTradeable = inAvailable && !tx.offClock;
      tickets.push({
        id: tx.id,
        occurredAt: tx.occurredAt,
        label: `${fmtDate(tx.occurredAt)} ${fmtTime(tx.occurredAt)}`,
        amount: tx.amount,
        basis: tx.basis,
        inAvailable,
        inRaw,
        withinTradeable,
        insideClosure: inRaw && !inAvailable,
        note: tx.note,
      });
    }
    const insideClosed = tickets.filter((t) => t.insideClosure);
    const countable = tickets.filter((t) => t.withinTradeable);
    return {
      ...row,
      tickets,
      countableTickets: countable.length,
      ticketsInClosedWindow: insideClosed.length,
      closedWindowRevenue: insideClosed.reduce((n, t) => n + t.amount, 0),
      /** Business hours actually tradeable — the utilisation denominator. */
      denominator: {
        availableSeconds: row.availableSeconds,
        rawSeconds: row.rawSeconds,
        closedSeconds: (row.rawSeconds || 0) - row.availableSeconds,
        sessionSeconds: row.sessionSeconds,
      },
      ticketsPerAvailableHour:
        row.availableSeconds > 0 ? countable.length / (row.availableSeconds / 3600) : null,
    };
  });

  const perStall = stalls.map((stall) => {
    const stallRows = annotatedRows.filter((r) => r.stall.id === stall.id);
    const availableSeconds = stallRows.reduce((n, r) => n + r.availableSeconds, 0);
    const rawSeconds = stallRows.reduce((n, r) => n + (r.rawSeconds || 0), 0);
    const scheduledSeconds = stallRows
      .filter((r) => r.scheduled)
      .reduce((n, r) => n + r.sessionSeconds, 0);
    const cutSeconds = stallRows.reduce(
      (n, r) => n + r.contributors.reduce((m, c) => m + c.cutSeconds, 0),
      0,
    );
    const tickets = stallRows.flatMap((r) => r.tickets);
    const countable = stallRows.reduce((n, r) => n + r.countableTickets, 0);
    const revenue = tickets
      .filter((t) => t.withinTradeable)
      .reduce((n, t) => n + t.amount, 0);
    return {
      stall,
      rows: stallRows,
      scheduledNights: stallRows.filter((r) => r.scheduled).length,
      availableSeconds,
      rawSeconds,
      scheduledSeconds,
      cutSeconds,
      tickets: countable,
      attributedTickets: tickets.length,
      revenue,
      utilization: availableSeconds > 0 ? countable / (availableSeconds / 3600) : null,
      revenuePerHour: availableSeconds > 0 ? revenue / (availableSeconds / 3600) : null,
    };
  });

  const eligibleRows = annotatedRows.filter((r) => r.scheduled);
  const totalAvailable = eligibleRows.reduce((n, r) => n + r.availableSeconds, 0);
  const totalRaw = eligibleRows.reduce((n, r) => n + (r.rawSeconds || 0), 0);
  const totalCut = eligibleRows.reduce(
    (n, r) => n + r.contributors.reduce((m, c) => m + c.cutSeconds, 0),
    0,
  );
  const countableTickets = eligibleRows.reduce((n, r) => n + r.countableTickets, 0);
  const ticketCount = transactions.filter((t) => t.attributed).length;
  const unallocated = transactions.filter((t) => !t.attributed);

  return {
    window,
    from,
    to,
    sessions,
    stalls,
    rows: annotatedRows,
    perStall,
    closures: closureSet,
    totals: {
      sessionCount: sessions.length,
      stallCount: stalls.length,
      eligibleStallNights: eligibleRows.length,
      scheduledStallNights: perStall.reduce((n, p) => n + p.scheduledNights, 0),
      availableSeconds: totalAvailable,
      rawSeconds: totalRaw,
      cutSeconds: totalCut,
      ticketCount,
      countableTickets,
      unallocatedCount: unallocated.length,
      revenue: transactions
        .filter((t) => t.attributed)
        .reduce((n, t) => n + t.amount, 0),
      countableRevenue: eligibleRows.reduce(
        (n, r) => n + r.tickets.filter((t) => t.withinTradeable).reduce((m, t) => m + t.amount, 0),
        0,
      ),
      ticketsPerAvailableHour:
        totalAvailable > 0 ? countableTickets / (totalAvailable / 3600) : null,
      closureShareLabel: totalAvailable > 0 ? fmtPct(totalCut / Math.max(1, totalRaw)) : "—",
    },
    transactions,
    unallocated,
    series: buildSeries({ sessions, rows: annotatedRows, from, to }),
  };
}

/** Per-night series for the chart; one entry per session, never split at midnight. */
function buildSeries({ sessions, rows, from, to }) {
  return sessions.map((session) => {
    const nightRows = rows.filter((r) => r.session.nightKey === session.nightKey && r.scheduled);
    const availableSeconds = nightRows.reduce((n, r) => n + r.availableSeconds, 0);
    const cutSeconds = nightRows.reduce(
      (n, r) => n + r.contributors.reduce((m, c) => m + c.cutSeconds, 0),
      0,
    );
    const tickets = nightRows.reduce((n, r) => n + r.countableTickets, 0);
    const attributed = nightRows.reduce((n, r) => n + r.tickets.length, 0);
    return {
      nightKey: session.nightKey,
      weekdayLabel: session.weekdayLabel,
      start: session.start,
      end: session.end,
      crossesMidnight: session.crossesMidnight,
      sessionHours: totalDuration([session]) / 3600,
      availableHours: availableSeconds / 3600,
      cutHours: cutSeconds / 3600,
      tickets,
      attributedTickets: attributed,
      ticketsPerHour: availableSeconds > 0 ? tickets / (availableSeconds / 3600) : null,
    };
  });
}

/** JSON-safe projection of sessions for the API. */
export function serialiseSession(session) {
  return {
    nightKey: session.nightKey,
    weekday: session.weekday,
    weekdayLabel: session.weekdayLabel,
    start: session.start,
    end: session.end,
    startLabel: `${fmtDate(session.start)} ${fmtTime(session.start)}`,
    endLabel: `${fmtDate(session.end)} ${fmtTime(session.end)}`,
    crossesMidnight: session.crossesMidnight,
    registeredOpen: session.registeredOpen,
    registeredClose: session.registeredClose,
    overrideReason: session.overrideReason,
  };
}

export { DAY, addDays, fmtDuration, fmtPct, localDateKey, intersect, merge, subtractAll };

/** Re-export interval utilities used by the generator/tests. */
export { fmtDate, fmtTime };
