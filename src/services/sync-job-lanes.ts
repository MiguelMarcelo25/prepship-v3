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

  // Per user override unlock shipped data on 2026-07-14: Supabase's
  // transaction-pool client wedges when the high-write order/shipment,
  // fulfillment, classifier, and rate workflows overlap. Keep those durable
  // jobs in one cross-process DB-heavy lane; tracking/reporting remain
  // independent so carrier polling and operator read models are not starved.
  ['prepship.sync.rate-backfill', 'shipstation-sync'],
  ['rate backfill', 'shipstation-sync'],

  ['prepship.sync.fulfillment-outbox', 'shipstation-sync'],
  ['fulfillment outbox', 'shipstation-sync'],

  ['prepship.reporting.refresh', 'reporting'],
  ['reporting metrics refresh', 'reporting'],

  ['prepship.shipping.external-shipped-classifier', 'shipstation-sync'],
  ['external-shipped classifier', 'shipstation-sync'],

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
