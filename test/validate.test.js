import test from "node:test";
import assert from "node:assert/strict";

import { validateClosureInput, validateTransaction, validateWindow, ValidationError } from "../lib/validate.js";
import { makeService } from "./helpers.js";

function context() {
  const analysis = makeService().runAnalysis();
  return { sessions: analysis.sessions, stalls: analysis.stalls, areas: [{ id: "A", name: "A 区" }] };
}

test("分析窗口：格式与先后顺序", () => {
  assert.deepEqual(validateWindow({ from: "2026-11-16", to: "2026-11-25" }), {
    from: "2026-11-16",
    to: "2026-11-25",
  });
  assert.throws(() => validateWindow({ from: "2026-11-25", to: "2026-11-16" }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.statusCode, 422);
    assert.equal(err.problems[0].code, "empty-window");
    return true;
  });
  assert.throws(() => validateWindow({ from: "2026-02-30", to: "2026-03-02" }), /YYYY-MM-DD/);
  assert.throws(() => validateWindow({}), /YYYY-MM-DD/);
});

test("补录停业：缺少原因、时刻格式、未知摊位均被拒绝", () => {
  const ctx = context();
  const base = {
    scope: "stall",
    stallId: "S-A01",
    nightKey: "2026-11-19",
    startClock: "20:00",
    endClock: "21:00",
    reason: "设备故障",
  };
  assert.deepEqual(validateClosureInput(base, ctx), {
    id: null,
    kind: "registered",
    scope: "stall",
    stallId: "S-A01",
    areaId: null,
    nightKey: "2026-11-19",
    startClock: "20:00",
    endClock: "21:00",
    resumeClock: null,
    reason: "设备故障",
    recordedAt: null,
    supersedes: [],
  });

  const problemsOf = (patch) => {
    try {
      validateClosureInput({ ...base, ...patch }, ctx);
      return [];
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      return err.problems;
    }
  };

  assert.deepEqual(
    problemsOf({ reason: "" }).map((p) => p.code),
    ["missing-reason"],
  );
  assert.deepEqual(
    problemsOf({ startClock: "25:00" }).map((p) => p.code),
    ["invalid-start-clock"],
  );
  assert.deepEqual(
    problemsOf({ startClock: "21:00", endClock: "21:00" }).map((p) => p.code),
    ["empty-closure-window"],
  );
  assert.deepEqual(
    problemsOf({ stallId: "S-Z99" }).map((p) => p.code),
    ["unknown-stall"],
  );
  assert.deepEqual(
    problemsOf({ nightKey: "2026-12-01" }).map((p) => p.code),
    ["night-outside-window"],
  );
  assert.deepEqual(
    problemsOf({ scope: "galaxy" }).map((p) => p.code),
    ["invalid-scope"],
  );
});

test("推导型停业必须给出恢复时刻", () => {
  const ctx = context();
  const base = {
    kind: "mirror-inferred",
    scope: "stall",
    stallId: "S-A01",
    nightKey: "2026-11-19",
    reason: "只登记恢复营业点",
  };
  assert.throws(() => validateClosureInput(base, ctx), /恢复营业时刻/);
  const ok = validateClosureInput({ ...base, resumeClock: "21:00" }, ctx);
  assert.equal(ok.resumeClock, "21:00");
  assert.equal(ok.kind, "mirror-inferred");
});

test("区域/全场范围需要相应标识", () => {
  const ctx = context();
  assert.throws(
    () =>
      validateClosureInput(
        { scope: "area", nightKey: "2026-11-19", startClock: "20:00", endClock: "21:00", reason: "检修" },
        ctx,
      ),
    /区域/,
  );
  const venue = validateClosureInput(
    { scope: "venue", nightKey: "2026-11-19", startClock: "20:00", endClock: "21:00", reason: "全场检修" },
    ctx,
  );
  assert.equal(venue.scope, "venue");
  assert.equal(venue.stallId, null);
});

test("交易校验：金额、时间、摊位、营业日", () => {
  const ctx = context();
  const ok = validateTransaction(
    { stallId: "S-A01", occurredAt: "2026-11-19T20:00:00+08:00", amount: 10 },
    ctx,
  );
  assert.equal(ok.amount, 10);
  assert.throws(
    () =>
      validateTransaction(
        { stallId: "S-A01", occurredAt: "2026-11-19T20:00:00+08:00", amount: 0 },
        ctx,
      ),
    /金额/,
  );
  assert.throws(
    () => validateTransaction({ stallId: "S-A01", occurredAt: "昨天", amount: 1 }, ctx),
    /occurredAt|时间/,
  );
  assert.throws(
    () =>
      validateTransaction(
        { stallId: "S-A01", occurredAt: "2026-11-19T20:00:00+08:00", amount: 1, sessionId: "2026-12-01" },
        ctx,
      ),
    /营业日/,
  );
  assert.throws(
    () =>
      validateTransaction(
        { stallId: "S-QQ", occurredAt: "2026-11-19T20:00:00+08:00", amount: 1 },
        ctx,
      ),
    /摊位/,
  );
});
