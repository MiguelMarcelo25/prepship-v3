/**
 * PS-502 production provider adapter for replacement labels.
 *
 * The replacement commands own eligibility, durable intent, idempotency, receipt persistence,
 * and lifecycle. This module is deliberately only the provider boundary: it re-loads the
 * replacement's account scope, translates the already-resolved request, and normalizes the
 * provider receipt. Constructing the adapter performs no I/O and can never buy postage.
 * PS-502 enables ShipStation only. Direct/store-scoped providers remain a coded pre-purchase
 * refusal until their canonical owner exposes authoritative lookup by purchase identity;
 * purchase without crash recovery would make a duplicate-postage decision unknowable.
 *
 * Per user override unlock shipped data on 2026-08-19: replacement postage uses only the
 * replacement-scoped request/identity. This adapter reads the original order solely for tenant,
 * carrier-account, HUGRAB, and hazmat safety context; it never changes the original lifecycle,
 * dispatches marketplace fulfillment, or sends a customer notification.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients } from '../db/schema/clients.js';
import { orders } from '../db/schema/orders.js';
import {
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementLabelPurchaseIntentRow,
} from '../db/schema/replacements.js';
import { env } from '../lib/env.js';
import { getDefaultShipFrom } from '../lib/ship-from.js';
import {
  normalizeShipStationExternalShipmentId,
  ssCreateLabel,
  ssGetLabelByExternalShipmentId,
  ssVoidLabel,
  type CreatedExternalLabel,
  type ShipstationAddressInput,
} from '../lib/shipstation/labels.js';
import { loadClientCredentials } from '../lib/shipstation/credentials.js';
import { ShipStationError } from '../lib/shipstation/client.js';
import type { Carrier } from '../lib/shipstation/types.js';
import {
  assertShippingServiceEligible,
  isHugrabShippingContext,
} from '../lib/shipping-service-eligibility.js';
import { normalizeShippingOptions } from '../lib/shipping-options.js';
import { listCarrierAccounts } from './carrier-connector-orchestrator.js';
import { directLabelAccountRefFromProviderId } from './labels-direct.js';
import { assertPurchasedLabelArtifact } from './label-artifact-safety.js';
import { getOrderHazmatForShipping } from './order-hazmat.js';
import type {
  ProviderLabelReceipt,
  ReplacementLabelProvider,
} from './replacement-label-purchase-command.js';
import {
  replacementVoidIdempotencyKey,
  type ReplacementLabelVoidProvider,
  type ProviderVoidResult,
} from './replacement-label-void-command.js';
import {
  fingerprintPurchaseRequest,
  type ResolvedPurchaseRequest,
} from './replacement-purchase-request.js';
import {
  isReplacementProviderCredentialAuthority,
  sameReplacementProviderCredentialAuthority,
  selectReplacementProviderCredentialAuthority,
  type ReplacementProviderCredentialAuthority,
} from './replacement-provider-credential-authority.js';
import { loadShippingAutomationControls } from './automations/shipping-controls.js';
import { assertCarrierFamilyEligibleForPurchase } from './shipping-workflow/carrier-eligibility-policy.js';
import { isPoBoxAddress } from './shipping-workflow/address-classification.js';
import { assertInternationalOriginationSupported } from './shipping-workflow/international-origination-policy.js';

type ReplacementProviderErrorCode =
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_OUTCOME_UNKNOWN'
  | 'PROVIDER_LOOKUP_UNAVAILABLE';

/** Sanitized by construction: messages/details never contain credentials, provider payloads, or addresses. */
class ReplacementProviderError extends Error {
  readonly httpStatus = 409;

  constructor(
    readonly code: ReplacementProviderErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementProviderError';
  }
}

type ReplacementProviderContext = {
  replacementId: number;
  replacementShipmentId: number;
  replacementReference: string;
  orderId: number;
  clientId: number | null;
  clientName: string | null;
  clientIsTest: boolean;
  storeId: number | null;
  sourceProvider: string | null;
};

type ShipStationAccountAuthority = {
  apiKeyV2: string;
  credentialAuthority: ReplacementProviderCredentialAuthority;
  carrier: Carrier;
};

type ShipStationPurchaseAuthority = ShipStationAccountAuthority & {
  serviceName: string;
};

const BASIC_REPLACEMENT_SHIPPING_OPTIONS = normalizeShippingOptions({
  confirmation: 'none',
  insuranceProvider: 'none',
});

function rejected(
  message: string,
  replacementId: number,
  reason: string,
  extra: Record<string, unknown> = {},
): ReplacementProviderError {
  return new ReplacementProviderError('PROVIDER_REJECTED', message, {
    replacementId,
    reason,
    ...extra,
  });
}

function unknownOutcome(
  provider: string,
  replacementId: number,
  reason: string,
): ReplacementProviderError {
  return new ReplacementProviderError(
    'PROVIDER_OUTCOME_UNKNOWN',
    `${provider} did not return one complete, verifiable replacement-label receipt. `
      + 'The purchase intent must be reconciled; do not buy another label.',
    { provider, replacementId, reason },
  );
}

function lookupUnavailable(
  provider: string,
  replacementId: number,
  reason: string,
): ReplacementProviderError {
  return new ReplacementProviderError(
    'PROVIDER_LOOKUP_UNAVAILABLE',
    `${provider} purchase recovery could not prove a provider outcome. `
      + 'The purchase intent remains unresolved.',
    { provider, replacementId, reason },
  );
}

function voidOutcomeUnknown(
  replacementId: number,
  reason: string,
): ReplacementProviderError {
  return new ReplacementProviderError(
    'PROVIDER_OUTCOME_UNKNOWN',
    'ShipStation did not return a verifiable replacement-label void result. '
      + 'The void must be reconciled; do not infer that the label was cancelled.',
    { provider: 'ShipStation', replacementId, reason },
  );
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sameProviderCode(left: unknown, right: unknown): boolean {
  const a = normalizedText(left)?.toLowerCase();
  const b = normalizedText(right)?.toLowerCase();
  return Boolean(a && b && a === b);
}

function assertFactoryReplacementId(replacementId: number): void {
  if (!Number.isInteger(replacementId) || replacementId <= 0) {
    throw rejected(
      'A positive replacement id is required before a label provider can be selected.',
      replacementId,
      'replacement_id_invalid',
    );
  }
}

async function loadReplacementProviderContext(
  replacementId: number,
): Promise<ReplacementProviderContext> {
  const [row] = await db
    .select({
      replacementId: replacements.id,
      replacementShipmentId: replacements.replacementShipmentId,
      replacementReference: replacements.reference,
      replacementClientId: replacements.clientId,
      orderId: orders.id,
      orderClientId: orders.clientId,
      storeId: orders.storeId,
      sourceProvider: orders.sourceProvider,
    })
    .from(replacements)
    .innerJoin(orders, eq(orders.id, replacements.orderId))
    .where(eq(replacements.id, replacementId))
    .limit(1);

  if (!row || row.replacementShipmentId == null) {
    throw rejected(
      'The replacement and its dedicated shipment could not be verified.',
      replacementId,
      'replacement_context_missing',
    );
  }
  if (row.replacementClientId == null) {
    throw rejected(
      'The replacement has no frozen client owner for live postage.',
      replacementId,
      'replacement_client_required',
    );
  }
  if (row.orderClientId != null && row.replacementClientId !== row.orderClientId) {
    throw rejected(
      'The replacement client does not match the original order client.',
      replacementId,
      'replacement_client_mismatch',
    );
  }

  const clientId = row.replacementClientId;
  const [client] = await db
    .select({ name: clients.name, isTest: clients.isTest })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) {
    throw rejected(
      'The replacement client owner could not be verified.',
      replacementId,
      'replacement_client_missing',
    );
  }

  return {
    replacementId: row.replacementId,
    replacementShipmentId: row.replacementShipmentId,
    replacementReference: row.replacementReference,
    orderId: row.orderId,
    clientId,
    clientName: client?.name ?? null,
    clientIsTest: client?.isTest ?? false,
    storeId: row.storeId ?? null,
    sourceProvider: row.sourceProvider ?? null,
  };
}

function assertResolvedRequest(
  request: ResolvedPurchaseRequest,
  context: ReplacementProviderContext,
): void {
  const address = request?.address;
  const carrier = request?.carrier;
  const pkg = request?.package;
  const valid = request != null
    && request.replacementId === context.replacementId
    && request.replacementShipmentId === context.replacementShipmentId
    && request.replacementReference === context.replacementReference
    && normalizedText(request.replacementReference) != null
    && normalizedText(address?.name) != null
    && normalizedText(address?.line1) != null
    && (address?.line2 == null || normalizedText(address.line2) != null)
    && normalizedText(address?.city) != null
    && normalizedText(address?.state) != null
    && normalizedText(address?.postalCode) != null
    && normalizedText(address?.country) != null
    && (address?.residential == null || typeof address.residential === 'boolean')
    && normalizedText(carrier?.carrierCode) != null
    && normalizedText(carrier?.serviceCode) != null
    && positiveInteger(carrier?.providerAccountId) != null
    && normalizedText(pkg?.packageId) != null
    && positiveNumber(pkg?.weightOz) != null
    && positiveNumber(pkg?.dimsL) != null
    && positiveNumber(pkg?.dimsW) != null
    && positiveNumber(pkg?.dimsH) != null
    && isReplacementProviderCredentialAuthority(request.providerCredentialAuthority)
    && normalizedText(request.fingerprint) != null;

  if (!valid) {
    throw rejected(
      'The resolved replacement-label request does not match the replacement shipment.',
      context.replacementId,
      'resolved_request_invalid',
    );
  }

  let expectedFingerprint: string;
  try {
    expectedFingerprint = fingerprintPurchaseRequest(request);
  } catch {
    throw rejected(
      'The resolved replacement-label request cannot be fingerprinted safely.',
      context.replacementId,
      'resolved_request_unreadable',
    );
  }
  if (request.fingerprint !== expectedFingerprint) {
    throw rejected(
      'The resolved replacement-label request no longer matches its frozen fingerprint.',
      context.replacementId,
      'resolved_request_fingerprint_mismatch',
    );
  }
}

async function assertReplacementContextSafety(
  context: ReplacementProviderContext,
  request: ResolvedPurchaseRequest,
): Promise<void> {
  if (context.clientId == null) {
    throw rejected(
      'A client-owned replacement is required before live postage can be purchased.',
      context.replacementId,
      'replacement_client_required',
    );
  }
  if (context.clientIsTest) {
    throw rejected(
      'Test clients cannot buy live replacement postage.',
      context.replacementId,
      'test_client_live_postage_forbidden',
    );
  }
  assertInternationalOriginationSupported({ toCountry: request.address.country });

  if (isHugrabShippingContext({
    clientId: context.clientId,
    clientName: context.clientName,
    storeId: context.storeId,
  })) {
    throw rejected(
      'HUGRAB replacement postage is blocked until replacement insurance authority is frozen.',
      context.replacementId,
      'hugrab_replacement_unsupported',
    );
  }

  const hazmat = await getOrderHazmatForShipping(context.orderId);
  if (hazmat.declaration?.status === 'active') {
    throw rejected(
      'Hazmat replacement postage is blocked until replacement hazmat purchase facts are sealed.',
      context.replacementId,
      'hazmat_replacement_unsupported',
    );
  }
}

async function assertReplacementServiceSafety(
  context: ReplacementProviderContext,
  request: ResolvedPurchaseRequest,
  provider: string,
  serviceName: string,
): Promise<void> {
  const automationRules = await loadShippingAutomationControls();
  assertShippingServiceEligible(
    {
      clientId: context.clientId,
      clientName: context.clientName,
      storeId: context.storeId,
      destinationPoBox: isPoBoxAddress({
        street1: request.address.line1,
        street2: request.address.line2,
        country: request.address.country,
      }),
    },
    {
      provider,
      carrierId: `se-${request.carrier.providerAccountId}`,
      carrierCode: request.carrier.carrierCode,
      serviceCode: request.carrier.serviceCode,
      serviceName,
      serviceType: serviceName,
    },
    BASIC_REPLACEMENT_SHIPPING_OPTIONS,
    automationRules,
  );
}

function toShipstationAddress(
  request: ResolvedPurchaseRequest,
): ShipstationAddressInput {
  return {
    name: request.address.name,
    street1: request.address.line1,
    street2: request.address.line2 ?? undefined,
    city: request.address.city,
    state: request.address.state,
    postalCode: request.address.postalCode,
    country: request.address.country,
    residential: request.address.residential ?? null,
  };
}

function defaultShipFromAddress(
  address: Awaited<ReturnType<typeof getDefaultShipFrom>>,
): ShipstationAddressInput {
  return {
    name: address.name,
    company: address.company_name,
    street1: address.address_line1,
    street2: address.address_line2,
    city: address.city_locality,
    state: address.state_province,
    postalCode: address.postal_code,
    country: address.country_code,
    phone: address.phone,
  };
}

export function replacementExternalShipmentId(
  request: Pick<ResolvedPurchaseRequest, 'replacementId' | 'replacementShipmentId'>,
  idempotencyKey: string,
): string {
  if (!normalizedText(idempotencyKey)) {
    throw rejected(
      'A deterministic replacement purchase identity is required.',
      request.replacementId,
      'provider_idempotency_key_missing',
    );
  }
  const digest = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
  const externalId = `ps-rpl-${request.replacementId}-${request.replacementShipmentId}-${digest}`;
  const normalized = normalizeShipStationExternalShipmentId(externalId);
  if (normalized !== externalId) {
    throw rejected(
      'The replacement purchase identity cannot be represented safely at ShipStation.',
      request.replacementId,
      'external_shipment_id_invalid',
    );
  }
  return externalId;
}

async function resolveShipStationAccountAuthority(
  context: ReplacementProviderContext,
  request: ResolvedPurchaseRequest,
): Promise<ShipStationAccountAuthority> {
  const directRef = directLabelAccountRefFromProviderId(request.carrier.providerAccountId);
  if (directRef) {
    throw rejected(
      'A direct carrier account cannot be sent to ShipStation.',
      context.replacementId,
      'direct_account_on_shipstation_path',
      { providerAccountId: request.carrier.providerAccountId },
    );
  }

  const credentials = await loadClientCredentials(context.clientId);
  const selectedCredential = selectReplacementProviderCredentialAuthority({
    requestedClientId: context.clientId,
    credentials,
    mainApiKeyV2: env.SHIPSTATION_API_KEY_V2,
  });
  if (!selectedCredential) {
    throw rejected(
      'No ShipStation credential is configured for this replacement client.',
      context.replacementId,
      'shipstation_credential_missing',
    );
  }
  if (
    !request.providerCredentialAuthority
    || !sameReplacementProviderCredentialAuthority(
      request.providerCredentialAuthority,
      selectedCredential.authority,
    )
  ) {
    throw rejected(
      'The ShipStation credential owner changed after this purchase intent was frozen.',
      context.replacementId,
      'shipstation_credential_authority_changed',
    );
  }
  const { apiKeyV2 } = selectedCredential;

  const response = await listCarrierAccounts('shipstation', {
    apiKeyV2,
    // Connector request coalescing must never share a carrier catalog across credentials.
    dedupeKey: `replacement-label-account:${createHash('sha256').update(apiKeyV2).digest('hex').slice(0, 16)}`
      + `:${context.replacementId}:${request.carrier.providerAccountId}`,
  });
  const carriers: Carrier[] = Array.isArray(response.carriers)
    ? response.carriers as Carrier[]
    : [];
  const carrierId = `se-${request.carrier.providerAccountId}`;
  const matchingCarriers = carriers.filter((candidate) => candidate.carrier_id === carrierId);
  if (matchingCarriers.length !== 1) {
    throw rejected(
      'The selected ShipStation carrier account is not available to this client credential.',
      context.replacementId,
      'shipstation_account_not_owned',
      { providerAccountId: request.carrier.providerAccountId },
    );
  }

  const carrier = matchingCarriers[0]!;
  if (!sameProviderCode(carrier.carrier_code, request.carrier.carrierCode)) {
    throw rejected(
      'The selected carrier code does not belong to the selected ShipStation account.',
      context.replacementId,
      'shipstation_carrier_mismatch',
      { providerAccountId: request.carrier.providerAccountId },
    );
  }

  return { apiKeyV2, credentialAuthority: selectedCredential.authority, carrier };
}

async function resolveShipStationPurchaseAuthority(
  context: ReplacementProviderContext,
  request: ResolvedPurchaseRequest,
): Promise<ShipStationPurchaseAuthority> {
  const authority = await resolveShipStationAccountAuthority(context, request);
  if (authority.carrier.disabled_by_billing_plan !== false) {
    throw rejected(
      'The selected ShipStation carrier account is disabled by its billing plan.',
      context.replacementId,
      'shipstation_account_disabled',
      { providerAccountId: request.carrier.providerAccountId },
    );
  }

  const services = (authority.carrier.services ?? []).filter((service) => (
    service.carrier_id === authority.carrier.carrier_id
    && sameProviderCode(service.carrier_code, authority.carrier.carrier_code)
    && service.service_code === request.carrier.serviceCode
  ));
  if (
    services.length !== 1
    || services[0]!.domestic !== true
    || services[0]!.international === true
    || normalizedText(services[0]!.name) == null
  ) {
    throw rejected(
      'The selected ShipStation service is not an exact domestic service on the selected account.',
      context.replacementId,
      'shipstation_service_mismatch',
      {
        providerAccountId: request.carrier.providerAccountId,
        serviceCode: request.carrier.serviceCode,
      },
    );
  }

  return {
    ...authority,
    serviceName: services[0]!.name.trim(),
  };
}

function completeReceipt(
  created: CreatedExternalLabel,
  request: ResolvedPurchaseRequest,
  provider: string,
): ProviderLabelReceipt {
  const providerLabelId = normalizedText(created.labelId);
  const trackingNumber = normalizedText(created.trackingNumber);
  const labelUrl = normalizedText(created.labelUrl);
  const shipmentCost = positiveNumber(created.cost);
  const otherCost = nonNegativeNumber(created.insuranceCost);

  try {
    assertPurchasedLabelArtifact(provider, labelUrl);
  } catch {
    throw unknownOutcome(provider, request.replacementId, 'label_artifact_missing');
  }
  if (!providerLabelId || !trackingNumber || shipmentCost == null || otherCost == null) {
    throw unknownOutcome(provider, request.replacementId, 'provider_receipt_incomplete');
  }
  if (created.voided) {
    throw unknownOutcome(provider, request.replacementId, 'provider_receipt_already_voided');
  }
  if (
    created.providerAccountId !== request.carrier.providerAccountId
    || !sameProviderCode(created.carrierCode, request.carrier.carrierCode)
    || created.serviceCode !== request.carrier.serviceCode
  ) {
    throw unknownOutcome(provider, request.replacementId, 'provider_receipt_authority_mismatch');
  }

  return {
    providerTransactionId: providerLabelId,
    providerLabelId,
    providerShipmentId: created.shipmentId ? String(created.shipmentId) : null,
    trackingNumber,
    labelUrl,
    shipmentCost,
    otherCost,
  };
}

async function purchaseShipStationLabel(
  context: ReplacementProviderContext,
  request: ResolvedPurchaseRequest,
  idempotencyKey: string,
): Promise<ProviderLabelReceipt> {
  let authority: ShipStationPurchaseAuthority;
  let shipFrom: ShipstationAddressInput;
  let externalShipmentId: string;
  try {
    // Reject known unsupported replacement contexts before contacting ShipStation at all.
    await assertReplacementContextSafety(context, request);
    await assertCarrierFamilyEligibleForPurchase({
      carrierFamily: 'shipstation',
      order: { sourceProvider: context.sourceProvider },
      orderId: context.orderId,
    });
    authority = await resolveShipStationPurchaseAuthority(context, request);
    await assertReplacementServiceSafety(
      context,
      request,
      'shipstation',
      authority.serviceName,
    );
    shipFrom = defaultShipFromAddress(await getDefaultShipFrom());
    externalShipmentId = replacementExternalShipmentId(request, idempotencyKey);
  } catch (error) {
    if (error instanceof ReplacementProviderError) throw error;
    throw rejected(
      'ShipStation replacement-label preflight could not prove the selected account and service safe.',
      context.replacementId,
      'shipstation_preflight_unavailable',
    );
  }

  let created: CreatedExternalLabel;
  try {
    created = await ssCreateLabel({
      apiKeyV2: authority.apiKeyV2,
      carrierId: authority.carrier.carrier_id,
      serviceCode: request.carrier.serviceCode,
      // packageId is PrepShip's local inventory authority, not a ShipStation package code.
      // The canonical custom-package code preserves the frozen dimensions/weight without
      // guessing a carrier-branded package from an unrelated local identifier.
      packageCode: 'package',
      weightOz: request.package.weightOz,
      length: request.package.dimsL,
      width: request.package.dimsW,
      height: request.package.dimsH,
      shipTo: toShipstationAddress(request),
      shipFrom,
      confirmation: BASIC_REPLACEMENT_SHIPPING_OPTIONS.confirmation,
      insuranceProvider: BASIC_REPLACEMENT_SHIPPING_OPTIONS.insuranceProvider,
      insuredValue: BASIC_REPLACEMENT_SHIPPING_OPTIONS.insuredValue,
      // The original order id is never a replacement purchase identity.
      ssOrderId: null,
      orderNumber: request.replacementReference,
      externalShipmentId,
      testLabel: false,
      hazmat: null,
    });
  } catch (error) {
    // These HTTP responses are synchronous provider refusals: no label was created. In
    // particular, the shared client documents exhausted 429 as requests that were never
    // processed. Preserve the distinction so an operator can explicitly open a new audited
    // generation after correcting configuration/input. Transport, abort, 5xx, ambiguous 4xx,
    // and malformed successful receipts remain unknown and must reconcile, never repurchase.
    if (
      error instanceof ShipStationError
      && [400, 401, 403, 404, 422, 429].includes(error.status)
    ) {
      throw rejected(
        'ShipStation refused the replacement-label request before creating postage.',
        context.replacementId,
        `provider_http_${error.status}_no_effect`,
      );
    }
    throw unknownOutcome('ShipStation', context.replacementId, 'provider_dispatch_failed');
  }

  return completeReceipt(created, request, 'ShipStation');
}

async function loadIntentRequest(
  replacementId: number,
  intent: ReplacementLabelPurchaseIntentRow,
  context: ReplacementProviderContext,
): Promise<ResolvedPurchaseRequest> {
  if (intent.replacementId !== replacementId) {
    throw rejected(
      'The purchase intent does not belong to this replacement.',
      replacementId,
      'purchase_intent_scope_mismatch',
    );
  }
  if (intent.replacementShipmentId !== context.replacementShipmentId) {
    throw rejected(
      'The purchase intent does not belong to the replacement shipment.',
      replacementId,
      'purchase_intent_shipment_mismatch',
    );
  }
  const request = intent.resolvedRequest as ResolvedPurchaseRequest | null;
  if (!request) {
    throw rejected(
      'The purchase intent has no frozen provider request.',
      replacementId,
      'purchase_intent_request_missing',
    );
  }
  assertResolvedRequest(request, context);
  if (intent.requestFingerprint !== request.fingerprint) {
    throw rejected(
      'The purchase intent does not match its frozen provider request.',
      replacementId,
      'purchase_intent_fingerprint_mismatch',
    );
  }
  if (!sameProviderCode(intent.provider, request.carrier.carrierCode)) {
    throw rejected(
      'The purchase intent provider does not match its frozen carrier authority.',
      replacementId,
      'purchase_intent_provider_mismatch',
    );
  }
  return request;
}

async function findIntentForLookup(
  replacementId: number,
  idempotencyKey: string,
): Promise<ReplacementLabelPurchaseIntentRow> {
  const rows = await db
    .select()
    .from(replacementLabelPurchaseIntents)
    .where(and(
      eq(replacementLabelPurchaseIntents.replacementId, replacementId),
      eq(replacementLabelPurchaseIntents.providerIdempotencyKey, idempotencyKey),
    ))
    .limit(2);
  if (rows.length !== 1) {
    throw rejected(
      'The replacement purchase identity does not resolve to exactly one intent.',
      replacementId,
      'purchase_intent_not_unique',
    );
  }
  return rows[0] as ReplacementLabelPurchaseIntentRow;
}

async function findIntentForVoid(
  replacementId: number,
  providerTransactionId: string,
): Promise<ReplacementLabelPurchaseIntentRow> {
  const rows = await db
    .select()
    .from(replacementLabelPurchaseIntents)
    .where(and(
      eq(replacementLabelPurchaseIntents.replacementId, replacementId),
      eq(replacementLabelPurchaseIntents.state, 'purchased'),
      eq(replacementLabelPurchaseIntents.providerTransactionId, providerTransactionId),
    ))
    .limit(2);
  if (rows.length !== 1) {
    throw rejected(
      'The provider transaction does not resolve to exactly one purchased replacement intent.',
      replacementId,
      'void_purchase_intent_not_unique',
    );
  }
  return rows[0] as ReplacementLabelPurchaseIntentRow;
}

async function lookupShipStationPurchase(
  replacementId: number,
  idempotencyKey: string,
): Promise<ProviderLabelReceipt | null> {
  const context = await loadReplacementProviderContext(replacementId);
  const intent = await findIntentForLookup(replacementId, idempotencyKey);
  const request = await loadIntentRequest(replacementId, intent, context);
  if (directLabelAccountRefFromProviderId(request.carrier.providerAccountId)) {
    throw lookupUnavailable('Direct carrier', replacementId, 'direct_recovery_not_supported');
  }

  let authority: ShipStationAccountAuthority;
  try {
    authority = await resolveShipStationAccountAuthority(context, request);
  } catch (error) {
    if (error instanceof ReplacementProviderError) throw error;
    throw lookupUnavailable('ShipStation', replacementId, 'credential_or_account_unavailable');
  }

  let found: Awaited<ReturnType<typeof ssGetLabelByExternalShipmentId>>;
  try {
    found = await ssGetLabelByExternalShipmentId(
      replacementExternalShipmentId(request, idempotencyKey),
      { apiKeyV2: authority.apiKeyV2 },
    );
  } catch {
    throw lookupUnavailable('ShipStation', replacementId, 'provider_lookup_failed');
  }
  if (!found) {
    // A bare external-id 404 is only an eventually-consistent observation, not proof that
    // postage was never bought. The canonical Print Queue reconciler accepts it as no-effect
    // only after durable cancellation acknowledgement plus a five-minute grace. Replacement
    // intents carry neither proof, so keep this outcome indeterminate and let reconciliation
    // leave the intent in reconcile_required. Returning null here would permanently authorize
    // failed_pre_purchase and make a later retry capable of buying duplicate postage.
    throw lookupUnavailable(
      'ShipStation',
      replacementId,
      'external_shipment_not_found_without_no_effect_proof',
    );
  }

  return completeReceipt(found.label, request, 'ShipStation');
}

async function voidShipStationReplacementLabel(
  replacementId: number,
  input: { providerTransactionId: string; idempotencyKey: string },
): Promise<ProviderVoidResult> {
  const providerTransactionId = normalizedText(input.providerTransactionId);
  if (!providerTransactionId) {
    throw rejected(
      'ShipStation void requires a durable provider label id.',
      replacementId,
      'provider_label_id_missing',
    );
  }

  const context = await loadReplacementProviderContext(replacementId);
  const intent = await findIntentForVoid(replacementId, providerTransactionId);
  const request = await loadIntentRequest(replacementId, intent, context);
  if (directLabelAccountRefFromProviderId(request.carrier.providerAccountId)) {
    throw rejected(
      'Direct-carrier replacement labels cannot be voided by the ShipStation adapter.',
      replacementId,
      'direct_void_not_supported',
    );
  }
  if (
    intent.providerLabelId !== providerTransactionId
    || input.idempotencyKey !== replacementVoidIdempotencyKey(intent)
  ) {
    throw rejected(
      'The void request does not match the replacement intent and stored ShipStation label.',
      replacementId,
      'void_identity_mismatch',
    );
  }

  let authority: ShipStationAccountAuthority;
  try {
    authority = await resolveShipStationAccountAuthority(context, request);
  } catch (error) {
    if (error instanceof ReplacementProviderError) throw error;
    throw rejected(
      'The ShipStation credential that owns this replacement label could not be verified.',
      replacementId,
      'void_credential_unavailable',
    );
  }

  try {
    await ssVoidLabel(providerTransactionId, authority.apiKeyV2);
  } catch {
    throw voidOutcomeUnknown(replacementId, 'provider_void_failed');
  }
  return { providerVoidId: input.idempotencyKey, voided: true };
}

async function lookupShipStationVoidOutcome(
  replacementId: number,
  input: { providerTransactionId: string; idempotencyKey: string },
): Promise<{ disposition: 'voided' | 'active'; providerVoidId?: string | null }> {
  const providerTransactionId = normalizedText(input.providerTransactionId);
  if (!providerTransactionId) {
    throw lookupUnavailable('ShipStation void', replacementId, 'provider_label_id_missing');
  }
  const context = await loadReplacementProviderContext(replacementId);
  const intent = await findIntentForVoid(replacementId, providerTransactionId);
  const request = await loadIntentRequest(replacementId, intent, context);
  if (
    intent.providerLabelId !== providerTransactionId
    || input.idempotencyKey !== replacementVoidIdempotencyKey(intent)
    || directLabelAccountRefFromProviderId(request.carrier.providerAccountId)
  ) {
    throw lookupUnavailable('ShipStation void', replacementId, 'void_lookup_identity_mismatch');
  }

  let authority: ShipStationAccountAuthority;
  try {
    authority = await resolveShipStationAccountAuthority(context, request);
  } catch {
    throw lookupUnavailable('ShipStation void', replacementId, 'void_lookup_credential_unavailable');
  }

  let found: Awaited<ReturnType<typeof ssGetLabelByExternalShipmentId>>;
  try {
    found = await ssGetLabelByExternalShipmentId(
      replacementExternalShipmentId(request, intent.providerIdempotencyKey),
      { apiKeyV2: authority.apiKeyV2 },
    );
  } catch {
    throw lookupUnavailable('ShipStation void', replacementId, 'void_lookup_failed');
  }
  // A 404 after a destructive request is not a confirmed void. Keep it unknown.
  if (!found) {
    throw lookupUnavailable('ShipStation void', replacementId, 'void_lookup_missing');
  }

  const label = found.label;
  const exactIdentity = normalizedText(label.labelId) === providerTransactionId
    && String(label.shipmentId) === String(intent.providerShipmentId)
    && label.providerAccountId === request.carrier.providerAccountId
    && sameProviderCode(label.carrierCode, request.carrier.carrierCode)
    && label.serviceCode === request.carrier.serviceCode;
  if (!exactIdentity) {
    throw lookupUnavailable('ShipStation void', replacementId, 'void_lookup_receipt_mismatch');
  }
  return {
    disposition: label.voided ? 'voided' : 'active',
    providerVoidId: label.voided ? providerTransactionId : null,
  };
}

/**
 * Create the production adapter for one already-authorized replacement.
 *
 * No database or provider work happens here. Purchase/lookup/void methods are invoked only by
 * their command owners, after feature flags, RBAC, scope, state, and durable-intent gates.
 */
export function replacementLabelProviderFor(
  replacementId: number,
): ReplacementLabelProvider & ReplacementLabelVoidProvider {
  return {
    purchase: async ({ request, idempotencyKey }) => {
      assertFactoryReplacementId(replacementId);
      let context: ReplacementProviderContext;
      try {
        context = await loadReplacementProviderContext(replacementId);
        assertResolvedRequest(request, context);
      } catch (error) {
        if (error instanceof ReplacementProviderError) throw error;
        throw rejected(
          'The replacement provider context could not be verified.',
          replacementId,
          'replacement_context_unavailable',
        );
      }
      // PS-502 deliberately supports only the provider family with authoritative lookup by
      // our deterministic purchase identity. The canonical direct-label owner can purchase,
      // but exposes no equivalent recovery seam; allowing it here could charge postage and
      // leave a crash outcome permanently unknowable. A future ticket must add recovery first.
      if (directLabelAccountRefFromProviderId(request.carrier.providerAccountId)) {
        throw rejected(
          'Direct-provider replacement labels are not supported until authoritative purchase recovery exists.',
          replacementId,
          'direct_provider_recovery_unsupported',
          { providerAccountId: request.carrier.providerAccountId },
        );
      }

      return purchaseShipStationLabel(context, request, idempotencyKey);
    },
    lookupPurchase: async ({ idempotencyKey }) => {
      assertFactoryReplacementId(replacementId);
      try {
        return await lookupShipStationPurchase(replacementId, idempotencyKey);
      } catch (error) {
        if (error instanceof ReplacementProviderError) throw error;
        throw lookupUnavailable('ShipStation', replacementId, 'replacement_lookup_unavailable');
      }
    },
    voidLabel: async (input) => {
      assertFactoryReplacementId(replacementId);
      try {
        return await voidShipStationReplacementLabel(replacementId, input);
      } catch (error) {
        if (error instanceof ReplacementProviderError) throw error;
        throw lookupUnavailable('ShipStation void', replacementId, 'replacement_void_unavailable');
      }
    },
    lookupVoid: async (input) => {
      assertFactoryReplacementId(replacementId);
      try {
        return await lookupShipStationVoidOutcome(replacementId, input);
      } catch (error) {
        if (error instanceof ReplacementProviderError) throw error;
        throw lookupUnavailable('ShipStation void', replacementId, 'replacement_void_lookup_unavailable');
      }
    },
  };
}
