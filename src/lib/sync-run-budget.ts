// PS-265 (sync drain): a per-run budget so a paginating sync RETURNS before the job-handler
// deadline (PS-265 core's withDeadline, ~10 min) and advances its watermark for the work it
// actually did.
//
// Root cause it fixes: the heavy syncs walked the ENTIRE provider backlog in one run
// (uncapped `while(true)` pagination) and only advanced their watermark on FULL success. When
// a run exceeded the deadline it was killed mid-walk, the watermark never advanced, and the
// next run re-pulled the identical backlog and timed out again — draining nothing, forever.
//
// With a budget, a run processes a bounded slice (page cap OR wall-clock budget, whichever
// hits first), advances its watermark/cursor to the last-processed point, and returns
// cleanly; the next run resumes from there. All-or-nothing becomes incremental progress.
// The deadline is NOT raised — this makes runs finish UNDER it.

export const DEFAULT_SYNC_MAX_PAGES_PER_RUN = 10; // 10 x 500 rows = 5000 rows/unit/run
export const DEFAULT_SYNC_TIME_BUDGET_MS = 7 * 60_000; // 7 min — comfortably under the 10-min handler deadline

export type SyncRunBudget = {
  startedAtMs: number;
  maxPages: number;
  timeBudgetMs: number;
};

export function createSyncRunBudget(opts?: {
  startedAtMs?: number;
  maxPages?: number;
  timeBudgetMs?: number;
}): SyncRunBudget {
  return {
    startedAtMs: opts?.startedAtMs ?? Date.now(),
    maxPages: Math.max(1, opts?.maxPages ?? DEFAULT_SYNC_MAX_PAGES_PER_RUN),
    timeBudgetMs: Math.max(10_000, opts?.timeBudgetMs ?? DEFAULT_SYNC_TIME_BUDGET_MS),
  };
}

/** True when this unit (e.g. one account) has spent its page budget OR the run has spent its
 *  wall-clock budget — stop paginating and let the run return so the watermark advances. */
export function syncRunBudgetExhausted(
  budget: SyncRunBudget,
  pagesThisUnit: number,
  nowMs: number = Date.now(),
): boolean {
  return pagesThisUnit >= budget.maxPages || syncRunBudgetTimeExhausted(budget, nowMs);
}

/** True when the run has spent its wall-clock budget — used between units (accounts) to stop
 *  starting new work near the deadline. */
export function syncRunBudgetTimeExhausted(
  budget: SyncRunBudget,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - budget.startedAtMs >= budget.timeBudgetMs;
}
