import { env } from '../../lib/env';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { shipments } from '../../db/schema/shipments';
import { normalizeScopeIds } from '../../lib/scope-sql';
import { loadClientCredentials } from '../../lib/shipstation/credentials';
import {
  extractShipstationLabelUrl,
  ssGetLabelByExternalShipmentId,
} from '../../lib/shipstation/labels';
import type { ClientStoreScope } from '../../lib/client-store-scope';
import {
  getLatestLabelOperationForOrder,
  recordFulfillmentOperationReceiptByOperator,
  resolveFulfillmentOperationNoEffect,
} from '../fulfillment-operation-ledger';
import type { ExternalOperation } from '../../db/schema/external-operations';
import { nextLabelSemanticGeneration } from '../labels';
import { resumeVerifiedShipStationForwardLabel } from '../verified-forward-label-recovery';
import {
  assertLabelPurchaseRateSelection,
} from '../shipping-workflow/rate-quote-snapshot-store';
import {
  assertShippingQuoteAccountMatches,
  shippingQuoteCredentialFingerprint,
  type ShippingQuoteAccountAuthorization,
} from '../shipping-workflow/shipping-quote-authorization';
import type { PrintQueueListScope, QueueSendOrderInput } from '../print-queue';

const NO_EFFECT_GRACE_MS = 5 * 60_000;

export type QueueShipStationReconciliationResult =
  | { status: 'not_applicable' | 'active' | 'held' }
  | { status: 'recovered'; labelUrl: string; trackingNumber: string }
  | { status: 'resume_receipt' }
  | { status: 'no_effect' };

function clientStoreScope(scope: PrintQueueListScope): ClientStoreScope {
  const isGlobal = scope.scopeRestricted === false;
  return {
    clientIds: normalizeScopeIds(scope.scopeClientIds),
    storeIds: normalizeScopeIds(scope.scopeStoreIds),
    isGlobal,
    isRestricted: !isGlobal,
  };
}

function currentAccountAuthorization(input: {
  shippingProviderId: number;
  clientId: number;
  sourceClientId: number | null;
  credential: string;
}): ShippingQuoteAccountAuthorization {
  return {
    providerFamily: 'shipstation',
    provider: 'shipstation',
    shippingProviderId: input.shippingProviderId,
    sourceTable: 'shipstation',
    sourceAccountId: input.shippingProviderId,
    ownerClientId: input.sourceClientId,
    ownerStoreAccountId: null,
    credentialSource: input.sourceClientId == null
      ? 'application_default'
      : input.sourceClientId === input.clientId
        ? 'client'
        : 'rate_source_client',
    credentialFingerprint: shippingQuoteCredentialFingerprint(input.credential),
    environment: process.env.NODE_ENV ?? 'development',
  };
}

/** Resolve the exact local shipment committed with a consumed operation. */
export function consumedQueueLabelShipmentId(
  operation: Pick<ExternalOperation, 'state' | 'providerReceipt' | 'localResult'>,
): number | null {
  if (operation.state !== 'consumed') return null;
  const localShipmentId = Number(operation.localResult?.shipmentId ?? 0);
  return Number.isInteger(localShipmentId) && localShipmentId > 0 ? localShipmentId : null;
}

export function isQueueLabelSafeNoEffect(
  operation: Pick<ExternalOperation, 'state'>,
): boolean {
  return operation.state === 'failed_pre_dispatch';
}

export function isHistoricalConsumedQueueLabelOperation(
  operation: Pick<ExternalOperation, 'state' | 'semanticGeneration'>,
  nextSemanticGeneration: number,
  exactShipmentDisposition: 'voided' | 'active_unqueueable' | 'missing_or_inconsistent',
): boolean {
  return operation.state === 'consumed'
    && exactShipmentDisposition === 'voided'
    && operation.semanticGeneration < nextSemanticGeneration;
}

type ConsumedQueueLabelInspection =
  | { status: 'recovered'; labelUrl: string; trackingNumber: string }
  | { status: 'voided' | 'held' };

async function recoverConsumedQueueLabelOperation(
  orderId: number,
  operation: Pick<ExternalOperation, 'state' | 'providerReceipt' | 'localResult'>,
): Promise<ConsumedQueueLabelInspection> {
  const localShipmentId = consumedQueueLabelShipmentId(operation);
  if (!localShipmentId) return { status: 'held' };
  const [shipment] = await db
    .select({
      orderId: shipments.orderId,
      voided: shipments.voided,
      isReturn: shipments.isReturn,
      labelUrl: shipments.labelUrl,
      trackingNumber: shipments.trackingNumber,
    })
    .from(shipments)
    .where(eq(shipments.id, localShipmentId))
    .limit(1);
  if (!shipment || shipment.orderId !== orderId || shipment.isReturn) {
    return { status: 'held' };
  }
  if (shipment.voided) return { status: 'voided' };
  const labelUrl = extractShipstationLabelUrl(shipment?.labelUrl);
  const trackingNumber = String(shipment?.trackingNumber ?? '').trim();
  if (!labelUrl || !trackingNumber) return { status: 'held' };
  return { status: 'recovered', labelUrl, trackingNumber };
}

/**
 * Reconcile one queue-held ShipStation purchase by its exact provider identity.
 * This function never sends a label-purchase request. A provider read failure,
 * credential drift, nonterminal response, or incomplete artifact remains held.
 */
export async function reconcileQueueShipStationOperation(
  order: QueueSendOrderInput,
  scope: PrintQueueListScope,
): Promise<QueueShipStationReconciliationResult> {
  const operation = await getLatestLabelOperationForOrder(order.orderId);
  // No ledger row means the crash happened before canonical dispatch
  // acquisition, so no provider mutation was possible and a bounded retry is
  // safe. failed_pre_dispatch is the ledger's equivalent no-effect proof.
  if (!operation) return { status: 'no_effect' };
  if (isQueueLabelSafeNoEffect(operation)) return { status: 'no_effect' };

  const label = order.label as {
    selectionRef?: string | null;
    shippingProviderId?: number | null;
    weightOz?: number;
    length?: number | null;
    width?: number | null;
    height?: number | null;
    customPackageId?: number | string | null;
    insuranceProvider?: string | null;
    insuredValue?: number | null;
  } | undefined;

  if (operation.state === 'consumed') {
    // Per user override unlock shipped data on 2026-07-21: a consumed operation
    // proves the local shipment transaction already committed. Rehydrate every
    // provider's queue sidecar from that exact canonical shipment row; never
    // issue a provider request or interpret provider-specific receipt shapes.
    const consumedShipment = await recoverConsumedQueueLabelOperation(order.orderId, operation);
    if (consumedShipment.status === 'recovered') return consumedShipment;
    if (consumedShipment.status !== 'voided') return { status: 'held' };
    // Per user override unlock shipped data on 2026-07-21: a consumed receipt
    // whose exact shipment is no longer active can only be treated as
    // historical when the canonical outbound-shipment count has advanced its
    // semantic generation. This closes the voided-label/no-new-ledger crash gap
    // without re-admitting any same-generation unknown provider outcome.
    const nextSemanticGeneration = await nextLabelSemanticGeneration(order.orderId);
    return isHistoricalConsumedQueueLabelOperation(operation, nextSemanticGeneration, 'voided')
      ? { status: 'no_effect' }
      : { status: 'held' };
  }
  if (operation.state === 'receipt_recorded') {
    if (operation.provider !== 'shipstation' || operation.kind !== 'forward_label') {
      // The canonical label service will reacquire the same semantic generation
      // and receive resume_receipt from the ledger. This only re-admits local
      // consumption; dispatch cannot run while this receipt remains durable.
      return { status: 'resume_receipt' };
    }
    if (!label) return { status: 'held' };
    // Per user override unlock shipped data on 2026-07-21: consume the already
    // durable receipt through the existing atomic shipment/lifecycle owner.
    // This path performs no provider POST and cannot buy duplicate postage.
    const recovered = await resumeVerifiedShipStationForwardLabel({
      operationId: operation.id,
      orderId: order.orderId,
      weightOz: Number(label.weightOz ?? 0),
      length: label.length,
      width: label.width,
      height: label.height,
      customPackageId: label.customPackageId,
      insuranceProvider: label.insuranceProvider,
      insuredValue: label.insuredValue,
    }, clientStoreScope(scope));
    if (!recovered.labelUrl || !recovered.trackingNumber) {
      throw new Error('Recovered ShipStation receipt is missing its label artifact');
    }
    return {
      status: 'recovered',
      labelUrl: recovered.labelUrl,
      trackingNumber: recovered.trackingNumber,
    };
  }
  if (operation.provider !== 'shipstation' || operation.kind !== 'forward_label') {
    return { status: 'not_applicable' };
  }
  if (operation.state === 'in_flight') return { status: 'active' };
  if (operation.state !== 'reconcile_required') return { status: 'held' };
  if (!label?.selectionRef || !label.shippingProviderId) return { status: 'held' };

  const selection = await assertLabelPurchaseRateSelection({
    selectionRef: label.selectionRef,
    purchaseShippingProviderId: label.shippingProviderId,
  });
  if (
    selection.authorizationContext.order.orderId !== order.orderId
    || selection.authorizationContext.order.clientId !== order.clientId
  ) return { status: 'held' };

  const credentials = await loadClientCredentials(order.clientId);
  const credential = credentials.apiKeyV2 ?? env.SHIPSTATION_API_KEY_V2 ?? null;
  if (!credential) return { status: 'held' };
  assertShippingQuoteAccountMatches({
    authorized: selection.accountAuthorization,
    current: currentAccountAuthorization({
      shippingProviderId: label.shippingProviderId,
      clientId: order.clientId,
      sourceClientId: credentials.sourceClientId,
      credential,
    }),
  });

  const lookup = await ssGetLabelByExternalShipmentId(operation.idempotencyKey, {
    apiKeyV2: credential,
    timeoutMs: 10_000,
  });
  if (!lookup) {
    const acknowledgedAt = operation.cancellationAcknowledgedAt?.getTime() ?? 0;
    const referenceAt = Math.max(
      operation.updatedAt?.getTime() ?? 0,
      operation.dispatchedAt?.getTime() ?? 0,
    );
    if (!acknowledgedAt || Date.now() - referenceAt < NO_EFFECT_GRACE_MS) {
      return { status: 'held' };
    }
    await resolveFulfillmentOperationNoEffect(operation.id, {
      actor: 'system:print-queue-reconciler',
      note: 'Exact ShipStation external_shipment_id lookup returned 404 after cancellation acknowledgement and consistency grace.',
    });
    return { status: 'no_effect' };
  }

  const providerStatus = String(lookup.status ?? '').toLowerCase();
  const created = lookup.label;
  if (
    (providerStatus && providerStatus !== 'completed')
    || created.voided
    || !created.labelUrl
    || !created.trackingNumber
    || created.shipmentId <= 0
  ) return { status: 'held' };

  await recordFulfillmentOperationReceiptByOperator(operation.id, {
    actor: 'system:print-queue-reconciler',
    note: 'Exact ShipStation external_shipment_id lookup verified the completed provider receipt.',
    receipt: { created },
    providerOperationId: created.labelId ?? created.shipmentId,
    providerResultId: created.trackingNumber,
  });
  // Per user override unlock shipped data on 2026-07-21: PS-444 consumes only
  // the exact-ID verified provider receipt. This path performs no provider POST,
  // buys no postage, and delegates shipment/order persistence to the existing
  // atomic verified-receipt owner.
  await resumeVerifiedShipStationForwardLabel({
    operationId: operation.id,
    orderId: order.orderId,
    weightOz: Number(label.weightOz ?? 0),
    length: label.length,
    width: label.width,
    height: label.height,
    customPackageId: label.customPackageId,
    insuranceProvider: label.insuranceProvider,
    insuredValue: label.insuredValue,
  }, clientStoreScope(scope));
  return {
    status: 'recovered',
    labelUrl: created.labelUrl,
    trackingNumber: created.trackingNumber,
  };
}
