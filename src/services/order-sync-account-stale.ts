/**
 * PS-484 — the one owner of "is this ShipStation sync account stale", and WHY.
 *
 * The original rule was inline in the diagnostics loop and therefore untested; ae59ab07 pulled it
 * out as a boolean. A boolean cannot say which clause fired, and that is the gap this card was
 * raised on: /health/deep went 503 "1 order sync account(s) are stale or failed" while both
 * accounts reported healthy, and nobody could tell which of five clauses did it. The per-run
 * account snapshot is overwritten every pass, so the evidence is gone by the time anyone looks.
 *
 * So the rule now returns its REASONS. The boolean delegates to it (one truth), the diagnostics
 * carry the codes per account, the watchdog verdict names them in the 503 text, and the health
 * payload exposes them — the next occurrence explains itself.
 *
 * Narrowing kept from ae59ab07: a backlog counts only once it has STOPPED draining
 * (stalledPasses at the alert threshold); a draining backlog is progress, not staleness.
 */

/**
 * Passes a catch-up cursor may sit on the same page before its backlog counts as stalled.
 * Three: one budget-limited pass followed by one that completes is the normal production shape
 * for a store whose page count exceeds the pass budget (378060: 13 pages vs 10), and two is what
 * a store that is merely larger than the page budget produces on every cycle.
 */
export const STALLED_PASS_ALERT_THRESHOLD = 3;

export type OrderSyncStaleReason =
  | 'run_failed'
  | 'run_abandoned'
  | 'never_synced'
  | 'watermark_stale'
  | 'status_backlog_stalled'
  | 'awaiting_backlog_stalled';

export type OrderSyncAccountStaleInput = {
  /** The account's persisted run state is 'failed' (its last pass threw). */
  runStatusFailed: boolean;
  /** orderSyncRunQueueVerdict says the recorded running pass is no longer owned by the queue. */
  runAbandoned: boolean;
  watermarkMs: number | null;
  ageMs: number | null;
  freshMs: number;
  statusBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
  awaitingBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
};

const stalled = (entries: ReadonlyArray<{ stalledPasses: number }>): boolean =>
  entries.some((entry) => entry.stalledPasses >= STALLED_PASS_ALERT_THRESHOLD);

/** Every clause that makes the account stale, in a fixed order. Empty means fresh. */
export function orderSyncAccountStaleReasons(input: OrderSyncAccountStaleInput): OrderSyncStaleReason[] {
  const reasons: OrderSyncStaleReason[] = [];
  if (input.runStatusFailed) reasons.push('run_failed');
  if (input.runAbandoned) reasons.push('run_abandoned');
  if (input.watermarkMs === null) reasons.push('never_synced');
  if (input.ageMs !== null && input.ageMs > input.freshMs) reasons.push('watermark_stale');
  if (stalled(input.statusBacklogEntries)) reasons.push('status_backlog_stalled');
  if (stalled(input.awaitingBacklogEntries)) reasons.push('awaiting_backlog_stalled');
  return reasons;
}

/**
 * The boolean, kept for callers that only need the verdict. `failed` is the OR the diagnostics
 * loop used to compute (run state failed OR run abandoned); it maps onto run_failed here so the
 * truth table is unchanged. One rule, one place — this cannot drift from the reasons.
 */
export function isOrderSyncAccountStale(input: {
  failed: boolean;
  watermarkMs: number | null;
  ageMs: number | null;
  freshMs: number;
  statusBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
  awaitingBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
}): boolean {
  return orderSyncAccountStaleReasons({
    runStatusFailed: input.failed,
    runAbandoned: false,
    watermarkMs: input.watermarkMs,
    ageMs: input.ageMs,
    freshMs: input.freshMs,
    statusBacklogEntries: input.statusBacklogEntries,
    awaitingBacklogEntries: input.awaitingBacklogEntries,
  }).length > 0;
}
