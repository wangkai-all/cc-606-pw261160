import test from "node:test";
import assert from "node:assert/strict";

import {
  availabilityForStall,
  closureImpact,
  effectiveClosures,
  normaliseClosure,
} from "../lib/closures.js";
import { Service } from "../lib/service.js";
import { WINDOW, baseVenue, makeService, serviceWith } from "./helpers.js";
import { fmtDate, fmtTime } from "../lib/time.js";

function thursdayRow(analysis, stallId = "S1") {
  return analysis.rows.find(
    (r) => r.stall.id === stallId && r.session.nightKey === "2026-11-19" && r.scheduled,
  );
}

test("可用时段 = 摊位窗口 − 登记停业（区间求差）", () => {
  const service = makeService();
  const analysis = service.runAnalysis(WINDOW);
  const row = analysis.rows.find(
    (r) => r.stall.id === "S-A03" && r.session.nightKey === "2026-11-19",
  );
  // 周四市场 18:00 开市；摊位登记 17:30–23:00 被市场开门裁剪为 18:00–23:00（5h）
  // 再扣除 20:00–22:00（2h）
  assert.equal(row.rawSeconds, 5 * 3600);
  assert.equal(row.availableSeconds, 3 * 3600);
  assert.deepEqual(
    row.available.map((s) => `${fmtTime(s.start)}–${fmtTime(s.end)}`),
    ["18:00–20:00", "22:00–23:00"],
  );
  assert.equal(row.contributors.length, 1);
  assert.equal(row.contributors[0].id, "CL-R01");
});

test("停业区间超出摊位窗口时只扣真正相交的部分", () => {
  const venue = baseVenue({
    stalls: [
      {
        id: "S1",
        name: "一号摊",
        areaId: "A",
        weekdays: [4],
        hours: { default: { open: "19:00", close: "22:00" } },
      },
    ],
    closures: [
      {
        id: "C1",
        scope: "stall",
        stallId: "S1",
        nightKey: "2026-11-19",
        startClock: "18:00",
        endClock: "19:30",
        reason: "延迟开摊",
      },
    ],
  });
  const service = serviceWith(venue);
  const row = thursdayRow(service.runAnalysis({ from: "2026-11-19", to: "2026-11-20" }));
  assert.equal(row.rawSeconds, 3 * 3600);
  assert.equal(row.availableSeconds, 2.5 * 3600);
  assert.deepEqual(
    row.available.map((s) => `${fmtTime(s.start)}–${fmtTime(s.end)}`),
    ["19:30–22:00"],
  );
});

test("区域停业只作用于区域内当晚在营的摊位", () => {
  const service = makeService();
  const analysis = service.runAnalysis(WINDOW);
  const affected = analysis.rows.filter(
    (r) => r.session.nightKey === "2026-11-22" && r.contributors.some((c) => c.id === "CL-R02"),
  );
  // 周日 C 区只有 S-C01 在营（S-C02 周三至周六，S-C03 周一至周五）
  assert.deepEqual(affected.map((r) => r.stall.id), ["S-C01"]);
  assert.ok(affected.every((r) => r.stall.areaId === "C"));
  assert.ok(affected.every((r) => r.contributors[0].cutSeconds === 1.5 * 3600));
  // 区域停业不会波及 A/B 区
  const otherAreas = analysis.rows.filter(
    (r) => r.session.nightKey === "2026-11-22" && r.stall.areaId !== "C" && r.contributors.length,
  );
  assert.deepEqual(otherAreas, []);
});

test("多段停业取并集，不重复扣减", () => {
  const service = makeService();
  const window = WINDOW;
  service.backfillClosure(window, {
    scope: "stall",
    stallId: "S-A03",
    nightKey: "2026-11-19",
    startClock: "21:00",
    endClock: "22:30",
    reason: "延长停业",
  });
  const analysis = service.runAnalysis(window);
  const row = analysis.rows.find(
    (r) => r.stall.id === "S-A03" && r.session.nightKey === "2026-11-19",
  );
  // 20:00–22:00 ∪ 21:00–22:30 = 20:00–22:30 → 扣 2.5h；可经营窗口 18:00–23:00 = 5h
  assert.equal(row.availableSeconds, (5 - 2.5) * 3600);
  assert.equal(row.available.length, 2);
});

test("推导型停业从恢复点算到当晚收市", () => {
  const service = makeService();
  const result = service.backfillClosure(WINDOW, {
    kind: "mirror-inferred",
    scope: "stall",
    stallId: "S-A01",
    nightKey: "2026-11-19",
    resumeClock: "21:00",
    reason: "缺结束时刻，登记恢复营业点",
  });
  assert.equal(result.normalised.kind, "mirror-inferred");
  assert.equal(fmtTime(result.normalised.window.start), "21:00");
  // 周四 18:00 开市 00:30 收市；摊位窗口 18:30–23:30 → 停业 21:00–23:30
  assert.equal(fmtTime(result.normalised.window.end), "23:30");
  const row = result.analysis.rows.find(
    (r) => r.stall.id === "S-A01" && r.session.nightKey === "2026-11-19",
  );
  assert.equal(row.availableSeconds, 2.5 * 3600);
});

test("推导型停业可跨零点算到次日收市", () => {
  const venue = baseVenue({
    stalls: [
      {
        id: "S1",
        areaId: "A",
        name: "一号摊",
        weekdays: [5],
        hours: { default: { open: "18:00", close: "00:30" } },
      },
    ],
  });
  const service = serviceWith(venue);
  const result = service.backfillClosure(
    { from: "2026-11-20", to: "2026-11-21" },
    {
      kind: "mirror-inferred",
      scope: "stall",
      stallId: "S1",
      nightKey: "2026-11-20",
      resumeClock: "23:45",
      reason: "设备故障",
    },
  );
  assert.equal(fmtDate(result.normalised.window.start), "2026-11-20");
  assert.equal(fmtDate(result.normalised.window.end), "2026-11-21");
  assert.equal(fmtTime(result.normalised.window.end), "00:30");
});

test("补录停业后分母下降，票面归属不变", () => {
  const service = makeService();
  const before = service.runAnalysis(WINDOW);
  const result = service.backfillClosure(WINDOW, {
    scope: "stall",
    stallId: "S-A01",
    nightKey: "2026-11-19",
    startClock: "20:00",
    endClock: "21:00",
    reason: "燃气灶具临时故障",
  });
  const after = result.analysis;
  assert.equal(after.totals.availableSeconds, before.totals.availableSeconds - 3600);
  assert.equal(after.totals.rawSeconds, before.totals.rawSeconds);
  // 票面归属（attributed 张数）不变；若有票正好落在新停业窗口，它只是不再
  // 计入“可经营时段内的票”，这是本功能要暴露的真实冲突。
  assert.equal(after.totals.ticketCount, before.totals.ticketCount);
  assert.equal(result.impact.ticketAttributionStable, true);
  assert.equal(result.impact.availabilityDelta.length, 1);
  assert.equal(result.impact.availabilityDelta[0].lostMinutes, 60);
  assert.equal(after.totals.countableTickets, before.totals.countableTickets - result.impact.ticketCount);
});

test("补录不影响其他营业日与其他摊位", () => {
  const service = makeService();
  const before = service.runAnalysis(WINDOW);
  service.backfillClosure(WINDOW, {
    scope: "stall",
    stallId: "S-A01",
    nightKey: "2026-11-19",
    startClock: "20:00",
    endClock: "21:00",
    reason: "燃气灶具临时故障",
  });
  const after = service.runAnalysis(WINDOW);
  const key = (r) => `${r.stall.id}|${r.session.nightKey}`;
  const changed = after.rows
    .filter((r) => {
      const prev = before.rows.find((p) => key(p) === key(r));
      return prev && prev.availableSeconds !== r.availableSeconds;
    })
    .map(key);
  assert.deepEqual(changed, ["S-A01|2026-11-19"]);
});

test("补录命中票面时同时报出票号与归属营业日", () => {
  const service = makeService();
  const result = service.backfillClosure(WINDOW, {
    scope: "stall",
    stallId: "S-A03",
    nightKey: "2026-11-19",
    startClock: "20:00",
    endClock: "22:00",
    reason: "补登同一时段的停业（与实际一致）",
  });
  const ticket = result.impact.tickets.find((t) => t.id === "TX-20261119-0598");
  assert.ok(ticket, "停业窗口内的票应出现在回查结果中");
  assert.equal(ticket.attributedNightKey, "2026-11-19");
  assert.equal(ticket.ticketDate, "2026-11-19");
});

test("显式登记取代同一范围内的推导记录，不叠加扣减", () => {
  const venue = baseVenue({
    stalls: [
      {
        id: "S1",
        areaId: "A",
        name: "一号摊",
        weekdays: [4],
        hours: { default: { open: "18:00", close: "23:00" } },
      },
    ],
    closures: [
      {
        id: "M1",
        kind: "mirror-inferred",
        scope: "stall",
        stallId: "S1",
        nightKey: "2026-11-19",
        resumeClock: "20:00",
        reason: "推断：20:00 后停业至收市",
      },
    ],
  });
  const service = serviceWith(venue);
  const inferredOnly = service.runAnalysis({ from: "2026-11-19", to: "2026-11-20" });
  assert.equal(thursdayRow(inferredOnly).availableSeconds, 2 * 3600);

  const result = service.backfillClosure(
    { from: "2026-11-19", to: "2026-11-20" },
    {
      scope: "stall",
      stallId: "S1",
      nightKey: "2026-11-19",
      startClock: "20:00",
      endClock: "21:00",
      reason: "实际只停到 21:00",
      supersedes: ["M1"],
    },
  );
  const row = thursdayRow(result.analysis);
  assert.equal(row.availableSeconds, 4 * 3600, "20:00–21:00 停业，21:00–23:00 恢复");
  assert.equal(result.analysis.closures.superseded.length, 1);
  assert.equal(result.analysis.closures.superseded[0].id, "M1");
});

test("不停在窗口内的停业不改变分母，但会被记录", () => {
  const service = makeService();
  const before = service.runAnalysis(WINDOW);
  const result = service.backfillClosure(WINDOW, {
    scope: "stall",
    stallId: "S-B03",
    nightKey: "2026-11-16",
    startClock: "20:00",
    endClock: "21:00",
    reason: "当日未排班，停业无实际影响",
  });
  assert.deepEqual(result.impact.availabilityDelta, []);
  assert.equal(result.analysis.totals.availableSeconds, before.totals.availableSeconds);
  assert.ok(result.analysis.closures.all.some((c) => c.id === result.closure.id));
});

test("闭市后到次日的停业窗口可覆盖跨零点营业日", () => {
  const service = makeService();
  const result = service.backfillClosure(WINDOW, {
    scope: "stall",
    stallId: "S-A02",
    nightKey: "2026-11-20",
    startClock: "23:30",
    endClock: "00:15",
    reason: "后半夜设备检修",
  });
  assert.equal(fmtDate(result.normalised.window.end), "2026-11-21");
  assert.equal(fmtTime(result.normalised.window.end), "00:15");
  const row = result.analysis.rows.find(
    (r) => r.stall.id === "S-A02" && r.session.nightKey === "2026-11-20",
  );
  assert.equal(row.availableSeconds, (6.5 - 0.75) * 3600);
});

test("availableForStall 对无窗口摊位返回全零", () => {
  const result = availabilityForStall({
    stall: { id: "X", areaId: "A" },
    session: { nightKey: "2026-11-19" },
    stallWindow: null,
    closures: [],
  });
  assert.equal(result.availableSeconds, 0);
  assert.deepEqual(result.available, []);
});

test("normaliseClosure 拒绝缺少原因或非法时段的登记", () => {
  const sessions = makeService().runAnalysis(WINDOW).sessions;
  assert.throws(
    () =>
      normaliseClosure(
        { id: "C1", scope: "stall", stallId: "S-A01", nightKey: "2026-11-19", startClock: "20:00", endClock: "21:00" },
        sessions,
      ),
    /原因/,
  );
  assert.throws(
    () =>
      normaliseClosure(
        { id: "C2", scope: "stall", stallId: "S-A01", nightKey: "2026-11-19", startClock: "21:00", endClock: "21:00", reason: "零时长" },
        sessions,
      ),
    /起止时刻不能相同/,
  );
  assert.throws(
    () =>
      normaliseClosure(
        { id: "C3", scope: "stall", stallId: "S-A01", nightKey: "2026-12-31", startClock: "20:00", endClock: "21:00", reason: "窗口外" },
        sessions,
      ),
    /不在当前营业日历/,
  );
});
