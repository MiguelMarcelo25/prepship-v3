// Per user override unlock shipped data on 2026-07-01: backend worker lane ownership
// only; this does not mutate shipped/cancelled orders or shipment history.
export const SYNC_JOB_LANE_VALUES = [
  'shipstation-sync',
  'rate-backfill',
  'fulfillment-outbox',
  'reporting',
  'external-shipped-classifier',
  'shipment-tracking',
  'walmart-fees',
  'misc',
] as const;

export type SyncJobLane = (typeof SYNC_JOB_LANE_VALUES)[number];

const SYNC_JOB_LANE_BY_NAME = new Map<string, SyncJobLane>([
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

  // Queue maintenance is the recovery control plane for orphaned pg-boss
  // work. It must remain runnable when the DB-heavy ShipStation lane is
  // blocked by the stale job that maintenance needs to reap.
  ['prepship.maintenance.job-queue', 'misc'],
  ['job queue maintenance', 'misc'],

  // Per user override unlock shipped data on 2026-07-14: carrier snapshot
  // refresh performs provider reads plus database cache writes. Production
  // proof showed it can wedge the transaction-pool client when it starts in
  // the same second as fulfillment, so it shares the DB-heavy lane too.
  ['prepship.maintenance.carrier-account-snapshots', 'shipstation-sync'],
  ['carrier account snapshots', 'shipstation-sync'],

  // Audit 5.2: live quote probes consume the shared provider budget and write
  // one derived cache row, so they stay serialized with the DB-heavy lane.
  ['prepship.rates.local-tariff-calibration', 'shipstation-sync'],
  ['local tariff calibration', 'shipstation-sync'],
]);

export function syncJobLaneFor(name: string): SyncJobLane {
  // Per user override unlock shipped data on 2026-07-14: unknown worker jobs
  // are conservatively database-heavy. They must opt into an independent lane
  // explicitly instead of silently overlapping sync through the old misc
  // fallback (production rate-cache overlap reproduced the pool wedge).
  return SYNC_JOB_LANE_BY_NAME.get(name) ?? 'shipstation-sync';
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
