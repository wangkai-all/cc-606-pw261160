/**
 * Ledger <-> session attribution.
 *
 * Transactions are posted one ticket at a time and each ticket belongs to
 * exactly one night. The register may carry an explicit posting slot
 * (`sessionId`) or only a timestamp:
 *
 *  - explicit slot: authoritative; an off-clock ticket inside that slot is
 *    flagged but still posted there, because the register's slot is a fact;
 *  - timestamp only: the night whose opening session contains the instant
 *    wins. A night crossing midnight therefore owns 00:31 under the previous
 *    calendar date's opening. Resolving by date would split one night into two.
 *
 * Attribution is a pure function of (ticket, calendar). Backfilling a closure
 * never moves a ticket's night; it only changes which time was tradeable.
 */

import { fmtDate, fmtTime, localDateKey } from "./time.js";

export function findSessionByInstant(sessions, instant) {
  return sessions.find((s) => instant >= s.start && instant < s.end) || null;
}

export function findSessionByKey(sessions, key) {
  return sessions.find((s) => s.nightKey === key) || null;
}

function describe(tx, ticketDate, session, nightKey, basis) {
  return {
    id: tx.id,
    stallId: tx.stallId,
    occurredAt: tx.occurredAt,
    ticketDate,
    sessionId: session ? session.nightKey : null,
    nightKey,
    basis,
    amount: tx.amount,
    note: tx.note || null,
  };
}

/**
 * @param {object} tx normalised transaction:
 *   { id, stallId, occurredAt, sessionId?, amount, note? }
 * @param {object[]} sessions
 * @param {Map<string,object>} stallsById
 */
export function attributeTransaction(tx, sessions, stallsById) {
  const ticketDate = localDateKey(tx.occurredAt);
  const issues = [];
  const stallKnown = stallsById.has(tx.stallId);
  if (!stallKnown) {
    issues.push({ code: "unknown-stall", message: `登记了不存在的摊位 ${tx.stallId}` });
  }

  if (tx.sessionId) {
    const session = findSessionByKey(sessions, tx.sessionId);
    if (!session) {
      issues.push({
        code: "unknown-session",
        message: `票面声明营业日 ${tx.sessionId} 不在当前营业日历中`,
      });
      return {
        ...describe(tx, ticketDate, null, null, "unknown-session"),
        attributed: false,
        unallocated: true,
        issues,
      };
    }
    const inside = tx.occurredAt >= session.start && tx.occurredAt < session.end;
    if (!inside) {
      issues.push({
        code: "ticket-outside-session-window",
        message:
          `票面时间 ${fmtDate(tx.occurredAt)} ${fmtTime(tx.occurredAt)} ` +
          `不在 ${session.nightKey} 营业时段内，但票面营业日已明确登记，按登记入账`,
      });
    }
    return {
      ...describe(tx, ticketDate, session, session.nightKey, "session-slot"),
      attributed: stallKnown,
      unallocated: !stallKnown,
      offClock: !inside,
      issues,
    };
  }

  const match = findSessionByInstant(sessions, tx.occurredAt);
  if (!match) {
    issues.push({
      code: "unattributed",
      message: `票面时间 ${fmtDate(tx.occurredAt)} ${fmtTime(tx.occurredAt)} 不落在任何营业时段，无法归属`,
    });
    return {
      ...describe(tx, ticketDate, null, null, "outside-calendar"),
      attributed: false,
      unallocated: true,
      issues,
    };
  }
  if (!stallKnown) {
    return {
      ...describe(tx, ticketDate, match, match.nightKey, "unknown-stall"),
      attributed: false,
      unallocated: true,
      issues,
    };
  }
  return {
    ...describe(
      tx,
      ticketDate,
      match,
      match.nightKey,
      ticketDate === match.nightKey ? "clock" : "clock-after-midnight",
    ),
    attributed: true,
    unallocated: false,
    offClock: false,
    issues,
  };
}

/**
 * Re-run attribution after a register revision (closure backfill, schedule
 * change). Returns the diff so the caller can prove posting stayed stable.
 */
export function reattribute(transactions, sessions, stallsById) {
  return transactions.map((tx) => {
    const attribution = attributeTransaction(tx, sessions, stallsById);
    return {
      tx,
      attribution,
      moved: tx.sessionId ? false : attribution.nightKey !== tx.nightKey,
    };
  });
}
