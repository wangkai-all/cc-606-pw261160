import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Service } from "../lib/service.js";
import { buildVenue } from "../lib/venue.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const registerPath = path.join(ROOT, "data/venue.json");
export const transactionsPath = path.join(ROOT, "data/transactions.json");

export const WINDOW = { from: "2026-11-16", to: "2026-11-25" };

export function readSeed() {
  return {
    venue: JSON.parse(fs.readFileSync(registerPath, "utf8")),
    transactions: JSON.parse(fs.readFileSync(transactionsPath, "utf8")),
  };
}

/** A fresh Service per call, so a backfill in one test cannot leak into another. */
export function makeService() {
  const seed = readSeed();
  return new Service({
    venue: buildVenue(seed.venue),
    transactions: seed.transactions,
    closures: seed.venue.closures,
  });
}

/** Build a Service from an inline register object. */
export function serviceWith(venue, transactions = []) {
  return new Service({
    venue: buildVenue(venue),
    transactions,
    closures: venue.closures || [],
  });
}

/** Minimal register skeleton for focused tests; override pieces as needed. */
export function baseVenue(overrides = {}) {
  const weekday = (open, close) => ({ open, close });
  return {
    site: { name: "测试夜市", timezone: "Asia/Shanghai" },
    openingHours: {
      byWeekday: {
        0: weekday("17:30", "23:30"),
        1: weekday("18:00", "23:00"),
        2: weekday("18:00", "23:00"),
        3: weekday("18:00", "00:00"),
        4: weekday("18:00", "00:30"),
        5: weekday("18:00", "00:30"),
        6: weekday("17:30", "01:00"),
      },
      overrides: [],
    },
    areas: [{ id: "A", name: "A 区" }],
    stalls: [
      {
        id: "S1",
        name: "一号摊",
        areaId: "A",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        hours: { default: { open: "18:00", close: "23:00" } },
      },
    ],
    closures: [],
    ...overrides,
  };
}
