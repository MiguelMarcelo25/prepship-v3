import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { externalOperations } from '../db/schema/external-operations';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { ensureShipmentsSelectedRateCostColumn } from '../db/ensure-shipments-selected-rate-cost';
import type { ClientStoreScope } from '../lib/client-store-scope';
import { assertResourceInScope } from '../lib/scope-predicates';
import { normalizeShippingOptions } from '../lib/shipping-options';
import { consumeFulfillmentOperation } from './fulfillment-operation-ledger';
import { ensurePackageConsumptionSchema } from './package-consumption-schema';
import { applyOrderLifecycleCommandInTransaction } from './order-lifecycle-command';
import {
  baseConfirmationPayload,
  confirmationProviderForOrder,
  createdLabelFromOperationReceipt,
  marketplaceConfirmationPayload,
  persistCreatedLabel,
  resolveLabelPackageId,
  type CreateLabelResponseDto,
} from './labels';
import {
  enqueueShipmentConfirmation,
  ensureFulfillmentSchema,
} from './fulfillment/outbox';

export type ResumeVerifiedShipStationForwardLabelInput = {
  operationId: number;
  orderId: number;
  weightOz: number;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  customPackageId?: number | string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
};

/**
 * Consume a ShipStation forward-label receipt that an operator already verified
 * and recorded in external_operations.
 *
 * This is a post-purchase recovery boundary, not a purchase path: it never
 * resolves a rate, authorizes an account, or invokes a carrier connector. The
 * durable receipt is the provider truth, while shipment persistence and the
 * shipped lifecycle transition remain atomic in their canonical owners.
 */
export async function resumeVerifiedShipStationForwardLabel(
  input: ResumeVerifiedShipStationForwardLabelInput,
  scope: ClientStoreScope,
): Promise<CreateLabelResponseDto> {
  await ensureFulfillmentSchema();
  await ensurePackageConsumptionSchema();
  await ensureShipmentsSelectedRateCostColumn();

  const [operation] = await db
    .select({
      kind: externalOperations.kind,
      provider: externalOperations.provider,
      subjectType: externalOperations.subjectType,
      subjectId: externalOperations.subjectId,
      state: externalOperations.state,
      providerReceipt: externalOperations.providerReceipt,
    })
    .from(externalOperations)
    .where(eq(externalOperations.id, input.operationId))
    .limit(1);
  if (
    !operation
    || operation.kind !== 'forward_label'
    || operation.provider !== 'shipstation'
    || operation.subjectType !== 'order'
    || operation.subjectId !== String(input.orderId)
    || operation.state !== 'receipt_recorded'
    || !operation.providerReceipt
  ) throw new Error('Verified ShipStation forward-label receipt is not recoverable');

  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw new Error('Order not found');
  assertResourceInScope(scope, { clientId: order.clientId, storeId: order.storeId }, 'Order not found');
  if (order.orderStatus !== 'awaiting_shipment') {
    throw new Error(`Cannot recover a verified label onto ${order.orderStatus} order`);
  }
  const [activeLabel] = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), eq(shipments.voided, false), eq(shipments.isReturn, false)))
    .limit(1);
  if (activeLabel) throw new Error('An active local label already exists for this order');

  const created = createdLabelFromOperationReceipt(operation.providerReceipt);
  if (created.voided || !created.labelUrl || !created.trackingNumber || created.shipmentId <= 0) {
    throw new Error('Verified ShipStation forward-label receipt is incomplete or voided');
  }
  const effectiveWeightOz = Number(input.weightOz ?? 0);
  if (!Number.isFinite(effectiveWeightOz) || effectiveWeightOz <= 0) {
    throw new Error('Verified label recovery requires the purchased shipment weight');
  }
  const length = Number(input.length ?? 0) || null;
  const width = Number(input.width ?? 0) || null;
  const height = Number(input.height ?? 0) || null;
  const selectedPackageId = await resolveLabelPackageId({
    orderId: order.id,
    customPackageId: input.customPackageId,
    length,
    width,
    height,
  });
  const shippingOptions = normalizeShippingOptions({
    insuranceProvider: input.insuranceProvider,
    insuredValue: input.insuredValue,
  });

  // Per user override unlock shipped data on 2026-07-21: consume only an
  // operator-recorded receipt. No ShipStation POST/PUT or new postage path is
  // reachable here; shipment + lifecycle persistence stays one transaction.
  const consumed = await consumeFulfillmentOperation(input.operationId, async (tx, receipt) => {
    const durableCreated = createdLabelFromOperationReceipt(receipt);
    const shipmentId = await persistCreatedLabel({
      created: durableCreated,
      orderId: order.id,
      orderNumber: order.orderNumber ?? null,
      clientId: order.clientId ?? null,
      effectiveWeightOz,
      length,
      width,
      height,
      selectedPackageId: selectedPackageId != null ? String(selectedPackageId) : null,
      source: 'prepship_v2',
      insuranceProvider: shippingOptions.insuranceProvider,
      insuredValue: shippingOptions.insuredValue,
      tx,
    });
    await applyOrderLifecycleCommandInTransaction(tx, {
      orderId: order.id,
      shipmentId,
      commandKey: `lifecycle:shipment:${shipmentId}:shipped`,
      transition: 'shipped',
      source: 'prepship_v2',
      effectiveAt: new Date(durableCreated.shipDate),
      fulfillmentFacts: {
        kind: 'unavailable',
        description: 'Verified provider receipt did not identify shipped line quantities',
      },
      trackingNumber: durableCreated.trackingNumber,
      packageConsumption: {
        shipmentId,
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        source: 'prepship_v2',
        sourceAccountId: durableCreated.providerAccountId ?? null,
        providerShipmentId: durableCreated.shipmentId || null,
        effectiveAt: durableCreated.shipDate,
        selectedPackageId: selectedPackageId ?? input.customPackageId,
        dimensions: { length, width, height },
      },
    });
    return { shipmentId };
  });
  const shipmentId = Number(consumed.localResult?.shipmentId ?? 0);
  if (!shipmentId) throw new Error('Verified label recovery did not persist a local shipment');

  const confirmationProvider = confirmationProviderForOrder(order);
  const confirmationPayload = confirmationProvider
    ? marketplaceConfirmationPayload(order, created, confirmationProvider)
    : baseConfirmationPayload(created);
  try {
    await enqueueShipmentConfirmation({
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        sourceProvider: order.sourceProvider,
        clientId: order.clientId,
        orderNumber: order.orderNumber ?? null,
      },
      shipmentId,
      trackingNumber: created.trackingNumber,
      carrierCode: created.carrierCode,
      shipDate: created.shipDate,
      confirmationProvider,
      payload: confirmationPayload,
    });
  } catch (error) {
    console.warn(
      '[verified-forward-label-recovery] confirmation enqueue failed:',
      error instanceof Error ? error.message : error,
    );
  }
  return {
    shipmentId,
    trackingNumber: created.trackingNumber,
    labelUrl: created.labelUrl,
    cost: created.cost,
    voided: created.voided,
    orderStatus: 'shipped',
    apiVersion: 'v2',
  };
}
