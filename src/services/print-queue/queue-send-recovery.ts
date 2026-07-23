import type { QueueSendOrderInput } from '../print-queue';
import type { QueueSendJobItemInput } from './queue-send-item-state';
import type { QueueSendSnapshotResult } from './queue-send-snapshot';

const TERMINAL_STATES = new Set([
  'queued',
  'preflight_blocked',
  'skipped_preflight',
  'failed_retryable',
  'failed_terminal',
]);

const PROVIDER_PENDING_STATES = new Set([
  'provider_pending',
  'provider_pending_recovery',
]);

export type QueueSendRecoveryPlan = {
  safeOrders: QueueSendOrderInput[];
  completedOrderIds: number[];
  providerPendingOrderIds: number[];
};

/**
 * Plan recovery from the durable per-order sidecars, which are newer and more
 * authoritative than the parent snapshot's result array after a hard worker
 * interruption. Unknown provider outcomes remain fenced while unrelated safe
 * orders can continue.
 */
export function planQueueSendRecovery(input: {
  workerOrders: QueueSendOrderInput[];
  itemStates?: QueueSendJobItemInput[];
  results?: QueueSendSnapshotResult[];
}): QueueSendRecoveryPlan {
  const latestStateByOrder = new Map<number, string>();
  for (const item of input.itemStates ?? []) {
    if (Number.isInteger(item.orderId) && item.orderId > 0) {
      latestStateByOrder.set(item.orderId, item.state);
    }
  }

  const completed = new Set<number>();
  const providerPending = new Set<number>();
  for (const [orderId, state] of latestStateByOrder) {
    if (TERMINAL_STATES.has(state)) completed.add(orderId);
    if (PROVIDER_PENDING_STATES.has(state)) providerPending.add(orderId);
  }

  // Backward compatibility for snapshots written before item sidecars existed.
  for (const result of input.results ?? []) {
    if (!latestStateByOrder.has(result.orderId)) completed.add(result.orderId);
  }

  return {
    safeOrders: input.workerOrders.filter(
      (order) => !completed.has(order.orderId) && !providerPending.has(order.orderId),
    ),
    completedOrderIds: [...completed],
    providerPendingOrderIds: [...providerPending],
  };
}
