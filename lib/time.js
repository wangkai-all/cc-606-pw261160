/**
 * Pure interval / enablement-domain helpers.
 *
 * All instants are integer epoch seconds. Intervals are half-open [start, end).
 * No dependency on wall-clock parsing here: callers hand in epoch seconds.
 */

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * The site runs on Asia/Shanghai wall-clock time. We normalise every instant to
 * "floating local seconds": the local calendar fields reinterpreted as UTC.
 * This keeps interval arithmetic exact and independent of the host timezone
 * (important for reproducibility and tests), while all display remains +08:00.
 */
export const SITE_OFFSET_SEC = 8 * HOUR;

/** Parse an ISO timestamp that carries an explicit offset/Z into floating local seconds. */
export function parseLocalInstant(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("时间必须是带时区的 ISO 字符串");
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    input.trim(),
  );
  if (!m) throw new TypeError(`时间必须带时区偏移，格式 YYYY-MM-DDTHH:MM±HH:MM：${input}`);
  const [, date, hh, mm, ss = "00", offset] = m;
  const wall =
    localMidnight(date) + Number(hh) * HOUR + Number(mm) * MINUTE + Number(ss);
  if (offset === "Z") return wall + SITE_OFFSET_SEC;
  const sign = offset[0] === "-" ? -1 : 1;
  const [oh, om] = offset.slice(1).split(":");
  const offsetSec = sign * (Number(oh) * HOUR + Number(om) * MINUTE);
  // actual instant = wall - offset; site-local seconds = instant + site offset.
  return wall - offsetSec + SITE_OFFSET_SEC;
}

/** Back to a real instant (UTC epoch seconds) for wall-clock metadata if needed. */
export function floatingToUtc(t) {
  return t - SITE_OFFSET_SEC;
}

/** ISO string in site-local time, e.g. 2026-11-20T21:00:00+08:00. */
export function toIsoLocal(epochSec) {
  const d = new Date(epochSec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
  );
}

/** Calendar pieces for a floating-local instant. */
export function localParts(epochSec) {
  const d = new Date(epochSec * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0 Sunday … 6 Saturday
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @param {string} key @returns {number} floating-local midnight */
export function localMidnight(key) {
  const m = DATE_RE.exec(String(key));
  if (!m) throw new TypeError(`日期格式应为 YYYY-MM-DD：${key}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  const check = localParts(t);
  if (check.year !== Number(m[1]) || check.month !== Number(m[2]) || check.day !== Number(m[3])) {
    throw new TypeError(`不存在的日期：${key}`);
  }
  return t;
}

/** @param {string} key @param {string} hhmm */
export function localInstant(key, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm));
  if (!m) throw new TypeError(`时刻格式应为 HH:MM：${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new TypeError(`时刻越界：${hhmm}`);
  return localMidnight(key) + h * HOUR + min * MINUTE;
}

export function localDateKey(epochSec) {
  return fmtDate(epochSec);
}

/** Add whole local days to a floating-local instant. */
export function addDays(epochSec, days) {
  return epochSec + days * DAY;
}

/** Inclusive-start, exclusive-end list of date keys. */
export function dateKeys(fromKey, toKeyExclusive) {
  const out = [];
  let t = localMidnight(fromKey);
  const end = localMidnight(toKeyExclusive);
  if (end <= t) throw new RangeError("分析窗口结束必须晚于开始");
  while (t < end) {
    out.push(localDateKey(t));
    t = addDays(t, 1);
  }
  return out;
}

/** @typedef {{start:number, end:number}} Span */

/** @param {number} t @param {number} step @returns {number} */
export function floorTo(t, step) {
  return Math.floor(t / step) * step;
}

/** @param {number} t @param {number} step @returns {number} */
export function ceilTo(t, step) {
  return Math.ceil(t / step) * step;
}

/** Format epoch seconds as an ISO-like local stamp (no system timezone dependence). */
export function fmt(epochSec) {
  if (epochSec == null || !Number.isFinite(epochSec)) return "—";
  const d = new Date(epochSec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

export function fmtDate(epochSec) {
  return fmt(epochSec).slice(0, 10);
}

export function fmtTime(epochSec) {
  return fmt(epochSec).slice(11, 16);
}

/** @param {Span} a @param {Span} b */
export function intersects(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Half-open intersection. Returns null when they only touch. */
export function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** Sort and merge touching/overlapping spans. */
export function merge(spans) {
  const sorted = spans
    .filter((s) => s && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** @param {Span} outer @param {Span[]} cutters */
export function subtractAll(outer, cutters) {
  let pieces = [{ ...outer }];
  for (const cut of merge(cutters)) {
    const next = [];
    for (const p of pieces) {
      if (!intersects(p, cut)) {
        next.push(p);
        continue;
      }
      if (cut.start > p.start) next.push({ start: p.start, end: Math.min(cut.start, p.end) });
      if (cut.end < p.end) next.push({ start: Math.max(cut.end, p.start), end: p.end });
    }
    pieces = next.filter((p) => p.end > p.start);
  }
  return merge(pieces);
}

/** @param {Span[]} spans */
export function totalDuration(spans) {
  return spans.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/** @param {Span[]} spans @param {Span} window */
export function clip(spans, window) {
  return merge(
    spans
      .map((s) => intersect(s, window))
      .filter(Boolean),
  );
}

/**
 * Collapse a set of per-period intervals into a sorted, closed disjoint union,
 * optionally limited to a window.
 */
export function union(spans, window = null) {
  return window ? clip(spans, window) : merge(spans);
}

/** id helper for stable references in audit output. */
export function spanId(prefix, span) {
  return `${prefix}:${span.start}-${span.end}`;
}

/** Format a duration in hours+minutes for human display. */
export function fmtDuration(sec) {
  const n = Math.max(0, Math.round(sec));
  const h = Math.floor(n / HOUR);
  const m = Math.round((n % HOUR) / MINUTE);
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分`;
}

/** Format a fraction as a percentage with one decimal. */
export function fmtPct(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}
