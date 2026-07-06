export type ManualOrderSyncMode = 'incremental' | 'full';

export type ManualOrderSyncRequest = {
  sinceIso?: string;
  sinceMs?: number;
  pageSize?: number;
  fullResync?: boolean;
  full?: boolean;
};

export type ManualOrderSyncJobPayload = {
  requestedAt: string;
  requestedBy: 'manual-sync';
  mode: ManualOrderSyncMode;
  sinceMs?: number;
  awaitingSinceMs?: number;
  pageSize?: number;
  fullResync?: boolean;
  skipStatusPasses?: boolean;
};

export type OrderSyncJobOptions = {
  sinceMs?: number;
  awaitingSinceMs?: number;
  pageSize?: number;
  skipStatusPasses?: boolean;
};

function finiteNonnegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

function boundedPageSize(value: unknown): number | undefined {
  const pageSize = finiteNonnegativeInteger(value);
  if (pageSize === undefined || pageSize < 1) return undefined;
  return Math.min(500, pageSize);
}

export function buildManualOrderSyncJobPayload(
  input: ManualOrderSyncRequest = {},
): ManualOrderSyncJobPayload {
  const fullResync = input.fullResync === true;
  const legacyFull = input.full === true;
  const parsedSinceIso = input.sinceIso ? Date.parse(input.sinceIso) : NaN;
  const sinceMs = fullResync
    ? 0
    : finiteNonnegativeInteger(input.sinceMs) ??
      (Number.isFinite(parsedSinceIso) ? Math.trunc(parsedSinceIso) : undefined);

  const payload: ManualOrderSyncJobPayload = {
    requestedAt: new Date().toISOString(),
    requestedBy: 'manual-sync',
    mode: fullResync || legacyFull ? 'full' : 'incremental',
  };

  if (sinceMs !== undefined) {
    payload.sinceMs = sinceMs;
    payload.awaitingSinceMs = fullResync ? 0 : sinceMs;
  }

  const pageSize = boundedPageSize(input.pageSize);
  if (pageSize !== undefined) payload.pageSize = pageSize;
  if (fullResync) payload.fullResync = true;
  if (payload.mode === 'incremental') {
    // Per user override unlock shipped data on 2026-07-07: the operator refresh
    // button is an awaiting-order freshness request. Historical shipped/cancelled/
    // hold reconciliation remains owned by cadence/watchdog sync, so clicks cannot
    // spend the whole worker deadline on redundant status catch-up.
    payload.skipStatusPasses = true;
  }

  return payload;
}

export function orderSyncOptionsFromJobPayload(data: unknown): OrderSyncJobOptions {
  const source = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const fullResync = source.fullResync === true || source.full === true || source.mode === 'full';
  const sinceMs = fullResync
    ? 0
    : finiteNonnegativeInteger(source.sinceMs) ??
      (typeof source.sinceIso === 'string' && Number.isFinite(Date.parse(source.sinceIso))
        ? Math.trunc(Date.parse(source.sinceIso))
        : undefined);

  const options: OrderSyncJobOptions = {};
  if (sinceMs !== undefined) {
    options.sinceMs = sinceMs;
    options.awaitingSinceMs = fullResync ? 0 : sinceMs;
  }

  const pageSize = boundedPageSize(source.pageSize);
  if (pageSize !== undefined) options.pageSize = pageSize;
  if (source.skipStatusPasses === true) options.skipStatusPasses = true;

  return options;
}
