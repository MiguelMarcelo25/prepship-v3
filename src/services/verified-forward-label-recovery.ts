import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { externalOperations } from '../db/schema/external-operations';
import { orders } from '../db/schema/orders';
import { ensureShipmentsSelectedRateCostColumn } from '../db/ensure-shipments-selected-rate-cost';
import type { ClientStoreScope } from '../lib/client-store-scope';
import { assertResourceInScope } from '../lib/scope-predicates';
import { consumeFulfillmentOperation } from './fulfillment-operation-ledger';
import { ensurePackageConsumptionSchema } from './package-consumption-schema';
import { applyOrderLifecycleCommandInTransaction } from './order-lifecycle-command';
import { resolveShippingClientId } from './shipping-client-identity';
import {
  baseConfirmationPayload,
  confirmationProviderForOrder,
  createdLabelFromOperationReceipt,
  marketplaceConfirmationPayload,
  persistCreatedLabel,
  // PS-493: destination country for the insurance tier — see the toCountry note below.
  orderShipToCountryFromRaw,
  type CreateLabelResponseDto,
} from './labels';
import {
  readShipStationForwardLabelPersistenceFacts,
  SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR,
} from './shipstation-forward-label-operation';
import {
  enqueueShipmentConfirmation,
  ensureFulfillmentSchema,
} from './fulfillment/outbox';

export type ResumeVerifiedShipStationForwardLabelInput = {
  operationId: number;
  orderId: number;
};

type RecoveryOrder = typeof orders.$inferSelect;
type RecoveryTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RecoveryConsumeResult = {
  kind: 'consumed' | 'already_consumed';
  localResult: Record<string, unknown> | null;
};

export type VerifiedForwardLabelRecoveryDependencies = {
  database?: typeof db;
  ensureFulfillment?: () => Promise<void>;
  ensurePackageConsumption?: () => Promise<void>;
  ensureShipmentRateCost?: () => Promise<void>;
  loadOrder?: (orderId: number) => Promise<RecoveryOrder | null>;
  resolveClientId?: typeof resolveShippingClientId;
  consumeOperation?: (
    operationId: number,
    apply: (tx: RecoveryTransaction, receipt: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<RecoveryConsumeResult>;
  persistLabel?: typeof persistCreatedLabel;
  applyLifecycle?: typeof applyOrderLifecycleCommandInTransaction;
  enqueueConfirmation?: typeof enqueueShipmentConfirmation;
};

/**
 * Consume a ShipStation forward-label receipt recorded by the purchase boundary
 * or the dedicated exact-ID reconciler in external_operations.
 *
 * This is a post-purchase recovery boundary, not a purchase path: it never
 * resolves a rate, authorizes an account, or invokes a carrier connector. The
 * durable receipt is the provider truth, while shipment persistence and the
 * shipped lifecycle transition remain atomic in their canonical owners.
 */
export async function resumeVerifiedShipStationForwardLabel(
  input: ResumeVerifiedShipStationForwardLabelInput,
  scope: ClientStoreScope,
  injected: VerifiedForwardLabelRecoveryDependencies = {},
): Promise<CreateLabelResponseDto> {
  if (Object.keys(injected).length > 0 && process.env.NODE_ENV !== 'test') {
    throw new Error('Verified forward-label recovery dependencies may only be injected in tests');
  }
  const database = injected.database ?? db;
  const ensureFulfillment = injected.ensureFulfillment ?? ensureFulfillmentSchema;
  const ensurePackageConsumption = injected.ensurePackageConsumption ?? ensurePackageConsumptionSchema;
  const ensureShipmentRateCost = injected.ensureShipmentRateCost ?? ensureShipmentsSelectedRateCostColumn;
  const loadOrder = injected.loadOrder ?? (async (orderId: number) => {
    const [order] = await database.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return order ?? null;
  });
  const resolveClientId = injected.resolveClientId ?? resolveShippingClientId;
  const consumeOperation = injected.consumeOperation ?? (
    (operationId, apply) => consumeFulfillmentOperation(operationId, apply)
  );
  const persistLabel = injected.persistLabel ?? persistCreatedLabel;
  const applyLifecycle = injected.applyLifecycle ?? applyOrderLifecycleCommandInTransaction;
  const enqueueConfirmation = injected.enqueueConfirmation ?? enqueueShipmentConfirmation;

  await ensureFulfillment();
  await ensurePackageConsumption();
  await ensureShipmentRateCost();

  const [operation] = await database
    .select({
      kind: externalOperations.kind,
      provider: externalOperations.provider,
      subjectType: externalOperations.subjectType,
      subjectId: externalOperations.subjectId,
      state: externalOperations.state,
      providerReceipt: externalOperations.providerReceipt,
      resolvedBy: externalOperations.resolvedBy,
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
    || !['receipt_recorded', 'consumed'].includes(operation.state)
    || !operation.providerReceipt
  ) throw new Error('Verified ShipStation forward-label receipt is not recoverable');

  const order = await loadOrder(input.orderId);
  if (!order) throw new Error('Order not found');
  const clientId = await resolveClientId(order);
  assertResourceInScope(scope, { clientId, storeId: order.storeId }, 'Order not found');

  const created = createdLabelFromOperationReceipt(operation.providerReceipt);
  if (created.voided || !created.labelUrl || !created.trackingNumber || created.shipmentId <= 0) {
    throw new Error('Verified ShipStation forward-label receipt is incomplete or voided');
  }
  if (
    operation.resolvedBy != null
    && operation.resolvedBy !== SHIPSTATION_FORWARD_LABEL_RECEIPT_SYSTEM_ACTOR
  ) {
    throw new Error('Operator-supplied ShipStation receipt requires manual local recovery');
  }
  readShipStationForwardLabelPersistenceFacts(
    operation.providerReceipt,
    { orderId: order.id, clientId },
  );

  // Per user override unlock shipped data on 2026-07-22: recovery consumes only
  // immutable, backend-authorized receipt facts. Queue payloads and generic
  // operator JSON cannot choose shipment/package/insurance truth; no provider
  // mutation is reachable and every local write remains in this transaction.
  const consumed = await consumeOperation(input.operationId, async (tx, receipt) => {
    const durableCreated = createdLabelFromOperationReceipt(receipt);
    const durableFacts = readShipStationForwardLabelPersistenceFacts(receipt, {
      orderId: order.id,
      clientId,
    });
    const shipmentId = await persistLabel({
      created: durableCreated,
      orderId: order.id,
      orderNumber: order.orderNumber ?? null,
      clientId,
      effectiveWeightOz: durableFacts.effectiveWeightOz,
      length: durableFacts.dimensions.length,
      width: durableFacts.dimensions.width,
      height: durableFacts.dimensions.height,
      selectedPackageId: durableFacts.selectedPackageId != null
        ? String(durableFacts.selectedPackageId)
        : null,
      source: 'prepship_v2',
      insuranceProvider: durableFacts.insuranceProvider,
      insuredValue: durableFacts.insuredValue,
      // PS-493: this recovery path can carry insuranceProvider 'parcelguard', so it is a
      // real premium-persistence site, not just a replay. The durable receipt facts hold
      // no destination, so the country comes from the order's retained provider payload —
      // null when absent, never an assumed 'US'.
      toCountry: orderShipToCountryFromRaw(order),
      tx,
    });
    await applyLifecycle(tx, {
      orderId: order.id,
      shipmentId,
      commandKey: `lifecycle:shipment:${shipmentId}:shipped`,
      transition: 'shipped',
      source: 'prepship_v2',
      requireAwaitingOrderStatus: true,
      requireNoActiveOutboundShipment: true,
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
        selectedPackageId: durableFacts.selectedPackageId,
        dimensions: durableFacts.dimensions,
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
    await enqueueConfirmation({
      order: {
        id: order.id,
        externalOrderId: order.externalOrderId,
        sourceProvider: order.sourceProvider,
        clientId,
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
