// PS-279 (Steps 1–4): server-side owner of the Send-to-Queue routing decision.
//
// This PORTS the pure never-buy ladder out of web/src/lib/shipping-routes.ts
// (classifyQueueOrderRoute) into src/ so the backend — not the frontend — owns
// this MONEY-PATH decision (one rung buys real postage). It is a re-implementation:
// src/ must NOT import web/. The rung order is identical to the FE classifier so
// the DEFERRED FE cutover can delegate here with zero behavior change.
//
// PURE: no DB, no network, no provider calls, no postage. It decides a route only.
// The synthetic-direct floor is reused from the canonical owner (rate-fingerprint)
// rather than re-hardcoding 10_000_000.

import { DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR } from '../shipping-workflow/rate-fingerprint';

/** Which CLIENT flow the operator's Send-to-Queue action should run for an order. */
export type QueueOrderRoute = 'direct-create' | 'backend';

export type QueueOrderRouteInput = {
  /** The order already has a queueable (non-[object Object]) label URL. */
  hasQueueableLabel: boolean;
  /** Test-client order — must never buy real postage; backend forces a mock. */
  isTest: boolean;
  /** Selected/best rate resolves to a direct carrier_accounts synthetic id. */
  isDirectCarrier: boolean;
  /**
   * The backend's routing policy (bestRateWorkflow.queueRoute). Consulted ONLY
   * after the live never-buy ladder, so a stale list-time value can never cause
   * a re-buy — it only decides the residual direct-vs-backend question.
   */
  backendQueueRoute?: string | null;
  /**
   * The LIVE single-order panel payload's shippingProviderId, present only when
   * the caller carries an explicit override for this order. When present it — not
   * the stale saved DTO — decides the residual direct-vs-backend question.
   */
  explicitPayloadProviderId?: number | null;
};

export type QueueOrderRouteOptions = {
  /** Caller only wants existing labels queued — never create one. */
  existingLabelOnly?: boolean;
  /** Test run → backend mock, no real postage. */
  batchTestMode?: boolean;
};

/**
 * The pure Send-to-Queue route decision, server-side. Same rungs, same order as
 * the FE classifyQueueOrderRoute. Returns 'backend' (defer to the create/recover
 * job — never buy) for every never-buy rung; only the residual question can yield
 * 'direct-create' (the buy-then-queue client flow).
 */
export function classifyQueueOrderRouteServer(
  input: QueueOrderRouteInput,
  options: QueueOrderRouteOptions = {},
): QueueOrderRoute {
  // ── Never-buy ladder (each rung defers to the backend job) ──
  if (options.existingLabelOnly) return 'backend'; // caller only wants existing labels queued
  if (options.batchTestMode) return 'backend'; // test run → backend mock, no real postage
  if (input.isTest) return 'backend'; // test-client order → backend mock
  if (input.hasQueueableLabel) return 'backend'; // already bought → backend queues it as-is

  // ── Residual direct-vs-backend question (only reached for orders that
  //    genuinely still need a label) ──
  // An explicit live panel payload outranks the saved DTO policy here.
  if (input.explicitPayloadProviderId != null) {
    return input.explicitPayloadProviderId >= DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR
      ? 'direct-create'
      : 'backend';
  }
  // The backend owns the residual routing policy when it spoke.
  if (input.backendQueueRoute === 'backend' || input.backendQueueRoute === 'direct-create') {
    return input.backendQueueRoute;
  }
  // A direct-carrier order that still needs a label: buy via the direct client flow, then queue.
  if (input.isDirectCarrier) return 'direct-create';
  return 'backend'; // ShipStation provider → backend createLabelV2
}

/** One order's identity + the facts the route ladder needs to classify it. */
export type QueueRouteOrderInput = {
  orderId: number;
  route: QueueOrderRouteInput;
};

/** The computed route for a single order (the create/recover/queue plan unit). */
export type QueueRouteOrderPlan = {
  orderId: number;
  route: QueueOrderRoute;
};

/**
 * The server-side create/recover/queue entrypoint: classify a batch of orders
 * and split them into the orders the BACKEND create/recover job owns vs the
 * DIRECT-CREATE orders (the buy-then-queue client flow, until the deferred FE
 * cutover). PURE — it computes the plan only; it buys nothing and calls no
 * provider. Callers feed the backend orders into startQueueSendJob.
 */
export function planQueueRouteForOrders(
  orders: QueueRouteOrderInput[],
  options: QueueOrderRouteOptions = {},
): {
  plans: QueueRouteOrderPlan[];
  backendOrderIds: number[];
  directCreateOrderIds: number[];
} {
  const plans: QueueRouteOrderPlan[] = orders.map((order) => ({
    orderId: order.orderId,
    route: classifyQueueOrderRouteServer(order.route, options),
  }));
  return {
    plans,
    backendOrderIds: plans.filter((p) => p.route === 'backend').map((p) => p.orderId),
    directCreateOrderIds: plans.filter((p) => p.route === 'direct-create').map((p) => p.orderId),
  };
}
