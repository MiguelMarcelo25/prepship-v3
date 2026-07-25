import { createHash } from 'node:crypto';
import {
  sealHazmatQuoteFacts,
  type CanonicalHazmatPurchaseFacts,
  type CanonicalHazmatQuoteFacts,
  type HazmatProfile,
} from './hazmat-declaration.js';

export type ShippingQuoteAddress = {
  name: string;
  company: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
};

export type ShippingQuoteAuthorizationContext = {
  version: 1;
  order: {
    orderId: number;
    clientId: number | null;
    storeId: number | null;
    sourceProvider: string | null;
    sourceAccountId: string | null;
    sourceOrderId: string | null;
  };
  shipment: {
    shipFromLocationId: number | null;
    shipFrom: ShippingQuoteAddress;
    shipTo: ShippingQuoteAddress;
    package: {
      id: number | null;
      type: string | null;
      code: string | null;
    };
    weightOz: number;
    dimensions: {
      length: number | null;
      width: number | null;
      height: number | null;
    };
    residential: boolean;
    confirmation: string;
    insuranceProvider: string;
    insuredValue: number;
    /** Present only for an active backend-owned declaration. */
    hazmat?: CanonicalHazmatQuoteFacts;
  };
};

export type ShippingQuoteAccountAuthorization = {
  providerFamily: 'shipstation' | 'direct';
  provider: string;
  shippingProviderId: number;
  sourceTable: 'shipstation' | 'carrier_accounts' | 'store_accounts';
  sourceAccountId: number | null;
  ownerClientId: number | null;
  ownerStoreAccountId: number | null;
  credentialSource: 'client' | 'rate_source_client' | 'application_default' | 'carrier_account' | 'store_account';
  credentialFingerprint: string;
  environment: string;
};

export type ShippingQuoteAuthorizedPurchaseFacts = {
  shippingProviderId: number;
  carrierCode: string | null;
  serviceCode: string;
  serviceName: string | null;
  packageCode: string;
  customPackageId: number | null;
  weightOz: number;
  length: number | null;
  width: number | null;
  height: number | null;
  confirmation: string;
  insuranceProvider: string;
  insuredValue: number;
  shipFrom: ShippingQuoteAddress;
  shipTo: ShippingQuoteAddress;
  hazmat: CanonicalHazmatPurchaseFacts | null;
};

export type ShippingQuotePurchaseIntent = {
  orderId?: unknown;
  shippingProviderId?: unknown;
  serviceCode?: unknown;
  customPackageId?: unknown;
  weightOz?: unknown;
  length?: unknown;
  width?: unknown;
  height?: unknown;
  confirmation?: unknown;
  insuranceProvider?: unknown;
  insuredValue?: unknown;
  shipFrom?: unknown;
  shipTo?: unknown;
};

export class ShippingQuoteAuthorizationError extends Error {
  code = 'SHIPPING_QUOTE_AUTHORIZATION_MISMATCH';
  details: { reason: string };

  constructor(reason: string) {
    super(`Shipping quote authorization no longer matches current ${reason}. Re-rate before buying the label.`);
    this.name = 'ShippingQuoteAuthorizationError';
    this.details = { reason };
  }
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalJson(value: unknown): CanonicalJson {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, canonicalJson(row[key])]),
    );
  }
  return String(value);
}

function canonicalKey(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function normalizedText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizedNullableText(value: unknown): string | null {
  const text = normalizedText(value);
  return text || null;
}

function normalizedNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeShippingQuoteAddress(value: unknown): ShippingQuoteAddress {
  const row = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    name: normalizedText(row.name),
    company: normalizedText(row.company ?? row.company_name),
    street1: normalizedText(row.street1 ?? row.address_line1),
    street2: normalizedText(row.street2 ?? row.address_line2),
    city: normalizedText(row.city ?? row.city_locality),
    state: normalizedText(row.state ?? row.state_province).toUpperCase(),
    postalCode: normalizedText(row.postalCode ?? row.postal_code).toUpperCase(),
    country: normalizedText(row.country ?? row.country_code ?? 'US').toUpperCase(),
    phone: normalizedText(row.phone),
  };
}

export function shippingQuoteCredentialFingerprint(value: unknown): string {
  return `qcf_${createHash('sha256').update(canonicalKey(value)).digest('hex')}`;
}

export function shippingQuoteSnapshotIdentityKey(input: {
  rateCacheKey: string;
  authorization?: {
    context: ShippingQuoteAuthorizationContext;
    accounts: ShippingQuoteAccountAuthorization[];
  } | null;
  rates?: unknown[];
  fetchedAt?: string | number;
}): string {
  if (!input.authorization) return input.rateCacheKey;
  const snapshotDigest = createHash('sha256')
    .update(canonicalKey({
      authorization: input.authorization,
      rates: input.rates ?? [],
    }))
    .digest('hex');
  return [
    input.rateCacheKey,
    `qauth=${snapshotDigest}`,
    `qf=${normalizedText(input.fetchedAt)}`,
  ].join('|');
}

export function createShippingQuoteSelectionRef(
  rateQuoteId: string,
  selectedRateKey: string,
): string {
  const quoteMatch = /^rq_([a-f0-9]{32})$/i.exec(normalizedText(rateQuoteId));
  const rateMatch = /^srk_([a-f0-9]{24})$/i.exec(normalizedText(selectedRateKey));
  if (!quoteMatch || !rateMatch) {
    throw new ShippingQuoteAuthorizationError('selection reference');
  }
  return `sqa_${quoteMatch[1]!.toLowerCase()}.${rateMatch[1]!.toLowerCase()}`;
}

export function parseShippingQuoteSelectionRef(
  selectionRef: string | null | undefined,
): { rateQuoteId: string; selectedRateKey: string } | null {
  const match = /^sqa_([a-f0-9]{32})\.([a-f0-9]{24})$/i.exec(normalizedText(selectionRef));
  if (!match) return null;
  return {
    rateQuoteId: `rq_${match[1]!.toLowerCase()}`,
    selectedRateKey: `srk_${match[2]!.toLowerCase()}`,
  };
}

export function assertShippingQuoteContextMatches(input: {
  authorized: ShippingQuoteAuthorizationContext | null | undefined;
  current: ShippingQuoteAuthorizationContext | null | undefined;
}): void {
  if (!input.authorized || !input.current) {
    throw new ShippingQuoteAuthorizationError('order and shipment facts');
  }
  if (canonicalKey(input.authorized.order) !== canonicalKey(input.current.order)) {
    throw new ShippingQuoteAuthorizationError('order, client, store, or marketplace identity');
  }
  if (canonicalKey(input.authorized.shipment.shipFrom) !== canonicalKey(input.current.shipment.shipFrom)
    || input.authorized.shipment.shipFromLocationId !== input.current.shipment.shipFromLocationId) {
    throw new ShippingQuoteAuthorizationError('ship-from origin');
  }
  if (canonicalKey(input.authorized.shipment.shipTo) !== canonicalKey(input.current.shipment.shipTo)) {
    throw new ShippingQuoteAuthorizationError('ship-to destination');
  }
  if (canonicalKey(input.authorized.shipment.package) !== canonicalKey(input.current.shipment.package)) {
    throw new ShippingQuoteAuthorizationError('package identity');
  }
  if (
    input.authorized.shipment.weightOz !== input.current.shipment.weightOz
    || canonicalKey(input.authorized.shipment.dimensions) !== canonicalKey(input.current.shipment.dimensions)
  ) {
    throw new ShippingQuoteAuthorizationError('weight or dimensions');
  }
  if (input.authorized.shipment.residential !== input.current.shipment.residential) {
    throw new ShippingQuoteAuthorizationError('residential classification');
  }
  if (input.authorized.shipment.confirmation !== input.current.shipment.confirmation) {
    throw new ShippingQuoteAuthorizationError('confirmation');
  }
  if (
    input.authorized.shipment.insuranceProvider !== input.current.shipment.insuranceProvider
    || input.authorized.shipment.insuredValue !== input.current.shipment.insuredValue
  ) {
    throw new ShippingQuoteAuthorizationError('insurance');
  }
  if (canonicalKey(input.authorized.shipment.hazmat ?? null)
    !== canonicalKey(input.current.shipment.hazmat ?? null)) {
    throw new ShippingQuoteAuthorizationError('hazmat declaration');
  }
}

function completeAccountIdentity(value: ShippingQuoteAccountAuthorization | null | undefined): boolean {
  if (!value) return false;
  const sourceAccountId = value.sourceAccountId;
  const validOwnerId = (ownerId: number | null) =>
    ownerId == null || (Number.isInteger(ownerId) && ownerId > 0);
  const common =
    normalizedText(value.provider) !== ''
    && Number.isInteger(value.shippingProviderId)
    && value.shippingProviderId > 0
    && Number.isInteger(sourceAccountId)
    && sourceAccountId != null
    && sourceAccountId > 0
    && validOwnerId(value.ownerClientId)
    && validOwnerId(value.ownerStoreAccountId)
    && /^qcf_[a-f0-9]{64}$/i.test(normalizedText(value.credentialFingerprint))
    && normalizedText(value.environment) !== '';
  if (!common) return false;

  if (value.providerFamily === 'shipstation') {
    return (
      value.provider === 'shipstation'
      && value.sourceTable === 'shipstation'
      && value.shippingProviderId === sourceAccountId
      && ['client', 'rate_source_client', 'application_default'].includes(value.credentialSource)
    );
  }
  if (value.providerFamily !== 'direct') return false;
  if (value.sourceTable === 'carrier_accounts') {
    return (
      value.shippingProviderId === 10_000_000 + sourceAccountId
      && value.credentialSource === 'carrier_account'
    );
  }
  return (
    value.sourceTable === 'store_accounts'
    && value.shippingProviderId === 20_000_000 + sourceAccountId
    && value.credentialSource === 'store_account'
  );
}

export function assertShippingQuoteAccountMatches(input: {
  authorized: ShippingQuoteAccountAuthorization | null | undefined;
  current: ShippingQuoteAccountAuthorization | null | undefined;
}): void {
  if (!completeAccountIdentity(input.authorized) || !completeAccountIdentity(input.current)) {
    throw new ShippingQuoteAuthorizationError('carrier credential identity');
  }
  if (canonicalKey(input.authorized) !== canonicalKey(input.current)) {
    throw new ShippingQuoteAuthorizationError('carrier account or credential version');
  }
}

function intentHasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function normalizedIntentNumber(value: unknown): number | null {
  return intentHasValue(value) ? normalizedNumber(value) : null;
}

function routingAddressKey(value: unknown): string {
  const address = normalizeShippingQuoteAddress(value);
  return canonicalKey({
    street1: address.street1,
    street2: address.street2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  });
}

export function shippingQuoteAuthorizedPurchaseFacts(input: {
  authorizationContext: ShippingQuoteAuthorizationContext;
  accountAuthorization: ShippingQuoteAccountAuthorization;
  selectedRate: unknown;
}): ShippingQuoteAuthorizedPurchaseFacts {
  const serviceCode = shippingServiceCodeFromAuthorizedRate(input.selectedRate);
  if (!serviceCode) {
    throw new ShippingQuoteAuthorizationError('selected carrier service');
  }
  const shipment = input.authorizationContext.shipment;
  const selectedRate = rateRecord(input.selectedRate);
  const profileValue = normalizedText(selectedRate.hazmatProfile);
  const allowedProfiles: HazmatProfile[] = [
    'shipstation_usps',
    'shipstation_ups_dry_ice',
    'shipstation_ups_dangerous_goods',
    'ups_direct',
    'walmart',
  ];
  const hazmatProfile = allowedProfiles.includes(profileValue as HazmatProfile)
    ? profileValue as HazmatProfile
    : null;
  if (shipment.hazmat && !hazmatProfile) {
    throw new ShippingQuoteAuthorizationError('selected carrier hazmat profile');
  }
  return {
    shippingProviderId: input.accountAuthorization.shippingProviderId,
    carrierCode: shippingCarrierCodeFromAuthorizedRate(input.selectedRate),
    serviceCode,
    serviceName: shippingServiceNameFromAuthorizedRate(input.selectedRate),
    packageCode:
      shippingPackageCodeFromAuthorizedRate(input.selectedRate)
      ?? shipment.package.code
      ?? 'package',
    customPackageId: shipment.package.id,
    weightOz: shipment.weightOz,
    length: shipment.dimensions.length,
    width: shipment.dimensions.width,
    height: shipment.dimensions.height,
    confirmation: shipment.confirmation,
    insuranceProvider: shipment.insuranceProvider,
    insuredValue: shipment.insuredValue,
    shipFrom: shipment.shipFrom,
    shipTo: shipment.shipTo,
    hazmat: shipment.hazmat
      ? sealHazmatQuoteFacts(shipment.hazmat, hazmatProfile!)
      : null,
  };
}

export function assertShippingQuoteIntentMatches(input: {
  authorizationContext: ShippingQuoteAuthorizationContext;
  accountAuthorization: ShippingQuoteAccountAuthorization;
  selectedRate: unknown;
  intent: ShippingQuotePurchaseIntent;
}): void {
  const authorized = shippingQuoteAuthorizedPurchaseFacts(input);
  const intent = input.intent;
  const mismatch = (reason: string): never => {
    throw new ShippingQuoteAuthorizationError(`requested ${reason}`);
  };
  if (
    intentHasValue(intent.orderId)
    && normalizedIntentNumber(intent.orderId) !== input.authorizationContext.order.orderId
  ) mismatch('order');
  if (
    intentHasValue(intent.shippingProviderId)
    && normalizedIntentNumber(intent.shippingProviderId) !== authorized.shippingProviderId
  ) mismatch('carrier account');
  if (
    intentHasValue(intent.serviceCode)
    && normalizedText(intent.serviceCode).toLowerCase() !== authorized.serviceCode.toLowerCase()
  ) mismatch('carrier service');
  if (
    intentHasValue(intent.customPackageId)
    && normalizedIntentNumber(intent.customPackageId) !== authorized.customPackageId
  ) mismatch('package');
  for (const [reason, requested, expected] of [
    ['weight', intent.weightOz, authorized.weightOz],
    ['length', intent.length, authorized.length],
    ['width', intent.width, authorized.width],
    ['height', intent.height, authorized.height],
    ['insured value', intent.insuredValue, authorized.insuredValue],
  ] as const) {
    if (intentHasValue(requested) && normalizedIntentNumber(requested) !== expected) {
      mismatch(reason);
    }
  }
  if (
    intentHasValue(intent.confirmation)
    && normalizedText(intent.confirmation).toLowerCase() !== authorized.confirmation.toLowerCase()
  ) mismatch('confirmation');
  if (
    intentHasValue(intent.insuranceProvider)
    && normalizedText(intent.insuranceProvider).toLowerCase() !== authorized.insuranceProvider.toLowerCase()
  ) mismatch('insurance provider');
  if (intent.shipFrom && routingAddressKey(intent.shipFrom) !== routingAddressKey(authorized.shipFrom)) {
    mismatch('ship-from address');
  }
  if (intent.shipTo && routingAddressKey(intent.shipTo) !== routingAddressKey(authorized.shipTo)) {
    mismatch('ship-to address');
  }
}

function rateRecord(rate: unknown): Record<string, unknown> {
  return rate && typeof rate === 'object' && !Array.isArray(rate)
    ? rate as Record<string, unknown>
    : {};
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export function shippingProviderIdFromAuthorizedRate(rate: unknown): number | null {
  const row = rateRecord(rate);
  const raw = rateRecord(row.raw);
  const value = firstPresent(
    row.shippingProviderId,
    row.providerAccountId,
    row.shipping_provider_id,
    row.carrier_id,
    row.carrierId,
    raw.shippingProviderId,
    raw.providerAccountId,
    raw.carrier_id,
  );
  const match = /^se-(\d+)$/i.exec(normalizedText(value));
  const number = normalizedNumber(match?.[1] ?? value);
  return number != null && Number.isInteger(number) && number > 0 ? number : null;
}

export function shippingCarrierCodeFromAuthorizedRate(rate: unknown): string | null {
  const row = rateRecord(rate);
  const raw = rateRecord(row.raw);
  return normalizedNullableText(firstPresent(
    row.carrierCode,
    row.carrier_code,
    raw.carrierCode,
    raw.carrier_code,
  ));
}

export function shippingServiceCodeFromAuthorizedRate(rate: unknown): string | null {
  const row = rateRecord(rate);
  const raw = rateRecord(row.raw);
  return normalizedNullableText(firstPresent(
    row.serviceCode,
    row.service_code,
    raw.serviceCode,
    raw.service_code,
  ));
}

export function shippingServiceNameFromAuthorizedRate(rate: unknown): string | null {
  const row = rateRecord(rate);
  const raw = rateRecord(row.raw);
  return normalizedNullableText(firstPresent(
    row.serviceName,
    row.service_type,
    row.serviceType,
    raw.serviceName,
    raw.service_type,
  ));
}

export function shippingPackageCodeFromAuthorizedRate(rate: unknown): string | null {
  const row = rateRecord(rate);
  const raw = rateRecord(row.raw);
  return normalizedNullableText(firstPresent(
    row.packageCode,
    row.package_type,
    raw.packageCode,
    raw.package_type,
  ));
}
