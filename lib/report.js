/**
 * Presentation layer: turn the domain analysis into JSON for the browser.
 * Every number the page shows originates here from an actual `analyse()` run;
 * nothing is hard-coded in the HTML.
 */

import {
  fmtDate,
  fmtDuration,
  fmtPct,
  fmtTime,
  totalDuration,
} from "./time.js";
import { closureKindLabel, closureScopeLabel } from "./closures.js";

export function hoursLabel(seconds) {
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export function minutesLabel(seconds) {
  return `${Math.round(seconds / 60)} 分钟`;
}

export function spanLabel(span) {
  if (!span) return "—";
  return `${fmtDate(span.start)} ${fmtTime(span.start)} – ${fmtDate(span.end)} ${fmtTime(span.end)}`;
}

export function sessionLabel(session) {
  return `${fmtDate(session.start)} ${fmtTime(session.start)} → ${fmtDate(session.end)} ${fmtTime(session.end)}`;
}

export function windowLabel(from, to) {
  return `${from} 至 ${to}（结束日不含）`;
}

export function serialiseClosure(closure, { stallsById, areasById }) {
  return {
    id: closure.id,
    kind: closure.kind,
    kindLabel: closureKindLabel(closure.kind),
    scope: closure.scope,
    scopeLabel: closureScopeLabel(closure, stallsById, areasById),
    stallId: closure.stallId,
    areaId: closure.areaId,
    nightKey: closure.nightKey,
    startLabel: closure.startLabel,
    endLabel: closure.endLabel,
    windowLabel: `${closure.startLabel} – ${closure.endLabel}`,
    minutes: Math.round((closure.end - closure.start) / 60),
    reason: closure.reason,
    recordedAt: closure.recordedAt,
    source: closure.source,
    supersededBy: closure.supersededBy,
  };
}

export function serialiseSessions(analysis) {
  return analysis.sessions.map((session) => {
    const night = analysis.series.find((s) => s.nightKey === session.nightKey);
    return {
      nightKey: session.nightKey,
      weekdayLabel: session.weekdayLabel,
      startLabel: `${fmtDate(session.start)} ${fmtTime(session.start)}`,
      endLabel: `${fmtDate(session.end)} ${fmtTime(session.end)}`,
      crossesMidnight: session.crossesMidnight,
      overrideReason: session.overrideReason,
      sessionHours: Number(((session.end - session.start) / 3600).toFixed(2)),
      availableHours: Number((night?.availableHours || 0).toFixed(2)),
      cutHours: Number((night?.cutHours || 0).toFixed(2)),
      tickets: night?.tickets || 0,
      ticketsPerHour:
        night && night.ticketsPerHour != null ? Number(night.ticketsPerHour.toFixed(2)) : null,
    };
  });
}

export function serialiseNights(analysis) {
  return analysis.series.map((night) => ({
    nightKey: night.nightKey,
    weekdayLabel: night.weekdayLabel,
    label: `${night.nightKey.slice(5)} ${night.weekdayLabel}`,
    crossesMidnight: night.crossesMidnight,
    availableHours: Number(night.availableHours.toFixed(2)),
    cutHours: Number(night.cutHours.toFixed(2)),
    tickets: night.tickets,
    ticketsPerHour:
      night.ticketsPerHour != null ? Number(night.ticketsPerHour.toFixed(2)) : null,
  }));
}

function serialiseRow(row, analysis) {
  const tickets = row.tickets || [];
  return {
    stallId: row.stall.id,
    stallName: row.stall.name,
    areaId: row.stall.areaId,
    areaName: row.stall.areaName,
    nightKey: row.session.nightKey,
    weekdayLabel: row.session.weekdayLabel,
    sessionRange: sessionLabel(row.session),
    crossesMidnight: row.session.crossesMidnight,
    scheduled: row.scheduled,
    rawLabel: row.raw ? spanLabel(row.raw) : "—",
    rawMinutes: row.raw ? Math.round(totalDuration([row.raw]) / 60) : 0,
    availableLabel: row.available.length ? row.available.map(spanLabel).join("；") : "—",
    availableMinutes: Math.round(row.availableSeconds / 60),
    closedMinutes: Math.round(((row.rawSeconds || 0) - row.availableSeconds) / 60),
    availableHours: Number((row.availableSeconds / 3600).toFixed(2)),
    closedHours: Number((((row.rawSeconds || 0) - row.availableSeconds) / 3600).toFixed(2)),
    closures: (row.contributors || []).map((c) => ({
      id: c.id,
      kind: c.kind,
      reason: c.reason,
      windowLabel: spanLabel(c.cut),
      minutes: Math.round(c.cutSeconds / 60),
    })),
    ticketCount: tickets.length,
    countableTickets: row.countableTickets || 0,
    tickets: tickets.map((t) => ({
      id: t.id,
      label: t.label,
      amount: t.amount,
      basis: t.basis,
      inAvailable: t.inAvailable,
      inRaw: t.inRaw,
      withinTradeable: t.withinTradeable,
      insideClosure: t.insideClosure,
      note: t.note,
    })),
    ticketsInClosedWindow: row.ticketsInClosedWindow || 0,
    ticketsPerHour:
      row.availableSeconds > 0
        ? Number(((row.countableTickets || 0) / (row.availableSeconds / 3600)).toFixed(2))
        : null,
  };
}

export function serialiseAnalysis(analysis, venue, meta = {}) {
  const stallsById = new Map(analysis.stalls.map((s) => [s.id, s]));
  const rows = analysis.rows
    .filter((row) => row.scheduled)
    .map((row) => serialiseRow(row, analysis));

  const stallSummaries = analysis.perStall.map((entry) => ({
    id: entry.stall.id,
    name: entry.stall.name,
    areaId: entry.stall.areaId,
    areaName: entry.stall.areaName,
    scheduledNights: entry.scheduledNights,
    availableHours: Number((entry.availableSeconds / 3600).toFixed(2)),
    rawHours: Number((entry.rawSeconds / 3600).toFixed(2)),
    cutHours: Number(
      (
        (entry.rows.reduce((n, r) => n + (r.rawSeconds || 0), 0) - entry.availableSeconds) /
        3600
      ).toFixed(2),
    ),
    tickets: entry.tickets,
    attributedTickets: entry.attributedTickets,
    revenue: Number(entry.revenue.toFixed(2)),
    ticketsPerHour:
      entry.availableSeconds > 0
        ? Number((entry.tickets / (entry.availableSeconds / 3600)).toFixed(2))
        : null,
    utilization:
      entry.availableSeconds > 0
        ? fmtPct(entry.tickets / (entry.availableSeconds / 3600))
        : "—",
  }));

  const totals = analysis.totals;
  const summary = {
    from: analysis.from,
    to: analysis.to,
    windowLabel: windowLabel(analysis.from, analysis.to),
    sessionCount: totals.sessionCount,
    stallCount: totals.stallCount,
    stallNights: totals.scheduledStallNights,
    availableHours: Number((totals.availableSeconds / 3600).toFixed(2)),
    rawHours: Number((totals.rawSeconds / 3600).toFixed(2)),
    closedHours: Number(((totals.rawSeconds - totals.availableSeconds) / 3600).toFixed(2)),
    ticketCount: totals.countableTickets,
    attributedCount: totals.ticketCount,
    unallocatedCount: totals.unallocatedCount,
    revenue: Number(totals.countableRevenue.toFixed(2)),
    ticketsPerAvailableHour:
      totals.ticketsPerAvailableHour != null
        ? Number(totals.ticketsPerAvailableHour.toFixed(2))
        : null,
    closureCount: analysis.closures.active.length,
    inferredClosureCount: analysis.closures.active.filter((c) => c.kind === "mirror-inferred").length,
    supersededCount: analysis.closures.superseded.length,
    closureShare: totals.closureShareLabel,
    denominatorNote:
      "分母 = 摊位登记营业窗口 ∩ 市场营业时段 − 当晚登记的临时停业；只计真正可经营的时间。",
  };

  const closures = analysis.closures.all
    .map((c) => serialiseClosure(c, { stallsById, areasById: venue.areasById }))
    .sort((a, b) => (a.startLabel < b.startLabel ? -1 : 1));

  const digest = [
    "ANALYSIS",
    `${analysis.from}..${analysis.to}`,
    `sessions=${totals.sessionCount}`,
    `stallNights=${totals.scheduledStallNights}`,
    `available=${(totals.availableSeconds / 3600).toFixed(1)}h`,
    `closed=${((totals.rawSeconds - totals.availableSeconds) / 3600).toFixed(1)}h`,
    `tickets=${totals.countableTickets}`,
    `unallocated=${totals.unallocatedCount}`,
    `closures=${analysis.closures.all.length}`,
  ].join("|");

  return {
    ok: true,
    action: "analysis",
    window: { from: analysis.from, to: analysis.to, label: windowLabel(analysis.from, analysis.to) },
    summary,
    sessions: serialiseSessions(analysis),
    nights: serialiseNights(analysis),
    stalls: stallSummaries,
    rows,
    closures,
    unallocated: analysis.unallocated.map((tx) => ({
      id: tx.id,
      stallId: tx.stallId,
      label: `${fmtDate(tx.occurredAt)} ${fmtTime(tx.occurredAt)}`,
      amount: tx.amount,
      basis: tx.basis,
      issues: tx.issues,
    })),
    evidence: {
      digest,
      generatedAt: new Date().toISOString(),
      strategy: "interval-intersection",
      rowsRecomputed: analysis.rows.length,
      meta,
    },
  };
}

export function serialiseAvailability(analysis, venue, meta = {}) {
  const stallsById = new Map(analysis.stalls.map((s) => [s.id, s]));
  const rows = analysis.rows
    .filter((row) => row.scheduled)
    .map((row) => {
      const serialised = serialiseRow(row, analysis);
      return {
        ...serialised,
        segments: row.available.map((s) => ({
          startLabel: `${fmtDate(s.start)} ${fmtTime(s.start)}`,
          endLabel: `${fmtDate(s.end)} ${fmtTime(s.end)}`,
          minutes: Math.round((s.end - s.start) / 60),
          label: `${fmtTime(s.start)}–${fmtTime(s.end)}`,
        })),
        sessionRange: `${fmtDate(row.session.start)} ${fmtTime(row.session.start)} → ${fmtDate(row.session.end)} ${fmtTime(row.session.end)}`,
      };
    });
  const byNight = analysis.series.map((night) => ({
    nightKey: night.nightKey,
    weekdayLabel: night.weekdayLabel,
    label: `${night.nightKey.slice(5)} ${night.weekdayLabel}`,
    crossesMidnight: night.crossesMidnight,
    availableHours: Number(night.availableHours.toFixed(2)),
    cutHours: Number(night.cutHours.toFixed(2)),
    sessionHours: Number(night.sessionHours.toFixed(2)),
    tickets: night.tickets,
  }));
  const digest = [
    "AVAILABILITY",
    `${analysis.from}..${analysis.to}`,
    `rows=${rows.length}`,
    `available=${(analysis.totals.availableSeconds / 3600).toFixed(1)}h`,
    `closed=${((analysis.totals.rawSeconds - analysis.totals.availableSeconds) / 3600).toFixed(1)}h`,
  ].join("|");
  return {
    ok: true,
    action: "availability",
    window: { from: analysis.from, to: analysis.to, label: windowLabel(analysis.from, analysis.to) },
    summary: {
      availableHours: Number((analysis.totals.availableSeconds / 3600).toFixed(2)),
      rawHours: Number((analysis.totals.rawSeconds / 3600).toFixed(2)),
      closedHours: Number(((analysis.totals.rawSeconds - analysis.totals.availableSeconds) / 3600).toFixed(2)),
      rows: rows.length,
      definition:
        "可经营时长 = 摊位登记窗口 ∩ 市场营业时段 − 当晚停业登记（按区间求交、求差逐段计算）",
    },
    byNight,
    rows,
    closures: analysis.closures.all.map((c) =>
      serialiseClosure(c, { stallsById, areasById: venue.areasById }),
    ),
    evidence: {
      digest,
      generatedAt: new Date().toISOString(),
      strategy: "interval-intersection",
      rowsRecomputed: analysis.rows.length,
      meta,
    },
  };
}

export function sessionsPayload(analysis) {
  return {
    sessions: serialiseSessions(analysis),
    nights: serialiseNights(analysis),
  };
}

export { fmtDuration, fmtPct };
