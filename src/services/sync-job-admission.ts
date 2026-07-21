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

export const FULFILLMENT_OUTBOX_JOB_NAME = 'prepship.sync.fulfillment-outbox';

export const ORDER_REFRESH_SINGLETON_KEY = 'order-refresh';
export const SHIPMENT_REFRESH_SINGLETON_KEY = 'shipment-refresh';
export const FULFILLMENT_OUTBOX_SINGLETON_KEY = 'fulfillment-outbox';
export const MANUAL_FULL_ORDER_SINGLETON_KEY = 'manual-full';

export const OPERATOR_SYNC_PRIORITY = 1_000;
export const WATCHDOG_SYNC_PRIORITY = 500;
export const STARVATION_RECOVERY_PRIORITY = 100;
export const SYNC_STARVATION_DEFER_THRESHOLD = 3;
export const STARVED_SHIPMENT_LOOKAHEAD_MS = 60_000;
export const FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS = 60_000;

export type SyncQueuePolicy = 'standard' | 'stately';

export type SyncJobAdmissionIntent =
  | { kind: 'cadence' }
  | { kind: 'manual-order'; mode: 'incremental' | 'full' }
  | { kind: 'watchdog-order' }
  | { kind: 'manual-shipment' }
  | { kind: 'watchdog-shipment' }
  | { kind: 'busy-defer'; recoveryPriority: boolean };

export type SyncJobAdmission = {
  policy: SyncQueuePolicy;
  singletonKey: string;
  priority: number;
};

export type OperationalSyncQueueSizes = {
  orders: number;
  shipments: number;
};

export type OperationalSyncQueueRow = {
  name: string;
  state: string;
  startAfter: Date | string | number | null;
  priority?: number | null;
  deferCount?: number | string | null;
};

/**
 * A future busy-defer wake-up is durable intent, not runnable work. Counting
 * it as pending would let the always-present shipment wake-up starve targeted
 * rates forever.
 */
export function runnableOperationalSyncQueueSizes(
  rows: ReadonlyArray<OperationalSyncQueueRow>,
  nowMs: number = Date.now(),
): OperationalSyncQueueSizes {
  const sizes: OperationalSyncQueueSizes = { orders: 0, shipments: 0 };
  for (const row of rows) {
    if (row.state !== 'created' && row.state !== 'retry') continue;
    const startAfterMs =
      row.startAfter instanceof Date
        ? row.startAfter.getTime()
        : new Date(row.startAfter ?? 0).getTime();
    if (!Number.isFinite(startAfterMs) || startAfterMs > nowMs) continue;
    if (row.name === SHIPSTATION_SYNC_JOBS.orders) sizes.orders += 1;
    if (row.name === SHIPSTATION_SYNC_JOBS.shipments) sizes.shipments += 1;
  }
  return sizes;
}

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

function nonnegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

/**
 * Per user override unlock shipped data on 2026-07-21: queue-control fairness
 * only. A shipment attempt that is already active, explicitly requested for
 * recovery, or repeatedly deferred gets one bounded turn before another long
 * order refresh. No order/shipment/provider row is read or mutated here.
 */
export function shouldYieldOrderSyncToShipmentRecovery(
  rows: ReadonlyArray<OperationalSyncQueueRow>,
  nowMs: number = Date.now(),
): boolean {
  return rows.some((row) => {
    if (row.name !== SHIPSTATION_SYNC_JOBS.shipments) return false;
    if (row.state === 'active') return true;
    if (row.state !== 'created' && row.state !== 'retry') return false;

    const startAfterMs = row.startAfter instanceof Date
      ? row.startAfter.getTime()
      : new Date(row.startAfter ?? 0).getTime();
    if (
      !Number.isFinite(startAfterMs)
      || startAfterMs > nowMs + STARVED_SHIPMENT_LOOKAHEAD_MS
    ) {
      return false;
    }

    return nonnegativeInteger(row.priority) >= WATCHDOG_SYNC_PRIORITY
      || nonnegativeInteger(row.deferCount) >= SYNC_STARVATION_DEFER_THRESHOLD;
  });
}

/**
 * Per user override unlock shipped data on 2026-05-23: reconfirmed on
 * 2026-07-21; the fulfillment outbox gets one bounded shared-lane turn when it
 * is due or has a durable retry approaching. This is queue control-plane state
 * only; it never reads or mutates orders, shipments, labels, postage, or
 * marketplace state.
 */
export function shouldYieldOrderSyncToFulfillmentOutbox(
  rows: ReadonlyArray<OperationalSyncQueueRow>,
  nowMs: number = Date.now(),
): boolean {
  return rows.some((row) => {
    if (row.name !== FULFILLMENT_OUTBOX_JOB_NAME) return false;
    if (row.state === 'active') return true;
    if (row.state !== 'created' && row.state !== 'retry') return false;

    const startAfterMs = row.startAfter instanceof Date
      ? row.startAfter.getTime()
      : new Date(row.startAfter ?? 0).getTime();
    if (!Number.isFinite(startAfterMs)) return false;
    if (startAfterMs <= nowMs) return true;
    if (startAfterMs > nowMs + FULFILLMENT_OUTBOX_RECOVERY_LOOKAHEAD_MS) return false;

    return nonnegativeInteger(row.priority) >= STARVATION_RECOVERY_PRIORITY
      || nonnegativeInteger(row.deferCount) > 0;
  });
}

export function shipmentSyncRequestHasRecoveryPriority(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const requestedBy = (data as { requestedBy?: unknown }).requestedBy;
  return requestedBy === 'manual-shipment-sync'
    || requestedBy === 'shipment-sync-watchdog';
}

/**
 * Orders may interrupt a fresh shipment attempt once. The durable replacement
 * must then finish even if another cadence order wake-up arrives; otherwise a
 * steady order stream can keep resetting shipment progress forever.
 */
export function shouldYieldShipmentSyncToOrders(input: {
  ordersPending: boolean;
  priorDeferCount: number;
  recoveryRequested: boolean;
}): boolean {
  const priorDeferCount = Number.isFinite(input.priorDeferCount)
    ? Math.max(0, Math.trunc(input.priorDeferCount))
    : 0;
  return input.ordersPending && priorDeferCount === 0 && !input.recoveryRequested;
}

export function syncQueuePolicyForJob(name: string): SyncQueuePolicy {
  return name === SHIPSTATION_SYNC_JOBS.orders
    || name === SHIPSTATION_SYNC_JOBS.shipments
    || name === FULFILLMENT_OUTBOX_JOB_NAME
    ? 'stately'
    : 'standard';
}

function refreshSingletonKey(name: string): string {
  if (name === SHIPSTATION_SYNC_JOBS.orders) return ORDER_REFRESH_SINGLETON_KEY;
  if (name === SHIPSTATION_SYNC_JOBS.shipments) return SHIPMENT_REFRESH_SINGLETON_KEY;
  if (name === FULFILLMENT_OUTBOX_JOB_NAME) return FULFILLMENT_OUTBOX_SINGLETON_KEY;
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
    priority: intent.recoveryPriority ? STARVATION_RECOVERY_PRIORITY : 0,
  };
}
