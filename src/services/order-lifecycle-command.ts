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
import { resolveOrderLifecycleStatus } from './order-lifecycle-status.js';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OrderLifecycleTransition =
  | 'shipped'
  | 'external_shipped'
  | 'external_classified'
  | 'cancelled'
  | 'external_unmark';

export type OrderLifecycleFulfillmentFacts =
  | { kind: 'exact'; lines: unknown[] }
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
    if (exactLines.length > 0) return exactLines;
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

  if (input.shipmentId != null) {
    const [shipment] = await tx
      .select({
        id: shipments.id,
        orderId: shipments.orderId,
        voided: shipments.voided,
        isReturn: shipments.isReturn,
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

  const [event] = await tx
    .insert(orderLifecycleEvents)
    .values({
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      commandKey,
      transition,
      source,
      provenance: input.provenance ?? {},
      fulfilledLines,
      effectiveAt,
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
  const claimCount = createsDeduction ? fulfilledLines.length : 0;
  if (createsDeduction && fulfilledLines.length > 0) {
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
  }
  maybeFault('claims', input.faultAfter);

  if (input.packageConsumption) {
    if (input.packageConsumption.shipmentId !== input.shipmentId) {
      throw new Error('Package consumption shipment does not match lifecycle shipment');
    }
    await consumeOutboundPackageInTransaction(input.packageConsumption, tx);
  }

  // PS-497: the same three-part test as the claim status above. Review-only lines must never
  // enqueue inventory work.
  if (createsDeduction
    && fulfilledLines.some((line) => line.sku && !line.reviewReason && line.quantity !== null)) {
    await enqueueInventoryClaimDeduction({
      lifecycleEventId: event.id,
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      source,
    }, tx);
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
    await tx
      .insert(fulfillmentLineClaims)
      .values(appliedClaims.map((claim) => ({
        lifecycleEventId: event.id,
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        lineKey: claim.lineKey,
        sku: claim.sku,
        name: claim.name,
        quantity: claim.quantity,
        direction: 'reverse',
        originalClaimId: claim.id,
        inventoryId: claim.inventoryId,
        status: claim.inventoryId ? 'pending' : 'review',
        idempotencyKey: `${claim.idempotencyKey}:void`,
        updatedAt: now,
      })))
      .onConflictDoNothing({ target: fulfillmentLineClaims.idempotencyKey });
    await enqueueInventoryClaimDeduction({
      lifecycleEventId: event.id,
      orderId: input.orderId,
      shipmentId: input.shipmentId,
      source: `${input.source}:void`,
    }, tx);
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
