export type ManualShipmentSyncRequest = {
  sinceMs?: number;
  fullResync?: boolean;
};

export type ManualShipmentSyncJobPayload = {
  requestedAt: string;
  requestedBy: 'manual-shipment-sync';
  sinceMs?: number;
};

function finiteNonnegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

export function buildManualShipmentSyncJobPayload(
  input: ManualShipmentSyncRequest = {},
): ManualShipmentSyncJobPayload {
  const sinceMs = input.fullResync === true ? 0 : finiteNonnegativeInteger(input.sinceMs);
  return {
    requestedAt: new Date().toISOString(),
    requestedBy: 'manual-shipment-sync',
    ...(sinceMs === undefined ? {} : { sinceMs }),
  };
}

export function shipmentSyncOptionsFromJobPayload(data: unknown): { sinceMs?: number } {
  const source = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const sinceMs = finiteNonnegativeInteger(source.sinceMs);
  return sinceMs === undefined ? {} : { sinceMs };
}
