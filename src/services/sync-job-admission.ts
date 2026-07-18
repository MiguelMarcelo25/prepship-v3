/**
 * Canonical pg-boss admission policy for the shared ShipStation sync lane.
 *
 * Per user override unlock shipped data on 2026-07-14: this policy only
 * coalesces queue wake-ups and prioritizes operator recovery requests. It does
 * not read or mutate orders, shipments, labels, postage, or marketplace state.
 */

export const SHIPSTATION_SYNC_JOBS = {
  orders: 'prepship.sync.orders',
  shipments: 'prepship.sync.shipments',
} as const;

export const ORDER_REFRESH_SINGLETON_KEY = 'order-refresh';
export const SHIPMENT_REFRESH_SINGLETON_KEY = 'shipment-refresh';
export const MANUAL_FULL_ORDER_SINGLETON_KEY = 'manual-full';

export const OPERATOR_SYNC_PRIORITY = 1_000;
export const WATCHDOG_SYNC_PRIORITY = 500;
export const STARVATION_RECOVERY_PRIORITY = 100;

export type SyncQueuePolicy = 'standard' | 'stately';

export type SyncJobAdmissionIntent =
  | { kind: 'cadence' }
  | { kind: 'manual-order'; mode: 'incremental' | 'full' }
  | { kind: 'watchdog-order' }
  | { kind: 'manual-shipment' }
  | { kind: 'watchdog-shipment' }
  | { kind: 'busy-defer'; orderStarvation: boolean };

export type SyncJobAdmission = {
  policy: SyncQueuePolicy;
  singletonKey: string;
  priority: number;
};

export type OperationalSyncQueueSizes = {
  orders: number;
  shipments: number;
};

/**
 * Cross-queue priority fence. Pg-boss priorities are queue-local, so the
 * lower-priority rate queue must explicitly yield before racing an already
 * pending order or shipment tick for the shared lane.
 */
export function rateBackfillOperationalBlocker(
  queueSizes: OperationalSyncQueueSizes,
): string | null {
  if (queueSizes.orders > 0) return SHIPSTATION_SYNC_JOBS.orders;
  if (queueSizes.shipments > 0) return SHIPSTATION_SYNC_JOBS.shipments;
  return null;
}

export function syncQueuePolicyForJob(name: string): SyncQueuePolicy {
  return name === SHIPSTATION_SYNC_JOBS.orders || name === SHIPSTATION_SYNC_JOBS.shipments
    ? 'stately'
    : 'standard';
}

function refreshSingletonKey(name: string): string {
  if (name === SHIPSTATION_SYNC_JOBS.orders) return ORDER_REFRESH_SINGLETON_KEY;
  if (name === SHIPSTATION_SYNC_JOBS.shipments) return SHIPMENT_REFRESH_SINGLETON_KEY;
  throw new Error(`Job ${name} does not use the shared ShipStation refresh lane`);
}

/**
 * Resolve every cadence/manual/watchdog/defer producer through one policy so
 * equivalent wake-ups cannot accumulate under producer-specific keys.
 */
export function resolveSyncJobAdmission(
  name: string,
  intent: SyncJobAdmissionIntent,
): SyncJobAdmission {
  const policy = syncQueuePolicyForJob(name);

  if (intent.kind === 'cadence') {
    return {
      policy,
      singletonKey: policy === 'stately' ? refreshSingletonKey(name) : 'cadence',
      priority: 0,
    };
  }

  if (intent.kind === 'manual-order') {
    if (name !== SHIPSTATION_SYNC_JOBS.orders) {
      throw new Error(`Manual order sync cannot target ${name}`);
    }
    return {
      policy,
      singletonKey:
        intent.mode === 'full' ? MANUAL_FULL_ORDER_SINGLETON_KEY : ORDER_REFRESH_SINGLETON_KEY,
      priority: OPERATOR_SYNC_PRIORITY,
    };
  }

  // Per user override unlock shipped data on 2026-07-15: backlog recovery
  // shares the canonical order-refresh singleton but stays below operator priority.
  if (intent.kind === 'watchdog-order') {
    if (name !== SHIPSTATION_SYNC_JOBS.orders) {
      throw new Error(`Order recovery cannot target ${name}`);
    }
    return {
      policy,
      singletonKey: ORDER_REFRESH_SINGLETON_KEY,
      priority: WATCHDOG_SYNC_PRIORITY,
    };
  }

  if (intent.kind === 'manual-shipment' || intent.kind === 'watchdog-shipment') {
    if (name !== SHIPSTATION_SYNC_JOBS.shipments) {
      throw new Error(`Shipment recovery cannot target ${name}`);
    }
    return {
      policy,
      singletonKey: SHIPMENT_REFRESH_SINGLETON_KEY,
      priority:
        intent.kind === 'manual-shipment' ? OPERATOR_SYNC_PRIORITY : WATCHDOG_SYNC_PRIORITY,
    };
  }

  return {
    policy,
    singletonKey: refreshSingletonKey(name),
    priority: intent.orderStarvation ? STARVATION_RECOVERY_PRIORITY : 0,
  };
}
