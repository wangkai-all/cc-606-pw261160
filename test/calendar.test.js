import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessions,
  parseClock,
  resolveClockWindow,
  resolveStallWindow,
  weekdaySet,
} from "../lib/calendar.js";
import { fmtDate, fmtTime, localInstant, parseLocalInstant } from "../lib/time.js";
import { baseVenue } from "./helpers.js";

const opening = () => {
  const v = baseVenue();
  return v.openingHours;
};

test("解析时刻并拒绝非法值", () => {
  assert.equal(parseClock("18:30"), 18 * 60 + 30);
  assert.equal(parseClock("00:00"), 0);
  assert.throws(() => parseClock("24:00"), /越界/);
  assert.throws(() => parseClock("8:5"), /HH:MM/);
});

test("跨零点的营业日只有一场，归属开市日期", () => {
  const sessions = buildSessions(opening(), { from: "2026-11-19", to: "2026-11-21" });
  const thursday = sessions.find((s) => s.nightKey === "2026-11-19");
  assert.equal(sessions.length, 2);
  assert.equal(thursday.closesNextDay, true);
  // 周四 18:00 开市，00:30 收市 → 结束时间落在 11-20 凌晨
  assert.equal(fmtDate(thursday.end), "2026-11-20");
  assert.equal(fmtTime(thursday.end), "00:30");
  // 没有一场以 11-20 为开市日期之外的“零点后第二场”
  assert.equal(sessions.filter((s) => s.nightKey === "2026-11-20").length, 1);
  assert.equal(
    fmtDate(sessions.find((s) => s.nightKey === "2026-11-20").start),
    "2026-11-20",
  );
});

test("收市时刻 00:00 作为 24:00 处理", () => {
  const sessions = buildSessions(opening(), { from: "2026-11-18", to: "2026-11-19" });
  const wednesday = sessions[0];
  assert.equal(fmtDate(wednesday.end), "2026-11-19");
  assert.equal(fmtTime(wednesday.end), "00:00");
  assert.equal((wednesday.end - wednesday.start) / 3600, 6);
});

test("日期例外覆盖当天的营业时间", () => {
  const hours = opening();
  hours.overrides = [
    { date: "2026-11-21", open: "17:30", close: "01:30", note: "周年庆" },
  ];
  const sessions = buildSessions(hours, { from: "2026-11-21", to: "2026-11-22" });
  assert.equal(sessions[0].overrideReason, "周年庆");
  assert.equal((sessions[0].end - sessions[0].start) / 3600, 8);
});

test("摊位窗口随市场开门、收市裁剪", () => {
  const sessions = buildSessions(opening(), { from: "2026-11-19", to: "2026-11-20" });
  const stall = baseVenue().stalls[0];
  const win = resolveStallWindow(stall, sessions[0]);
  assert.equal(fmtTime(win.start), "18:00");
  assert.equal(fmtTime(win.end), "23:00");
  // 摊位早于市场开门时，随市场开门
  const early = { ...stall, hours: { default: { open: "16:00", close: "23:00" } } };
  assert.equal(fmtTime(resolveStallWindow(early, sessions[0]).start), "18:00");
});

test("摊位跨零点窗口归属当晚的后半段", () => {
  const sessions = buildSessions(opening(), { from: "2026-11-20", to: "2026-11-21" });
  const friday = sessions.find((s) => s.nightKey === "2026-11-20");
  const stall = {
    id: "S2",
    weekdays: [5],
    hours: { default: { open: "19:00", close: "00:30" } },
  };
  const win = resolveStallWindow(stall, friday);
  assert.equal(fmtDate(win.end), "2026-11-21");
  assert.equal(fmtTime(win.end), "00:30");
});

test("闭市后的恢复时刻回落到当晚跨零点段", () => {
  const sessions = buildSessions(opening(), { from: "2026-11-20", to: "2026-11-21" });
  const friday = sessions.find((s) => s.nightKey === "2026-11-20");
  const win = resolveClockWindow("2026-11-20", "23:30", "00:15", friday);
  assert.equal(fmtDate(win.start), "2026-11-20");
  assert.equal(fmtDate(win.end), "2026-11-21");
  assert.equal(fmtTime(win.end), "00:15");
});

test("排班变更按生效日期切换", () => {
  const stall = {
    id: "S3",
    weekdays: [4, 5],
    scheduleChanges: [{ effective: "2026-11-19", weekdays: [4, 5, 0] }],
  };
  assert.deepEqual(weekdaySet(stall, "2026-11-18").weekdays, [4, 5]);
  assert.deepEqual(weekdaySet(stall, "2026-11-19").weekdays, [4, 5, 0]);
  assert.equal(weekdaySet(stall, "2026-11-22").appliedChange.effective, "2026-11-19");
});

test("时间解析要求显式时区且与主机时区无关", () => {
  assert.equal(fmtTime(parseLocalInstant("2026-11-20T21:00:00+08:00")), "21:00");
  assert.equal(fmtTime(parseLocalInstant("2026-11-20T13:00:00Z")), "21:00");
  assert.throws(() => parseLocalInstant("2026-11-20T21:00:00"), /时区/);
  assert.equal(fmtTime(localInstant("2026-11-20", "21:00")), "21:00");
});
