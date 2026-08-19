/**
 * PS-502 — recover CUSTOMER money for an already-paid replacement label.
 *
 * A provider receipt can commit while the pricing-policy read fails. The purchase owner keeps
 * that real receipt and parks the replacement in review; this command is the deliberately
 * separate, provider-free recovery path. It never buys, retries, looks up, voids, ships, bills,
 * or clears review. It only freezes the exact customer-money tuple and records who asked why.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementLabelPurchaseIntents,
  replacements,
} from '../db/schema/replacements';
import {
  freezeReplacementCustomerShippingMoney,
  readFrozenReplacementCustomerShippingMoney,
  type FrozenReplacementCustomerShippingMoney,
} from './customer-shipping-money';
import {
  assertReplacementLabelEnabled,
  REPLACEMENT_LABEL_PERMISSION,
} from './replacement-label-purchase-command';
import {
  fingerprintPurchaseRequest,
  type ResolvedPurchaseRequest,
} from './replacement-purchase-request';
import { isReplacementProviderCredentialAuthority } from './replacement-provider-credential-authority';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;
const MONEY_REVIEW_REASON = 'replacement_customer_money_unavailable';

type Conn = Pick<typeof db, 'transaction'>;

export type ReconcileReplacementLabelPricingInput = {
  replacementId: number;
  intentId: number;
  actor: { email: string | null; type: string; permissions: readonly string[] };
  reason: string;
};

export type ReconcileReplacementLabelPricingResult = {
  replacementId: number;
  intentId: number;
  shipmentId: number;
  frozenCustomerShippingMoney: FrozenReplacementCustomerShippingMoney;
  /** False means this exact audited reconciliation was replayed. */
  reconciled: boolean;
};

export type ReplacementLabelPricingReconcileErrorCode =
  | 'REPLACEMENT_LABEL_PRICING_FORBIDDEN'
  | 'REPLACEMENT_LABEL_PRICING_ACTOR_REQUIRED'
  | 'REPLACEMENT_LABEL_PRICING_REASON_REQUIRED'
  | 'REPLACEMENT_LABEL_PRICING_NOT_FOUND'
  | 'REPLACEMENT_LABEL_PRICING_NOT_ELIGIBLE'
  | 'REPLACEMENT_LABEL_PRICING_RECEIPT_INVALID'
  | 'REPLACEMENT_LABEL_PRICING_ALREADY_FROZEN'
  | 'REPLACEMENT_LABEL_PRICING_UNAVAILABLE';

export class ReplacementLabelPricingReconcileError extends Error {
  constructor(
    readonly code: ReplacementLabelPricingReconcileErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = 'ReplacementLabelPricingReconcileError';
  }
}

function requiredReason(reason: string | null | undefined): string {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized) {
    throw new ReplacementLabelPricingReconcileError(
      'REPLACEMENT_LABEL_PRICING_REASON_REQUIRED',
      'reconciling replacement customer money requires a written reason',
      400,
    );
  }
  return normalized;
}

function requiredActorEmail(email: string | null | undefined): string {
  const normalized = typeof email === 'string' ? email.trim() : '';
  if (!normalized) {
    throw new ReplacementLabelPricingReconcileError(
      'REPLACEMENT_LABEL_PRICING_ACTOR_REQUIRED',
      'reconciling replacement customer money requires a named actor',
      400,
    );
  }
  return normalized;
}

function positiveProviderShipmentId(value: string | null): number | null {
  const normalized = value?.trim() ?? '';
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function frozenRequestMatchesShipment(input: {
  resolvedRequest: unknown;
  requestFingerprint: string;
  replacementId: number;
  shipmentId: number;
  replacementReference: string;
  carrierCode: string | null;
  serviceCode: string | null;
  providerAccountId: number | null;
  selectedPackageId: string | null;
  weightOz: number | null;
  dimsL: number | null;
  dimsW: number | null;
  dimsH: number | null;
}): boolean {
  if (!input.resolvedRequest || typeof input.resolvedRequest !== 'object') return false;
  const request = input.resolvedRequest as ResolvedPurchaseRequest;
  if (
    request.replacementId !== input.replacementId
    || request.replacementShipmentId !== input.shipmentId
    || request.replacementReference !== input.replacementReference
    || request.fingerprint !== input.requestFingerprint
    || !isReplacementProviderCredentialAuthority(request.providerCredentialAuthority)
    || request.carrier.carrierCode !== input.carrierCode
    || request.carrier.serviceCode !== input.serviceCode
    || request.carrier.providerAccountId !== input.providerAccountId
    || request.package.packageId !== input.selectedPackageId
    || Math.fround(request.package.weightOz) !== Math.fround(input.weightOz ?? Number.NaN)
    || Math.fround(request.package.dimsL) !== Math.fround(input.dimsL ?? Number.NaN)
    || Math.fround(request.package.dimsW) !== Math.fround(input.dimsW ?? Number.NaN)
    || Math.fround(request.package.dimsH) !== Math.fround(input.dimsH ?? Number.NaN)
  ) return false;
  try {
    return fingerprintPurchaseRequest(request) === request.fingerprint;
  } catch {
    return false;
  }
}

/**
 * Freeze one missing customer-money tuple for one exact purchased intent.
 *
 * Replays are recognized by the append-only event and return the already-frozen tuple. A tuple
 * that exists without that event is not claimed as this command's work: it is an inconsistent
 * or separately-authorized state and fails closed.
 */
export async function reconcileReplacementLabelPricing(
  input: ReconcileReplacementLabelPricingInput,
  conn: Conn = db,
): Promise<ReconcileReplacementLabelPricingResult> {
  assertReplacementLabelEnabled();
  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementLabelPricingReconcileError(
      'REPLACEMENT_LABEL_PRICING_FORBIDDEN',
      `reconciling replacement customer money requires ${REPLACEMENT_LABEL_PERMISSION}`,
      403,
    );
  }
  const reason = requiredReason(input.reason);
  const actorEmail = requiredActorEmail(input.actor.email);
  const eventKey = `replacement:${input.replacementId}:pricing-reconcile:${input.intentId}`;

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId))
      .limit(1);
    const [intent] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.id, input.intentId),
        eq(replacementLabelPurchaseIntents.replacementId, input.replacementId),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1)
      .for('update');
    if (!replacement || !intent || intent.replacementShipmentId == null) {
      throw new ReplacementLabelPricingReconcileError(
        'REPLACEMENT_LABEL_PRICING_NOT_FOUND',
        'the addressed purchased replacement-label intent was not found',
        404,
      );
    }

    const [shipment] = await tx.select().from(shipments)
      .where(eq(shipments.id, intent.replacementShipmentId))
      .limit(1)
      .for('update');
    const providerShipmentId = positiveProviderShipmentId(intent.providerShipmentId);
    const ownsActiveReceipt = shipment != null
      && replacement.replacementShipmentId === intent.replacementShipmentId
      && shipment.orderId === null
      && shipment.clientId === replacement.clientId
      && shipment.orderNumber === replacement.reference
      && shipment.source === 'replacement'
      && shipment.voided === false
      && intent.voidState == null
      && Boolean(intent.providerTransactionId?.trim())
      && providerShipmentId != null
      && shipment.labelShipmentId === providerShipmentId
      && shipment.labelCreatedAt != null
      && replacement.labelCreatedAt != null
      && shipment.cost != null
      && shipment.otherCost != null
      && Number.isFinite(Number(shipment.cost))
      && Number.isFinite(Number(shipment.otherCost))
      && frozenRequestMatchesShipment({
        resolvedRequest: intent.resolvedRequest,
        requestFingerprint: intent.requestFingerprint,
        replacementId: replacement.id,
        shipmentId: shipment.id,
        replacementReference: replacement.reference,
        carrierCode: shipment.carrierCode,
        serviceCode: shipment.serviceCode,
        providerAccountId: shipment.providerAccountId,
        selectedPackageId: shipment.selectedPackageId,
        weightOz: shipment.weightOz,
        dimsL: shipment.dimsL,
        dimsW: shipment.dimsW,
        dimsH: shipment.dimsH,
      });
    if (!ownsActiveReceipt) {
      throw new ReplacementLabelPricingReconcileError(
        'REPLACEMENT_LABEL_PRICING_RECEIPT_INVALID',
        'the purchased intent does not own one complete, active replacement shipment receipt',
      );
    }

    const existing = readFrozenReplacementCustomerShippingMoney(shipment.selectedRateJson);
    const [audit] = await tx.select({ id: replacementActivityEvents.id })
      .from(replacementActivityEvents)
      .where(eq(replacementActivityEvents.idempotencyKey, eventKey))
      .limit(1);
    if (audit) {
      if (!existing) {
        throw new ReplacementLabelPricingReconcileError(
          'REPLACEMENT_LABEL_PRICING_UNAVAILABLE',
          'the pricing-reconciliation audit exists without its frozen customer-money tuple',
        );
      }
      return {
        replacementId: replacement.id,
        intentId: intent.id,
        shipmentId: shipment.id,
        frozenCustomerShippingMoney: existing,
        reconciled: false,
      };
    }
    if (existing) {
      throw new ReplacementLabelPricingReconcileError(
        'REPLACEMENT_LABEL_PRICING_ALREADY_FROZEN',
        'customer money was already frozen by another authority; this command will not relabel it',
      );
    }
    if (replacement.status !== 'review' || replacement.reviewReason !== MONEY_REVIEW_REASON) {
      throw new ReplacementLabelPricingReconcileError(
        'REPLACEMENT_LABEL_PRICING_NOT_ELIGIBLE',
        'only the paid-label customer-money review may use pricing reconciliation',
      );
    }

    let frozen: FrozenReplacementCustomerShippingMoney;
    try {
      frozen = await freezeReplacementCustomerShippingMoney(shipment.id, tx);
    } catch {
      throw new ReplacementLabelPricingReconcileError(
        'REPLACEMENT_LABEL_PRICING_UNAVAILABLE',
        'the active customer-shipping pricing authority is still unavailable; review remains open',
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement.id,
      shipmentId: shipment.id,
      eventType: 'replacement_customer_money_reconciled',
      fromStatus: replacement.status,
      toStatus: replacement.status,
      actorType: input.actor.type,
      actorEmail,
      detail: reason,
      idempotencyKey: eventKey,
    });

    return {
      replacementId: replacement.id,
      intentId: intent.id,
      shipmentId: shipment.id,
      frozenCustomerShippingMoney: frozen,
      reconciled: true,
    };
  });
}
