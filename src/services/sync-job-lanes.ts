// Per user override unlock shipped data on 2026-07-01: backend worker lane ownership
// only; this does not mutate shipped/cancelled orders or shipment history.
export type SyncJobLane =
  | 'shipstation-sync'
  | 'rate-backfill'
  | 'fulfillment-outbox'
  | 'reporting'
  | 'external-shipped-classifier'
  | 'shipment-tracking'
  | 'walmart-fees'
  | 'misc';

const SYNC_JOB_LANES = new Map<string, SyncJobLane>([
  ['prepship.sync.orders', 'shipstation-sync'],
  ['orders sync', 'shipstation-sync'],
  ['prepship.sync.shipments', 'shipstation-sync'],
  ['shipments sync', 'shipstation-sync'],
  ['prepship.sync.inventory-import', 'shipstation-sync'],
  ['inventory import-from-orders', 'shipstation-sync'],
  ['prepship.sync.products', 'shipstation-sync'],
  ['inventory sync-products', 'shipstation-sync'],

  ['prepship.sync.rate-backfill', 'rate-backfill'],
  ['rate backfill', 'rate-backfill'],

  ['prepship.sync.fulfillment-outbox', 'fulfillment-outbox'],
  ['fulfillment outbox', 'fulfillment-outbox'],

  ['prepship.reporting.refresh', 'reporting'],
  ['reporting metrics refresh', 'reporting'],

  ['prepship.shipping.external-shipped-classifier', 'external-shipped-classifier'],
  ['external-shipped classifier', 'external-shipped-classifier'],

  ['prepship.tracking.poll', 'shipment-tracking'],
  ['shipment tracking poll', 'shipment-tracking'],

  ['prepship.fees.walmart-sync', 'walmart-fees'],
  ['walmart fees sync', 'walmart-fees'],
]);

export function syncJobLaneFor(name: string): SyncJobLane {
  return SYNC_JOB_LANES.get(name) ?? 'misc';
}

export function getSyncJobLaneBlocker(
  activeJobsByLane: ReadonlyMap<SyncJobLane, string>,
  name: string,
): string | null {
  return activeJobsByLane.get(syncJobLaneFor(name)) ?? null;
}

export function isSyncJobNameActive(
  activeJobsByLane: ReadonlyMap<SyncJobLane, string>,
  name: string,
): boolean {
  for (const activeName of activeJobsByLane.values()) {
    if (activeName === name) return true;
  }
  return false;
}
