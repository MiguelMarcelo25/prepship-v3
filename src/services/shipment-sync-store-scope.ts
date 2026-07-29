import { isExcludedStoreId } from '../config/prepship';

/**
 * PS-468: shipment sync must agree with order sync about which stores are in scope.
 *
 * `EXCLUDED_STORE_IDS` is honoured by order-sync, the orders/dashboard/clients/
 * analysis/init routes, rates-backfill and active-client-predicate -- but not by
 * shipment sync. The result is that PrepShip deliberately refuses to ingest a
 * store's ORDERS while happily ingesting its SHIPMENTS, so every one of those
 * shipments arrives for an order that was configured never to exist. It can
 * never match, and lands with a NULL order_id. The orphan is not a matching
 * failure; it is guaranteed by configuration.
 *
 * DJ confirmed 2026-07-29 that the exclusion is permanent and those stores are
 * not in use, so nothing of value is dropped here.
 */

/** The only shape this needs from a provider shipment payload. */
export type StoreScopedShipment = {
  advancedOptions?: { storeId?: number | null } | null;
};

export type ShipmentStoreScopePartition<T> = {
  /** Shipments belonging to a store PrepShip still syncs. */
  inScope: T[];
  /** Shipments from an excluded store, dropped before any DB write. */
  excluded: T[];
  /** Excluded store ids seen in this batch, for one summary log line. */
  excludedStoreIds: number[];
};

function shipmentStoreId(shipment: StoreScopedShipment): number | null {
  const storeId = shipment.advancedOptions?.storeId;
  return typeof storeId === 'number' ? storeId : null;
}

/**
 * Split a provider page into shipments PrepShip should persist and shipments
 * from excluded stores.
 *
 * A shipment with no resolvable storeId is treated as IN SCOPE. Excluding on
 * missing data would silently drop shipments for live stores whenever the
 * provider omits advancedOptions, which is a worse failure than the orphan this
 * fixes. Anything that slips through is still caught by the unattributed-insert
 * diagnostic rather than disappearing quietly.
 */
export function partitionShipmentsByStoreScope<T extends StoreScopedShipment>(
  pageShipments: readonly T[],
): ShipmentStoreScopePartition<T> {
  const inScope: T[] = [];
  const excluded: T[] = [];
  const excludedStoreIds = new Set<number>();

  for (const shipment of pageShipments) {
    const storeId = shipmentStoreId(shipment);
    if (storeId != null && isExcludedStoreId(storeId)) {
      excluded.push(shipment);
      excludedStoreIds.add(storeId);
      continue;
    }
    inScope.push(shipment);
  }

  return { inScope, excluded, excludedStoreIds: [...excludedStoreIds].sort((a, b) => a - b) };
}
