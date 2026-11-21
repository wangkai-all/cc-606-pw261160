/**
 * Application service: holds the register state (closures can be backfilled at
 * runtime), runs analyses, and prepares the "what changed" report after a
 * revision.
 */

import {
  analyse,
  buildVenue,
  loadRegister,
  normaliseTransaction,
} from "./venue.js";
import { effectiveClosures, normaliseClosure, closureImpact } from "./closures.js";
import { validateClosureInput, validateWindow } from "./validate.js";
import { parseLocalInstant } from "./time.js";

export const DEFAULT_WINDOW = { from: "2026-11-16", to: "2026-11-25" };

export class Service {
  /**
   * @param {object} opts
   * @param {object} [opts.venue] built venue; loaded from data/venue.json by default
   * @param {object[]} [opts.transactions] raw tickets
   * @param {object[]} [opts.closures] raw closure records
   */
  constructor({ venue, transactions = [], closures } = {}) {
    this.venue = venue || loadRegister();
    this.transactions = transactions.map((t) => ({ ...t }));
    this.closures = (closures || this.venue.closuresRaw).map((c) => ({ ...c }));
    this.revision = 0;
    this.history = [];
  }

  static fromRegister(registerPath, transactions = []) {
    return new Service({ venue: loadRegister(registerPath), transactions });
  }

  state() {
    return {
      venue: {
        name: this.venue.site.name,
        timezone: this.venue.site.timezone || "Asia/Shanghai",
        areas: this.venue.areas,
        stalls: this.venue.stallsBase.map((s) => ({
          id: s.id,
          name: s.name,
          areaId: s.areaId,
          weekdays: s.weekdays,
        })),
        openingHours: this.venue.openingHours,
      },
      closures: this.closures,
      transactionCount: this.transactions.length,
      revision: this.revision,
      defaultWindow: DEFAULT_WINDOW,
    };
  }

  transactionsForRange(from, to) {
    return this.transactions;
  }

  runAnalysis(rawWindow = DEFAULT_WINDOW, closuresOverride = null) {
    const window = validateWindow(rawWindow);
    return analyse({
      venue: this.venue,
      transactionsRaw: this.transactions,
      closuresRaw: closuresOverride || this.closures,
      from: window.from,
      to: window.to,
    });
  }

  /**
   * Backfill a stop-business record, then report:
   *  - the affected sessions (same night, scoped stalls);
   *  - the tickets whose window status changed, with their unchanged night
   *    attribution shown explicitly;
   *  - any inferred record the new one supersedes.
   */
  backfillClosure(rawWindow, body) {
    const window = validateWindow(rawWindow || DEFAULT_WINDOW);
    const { sessions, stalls } = this.venue.sessionsFor(window);
    const context = { sessions, stalls, areas: this.venue.areas };
    const input = validateClosureInput(body, context);

    const id = input.id || `CL-B${String(this.history.length + 1).padStart(2, "0")}`;
    const closure = {
      ...input,
      id,
      source: "补录",
      recordedAt: input.recordedAt || new Date().toISOString(),
    };

    // Normalise once for validation before committing state.
    const normalised = normaliseClosure(closure, sessions, stalls);

    // Before/after snapshots of availability per stall-night.
    const before = this.runAnalysis(window, this.closures);
    const nextClosures = replaceOrAppend(this.closures, closure);
    const after = this.runAnalysis(window, nextClosures);

    const delta = diffAvailability(before, after, normalised);

    const impact = closureImpact(normalised, {
      sessions,
      stalls,
      transactions: after.transactions,
      allClosures: after.closures.all,
    });
    this.closures = nextClosures;
    this.revision += 1;
    this.history.push({
      revision: this.revision,
      id,
      nightKey: closure.nightKey,
      at: new Date().toISOString(),
    });

    return {
      closure,
      normalised,
      impact: {
        ...impact,
        availabilityDelta: delta,
        revision: this.revision,
        superseded: after.closures.superseded
          .filter((c) => c.id === id || c.supersededBy === id)
          .map((c) => ({ id: c.id, kind: c.kind, reason: c.reason })),
      },
      beforeDigest: digestOf(before, this.closures.length - 1),
      afterDigest: digestOf(after, this.closures.length),
      analysis: after,
    };
  }

  /** Remove a backfilled closure (revision rollback); seeded records are retained. */
  removeClosure(id) {
    const target = this.closures.find((c) => c.id === id);
    if (!target) return { removed: false, reason: "未找到该停业记录" };
    if (target.source === "登记表") return { removed: false, reason: "登记表原始记录不可通过补录接口删除" };
    this.closures = this.closures.filter((c) => c.id !== id);
    this.revision += 1;
    return { removed: true, id, revision: this.revision };
  }
}

function replaceOrAppend(list, closure) {
  const idx = list.findIndex((c) => c.id === closure.id);
  if (idx === -1) return [...list, closure];
  const copy = list.slice();
  copy[idx] = closure;
  return copy;
}

function diffAvailability(before, after, closure) {
  const key = (row) => `${row.stall.id}|${row.session.nightKey}`;
  const beforeMap = new Map(before.rows.map((r) => [key(r), r.availableSeconds]));
  const rows = [];
  for (const row of after.rows) {
    const previous = beforeMap.get(key(row));
    if (previous == null) continue;
    if (previous === row.availableSeconds) continue;
    rows.push({
      stallId: row.stall.id,
      stallName: row.stall.name,
      nightKey: row.session.nightKey,
      beforeMinutes: Math.round(previous / 60),
      afterMinutes: Math.round(row.availableSeconds / 60),
      lostMinutes: Math.round((previous - row.availableSeconds) / 60),
      closureId: closure.id,
    });
  }
  return rows;
}

function digestOf(analysis, closureCount) {
  return [
    "ANALYSIS",
    `${analysis.from}..${analysis.to}`,
    `revision=${closureCount}`,
    `available=${(analysis.totals.availableSeconds / 3600).toFixed(1)}h`,
    `closed=${((analysis.totals.rawSeconds - analysis.totals.availableSeconds) / 3600).toFixed(1)}h`,
    `tickets=${analysis.totals.ticketCount}`,
    `unallocated=${analysis.unallocated.length}`,
  ].join("|");
}

/** Load tickets from disk as raw register objects. */
export function readTransactions(raw) {
  if (!Array.isArray(raw)) throw new TypeError("交易登记必须是数组");
  return raw.map((t) => ({ ...t }));
}

export function parseTicketsJson(text) {
  const data = JSON.parse(text);
  return readTransactions(data);
}

export { normaliseTransaction, effectiveClosures, parseLocalInstant };
