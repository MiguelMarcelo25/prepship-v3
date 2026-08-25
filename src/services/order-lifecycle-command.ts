/**
 * PS-424 canonical backend owner for terminal order lifecycle commands.
 *
 * Per user override unlock shipped data on 2026-07-16: terminal order state,
 * provenance, exact fulfillment claims, package consumption/reversal, and the
 * durable inventory intent are committed together. Callers only normalize
 * provider facts and delegate here; no shipped/cancelled protection is removed.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  fulfillmentLineClaims,
  orderLifecycleEvents,
  type FulfilledLineQuantityReviewReason,
  type FulfilledLineSnapshot,
  type QuantityEvidence,
} from '../db/schema/order-lifecycle.js';
import { orderOverrides, orders } from '../db/schema/orders.js';
import { shipments } from '../db/schema/shipments.js';
import {
  consumeOutboundPackageInTransaction,
  reverseOutboundPackageConsumptionInTransaction,
  type OutboundPackageConsumptionInput,
} from './package-consumption.js';
import {
  activeOutboundShipmentPredicate,
  decideShipmentVoidLifecycle,
  type ShipmentVoidLifecycleDecision,
} from './shipment-aggregate.js';
import { enqueueInventoryClaimDeduction } from './fulfillment/inventory-deduction-outbox.js';
import { raiseReplacementOriginalOrderHoldsInTransaction } from './replacement-original-order-hold';
import { replacementSchemaPresent } from './replacement-schema-readiness';
import { resolveOrderLifecycleStatus } from './order-lifecycle-status.js';
// Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4) occurrence cutover. All of the
// following is gated behind env.FULFILLMENT_OCCURRENCE_PROJECTION (default OFF), so with the flag off this
// owner behaves byte-identically to Release A (occurrence_id stays NULL, the legacy status/idempotency/enqueue
// path runs). No shipped/cancelled protection is removed; supply GATES deductibility, it does not annotate.
import { env } from '../lib/env.js';
import { resolveFulfillmentOccurrence } from './fulfillment/resolve-fulfillment-occurrence.js';
import { resolveOccurrenceSupply, decideClaimDisposition, type LineEvidence } from './fulfillment/line-supply-policy.js';
import { readOccurrenceExecutionScope } from './fulfillment/occurrence-execution-scope.js';
import { enqueueOccurrenceDeduction } from './fulfillment/occurrence-deduction-outbox.js';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OrderLifecycleTransition =
  | 'shipped'
  | 'external_shipped'
  | 'external_classified'
  | 'cancelled'
  | 'external_unmark';

export type OrderLifecycleFulfillmentFacts =
  // PS-497 Release B (S2.4): `evidence` distinguishes per-shipment exact lines from a whole-order fallback
  // (the fallback additionally requires the owner to prove sole-outbound before deducting). Absent => the
  // Release A default 'exact_shipment'. `soleOutbound` is a caller corroboration only; the owner re-derives
  // it authoritatively inside the transaction.
  | { kind: 'exact'; lines: unknown[]; evidence?: 'exact_shipment' | 'whole_order_fallback'; soleOutbound?: boolean }
  | { kind: 'unavailable'; description: string }
  | { kind: 'none' };

export type OrderLifecycleCommandInput = {
  orderId: number;
  shipmentId?: number | null;
  commandKey: string;
  transition: OrderLifecycleTransition;
  source: string;
  effectiveAt?: Date;
  fulfillmentFacts: OrderLifecycleFulfillmentFacts;
  provenance?: Record<string, unknown>;
  trackingNumber?: string | null;
  externallyShippedSource?: string | null;
  canonicalStatus?: string | null;
  allowCanonicalOverride?: boolean;
  requireAwaitingOrderStatus?: boolean;
  requireNoActiveOutboundShipment?: boolean;
  suppressExternalWhenActiveShipment?: boolean;
  packageConsumption?: OutboundPackageConsumptionInput | null;
  /** Test-only crash seam proving the transaction cannot partially commit. */
  faultAfter?: 'event' | 'state' | 'claims';
};

export type OrderLifecycleCommandResult = {
  lifecycleEventId: number;
  alreadyApplied: boolean;
  statusChanged: boolean;
  claimCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Strip control characters before anything provider-supplied is persisted. */
const stripControl = (value: string): string => value.replace(/[\x00-\x1F\x7F]/g, '');

const NUMERIC_TOKEN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const MAX_EVIDENCE_TOKEN = 64;

/**
 * PS-497: describe an unusable quantity safely enough to persist forever.
 *
 * Numbers and numeric-looking strings are the diagnostically valuable cases and cannot carry
 * PII, so they are kept verbatim. Everything else is reduced: arbitrary strings are hashed so
 * repeat occurrences can be correlated without storing content, and objects and arrays keep
 * only a type marker — a provider object could contain anything.
 */
function describeQuantity(value: unknown): QuantityEvidence {
  if (value === null || value === undefined) {
    return { inputType: 'missing', token: null, redacted: false };
  }
  if (typeof value === 'boolean') {
    return { inputType: 'boolean', token: value ? 'true' : 'false', redacted: false };
  }
  if (typeof value === 'number') {
    // Covers NaN and ±Infinity too: String() renders them exactly, and they are safe.
    return { inputType: 'number', token: String(value).slice(0, MAX_EVIDENCE_TOKEN), redacted: false };
  }
  if (typeof value === 'string') {
    const trimmed = stripControl(value).trim();
    const numericLike = NUMERIC_TOKEN.test(trimmed)
      || trimmed === 'NaN' || trimmed === 'Infinity' || trimmed === '-Infinity';
    if (trimmed === '' || numericLike) {
      return {
        inputType: 'string',
        token: trimmed.slice(0, MAX_EVIDENCE_TOKEN),
        redacted: false,
        originalLength: value.length,
      };
    }
    return {
      inputType: 'string',
      token: '[redacted_non_numeric_string]',
      redacted: true,
      originalLength: value.length,
      sha256: createHash('sha256').update(value).digest('hex'),
    };
  }
  return {
    inputType: Array.isArray(value) ? 'array' : 'object',
    token: null,
    redacted: true,
  };
}

type FulfillmentQuantityResult =
  | { quantity: number; reviewReason?: never; quantityEvidence?: never }
  | {
      quantity: null;
      reviewReason: FulfilledLineQuantityReviewReason;
      quantityEvidence: QuantityEvidence;
    };

/**
 * PS-497: a claim may carry a deduction quantity ONLY when this owner proved a positive
 * integer. Unknown, zero and invalid values are never converted into one.
 *
 * The previous rule returned `{ quantity: 1 }` for every unusable input. That fabricated a
 * number nobody measured and persisted it on a claim row — inert only for as long as nothing
 * drains review claims. It also collapsed three different provider conditions into one.
 *
 * Two rules worth stating because they are easy to "simplify" back into bugs:
 *
 *   ZERO IS NOT INVALID. A zero-quantity line plausibly means the provider shipped nothing on
 *   it, which is a different fact from an unparseable value, and it gets its own reason. It is
 *   deliberately NOT skipped: dropping the line would erase a provider fact and could hide a
 *   provider defect. Promoting `zero_quantity` to "record, no claim" needs authoritative
 *   ShipStation semantics, not an inference from one occurrence.
 *
 *   ONLY NUMBERS AND STRINGS ARE PARSED. `Number()` on other types has surprising results —
 *   `Number(['1'])` is 1, `Number(true)` is 1, `Number([])` is 0 — so an array or object would
 *   otherwise coerce into a real deduction quantity. Anything else is invalid by type.
 */
function fulfillmentQuantity(value: unknown): FulfillmentQuantityResult {
  const unusable = (reviewReason: FulfilledLineQuantityReviewReason): FulfillmentQuantityResult => ({
    quantity: null,
    reviewReason,
    quantityEvidence: describeQuantity(value),
  });

  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return unusable('missing_quantity');
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return unusable('invalid_quantity');
  }

  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) return unusable('invalid_quantity');
  // `Object.is` because `-0 === 0` is true but they are distinguishable, and either way
  // nothing shipped.
  if (parsed === 0 || Object.is(parsed, -0)) return unusable('zero_quantity');
  if (parsed < 0 || !Number.isInteger(parsed)) return unusable('invalid_quantity');

  return { quantity: parsed };
}

/** Normalize at the provider/import boundary; the immutable result is persisted. */
export function normalizeFulfilledLines(items: unknown[] | null | undefined): FulfilledLineSnapshot[] {
  const usedKeys = new Map<string, number>();
  const lines: FulfilledLineSnapshot[] = [];
  for (let index = 0; index < (items ?? []).length; index += 1) {
    const item = record(items?.[index]);
    if (!item || item.adjustment === true) continue;
    const sku = text(item.sku ?? item.SKU);
    const baseKey = text(
      item.lineKey ??
      item.fulfillmentLineId ??
      item.shipmentItemId ??
      item.orderItemId ??
      item.lineItemId ??
      item.id,
    ) ?? `${sku ?? 'no-sku'}:${index + 1}`;
    const occurrence = (usedKeys.get(baseKey) ?? 0) + 1;
    usedKeys.set(baseKey, occurrence);
    // Presence-aware, NOT `item.quantity ?? item.qty`. That form cannot tell an ABSENT
    // `quantity` from an explicit `quantity: null`, so an explicitly malformed quantity would
    // silently fall through to a different field and be reported as a clean deduction.
    const rawQuantity = Object.prototype.hasOwnProperty.call(item, 'quantity')
      ? item.quantity
      : Object.prototype.hasOwnProperty.call(item, 'qty')
        ? item.qty
        : undefined;
    const normalizedQuantity = fulfillmentQuantity(rawQuantity);
    const lineKey = occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`;
    const name = text(item.name ?? item.title);
    // Every provider line stays in the snapshot. A line is never dropped for a bad quantity:
    // dropping it would erase the provider fact and hide a provider defect.
    lines.push(
      normalizedQuantity.quantity === null
        ? {
            lineKey,
            sku,
            name,
            quantity: null,
            reviewReason: normalizedQuantity.reviewReason,
            quantityEvidence: normalizedQuantity.quantityEvidence,
          }
        : { lineKey, sku, name, quantity: normalizedQuantity.quantity },
    );
  }
  return lines;
}

/**
 * PS-497: a shipment carrying a line with no SKU is not EXACT fulfillment truth.
 *
 * A deduction needs two facts — which product, and how many. A line without a SKU supplies
 * only the second. Previously such a line was still accepted as part of an `exact` fact set:
 * its siblings deducted and it alone went to review, which is a PARTIAL deduction. The order
 * then reads as fulfilled while some of its stock was never moved, and the shortfall is
 * visible only to whoever reads the claim queue.
 *
 * So identity failure condemns the whole set, matching `loadWholeOrderShipmentLines`, which
 * already refuses wholesale rather than "deducting some lines and quietly reviewing others".
 *
 * Every line is RETAINED, never dropped — including the product name, which is the only
 * remaining clue to what shipped. Deliberately NOT done here, per review:
 *   - no name matching. Resolving a SKU by product name guesses at inventory identity, and a
 *     wrong guess deducts the wrong product's stock — worse than not deducting.
 *   - no restored deduction. These stay in review until the identity gap is fixed upstream.
 *
 * All 9 production occurrences are single-line, wholly SKU-less shipments — 8 from the one
 * store whose provider returns sku, upc and fulfillmentSku all null — so no order currently
 * loses a working deduction to this. A MIXED shipment would, and that is the intended
 * fail-closed direction: an unidentifiable shipment should stop, not half-deduct.
 */
function refuseUnidentifiedShipment(lines: FulfilledLineSnapshot[]): FulfilledLineSnapshot[] {
  if (lines.every((line) => line.sku)) return lines;
  return lines.map((line) => (
    line.reviewReason
      // A line already quarantined for its quantity keeps that reason and its evidence: it
      // does not deduct either way, and the quantity evidence is the more specific fact.
      ? line
      : {
          lineKey: line.lineKey,
          sku: line.sku,
          name: line.name,
          quantity: line.quantity,
          reviewReason: 'fulfillment_line_missing_sku' as const,
        }
  ));
}

/** Exported for boundary tests: this is where the unavailable-line shape is decided. */
export function normalizeFulfillmentFacts(
  facts: OrderLifecycleFulfillmentFacts | null | undefined,
  transition: OrderLifecycleTransition,
): FulfilledLineSnapshot[] {
  const createsDeduction = transition === 'shipped' || transition === 'external_shipped';
  if (!facts) {
    throw new Error('Order lifecycle fulfillmentFacts are required');
  }
  if (!createsDeduction) {
    if (facts.kind !== 'none') {
      throw new Error(`Order lifecycle ${transition} must not carry fulfillment lines`);
    }
    return [];
  }
  if (facts.kind === 'none') {
    throw new Error(`Order lifecycle ${transition} requires exact or unavailable fulfillment facts`);
  }
  if (facts.kind === 'exact') {
    const exactLines = normalizeFulfilledLines(facts.lines);
    if (exactLines.length > 0) return refuseUnidentifiedShipment(exactLines);
  }
  const description = facts.kind === 'unavailable'
    ? text(facts.description)
    : null;
  return [{
    lineKey: 'review:fulfillment-lines-unavailable',
    sku: null,
    name: description ?? 'Exact shipment fulfillment-line quantities were unavailable',
    // PS-497: null, not 1. Nothing was measured here either — the old fabricated 1 is what
    // 2,950 production review claims carry today.
    quantity: null,
    reviewReason: 'fulfillment_lines_unavailable',
  }];
}

function assertFaultAllowed(faultAfter: OrderLifecycleCommandInput['faultAfter']): void {
  if (faultAfter && process.env.NODE_ENV !== 'test') {
    throw new Error('Order lifecycle fault injection is test-only');
  }
}

function maybeFault(
  expected: NonNullable<OrderLifecycleCommandInput['faultAfter']>,
  actual: OrderLifecycleCommandInput['faultAfter'],
): void {
  if (actual === expected) throw new Error(`PS-424 injected fault after ${expected}`);
}

export async function applyOrderLifecycleCommandInTransaction(
  tx: DbTransaction,
  input: OrderLifecycleCommandInput,
): Promise<OrderLifecycleCommandResult> {
  assertFaultAllowed(input.faultAfter);
  const commandKey = input.commandKey.trim();
  if (!commandKey) throw new Error('Order lifecycle commandKey is required');
  const source = input.source.trim();
  if (!source) throw new Error('Order lifecycle source is required');
  const effectiveAt = input.effectiveAt ?? new Date();

  const [order] = await tx
    .select({
      id: orders.id,
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      // PS-497 Release B (S2.4): the occurrence execution scope is an approved client/store/order allowlist.
      clientId: orders.clientId,
      storeId: orders.storeId,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for('update')
    .limit(1);
  if (!order) throw new Error(`Order ${input.orderId} not found`);
  // Per user override unlock shipped data on 2026-07-16: PS-424 never turns
  // mutable order.items into shipment truth. Every shipped caller must provide
  // exact shipment lines or persist a review-only unavailable-facts receipt.
  const fulfilledLines = normalizeFulfillmentFacts(input.fulfillmentFacts, input.transition);

  if (input.requireNoActiveOutboundShipment) {
    // Per user override unlock shipped data on 2026-07-22: label persistence
    // checks for a competing active shipment while excluding the shipment that
    // the same transaction just inserted; a conflict throws and rolls it back.
    const [activeShipment] = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(
        activeOutboundShipmentPredicate({ orderId: input.orderId }),
        input.shipmentId == null ? undefined : ne(shipments.id, input.shipmentId),
      ))
      .limit(1);
    if (activeShipment) {
      throw new Error(`Order ${input.orderId} has an active outbound shipment`);
    }
  }

  let transition = input.transition;
  if (transition === 'external_shipped' && input.suppressExternalWhenActiveShipment) {
    const [activeShipment] = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(activeOutboundShipmentPredicate({ orderId: input.orderId }))
      .limit(1);
    if (activeShipment) transition = 'shipped';
  }

  const currentLifecycle = resolveOrderLifecycleStatus(order);

  const [existing] = await tx
    .select({
      id: orderLifecycleEvents.id,
      orderId: orderLifecycleEvents.orderId,
      transition: orderLifecycleEvents.transition,
    })
    .from(orderLifecycleEvents)
    .where(eq(orderLifecycleEvents.commandKey, commandKey))
    .limit(1);
  if (existing) {
    if (existing.orderId !== input.orderId) {
      throw new Error(
        `Order lifecycle commandKey already belongs to order ${existing.orderId}`,
      );
    }
    if (existing.transition !== transition) {
      throw new Error(
        `Order lifecycle commandKey already represents ${existing.transition}`,
      );
    }
    const claims = await tx
      .select({ id: fulfillmentLineClaims.id })
      .from(fulfillmentLineClaims)
      .where(eq(fulfillmentLineClaims.lifecycleEventId, existing.id));
    return {
      lifecycleEventId: existing.id,
      alreadyApplied: true,
      statusChanged: false,
      claimCount: claims.length,
    };
  }

  // PS-497 Release B (S2.4): the locked shipment facts the occurrence resolver reads provider identity from
  // (labelShipmentId + source). Populated under the same FOR UPDATE; NULL for shipment-less transitions.
  let lockedShipment: { id: number; labelShipmentId: number | null; source: string | null } | null = null;
  if (input.shipmentId != null) {
    const [shipment] = await tx
      .select({
        id: shipments.id,
        orderId: shipments.orderId,
        voided: shipments.voided,
        isReturn: shipments.isReturn,
        labelShipmentId: shipments.labelShipmentId,
        source: shipments.source,
      })
      .from(shipments)
      .where(eq(shipments.id, input.shipmentId))
      .for('update')
      .limit(1);
    if (!shipment || shipment.orderId !== input.orderId) {
      throw new Error(`Shipment ${input.shipmentId} does not belong to order ${input.orderId}`);
    }
    if (
      (transition === 'shipped' || transition === 'external_shipped') &&
      (shipment.voided || shipment.isReturn)
    ) {
      throw new Error(`Shipment ${input.shipmentId} is not an active outbound shipment`);
    }
    lockedShipment = { id: shipment.id, labelShipmentId: shipment.labelShipmentId, source: shipment.source };
  }

  if (
    input.requireAwaitingOrderStatus &&
    order.orderStatus !== 'awaiting_shipment' &&
    !input.allowCanonicalOverride
  ) {
    throw new Error(`Order ${input.orderId} is no longer awaiting shipment`);
  }

  if (
    (transition === 'shipped' || transition === 'external_shipped') &&
    order.orderStatus === 'cancelled'
  ) {
    throw new Error(`Order ${input.orderId} is cancelled and cannot transition to shipped`);
  }
  if (transition === 'cancelled' && order.orderStatus === 'shipped') {
    throw new Error(`Order ${input.orderId} is shipped and cannot transition to cancelled`);
  }
  if (
    order.orderStatus === 'awaiting_shipment' &&
    currentLifecycle.isShippingBlocked &&
    !input.allowCanonicalOverride
  ) {
    throw new Error(
      `Order ${input.orderId} is ${currentLifecycle.orderLifecycleStatus} and cannot transition`,
    );
  }
  if (
    transition === 'external_unmark' &&
    (order.orderStatus !== 'awaiting_shipment' || currentLifecycle.isShippingBlocked) &&
    !input.allowCanonicalOverride
  ) {
    throw new Error(`Order ${input.orderId} is terminal and cannot clear external fulfillment`);
  }

  // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4). After BOTH FOR UPDATE locks
  // (order + shipment), resolve the canonical physical occurrence and derive the occurrence supply + line
  // evidence. Gated by PROJECTION (default OFF) — with the flag off, occurrenceId stays NULL and the legacy
  // path below runs unchanged. Provider identity is read ONLY from the locked shipment (never provenance).
  const isShippedTransition = transition === 'shipped' || transition === 'external_shipped';
  const projectionOn = env.FULFILLMENT_OCCURRENCE_PROJECTION && isShippedTransition;
  let resolvedOccurrence: Awaited<ReturnType<typeof resolveFulfillmentOccurrence>> | null = null;
  let occurrenceSupply: 'prepship' | 'external' | 'unknown' | null = null;
  let lineEvidence: LineEvidence = 'unavailable';
  let soleOutbound = false;
  if (projectionOn) {
    resolvedOccurrence = await resolveFulfillmentOccurrence(tx, {
      orderId: input.orderId,
      transition: transition as 'shipped' | 'external_shipped',
      source,
      effectiveAt,
      lockedShipment,
      external: transition === 'external_shipped',
    });
    occurrenceSupply = resolveOccurrenceSupply({
      discriminatorKind: resolvedOccurrence.discriminatorKind,
      external: transition === 'external_shipped',
    });
    lineEvidence = input.fulfillmentFacts.kind === 'exact'
      ? (input.fulfillmentFacts.evidence ?? 'exact_shipment')
      : 'unavailable';
    // Hermes #8: sole-outbound is established IN this transaction (after the locks) — the caller's
    // soleOutbound only corroborates. Only the whole-order-fallback case consults it.
    if (lineEvidence === 'whole_order_fallback' && input.shipmentId != null) {
      const active = await tx
        .select({ id: shipments.id })
        .from(shipments)
        .where(activeOutboundShipmentPredicate({ orderId: input.orderId }))
        .limit(2);
      soleOutbound = active.length === 1 && Number(active[0]?.id) === input.shipmentId;
    }
  }

  const [event] = await tx
    .insert(orderLifecycleEvents)
    .values({
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      commandKey,
      transition,
      source,
      // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.6 correction, Hermes #3).
      // Persist the AUTHORITATIVE line-evidence fact on this append-only (immutable) event so the operator
      // review-resolver can read the true evidence (exact_shipment vs whole_order_fallback) instead of
      // inferring it from the occurrence discriminator — the occurrence identity does NOT prove the supplied
      // quantities were exact shipment-scoped lines. Written only when projecting; flags-off is unchanged.
      provenance: projectionOn
        ? { ...(input.provenance ?? {}), ps497LineEvidence: lineEvidence }
        : (input.provenance ?? {}),
      fulfilledLines,
      effectiveAt,
      occurrenceId: resolvedOccurrence?.occurrenceId ?? null,
    })
    .returning({ id: orderLifecycleEvents.id });
  if (!event) throw new Error('Failed to persist order lifecycle event');
  maybeFault('event', input.faultAfter);

  const statusChanged =
    transition === 'shipped' || transition === 'external_shipped'
      ? order.orderStatus !== 'shipped' ||
        (transition === 'external_shipped' && order.externallyShipped !== true)
      : transition === 'cancelled'
        ? order.orderStatus !== 'cancelled'
        : transition === 'external_classified'
          ? order.externallyShipped !== true
          : order.externallyShipped === true;
  if (transition === 'shipped' || transition === 'external_shipped') {
    await tx
      .update(orders)
      .set({
        orderStatus: 'shipped',
        externallyShipped: transition === 'external_shipped' ? true : order.externallyShipped,
        ...(input.canonicalStatus !== undefined ? { canonicalStatus: input.canonicalStatus } : {}),
        updatedAt: effectiveAt,
      })
      .where(eq(orders.id, input.orderId));
  } else if (transition === 'cancelled') {
    await tx
      .update(orders)
      .set({
        orderStatus: 'cancelled',
        canonicalStatus: input.canonicalStatus ?? 'cancelled',
        updatedAt: effectiveAt,
      })
      .where(eq(orders.id, input.orderId));

    // PS-502 AC-16. In the SAME transaction, so "the original was cancelled" and "its
    // replacements were held" commit or roll back together — a cancellation that left its
    // replacements untouched would be a lie the audit log could not detect.
    //
    // Today this can only fire for an order that was awaiting, and an awaiting order cannot
    // have a replacement (creation requires `shipped`). It is here anyway because the rule is
    // "every writer of order_status=cancelled fans out", and a rule that holds only where it
    // is currently reachable is a rule that breaks the day the reachability changes. The
    // producer that actually fires today is the upstream-cancellation sweep, which raises
    // holds WITHOUT cancelling the order row.
    // Skipped entirely when the replacement schema is absent. Cancelling an order must not
    // require a feature's tables to exist: this is a pre-existing path and 0096-0101 are
    // gated behind the operator lane, so code reaches production first BY DESIGN. A database
    // with no replacements table has no replacements to hold.
    if (await replacementSchemaPresent(tx)) {
      await raiseReplacementOriginalOrderHoldsInTransaction(tx, {
        orderId: input.orderId,
        triggerKind: 'order_cancelled',
        evidence: { kind: 'order_lifecycle_event', orderLifecycleEventId: event.id },
        reason: `original order cancelled via ${source}`,
      // A system actor: this fan-out is a consequence of the cancellation, not an operator
      // action, and it performs nothing that needs a permission an operator would hold.
        actor: { type: 'system', email: null, permissions: [] },
      });
    }
  } else if (transition === 'external_classified') {
    await tx
      .update(orders)
      .set({ externallyShipped: true, updatedAt: effectiveAt })
      .where(eq(orders.id, input.orderId));
  } else {
    await tx
      .update(orders)
      .set({ externallyShipped: false, updatedAt: effectiveAt })
      .where(eq(orders.id, input.orderId));
  }

  const overridePatch: Record<string, unknown> = { updatedAt: effectiveAt };
  if (input.trackingNumber) overridePatch.trackingNumber = input.trackingNumber;
  if (
    (
      transition === 'external_shipped' ||
      transition === 'external_classified' ||
      transition === 'external_unmark'
    ) &&
    input.externallyShippedSource !== undefined
  ) {
    overridePatch.externallyShippedSource = input.externallyShippedSource;
  }
  if (Object.keys(overridePatch).length > 1) {
    await tx
      .insert(orderOverrides)
      .values({
        orderId: input.orderId,
        trackingNumber: input.trackingNumber ?? undefined,
        externallyShippedSource: input.externallyShippedSource ?? undefined,
        updatedAt: effectiveAt,
      })
      .onConflictDoUpdate({ target: orderOverrides.orderId, set: overridePatch });
  }
  maybeFault('state', input.faultAfter);

  const createsDeduction = transition === 'shipped' || transition === 'external_shipped';
  let claimCount = 0;
  let occurrenceEnqueueEligible = false;
  if (createsDeduction && fulfilledLines.length > 0) {
    if (projectionOn && resolvedOccurrence) {
      // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4). Supply GATES
      // deductibility per line (external -> not_applicable, unknown -> review, prepship -> pending only with
      // a trustworthy line). occurrence_id + canonical_line_identity are stamped and the idempotency key is
      // occurrence-scoped (the lifecycle-event id is no longer authoritative). The TARGETLESS
      // onConflictDoNothing + .returning() collapse the two converging writers to one claim set and give the
      // true inserted count.
      const supply = occurrenceSupply ?? 'unknown';
      const occId = resolvedOccurrence.occurrenceId;
      const inserted = await tx
        .insert(fulfillmentLineClaims)
        .values(fulfilledLines.map((line) => {
          const disposition = decideClaimDisposition({
            supply,
            evidence: lineEvidence,
            hasCanonicalSku: !!line.sku && !line.reviewReason,
            quantity: line.quantity,
            soleOutbound,
          });
          return {
            lifecycleEventId: event.id,
            orderId: input.orderId,
            shipmentId: input.shipmentId ?? null,
            lineKey: line.lineKey,
            sku: line.sku,
            name: line.name,
            quantity: line.quantity,
            direction: 'deduct' as const,
            status: disposition.status,
            supply: disposition.supply,
            occurrenceId: occId,
            canonicalLineIdentity: line.lineKey,
            lastError: disposition.status === 'not_applicable'
              ? 'external_not_applicable'
              : (line.reviewReason ?? (line.sku ? null : 'missing_sku')),
            idempotencyKey: `inventory:deduct:occ:${occId}:line:${line.lineKey}`,
            updatedAt: effectiveAt,
          };
        }))
        .onConflictDoNothing()
        .returning({
          id: fulfillmentLineClaims.id,
          status: fulfillmentLineClaims.status,
          supply: fulfillmentLineClaims.supply,
        });
      claimCount = inserted.length;
      // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4 correction, Hermes #4).
      // Enqueue authority is derived EXCLUSIVELY from the rows this owner actually inserted (the
      // onConflictDoNothing() winners), NEVER from the candidate boolean. A zero-winner retry — where a
      // competing writer already owns every claim — inserts nothing, so `inserted` is empty and no occurrence
      // intent is minted here (the winning writer already minted it).
      occurrenceEnqueueEligible = inserted.some(
        (row) => row.status === 'pending' && row.supply === 'prepship',
      );
    } else {
      // Legacy path (PROJECTION off): byte-identical to Release A.
      await tx.insert(fulfillmentLineClaims).values(
        fulfilledLines.map((line) => ({
          lifecycleEventId: event.id,
          orderId: input.orderId,
          shipmentId: input.shipmentId ?? null,
          lineKey: line.lineKey,
          sku: line.sku,
          name: line.name,
          quantity: line.quantity,
          direction: 'deduct',
          // PS-497: `quantity !== null` is part of the predicate, not an implication of it. A
          // claim only becomes deductable work when this owner PROVED a positive integer, so a
          // future snapshot variant cannot make a null-quantity line pending by omitting a
          // reviewReason. The database constraint added in 0090 enforces the same rule.
          status: line.sku && !line.reviewReason && line.quantity !== null ? 'pending' : 'review',
          lastError: line.reviewReason ?? (line.sku ? null : 'missing_sku'),
          idempotencyKey: `inventory:deduct:lifecycle:${event.id}:line:${line.lineKey}`,
          updatedAt: effectiveAt,
        })),
      );
      claimCount = fulfilledLines.length;
    }
  }
  maybeFault('claims', input.faultAfter);

  if (input.packageConsumption) {
    if (input.packageConsumption.shipmentId !== input.shipmentId) {
      throw new Error('Package consumption shipment does not match lifecycle shipment');
    }
    await consumeOutboundPackageInTransaction(input.packageConsumption, tx);
  }

  if (createsDeduction) {
    if (projectionOn && resolvedOccurrence) {
      // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4). Mint ONE occurrence
      // intent ONLY when a just-inserted claim is deductible (supply=prepship + pending) AND the occurrence
      // is within the execution scope (the enqueuer proves the scope/floor half; disposition proved the
      // per-line half — Hermes #4). Review / not_applicable mint nothing.
      if (occurrenceEnqueueEligible) {
        await enqueueOccurrenceDeduction({
          occurrenceId: resolvedOccurrence.occurrenceId,
          orderId: input.orderId,
          shipmentId: input.shipmentId ?? null,
          clientId: order.clientId ?? null,
          storeId: order.storeId ?? null,
          source,
        }, readOccurrenceExecutionScope(), tx);
      }
    } else if (fulfilledLines.some((line) => line.sku && !line.reviewReason && line.quantity !== null)) {
      // Legacy enqueue (PROJECTION off): byte-identical to Release A. Review-only lines never enqueue.
      await enqueueInventoryClaimDeduction({
        lifecycleEventId: event.id,
        orderId: input.orderId,
        shipmentId: input.shipmentId ?? null,
        source,
      }, tx);
    }
  }

  return {
    lifecycleEventId: event.id,
    alreadyApplied: false,
    statusChanged,
    claimCount,
  };
}

export function applyOrderLifecycleCommand(
  input: OrderLifecycleCommandInput,
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<OrderLifecycleCommandResult> {
  return conn.transaction((tx) => applyOrderLifecycleCommandInTransaction(tx, input));
}

export type VoidOrderShipmentLifecycleInput = {
  orderId: number;
  shipmentId: number;
  source: string;
  effectiveAt?: Date;
  reversePackage?: boolean;
};

export type VoidOrderShipmentLifecycleResult = {
  lifecycleEventId: number;
  alreadyApplied: boolean;
  decision: ShipmentVoidLifecycleDecision;
  reversalClaimCount: number;
};

export async function voidOrderShipmentLifecycleInTransaction(
  tx: DbTransaction,
  input: VoidOrderShipmentLifecycleInput,
): Promise<VoidOrderShipmentLifecycleResult> {
  const now = input.effectiveAt ?? new Date();
  const commandKey = `lifecycle:void:shipment:${input.shipmentId}`;
  const [order] = await tx
    .select({
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      // PS-497 Release B (S2.4): occurrence execution scope for the reverse (void) enqueue.
      clientId: orders.clientId,
      storeId: orders.storeId,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for('update')
    .limit(1);
  if (!order) throw new Error(`Order ${input.orderId} not found`);

  const [voidedShipment] = await tx
    .update(shipments)
    .set({ voided: true, updatedAt: now })
    .where(and(eq(shipments.id, input.shipmentId), eq(shipments.orderId, input.orderId)))
    .returning({ id: shipments.id });
  if (!voidedShipment) {
    throw new Error(`Shipment ${input.shipmentId} does not belong to order ${input.orderId}`);
  }

  const [remaining] = await tx
    .select({ id: shipments.id })
    .from(shipments)
    .where(activeOutboundShipmentPredicate({
      orderId: input.orderId,
      excludeShipmentId: input.shipmentId,
    }))
    .limit(1);
  const decision = decideShipmentVoidLifecycle({
    remainingActiveOutboundShipmentCount: remaining ? 1 : 0,
    orderStatus: order.orderStatus,
    canonicalStatus: order.canonicalStatus,
    externallyShipped: order.externallyShipped,
  });

  let [event] = await tx
    .select({ id: orderLifecycleEvents.id })
    .from(orderLifecycleEvents)
    .where(eq(orderLifecycleEvents.commandKey, commandKey))
    .limit(1);
  const alreadyApplied = !!event;
  if (!event) {
    [event] = await tx
      .insert(orderLifecycleEvents)
      .values({
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        commandKey,
        transition: 'void',
        source: input.source,
        provenance: {},
        fulfilledLines: [],
        effectiveAt: now,
      })
      .returning({ id: orderLifecycleEvents.id });
  }
  if (!event) throw new Error('Failed to persist void lifecycle event');

  if (decision.kind === 'reopen') {
    await tx
      .update(orders)
      .set({ orderStatus: decision.nextOrderStatus, updatedAt: now })
      .where(eq(orders.id, input.orderId));
  }

  const originalClaims = await tx
    .select()
    .from(fulfillmentLineClaims)
    .where(and(
      eq(fulfillmentLineClaims.shipmentId, input.shipmentId),
      eq(fulfillmentLineClaims.orderId, input.orderId),
      eq(fulfillmentLineClaims.direction, 'deduct'),
      inArray(fulfillmentLineClaims.status, ['pending', 'applied', 'review']),
    ));
  const unsettledIds = originalClaims
    .filter((claim) => claim.status !== 'applied')
    .map((claim) => claim.id);
  if (unsettledIds.length > 0) {
    await tx
      .update(fulfillmentLineClaims)
      .set({ status: 'superseded', updatedAt: now })
      .where(inArray(fulfillmentLineClaims.id, unsettledIds));
  }

  const appliedClaims = originalClaims.filter((claim) => claim.status === 'applied');
  if (appliedClaims.length > 0) {
    // Per user override unlock shipped data on 2026-08-25: PS-497 Release B (S2.4). The reverse claim INHERITS
    // the original applied claim's occurrence/canonical-identity/supply lineage — it never re-derives an
    // occurrence from the (possibly provider-enriched) shipment (Hermes #7). A Release-B claim (occurrence_id
    // present) recuts its reverse idempotency to the occurrence form; a legacy claim keeps the ':void' key.
    await tx
      .insert(fulfillmentLineClaims)
      .values(appliedClaims.map((claim) => {
        const occScoped = claim.occurrenceId != null && claim.canonicalLineIdentity != null;
        return {
          lifecycleEventId: event.id,
          orderId: input.orderId,
          shipmentId: input.shipmentId,
          lineKey: claim.lineKey,
          sku: claim.sku,
          name: claim.name,
          quantity: claim.quantity,
          direction: 'reverse' as const,
          originalClaimId: claim.id,
          inventoryId: claim.inventoryId,
          occurrenceId: claim.occurrenceId,
          canonicalLineIdentity: claim.canonicalLineIdentity,
          supply: claim.supply,
          status: claim.inventoryId ? 'pending' : 'review',
          idempotencyKey: occScoped
            ? `inventory:reverse:occ:${claim.occurrenceId}:line:${claim.canonicalLineIdentity}`
            : `${claim.idempotencyKey}:void`,
          updatedAt: now,
        };
      }))
      .onConflictDoNothing({ target: fulfillmentLineClaims.idempotencyKey });

    // Occurrence-bearing reverses go to the dedicated occurrence lane (reverse-discriminated so a prior
    // forward event on the same occurrence does not dedup this away); legacy claims keep the legacy lane.
    const occurrenceIds = Array.from(new Set(
      appliedClaims.filter((c) => c.occurrenceId != null).map((c) => c.occurrenceId as number),
    ));
    if (occurrenceIds.length > 0) {
      const scope = readOccurrenceExecutionScope();
      for (const occurrenceId of occurrenceIds) {
        await enqueueOccurrenceDeduction({
          occurrenceId,
          orderId: input.orderId,
          shipmentId: input.shipmentId,
          clientId: order.clientId ?? null,
          storeId: order.storeId ?? null,
          source: `${input.source}:void`,
          dedupeDiscriminator: `reverse:${event.id}`,
        }, scope, tx);
      }
    }
    if (appliedClaims.some((c) => c.occurrenceId == null)) {
      await enqueueInventoryClaimDeduction({
        lifecycleEventId: event.id,
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        source: `${input.source}:void`,
      }, tx);
    }
  }

  if (input.reversePackage !== false) {
    await reverseOutboundPackageConsumptionInTransaction(input.shipmentId, now, tx);
  }

  return {
    lifecycleEventId: event.id,
    alreadyApplied,
    decision,
    reversalClaimCount: appliedClaims.length,
  };
}
