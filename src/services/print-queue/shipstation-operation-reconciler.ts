import { env } from '../../lib/env';
import { normalizeScopeIds } from '../../lib/scope-sql';
import { loadClientCredentials } from '../../lib/shipstation/credentials';
import { ssGetLabelByExternalShipmentId } from '../../lib/shipstation/labels';
import type { ClientStoreScope } from '../../lib/client-store-scope';
import {
  getActiveOrHeldLabelOperationForOrder,
  recordFulfillmentOperationReceiptByOperator,
  resolveFulfillmentOperationNoEffect,
} from '../fulfillment-operation-ledger';
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

/**
 * Reconcile one queue-held ShipStation purchase by its exact provider identity.
 * This function never sends a label-purchase request. A provider read failure,
 * credential drift, nonterminal response, or incomplete artifact remains held.
 */
export async function reconcileQueueShipStationOperation(
  order: QueueSendOrderInput,
  scope: PrintQueueListScope,
): Promise<QueueShipStationReconciliationResult> {
  const operation = await getActiveOrHeldLabelOperationForOrder(order.orderId);
  if (!operation || operation.provider !== 'shipstation' || operation.kind !== 'forward_label') {
    return { status: 'not_applicable' };
  }
  if (operation.state === 'in_flight') return { status: 'active' };

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
