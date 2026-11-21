/**
 * Request validation for the HTTP layer. Kept dependency-free so tests can
 * exercise it directly.
 */

import { fmtDate, parseLocalInstant } from "./time.js";
import { parseClock } from "./calendar.js";

export class ValidationError extends Error {
  constructor(problems) {
    const list = (Array.isArray(problems) ? problems : [problems]).map((p) =>
      typeof p === "string" ? { code: "invalid", message: p } : p,
    );
    super(list.map((p) => p.message).join("；"));
    this.name = "ValidationError";
    this.statusCode = 422;
    this.problems = list;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^\d{2}:\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRealDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const t = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );
  return fmtDate(t / 1000) === value;
}

function isClock(value) {
  if (typeof value !== "string" || !CLOCK_RE.test(value)) return false;
  try {
    parseClock(value);
    return true;
  } catch {
    return false;
  }
}

export function validateWindow(input) {
  const from = input && input.from ? String(input.from) : "";
  const to = input && input.to ? String(input.to) : "";
  const problems = [];
  if (!isRealDate(from)) problems.push({ code: "invalid-from", field: "from", message: "开始日期必须是 YYYY-MM-DD" });
  if (!isRealDate(to)) problems.push({ code: "invalid-to", field: "to", message: "结束日期必须是 YYYY-MM-DD" });
  if (isRealDate(from) && isRealDate(to) && to <= from) {
    problems.push({ code: "empty-window", field: "to", message: "结束日期必须晚于开始日期（结束日不含）" });
  }
  if (problems.length) throw new ValidationError(problems);
  return { from, to };
}

/**
 * @param {object} body
 * @param {{sessions:object[], stalls:object[], areas:object[]}} context
 */
export function validateClosureInput(body, context) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError([{ code: "invalid-body", message: "请求体必须是 JSON 对象" }]);
  }
  const { sessions, stalls, areas } = context;
  const problems = [];

  const nightKey = body.nightKey ? String(body.nightKey) : "";
  const session = sessions.find((s) => s.nightKey === nightKey);
  if (!isRealDate(nightKey)) {
    problems.push({ code: "invalid-night", field: "nightKey", message: "营业日必须是 YYYY-MM-DD" });
  } else if (!session) {
    problems.push({
      code: "night-outside-window",
      field: "nightKey",
      message: `营业日 ${nightKey} 不在本次分析的营业日历中`,
    });
  }

  const scope = body.scope ? String(body.scope) : "";
  if (!["stall", "area", "venue"].includes(scope)) {
    problems.push({
      code: "invalid-scope",
      field: "scope",
      message: "scope 只能是 stall / area / venue",
    });
  }
  let stallId = null;
  let areaId = null;
  if (scope === "stall") {
    stallId = body.stallId ? String(body.stallId) : "";
    if (!stalls.some((s) => s.id === stallId)) {
      problems.push({
        code: "unknown-stall",
        field: "stallId",
        message: `摊位 ${stallId || "(空)"} 未在登记表登记`,
      });
    }
  } else if (scope === "area") {
    areaId = body.areaId ? String(body.areaId) : "";
    if (!areas.some((a) => a.id === areaId)) {
      problems.push({
        code: "unknown-area",
        field: "areaId",
        message: `区域 ${areaId || "(空)"} 未在登记表登记`,
      });
    }
  }

  const kind = body.kind === "mirror-inferred" ? "mirror-inferred" : "registered";
  let startClock = null;
  let endClock = null;
  let resumeClock = null;
  if (kind === "mirror-inferred") {
    resumeClock = body.resumeClock ? String(body.resumeClock) : "";
    if (!isClock(resumeClock)) {
      problems.push({
        code: "invalid-resume-clock",
        field: "resumeClock",
        message: "缺结束时刻的停业需要 HH:MM 的恢复营业时刻",
      });
    }
  } else {
    startClock = body.startClock ? String(body.startClock) : "";
    endClock = body.endClock ? String(body.endClock) : "";
    if (!isClock(startClock)) {
      problems.push({ code: "invalid-start-clock", field: "startClock", message: "停业开始时刻必须是 HH:MM" });
    }
    if (!isClock(endClock)) {
      problems.push({ code: "invalid-end-clock", field: "endClock", message: "停业结束时刻必须是 HH:MM" });
    }
    if (isClock(startClock) && isClock(endClock) && startClock === endClock) {
      problems.push({
        code: "empty-closure-window",
        field: "endClock",
        message: "停业起止时刻不能相同",
      });
    }
  }

  const reason = body.reason ? String(body.reason).trim() : "";
  if (reason.length < 2) {
    problems.push({ code: "missing-reason", field: "reason", message: "补录停业必须写明原因（至少 2 字）" });
  } else if (reason.length > 200) {
    problems.push({ code: "reason-too-long", field: "reason", message: "停业原因不得超过 200 字" });
  }

  const recordedAt = body.recordedAt ? String(body.recordedAt) : null;
  if (recordedAt && !ISO_RE.test(recordedAt)) {
    problems.push({
      code: "invalid-recorded-at",
      field: "recordedAt",
      message: "登记时间必须是带时区的 ISO 时间",
    });
  }

  if (problems.length) throw new ValidationError(problems);
  return {
    id: body.id ? String(body.id) : null,
    kind,
    scope,
    stallId,
    areaId,
    nightKey,
    startClock,
    endClock,
    resumeClock,
    reason,
    recordedAt,
    supersedes: Array.isArray(body.supersedes) ? body.supersedes.map(String) : [],
  };
}

export function validateTransaction(raw, context) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError([{ code: "invalid-body", message: "交易必须是对象" }]);
  }
  const { sessions = [], stalls = [] } = context || {};
  const problems = [];
  const stallId = raw.stallId ? String(raw.stallId) : "";
  if (stalls.length && !stalls.some((s) => s.id === stallId)) {
    problems.push({ code: "unknown-stall", field: "stallId", message: `摊位 ${stallId || "(空)"} 未登记` });
  }
  let occurredAt = null;
  try {
    occurredAt = parseLocalInstant(raw.occurredAt);
  } catch (err) {
    problems.push({ code: "invalid-occurred-at", field: "occurredAt", message: err.message });
  }
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    problems.push({ code: "invalid-amount", field: "amount", message: "金额必须为正数" });
  }
  const sessionId = raw.sessionId ? String(raw.sessionId) : null;
  if (sessionId && sessions.length && !sessions.some((s) => s.nightKey === sessionId)) {
    problems.push({
      code: "unknown-session",
      field: "sessionId",
      message: `营业日 ${sessionId} 不在营业日历中`,
    });
  }
  if (problems.length) throw new ValidationError(problems);
  return {
    id: raw.id ? String(raw.id) : `TX-${Date.now().toString(36)}`,
    stallId,
    occurredAt,
    sessionId,
    amount: Math.round(amount * 100) / 100,
    note: raw.note ? String(raw.note) : null,
  };
}
