export type RateBackfillOptions = {
  mode?: 'cache_first' | 'full_live_audit' | 'preexpiry_refresh';
  clientId?: number;
  limit?: number;
  maxAgeHours?: number;
  orderIds?: number[];
};

export type RateBackfillRequestSource =
  | 'manual'
  | 'rate-on-ingest'
  | 'targeted-order-change'
  | 'cadence';

export type RateBackfillCursor = {
  beforeOrderDate: string;
  beforeOrderId: number;
};

export type DurableRateBackfillJobPayload = {
  version: 1;
  jobId: string;
  requestedAt: string;
  requestedBy: RateBackfillRequestSource;
  options: RateBackfillOptions;
  /** One logical request may span many short pg-boss jobs. */
  generationId?: string;
  /** Zero-based durable chunk number within generationId. */
  chunkIndex?: number;
  /** Stable broad-scan cursor; absent on the first chunk. */
  cursor?: RateBackfillCursor | null;
  /** Remaining generation cap, including this chunk. */
  remainingLimit?: number;
  /** Targeted order-id offset for bounded explicit requests. */
  targetOffset?: number;
};

export const RATE_BACKFILL_YIELD_PRIORITY = -100;
export const RATE_BACKFILL_TARGETED_PRIORITY = -50;
export const RATE_BACKFILL_MANUAL_PRIORITY = -10;

export function rateBackfillPriority(
  payload: DurableRateBackfillJobPayload | null,
): number {
  // PS-436: every rate request remains below order/shipment cadence (priority
  // zero). First-chunk operator/targeted work stays ordered ahead of passive
  // cadence, but cannot starve operational freshness.
  if (
    !payload
    || (payload.chunkIndex ?? 0) > 0
    || payload.requestedBy === 'cadence'
  ) {
    return RATE_BACKFILL_YIELD_PRIORITY;
  }
  if (payload.requestedBy === 'manual') return RATE_BACKFILL_MANUAL_PRIORITY;
  return RATE_BACKFILL_TARGETED_PRIORITY;
}

export function buildCadenceRateBackfillJobPayload(
  queueJobId: string,
): DurableRateBackfillJobPayload {
  return {
    version: 1,
    jobId: queueJobId,
    generationId: queueJobId,
    chunkIndex: 0,
    cursor: null,
    remainingLimit: 5_000,
    targetOffset: 0,
    requestedAt: new Date().toISOString(),
    requestedBy: 'cadence',
    options: { mode: 'preexpiry_refresh', limit: 5_000 },
  };
}

export function parseDurableRateBackfillJobPayload(
  value: unknown,
): DurableRateBackfillJobPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<DurableRateBackfillJobPayload>;
  if (payload.version !== 1 || typeof payload.jobId !== 'string' || !payload.jobId.trim()) {
    return null;
  }
  if (
    payload.requestedBy !== 'manual'
    && payload.requestedBy !== 'rate-on-ingest'
    && payload.requestedBy !== 'targeted-order-change'
    && payload.requestedBy !== 'cadence'
  ) {
    return null;
  }
  if (!payload.options || typeof payload.options !== 'object') return null;
  if (
    payload.cursor != null
    && (
      typeof payload.cursor !== 'object'
      || typeof payload.cursor.beforeOrderDate !== 'string'
      || !Number.isFinite(Number(payload.cursor.beforeOrderId))
    )
  ) {
    return null;
  }
  return payload as DurableRateBackfillJobPayload;
}
