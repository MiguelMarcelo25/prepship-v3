export const ORDER_SYNC_COOPERATIVE_YIELD_CODE = 'ORDER_SYNC_COOPERATIVE_YIELD';

/**
 * Queue-control signal for a durable order-sync deferral.
 *
 * This is not a provider, credential, or persistence failure. The queue owner
 * has already preserved the original payload in a retry before treating the
 * attempt as successfully deferred.
 */
export class OrderSyncCooperativeYieldError extends Error {
  readonly code = ORDER_SYNC_COOPERATIVE_YIELD_CODE;

  constructor(message: string = 'Order sync yielded to pending fulfillment outbox') {
    super(message);
    this.name = 'OrderSyncCooperativeYieldError';
  }
}

export function isOrderSyncCooperativeYieldError(
  error: unknown,
): error is OrderSyncCooperativeYieldError {
  return error instanceof OrderSyncCooperativeYieldError;
}
