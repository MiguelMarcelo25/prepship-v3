export type WorkerResolvedResultClassification = {
  status: 'succeeded' | 'failed';
  summary: Record<string, unknown> | null;
  error: string | null;
};

const SUMMARY_KEYS = [
  'enabled',
  'accounts',
  'attemptedAccounts',
  'successfulAccounts',
  'candidates',
  'checked',
  'errors',
  'synced',
  'pages',
  'inserted',
  'updated',
  'matchedOrders',
  'ordersMarkedShipped',
  'processed',
  'succeeded',
  'failed',
  'skipped',
  'total',
  'delivered',
  'retired',
  'unknown',
  'refreshed',
  'days',
  'dailyRows',
  'skuRows',
  'inventoryRows',
  'billingRows',
  'lastSyncedAt',
] as const;

function nonNegativeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function summarizeResolvedResult(source: Record<string, unknown>): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) {
    if (source[key] !== undefined) summary[key] = source[key];
  }
  return Object.keys(summary).length ? summary : null;
}

/**
 * Some batch owners deliberately return per-item/account errors so one bad
 * record does not abort useful work. A run where every attempted unit failed
 * is different: worker truth must report failure even though the handler
 * resolved normally.
 */
export function classifyWorkerResolvedResult(result: unknown): WorkerResolvedResultClassification {
  if (!result || typeof result !== 'object') {
    return { status: 'succeeded', summary: null, error: null };
  }

  const source = result as Record<string, unknown>;
  const summary = summarizeResolvedResult(source);
  const errors = nonNegativeCount(source.errors) ?? 0;
  const attempted =
    nonNegativeCount(source.attemptedAccounts) ??
    nonNegativeCount(source.candidates) ??
    nonNegativeCount(source.accounts);

  if (errors > 0 && attempted !== null && attempted > 0 && errors >= attempted) {
    return {
      status: 'failed',
      summary,
      error: `All ${attempted} attempted work units failed`,
    };
  }

  return { status: 'succeeded', summary, error: null };
}
