// PS-128 + PS-129 — Canonical owner of the "is this order safe to ship right now?"
// decision. Every real postage/label/queue/print side effect MUST delegate here BEFORE
// acting, so a duplicate shipment (PS-128: marketplace already shipped) or an upstream
// cancellation (PS-129) cannot be silently shipped from PrepShip even when local sync,
// the webhook, or the frontend is stale/missing.
//
// Per user override unlock shipped data on 2026-06-09 (PS-128/PS-129): this guard READS
// shipped/cancelled signals and BLOCKS; it never mutates shipped/cancelled rows. The
// reconciliation that records upstream status is forward-only (awaiting -> cancelled/
// shipped) and lives in the webhook/reconcile layer, never here.
//
// Architecture: connectors translate provider payloads into normalized status events; the
// webhook route records them to the durable ledger; THIS service owns the final allow/block
// policy; routes/UI are thin consumers. The pure `decideShippingSafety` is unit-testable
// with no DB/network; `resolveShippingSafety`/`assertOrderSafeToShip` gather the live
// signals and apply it.

import { env } from '../../lib/env.js';
import { findUpstreamTerminalStatusForOrder } from './webhook-ledger.js';

export type ShippingSafetyPolicy = 'audit_only' | 'enforce';

export type ShippingSafetySignals = {
  /** Local PrepShip order_status. */
  orderStatus: string | null | undefined;
  /** Reconciled canonical status (orders.canonical_status), if maintained. */
  canonicalStatus?: string | null;
  /** orders.externally_shipped — a confirmed external/upstream shipment. */
  externallyShipped?: boolean | null;
  /** A trusted upstream "shipped" event exists in the webhook ledger for this order. */
  upstreamShippedEvent?: boolean;
  /** A trusted upstream "cancelled" event exists in the webhook ledger for this order. */
  upstreamCancelledEvent?: boolean;
  /** Source/marketplace provider (e.g. 'walmart', 'shipstation'). */
  sourceProvider?: string | null;
  /**
   * High-risk row whose source status we cannot positively verify (e.g. a Walmart-origin
   * order with no store linkage). Subject to the unverified policy below.
   */
  highRiskUnverifiedSource?: boolean;
  /** How to treat highRiskUnverifiedSource. Defaults to env policy. */
  unverifiedPolicy?: ShippingSafetyPolicy;
};

export type ShippingSafetyCode =
  | 'ok'
  | 'local_cancelled'
  | 'local_shipped'
  | 'upstream_cancelled_reconciled'
  | 'upstream_cancelled_event'
  | 'externally_shipped'
  | 'upstream_shipped_event'
  | 'unverified_high_risk_source';

export type ShippingSafetyDecision = {
  /** false => caller MUST NOT ship/label/queue. */
  safe: boolean;
  /** 'allow' = proceed; 'audit' = would-block but policy lets it proceed (logged); 'block' = hard stop. */
  severity: 'allow' | 'audit' | 'block';
  code: ShippingSafetyCode;
  reason: string;
  /** Operator-facing short status, e.g. for the Awaiting Shipment row. */
  operatorStatus?: string;
};

export class ShippingSafetyError extends Error {
  code: ShippingSafetyCode;
  decision: ShippingSafetyDecision;
  /** Marks this as a safe 4xx-style client error (operator-actionable), not a 500. */
  status = 409;
  constructor(decision: ShippingSafetyDecision) {
    super(decision.reason);
    this.name = 'ShippingSafetyError';
    this.code = decision.code;
    this.decision = decision;
  }
}

const ALLOW: ShippingSafetyDecision = {
  safe: true,
  severity: 'allow',
  code: 'ok',
  reason: 'Order is safe to ship.',
};

/**
 * PURE policy. No DB/network — deterministic and unit-testable. Priority order is
 * deliberate: definite local/upstream terminal signals hard-block first; the
 * high-risk-unverified case is last and governed by policy (default audit-only) so we
 * never false-block a legitimate awaiting order.
 */
export function decideShippingSafety(signals: ShippingSafetySignals): ShippingSafetyDecision {
  const policy: ShippingSafetyPolicy = signals.unverifiedPolicy ?? 'audit_only';

  // 1. Local cancelled (PS-129).
  if (signals.orderStatus === 'cancelled') {
    return {
      safe: false,
      severity: 'block',
      code: 'local_cancelled',
      reason: 'Order is cancelled — label blocked.',
      operatorStatus: 'Cancelled — label blocked',
    };
  }

  // 2. Local shipped (PS-128: already shipped locally — never buy a second label).
  if (signals.orderStatus === 'shipped') {
    return {
      safe: false,
      severity: 'block',
      code: 'local_shipped',
      reason: 'Order is already shipped — duplicate label blocked.',
      operatorStatus: 'Already shipped — label blocked',
    };
  }

  // 3. Reconciled upstream cancellation (PS-129).
  if (signals.canonicalStatus === 'cancelled') {
    return {
      safe: false,
      severity: 'block',
      code: 'upstream_cancelled_reconciled',
      reason: 'Order was cancelled upstream — label blocked. Sync/reconciliation required.',
      operatorStatus: 'Cancelled upstream — label blocked',
    };
  }

  // 4. Trusted upstream cancellation event in the ledger (PS-129).
  if (signals.upstreamCancelledEvent) {
    return {
      safe: false,
      severity: 'block',
      code: 'upstream_cancelled_event',
      reason: 'A cancellation event was received from the source store — label blocked.',
      operatorStatus: 'Cancelled upstream — do not ship',
    };
  }

  // 5. Confirmed external shipment (PS-128).
  if (signals.externallyShipped === true) {
    return {
      safe: false,
      severity: 'block',
      code: 'externally_shipped',
      reason: 'Order was already shipped externally/upstream — duplicate shipment blocked.',
      operatorStatus: 'Already shipped in store — sync required',
    };
  }

  // 6. Trusted upstream shipped event in the ledger (PS-128).
  if (signals.upstreamShippedEvent) {
    return {
      safe: false,
      severity: 'block',
      code: 'upstream_shipped_event',
      reason: 'A shipped event was received from the source marketplace — duplicate shipment blocked.',
      operatorStatus: 'Already shipped in store — do not ship',
    };
  }

  // 7. High-risk but unverifiable source (PS-128 fail-closed). Default audit-only so it
  //    never blocks a legitimate awaiting order; operators opt into hard enforcement.
  if (signals.highRiskUnverifiedSource) {
    if (policy === 'enforce') {
      return {
        safe: false,
        severity: 'block',
        code: 'unverified_high_risk_source',
        reason:
          'Source shipment status could not be verified for this high-risk order — label blocked (re-check/reconcile required).',
        operatorStatus: 'Source unverified — recheck before shipping',
      };
    }
    return {
      safe: true,
      severity: 'audit',
      code: 'unverified_high_risk_source',
      reason:
        'Source shipment status could not be verified for this high-risk order (audit-only: label allowed).',
      operatorStatus: 'Source unverified',
    };
  }

  return ALLOW;
}

export type ShippingSafetyOrderInput = {
  id: number;
  orderStatus?: string | null;
  canonicalStatus?: string | null;
  externallyShipped?: boolean | null;
  sourceProvider?: string | null;
  sourceAccountId?: string | null;
  sourceOrderId?: string | null;
  sourceOrderNumber?: string | null;
  orderNumber?: string | null;
  externalOrderId?: string | null;
  storeId?: number | null;
};

function isHighRiskUnverifiedSource(order: ShippingSafetyOrderInput): boolean {
  // A Walmart-origin order with no confirmable store linkage is the PS-128 sample class
  // (orderStatus awaiting, shipments [], store_orders []). We cannot positively confirm
  // it is NOT already shipped in Walmart. Treat as high-risk (governed by policy).
  const provider = String(order.sourceProvider ?? '').toLowerCase();
  const looksWalmart =
    provider.includes('walmart') ||
    String(order.externalOrderId ?? '').toLowerCase().includes('walmart');
  return looksWalmart && order.storeId == null;
}

/**
 * Gather live signals (incl. the durable webhook ledger) and decide. Ledger lookups are
 * best-effort: a missing ledger NEVER weakens the definite local/order-column checks.
 */
export async function resolveShippingSafety(
  order: ShippingSafetyOrderInput,
  options: { unverifiedPolicy?: ShippingSafetyPolicy } = {},
): Promise<ShippingSafetyDecision> {
  let upstreamShippedEvent = false;
  let upstreamCancelledEvent = false;
  try {
    const upstream = await findUpstreamTerminalStatusForOrder(order);
    upstreamShippedEvent = upstream.shipped;
    upstreamCancelledEvent = upstream.cancelled;
  } catch (err) {
    // Ledger unavailable (e.g. not migrated yet) — fall back to order-column signals only.
    console.warn(
      '[shipping-safety] upstream ledger lookup failed (using order-column signals only):',
      err instanceof Error ? err.message : err,
    );
  }

  return decideShippingSafety({
    orderStatus: order.orderStatus,
    canonicalStatus: order.canonicalStatus,
    externallyShipped: order.externallyShipped,
    upstreamShippedEvent,
    upstreamCancelledEvent,
    sourceProvider: order.sourceProvider,
    highRiskUnverifiedSource: isHighRiskUnverifiedSource(order),
    unverifiedPolicy: options.unverifiedPolicy ?? env.SHIPPING_SAFETY_UNVERIFIED_POLICY,
  });
}

/**
 * The single assertion every label/queue/print path calls BEFORE any side effect. Throws
 * ShippingSafetyError (409, operator-actionable) on a hard block. An audit-only would-block
 * is logged and allowed so we never false-block a legitimate awaiting order.
 */
export async function assertOrderSafeToShip(
  order: ShippingSafetyOrderInput,
  context: { entryPoint: string; unverifiedPolicy?: ShippingSafetyPolicy } = { entryPoint: 'unknown' },
): Promise<ShippingSafetyDecision> {
  const decision = await resolveShippingSafety(order, { unverifiedPolicy: context.unverifiedPolicy });
  if (decision.severity === 'block') {
    throw new ShippingSafetyError(decision);
  }
  if (decision.severity === 'audit') {
    console.warn('[shipping-safety] would-block (audit-only)', {
      orderId: order.id,
      entryPoint: context.entryPoint,
      code: decision.code,
      reason: decision.reason,
    });
  }
  return decision;
}
