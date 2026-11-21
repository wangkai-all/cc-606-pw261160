/**
 * Opening calendar, stall schedules and clock-window resolution.
 *
 * One business night (营业日) per opening date. A night that crosses midnight
 * stays a single session keyed by its opening date — the calendar date after
 * midnight never starts a second session. Stall schedules and closures are
 * resolved against the opening date, with a fallback to the after-midnight leg
 * when a clock window only makes sense on the following date.
 */

import {
  DAY,
  HOUR,
  MINUTE,
  addDays,
  fmtDate,
  fmtTime,
  localDateKey,
  localInstant,
  localMidnight,
  localParts,
} from "./time.js";

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** @param {string} hhmm @returns {number} minutes after local midnight */
export function parseClock(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new TypeError(`时刻格式应为 HH:MM：${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new TypeError(`时刻越界：${hhmm}`);
  return h * 60 + min;
}

function pickOverride(overrides, nightKey) {
  return (overrides || []).find((o) => o.date === nightKey) || null;
}

/**
 * Build one session per opening date in the analysis window.
 * @param {{byWeekday: Record<number,{open:string,close:string}>, overrides: object[]}} openingHours
 * @param {{from:string,to:string}} window `to` is an exclusive date key
 */
export function buildSessions(openingHours, window) {
  const sessions = [];
  let midnight = localMidnight(window.from);
  const end = localMidnight(window.to);
  if (end <= midnight) throw new RangeError("分析窗口结束必须晚于开始");
  while (midnight < end) {
    const nightKey = fmtDate(midnight);
    const weekday = localParts(midnight).weekday;
    const base = openingHours.byWeekday[weekday];
    if (!base) throw new RangeError(`缺少 ${WEEKDAY_LABELS[weekday]} 的营业时间登记`);
    const override = pickOverride(openingHours.overrides, nightKey);
    const open = (override && override.open) || base.open;
    const close = (override && override.close) || base.close;
    const openMin = parseClock(open);
    const closeMin = parseClock(close);
    const start = localInstant(nightKey, open);
    // A close clock at or before the opening clock means the night carries on
    // into the next calendar date. 00:00 is therefore "24:00".
    const closesNextDay = closeMin <= openMin;
    const finish = closesNextDay
      ? localInstant(nightKey, close) + DAY
      : localInstant(nightKey, close);
    const duration = finish - start;
    if (duration < 30 * MINUTE || duration > 16 * HOUR) {
      throw new RangeError(`${nightKey} 营业时长异常：${duration / HOUR} 小时`);
    }
    sessions.push({
      nightKey,
      weekday,
      weekdayLabel: WEEKDAY_LABELS[weekday],
      start,
      end: finish,
      closesNextDay,
      crossesMidnight: localDateKey(finish - 1) !== nightKey,
      tailDate: localDateKey(finish - 1),
      registeredOpen: open,
      registeredClose: close,
      overrideReason: override ? override.note || "日期例外登记" : null,
    });
    midnight = addDays(midnight, 1);
  }
  return sessions;
}

/** Effective weekday set for a stall on a given opening date. */
export function weekdaySet(stall, nightKey) {
  let weekdays = stall.weekdays;
  let appliedChange = null;
  const changes = [...(stall.scheduleChanges || [])].sort((a, b) =>
    a.effective.localeCompare(b.effective),
  );
  for (const change of changes) {
    if (change.effective <= nightKey) {
      weekdays = change.weekdays;
      appliedChange = change;
    }
  }
  return { weekdays, appliedChange };
}

export function isStallScheduled(stall, session) {
  return weekdaySet(stall, session.nightKey).weekdays.includes(session.weekday);
}

/** True when [start,end) overlaps [anchor.start,anchor.end). */
function overlaps(start, end, anchor) {
  return start < anchor.end && anchor.start < end;
}

/**
 * Resolve a pair of clock times against a night. If the window does not touch
 * the session on the opening date, try the following date (after-midnight leg
 * of the same night). A close clock at or before the open clock rolls over.
 */
export function resolveClockWindow(nightKey, openClock, closeClock, anchor) {
  const openMin = parseClock(openClock);
  const closeMin = parseClock(closeClock);
  const start = localInstant(nightKey, openClock);
  let end = localInstant(nightKey, closeClock);
  if (closeMin <= openMin) end += DAY;
  if (!overlaps(start, end, anchor) && overlaps(start + DAY, end + DAY, anchor)) {
    return { start: start + DAY, end: end + DAY };
  }
  return { start, end };
}

/**
 * A stall's own opening window on a given night, clipped to the venue session.
 * Missing clocks follow the venue. Returns null when the resolved window is
 * empty. `rawStart`/`rawEnd` keep the stall's registered clocks for display.
 */
export function resolveStallWindow(stall, session) {
  const hours = stall.hours || {};
  const byDay = (hours.byWeekday && hours.byWeekday[session.weekday]) || {};
  const fallback = hours.default || {};
  const openClock = byDay.open || fallback.open || null;
  const closeClock = byDay.close || fallback.close || null;
  if (!openClock && !closeClock) {
    return {
      start: session.start,
      end: session.end,
      openSource: "随市场开门",
      closeSource: "随市场收市",
    };
  }
  const registered = resolveClockWindow(
    session.nightKey,
    openClock || session.registeredOpen,
    closeClock || session.registeredClose,
    session,
  );
  const start = Math.max(registered.start, session.start);
  const end = Math.min(registered.end, session.end);
  if (end <= start) return null;
  return {
    start,
    end,
    rawStart: registered.start,
    rawEnd: registered.end,
    clipped:
      registered.start < session.start || registered.end > session.end,
    openSource: openClock ? `摊位登记 ${openClock}` : "随市场开门",
    closeSource: closeClock ? `摊位登记 ${closeClock}` : "随市场收市",
  };
}

export function stallAppliesToClosure(closure, stall) {
  if (closure.scope === "venue") return true;
  if (closure.scope === "area") return closure.areaId === stall.areaId;
  if (closure.scope === "stall") return closure.stallId === stall.id;
  return false;
}

export function formatSpan(span) {
  return `${fmtDate(span.start)} ${fmtTime(span.start)} – ${fmtDate(span.end)} ${fmtTime(span.end)}`;
}
