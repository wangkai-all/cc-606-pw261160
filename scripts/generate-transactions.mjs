#!/usr/bin/env node
/**
 * Deterministic synthetic-data generator for the night-market utilisation
 * analysis. Produces data/transactions.json from data/venue.json.
 *
 * The output intentionally contains the edge cases the analysis must handle:
 *  - a ticket after midnight that belongs to the previous opening night;
 *  - a ticket inside a registered closure window;
 *  - a ticket explicitly slotted to a night but stamped off-clock;
 *  - a ticket posted outside any opening session;
 *  - a ticket stamped exactly at a session's end (half-open boundary);
 *  - a ticket against an unregistered stall.
 *
 * Usage: node scripts/generate-transactions.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSessions,
  parseClock,
  resolveClockWindow,
  resolveStallWindow,
  weekdaySet,
} from "../lib/calendar.js";
import { attributeTransaction } from "../lib/ledger.js";
import { fmtDate, localDateKey, parseLocalInstant, toIsoLocal } from "../lib/time.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venue = JSON.parse(fs.readFileSync(path.join(root, "data/venue.json"), "utf8"));

const FROM = "2026-11-16";
const TO = "2026-11-25"; // exclusive
const SEED = 20261120;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const rand = lcg(SEED);

const byWeekday = {};
for (let d = 0; d < 7; d += 1) byWeekday[d] = venue.openingHours.byWeekday[String(d)];
const sessions = buildSessions(
  { byWeekday, overrides: venue.openingHours.overrides },
  { from: FROM, to: TO },
);
const stalls = venue.stalls.map((s) => ({ ...s, weekdays: s.weekdays.map(Number) }));
const stallsById = new Map(stalls.map((s) => [s.id, s]));

/** Resolve registered closures into concrete windows for traffic filtering. */
const closureWindows = (venue.closures || [])
  .filter((c) => c.kind !== "mirror-inferred")
  .map((c) => {
    const session = sessions.find((s) => s.nightKey === c.nightKey);
    const win = resolveClockWindow(c.nightKey, c.startClock, c.endClock, session);
    return { ...c, window: win };
  });

function isClosed(stall, t) {
  return closureWindows.some((c) => {
    if (t < c.window.start || t >= c.window.end) return false;
    if (c.scope === "venue") return true;
    if (c.scope === "area") return c.areaId === stall.areaId;
    return c.stallId === stall.id;
  });
}

const tickets = [];
let seq = 0;

function addTicket(stallId, at, amount, note, sessionId = null) {
  seq += 1;
  tickets.push({
    id: `TX-${localDateKey(at).replaceAll("-", "")}-${String(seq).padStart(4, "0")}`,
    stallId,
    occurredAt: toIsoLocal(at),
    amount: Math.round(amount * 100) / 100,
    ...(sessionId ? { sessionId } : {}),
    ...(note ? { note } : {}),
  });
}

for (const session of sessions) {
  for (const stall of stalls) {
    if (!weekdaySet(stall, session.nightKey).weekdays.includes(session.weekday)) continue;
    const win = resolveStallWindow(stall, session);
    if (!win) continue;
    const start = Math.max(win.start, session.start);
    const end = Math.min(win.end, session.end);
    if (end <= start) continue;
    const weekend = [5, 6, 0].includes(session.weekday);
    const count = (weekend ? 10 : 6) + Math.floor(rand() * 5);
    for (let i = 0; i < count; i += 1) {
      const at = start + Math.floor(rand() * Math.max(1, end - start));
      if (isClosed(stall, at)) continue;
      addTicket(stall.id, at, 18 + rand() * 92);
    }
  }
}

/* ---- deliberate edge cases ------------------------------------------------ */

// 1. After-midnight ticket: belongs to the night opened on 11-20 (Fri).
//    S-A02 trades 18:00–00:30 on Fridays, so 00:15 on 11-21 is its tail.
addTicket(
  "S-A02",
  parseLocalInstant("2026-11-21T00:15:00+08:00"),
  76.5,
  "00:15 售出，属于 11-20 开市的营业日",
);

// 2. Ticket inside the registered closure on 11-19 20:00–22:00 (S-A03).
addTicket(
  "S-A03",
  parseLocalInstant("2026-11-19T20:30:00+08:00"),
  44,
  "停业时段内仍出票（登记与实际冲突，需核对）",
);

// 3. Explicitly slotted ticket stamped before the night opens.
addTicket(
  "S-A01",
  parseLocalInstant("2026-11-18T16:45:00+08:00"),
  31,
  "票面营业日登记为 11-18，时间为开市前补录",
  "2026-11-18",
);

// 4. Ticket posted outside every opening session.
addTicket(
  "S-B01",
  parseLocalInstant("2026-11-18T03:15:00+08:00"),
  12,
  "凌晨 03:15 补录，不在任何营业时段",
);

// 5. Ticket stamped exactly at the session end (half-open: excluded).
addTicket(
  "S-A02",
  parseLocalInstant("2026-11-22T01:30:00+08:00"),
  58,
  "收市时刻整点票面，按半开区间不计入营业时段",
);

// 6. Ticket against an unregistered stall.
tickets.push({
  id: "TX-20261121-9001",
  stallId: "S-X99",
  occurredAt: "2026-11-21T20:10:00+08:00",
  amount: 66,
  note: "摊位号登记错误，登记表中不存在",
});

/* ---- sort, verify, write -------------------------------------------------- */

tickets.sort((a, b) =>
  a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id.localeCompare(b.id),
);

const unattributed = [];
const byNight = new Map();
for (const tx of tickets) {
  const attr = attributeTransaction(
    {
      id: tx.id,
      stallId: tx.stallId,
      occurredAt: parseLocalInstant(tx.occurredAt),
      sessionId: tx.sessionId || null,
      amount: tx.amount,
    },
    sessions,
    stallsById,
  );
  if (!attr.attributed) unattributed.push(`${tx.id} ${tx.occurredAt} ${tx.stallId} (${attr.basis})`);
  else byNight.set(attr.nightKey, (byNight.get(attr.nightKey) || 0) + 1);
}

fs.writeFileSync(
  path.join(root, "data/transactions.json"),
  `${JSON.stringify(tickets, null, 2)}\n`,
);

console.log(`wrote ${tickets.length} tickets to data/transactions.json`);
console.log(`sessions: ${sessions.length}; tickets per opening night:`);
for (const [night, n] of [...byNight.entries()].sort()) console.log(`  ${night}: ${n}`);
console.log(`unattributed: ${unattributed.length}`);
for (const line of unattributed) console.log(`  ${line}`);
