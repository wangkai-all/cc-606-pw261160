import test from "node:test";
import assert from "node:assert/strict";

import { attributeTransaction } from "../lib/ledger.js";
import { buildSessions } from "../lib/calendar.js";
import { Service } from "../lib/service.js";
import { WINDOW, baseVenue, makeService, serviceWith } from "./helpers.js";
import { fmtDate, fmtTime, parseLocalInstant } from "../lib/time.js";

function sessionsFor(from, to, hoursOverrides = {}) {
  const v = baseVenue();
  const hours = { ...v.openingHours, ...hoursOverrides };
  return buildSessions(hours, { from, to });
}

const stallsById = new Map([
  ["S1", { id: "S1", areaId: "A", name: "一号摊" }],
  ["S2", { id: "S2", areaId: "A", name: "二号摊" }],
]);

test("零点后的票归到前一晚开市的营业日，而不是按日期裂成两场", () => {
  const sessions = sessionsFor("2026-11-19", "2026-11-22");
  const result = attributeTransaction(
    {
      id: "T1",
      stallId: "S1",
      occurredAt: parseLocalInstant("2026-11-20T00:15:00+08:00"),
      amount: 50,
    },
    sessions,
    stallsById,
  );
  assert.equal(result.attributed, true);
  assert.equal(result.ticketDate, "2026-11-20");
  assert.equal(result.nightKey, "2026-11-19", "00:15 属于周四开市的那一场");
  assert.equal(result.basis, "clock-after-midnight");
});

test("票面日期与营业日不同也不会额外生成一场", () => {
  const sessions = sessionsFor("2026-11-19", "2026-11-22");
  const service = serviceWith(
    baseVenue({
      stalls: [
        {
          id: "S1",
          name: "一号摊",
          areaId: "A",
          weekdays: [4, 5, 6],
          hours: { default: { open: "18:00", close: "00:30" } },
        },
      ],
    }),
    [
      { id: "T1", stallId: "S1", occurredAt: "2026-11-20T00:15:00+08:00", amount: 50 },
      { id: "T2", stallId: "S1", occurredAt: "2026-11-20T21:00:00+08:00", amount: 50 },
    ],
  );
  const analysis = service.runAnalysis({ from: "2026-11-19", to: "2026-11-22" });
  const nightsWithTickets = analysis.series.filter((s) => s.tickets > 0).map((s) => s.nightKey);
  assert.deepEqual(nightsWithTickets, ["2026-11-19", "2026-11-20"]);
  const t1 = analysis.transactions.find((t) => t.id === "T1");
  assert.equal(t1.nightKey, "2026-11-19");
  assert.equal(analysis.sessions.length, sessions.length);
});

test("营业日整点收市时刻按半开区间排除", () => {
  const sessions = sessionsFor("2026-11-19", "2026-11-21");
  const night = sessions[0]; // 周四 18:00–00:30
  const atClose = attributeTransaction(
    { id: "T", stallId: "S1", occurredAt: night.end, amount: 1 },
    sessions,
    stallsById,
  );
  assert.equal(atClose.attributed, false);
  assert.equal(atClose.basis, "outside-calendar");
  const justBefore = attributeTransaction(
    { id: "T2", stallId: "S1", occurredAt: night.end - 60, amount: 1 },
    sessions,
    stallsById,
  );
  assert.equal(justBefore.nightKey, "2026-11-19");
});

test("不在任何营业时段的票不归属任何营业日", () => {
  const sessions = sessionsFor("2026-11-16", "2026-11-25");
  const result = attributeTransaction(
    { id: "T", stallId: "S1", occurredAt: parseLocalInstant("2026-11-18T03:15:00+08:00"), amount: 9 },
    sessions,
    stallsById,
  );
  assert.equal(result.attributed, false);
  assert.equal(result.nightKey, null);
  assert.equal(result.issues[0].code, "unattributed");
});

test("票面明确登记营业日时以登记为准，但标记为不在时段内", () => {
  const sessions = sessionsFor("2026-11-16", "2026-11-25");
  const result = attributeTransaction(
    {
      id: "T",
      stallId: "S1",
      occurredAt: parseLocalInstant("2026-11-18T16:45:00+08:00"),
      sessionId: "2026-11-18",
      amount: 31,
    },
    sessions,
    stallsById,
  );
  assert.equal(result.attributed, true);
  assert.equal(result.nightKey, "2026-11-18");
  assert.equal(result.offClock, true);
  assert.equal(result.issues[0].code, "ticket-outside-session-window");
});

test("声明的营业日不在日历中时为异常", () => {
  const sessions = sessionsFor("2026-11-16", "2026-11-25");
  const result = attributeTransaction(
    {
      id: "T",
      stallId: "S1",
      occurredAt: parseLocalInstant("2026-11-18T20:00:00+08:00"),
      sessionId: "2026-12-01",
      amount: 31,
    },
    sessions,
    stallsById,
  );
  assert.equal(result.attributed, false);
  assert.equal(result.basis, "unknown-session");
  assert.equal(result.issues[0].code, "unknown-session");
});

test("未登记摊位的票不进入任何摊位分母", () => {
  const sessions = sessionsFor("2026-11-16", "2026-11-25");
  const result = attributeTransaction(
    { id: "T", stallId: "S-X", occurredAt: parseLocalInstant("2026-11-18T20:00:00+08:00"), amount: 1 },
    sessions,
    stallsById,
  );
  assert.equal(result.attributed, false);
  assert.equal(result.issues[0].code, "unknown-stall");
});

test("种子数据的异常票被逐条识别", () => {
  const service = makeService();
  const analysis = service.runAnalysis(WINDOW);
  const unallocated = analysis.unallocated.map((t) => t.id).sort();
  assert.deepEqual(unallocated, [
    "TX-20261118-0600",
    "TX-20261121-9001",
    "TX-20261122-0601",
  ]);
  const cross = analysis.transactions.find((t) => t.id === "TX-20261121-0597");
  assert.equal(cross.nightKey, "2026-11-20");
  assert.equal(cross.ticketDate, "2026-11-21");
  assert.equal(fmtTime(cross.occurredAt), "00:15");
  assert.equal(fmtDate(cross.occurredAt), "2026-11-21");
});

test("分析窗口之外的票不进入窗口计数", () => {
  const service = makeService();
  const narrow = service.runAnalysis({ from: "2026-11-20", to: "2026-11-22" });
  assert.equal(narrow.sessions.length, 2);
  // Every attributed ticket belongs to one of the two analysed nights…
  for (const tx of narrow.transactions) {
    if (tx.attributed) {
      assert.ok(
        ["2026-11-20", "2026-11-21"].includes(tx.nightKey),
        `${tx.id} 不应归属 ${tx.nightKey}`,
      );
    }
  }
  // …and tickets from other nights are absent entirely.
  assert.ok(!narrow.transactions.some((t) => t.id === "TX-20261116-0001"));
  // The unallocated ticket inside the window is still surfaced.
  assert.ok(narrow.unallocated.some((t) => t.id === "TX-20261121-9001"));
  assert.ok(narrow.unallocated.length < 3);
});
