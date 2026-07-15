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
  | 'targeted-order-change';

export type DurableRateBackfillJobPayload = {
  version: 1;
  jobId: string;
  requestedAt: string;
  requestedBy: RateBackfillRequestSource;
  options: RateBackfillOptions;
};

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
  ) {
    return null;
  }
  if (!payload.options || typeof payload.options !== 'object') return null;
  return payload as DurableRateBackfillJobPayload;
}
