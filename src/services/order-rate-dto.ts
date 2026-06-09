/**
 * order-rate-dto.ts — rate DTO normalization + persistence guards.
 *
 * Ported from v2's apps/api/src/modules/orders/application/order-rate-dto.ts.
 * Responsible for canonicalizing any-shape rate JSON (ShipStation camelCase,
 * ShipStation snake_case, or manual) into a stable OrderBestRateDto /
 * OrderSelectedRateDto shape with guaranteed fields.
 *
 * v4 note: contracts package does not exist here — DTO types are inlined below.
 * v4 note: InputValidationError is a local 400-class error that the Hono error
 *           handler (or callers) can map to a 400 response.
 */

// ── Inlined DTO types (v2 parity) ────────────────────────────────────────────

export interface OrderBestRateDto {
  serviceCode: string | null;
  serviceName: string | null;
  packageType: string | null;
  shipmentCost: number;
  otherCost: number;
  insuranceCost: number | null;
  insuranceProvenance: string | null;
  totalCost: number | null;
  rateDetails: unknown[];
  carrierCode: string | null;
  shippingProviderId: number | null;
  carrierNickname: string | null;
  guaranteed: boolean;
  zone: string | null;
  sourceClientId: number | null;
  deliveryDays: number | null;
  estimatedDelivery: string | null;
  requestFingerprint: string | null;
  cacheKey: string | null;
  cacheCreatedAt: string | null;
  cacheExpiresAt: string | null;
  eligibilityVersion: string | null;
  isComplete: boolean | null;
  rateCount: number | null;
  matchType: string | null;
  clientRequestKey: string | null;
  proofSource: string | null;
  rateQuoteId: string | null;
  selectedRateKey: string | null;
}

export interface OrderSelectedRateDto {
  providerAccountId: number | null;
  providerAccountNickname: string | null;
  shippingProviderId: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  cost: number | null;
  shipmentCost: number | null;
  otherCost: number | null;
  insuranceCost: number | null;
  insuranceProvenance: string | null;
  totalCost: number | null;
}

// ── Local 400-class error (v4 has no contracts/input-validation module) ──────

export class InputValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InputValidationError';
  }
}

// ── Primitive readers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function readNullableString(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string or null`);
  }
  return value;
}

function readNullableStringLike(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${path} must be a string, number, or null`);
  }
  return String(value);
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function readNullableNumber(value: unknown, path: string): number | null {
  if (value == null) return null;
  return readNumber(value, path);
}

function readMoneyAmount(value: unknown): number | null {
  if (isRecord(value)) return readNullableNumber(value.amount ?? null, 'money.amount');
  return readNullableNumber(value ?? null, 'money');
}

function readNullableProviderAccountId(value: unknown, path: string): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/^se-(\d+)$/i);
    const parsed = Number.parseInt(match?.[1] ?? value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${path} must be a finite number, se-* carrier id, or null`);
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function hasAnyMeaningfulRateField(rate: OrderBestRateDto): boolean {
  return (
    rate.serviceCode != null ||
    rate.serviceName != null ||
    rate.carrierCode != null ||
    rate.shippingProviderId != null ||
    rate.shipmentCost > 0 ||
    rate.otherCost > 0
  );
}

function hasAnyMeaningfulSelectedRateField(rate: OrderSelectedRateDto): boolean {
  return (
    rate.providerAccountId != null ||
    rate.providerAccountNickname != null ||
    rate.shippingProviderId != null ||
    rate.carrierCode != null ||
    rate.serviceCode != null ||
    rate.serviceName != null ||
    rate.cost != null ||
    rate.shipmentCost != null ||
    rate.otherCost != null
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

// PS-139: removed dead export parseOrderRateJson (0 callers; best_rate_json/selected_rate_json
// are stored as Postgres jsonb and auto-parsed, so the JSON.parse wrapper was never adopted).
export function normalizeOrderBestRateDto(value: unknown, path = 'bestRate'): OrderBestRateDto | null {
  if (value == null) return null;

  const record = expectRecord(value, path);
  const shippingAmount = isRecord(record.shipping_amount) ? record.shipping_amount : null;
  const otherAmount = isRecord(record.other_amount) ? record.other_amount : null;
  // PS-108: the insured total must include the ParcelGuard/insurance premium. The
  // raw backend rate stores it as a separate `insurance_amount` (postage lives in
  // `other_amount`), and the backend rateTotal + Rate Browser both count it. Fold
  // it into otherCost so OrderBestRateDto.shipmentCost + otherCost equals the true
  // insured total shown in the Rate Browser (otherwise the Best Rate column reads
  // postage-only and undershoots an insured order by the premium).
  //
  // Guard against double-counting: a pre-summed camelCase `otherCost` (our own DTO
  // and the applied-rate shape) already includes the premium, so only the raw
  // snake_case shape — which has `other_amount` + a separate `insurance_amount` —
  // needs the premium folded in here. No persisted shape carries both.
  const insuranceAmount = isRecord(record.insurance_amount) ? record.insurance_amount : null;
  const insurancePremium =
    typeof record.otherCost === 'number'
      ? 0
      : typeof insuranceAmount?.amount === 'number' && Number.isFinite(insuranceAmount.amount)
        ? insuranceAmount.amount
        : 0;
  const insuranceMeta = isRecord(record.insuranceCost) ? record.insuranceCost : null;
  const insuranceCost =
    readMoneyAmount(insuranceMeta?.amount ?? record.insuranceCost ?? record.insuranceAmount ?? insuranceAmount) ??
    null;
  const insuranceProvenance = readNullableString(
    insuranceMeta?.provenance ?? record.insuranceProvenance ?? (insuranceCost != null && insuranceCost > 0 ? 'shipstation_estimate' : null),
    `${path}.insuranceProvenance`,
  );
  const shipmentCost = readNumber(
    record.shipmentCost ?? shippingAmount?.amount ?? record.cost ?? record.amount ?? 0,
    `${path}.shipmentCost`,
  );
  const otherCost =
    readNumber(record.otherCost ?? otherAmount?.amount ?? 0, `${path}.otherCost`) + insurancePremium;
  const rate: OrderBestRateDto = {
    serviceCode: readNullableString(record.serviceCode ?? record.service_code ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(
      record.serviceName ?? record.service_type ?? record.serviceCode ?? record.service_code ?? null,
      `${path}.serviceName`,
    ),
    packageType: readNullableString(record.packageType ?? record.package_type ?? null, `${path}.packageType`),
    shipmentCost,
    otherCost,
    insuranceCost,
    insuranceProvenance,
    totalCost: readNullableNumber(record.totalCost ?? record.total_cost ?? null, `${path}.totalCost`) ?? shipmentCost + otherCost,
    rateDetails: readArray(record.rateDetails ?? record.rate_details ?? [], `${path}.rateDetails`),
    carrierCode: readNullableString(
      record.carrierCode ?? record.carrier_code ?? record.carrier ?? null,
      `${path}.carrierCode`,
    ),
    shippingProviderId: readNullableProviderAccountId(
      record.shippingProviderId ?? record.providerAccountId ?? record.carrier_id ?? null,
      `${path}.shippingProviderId`,
    ),
    carrierNickname: readNullableString(
      record.carrierNickname ?? record.carrier_nickname ?? record._carrierName ?? null,
      `${path}.carrierNickname`,
    ),
    guaranteed: readBoolean(record.guaranteed ?? record.guaranteed_service ?? false, `${path}.guaranteed`),
    zone: readNullableStringLike(record.zone ?? null, `${path}.zone`),
    sourceClientId: readNullableNumber(record.sourceClientId ?? record.clientId ?? null, `${path}.sourceClientId`),
    deliveryDays: readNullableNumber(record.deliveryDays ?? record.delivery_days ?? null, `${path}.deliveryDays`),
    estimatedDelivery: readNullableString(
      record.estimatedDelivery ?? record.estimated_delivery_date ?? null,
      `${path}.estimatedDelivery`,
    ),
    requestFingerprint: readNullableString(record.requestFingerprint ?? null, `${path}.requestFingerprint`),
    cacheKey: readNullableString(record.cacheKey ?? null, `${path}.cacheKey`),
    cacheCreatedAt: readNullableString(record.cacheCreatedAt ?? null, `${path}.cacheCreatedAt`),
    cacheExpiresAt: readNullableString(record.cacheExpiresAt ?? null, `${path}.cacheExpiresAt`),
    eligibilityVersion: readNullableString(record.eligibilityVersion ?? null, `${path}.eligibilityVersion`),
    isComplete: record.isComplete == null ? null : readBoolean(record.isComplete, `${path}.isComplete`),
    rateCount: readNullableNumber(record.rateCount ?? null, `${path}.rateCount`),
    matchType: readNullableString(record.matchType ?? null, `${path}.matchType`),
    clientRequestKey: readNullableString(record.clientRequestKey ?? null, `${path}.clientRequestKey`),
    proofSource: readNullableString(record.proofSource ?? null, `${path}.proofSource`),
    rateQuoteId: readNullableString(record.rateQuoteId ?? null, `${path}.rateQuoteId`),
    selectedRateKey: readNullableString(record.selectedRateKey ?? null, `${path}.selectedRateKey`),
  };

  return hasAnyMeaningfulRateField(rate) ? rate : null;
}

export function assertPersistedOrderBestRateDto(value: unknown, path = 'bestRate'): OrderBestRateDto {
  const rate = normalizeOrderBestRateDto(value, path);
  if (!rate) {
    throw new InputValidationError(`${path} must include a carrier/service or cost payload`);
  }
  if (!rate.serviceCode) {
    throw new InputValidationError(`${path}.serviceCode is required`);
  }
  if (!rate.carrierCode) {
    throw new InputValidationError(`${path}.carrierCode is required`);
  }
  return rate;
}

export function normalizeOrderSelectedRateDto(
  value: unknown,
  fallback?: {
    providerAccountId?: number | null;
    carrierCode?: string | null;
    serviceCode?: string | null;
    shipmentCost?: number | null;
    otherCost?: number | null;
  },
  path = 'selectedRate',
): OrderSelectedRateDto | null {
  if (value == null) return null;

  const record = expectRecord(value, path);
  const providerAccountId = readNullableProviderAccountId(
    record.providerAccountId ?? record.shippingProviderId ?? fallback?.providerAccountId ?? null,
    `${path}.providerAccountId`,
  );
  const shipmentCost = readNullableNumber(
    record.shipmentCost ?? record.cost ?? fallback?.shipmentCost ?? null,
    `${path}.shipmentCost`,
  );
  const fallbackOtherCost =
    shipmentCost != null || fallback?.otherCost != null ? (fallback?.otherCost ?? 0) : null;
  const otherCost = readNullableNumber(record.otherCost ?? fallbackOtherCost, `${path}.otherCost`);
  const insuranceCost = readMoneyAmount(record.insuranceCost ?? record.insuranceAmount ?? null);
  const insuranceProvenance = readNullableString(
    record.insuranceProvenance ?? (insuranceCost != null && insuranceCost > 0 ? 'shipstation_v2_label' : null),
    `${path}.insuranceProvenance`,
  );
  const rate: OrderSelectedRateDto = {
    providerAccountId,
    providerAccountNickname: readNullableString(
      record.providerAccountNickname ?? null,
      `${path}.providerAccountNickname`,
    ),
    shippingProviderId: readNullableProviderAccountId(
      record.shippingProviderId ?? providerAccountId ?? fallback?.providerAccountId ?? null,
      `${path}.shippingProviderId`,
    ),
    carrierCode: readNullableString(record.carrierCode ?? fallback?.carrierCode ?? null, `${path}.carrierCode`),
    serviceCode: readNullableString(record.serviceCode ?? fallback?.serviceCode ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(
      record.serviceName ?? record.serviceCode ?? fallback?.serviceCode ?? null,
      `${path}.serviceName`,
    ),
    cost: readNullableNumber(record.cost ?? shipmentCost ?? null, `${path}.cost`),
    shipmentCost,
    otherCost,
    insuranceCost,
    insuranceProvenance,
    totalCost: readNullableNumber(record.totalCost ?? record.total_cost ?? null, `${path}.totalCost`),
  };

  return hasAnyMeaningfulSelectedRateField(rate) ? rate : null;
}

// PS-137: the Orders list/export bestRate normalizer, co-located with its owner
// normalizeOrderBestRateDto (rate truth lives in this service per ARCHITECTURE.md). Thin wrapper:
// normalize, reject an empty rate (no positive amount AND no carrier+service), then add the list
// DTO aliases (amount/cost/providerAccountId/providerAccountNickname). Behavior-identical to the
// prior inline routes/orders.ts version; consumed by GET '/' (list) and GET '/export'.
export function normalizeListBestRate(value: unknown) {
  try {
    const bestRate = normalizeOrderBestRateDto(value);
    if (!bestRate) return null;
    const amount = bestRate.shipmentCost + bestRate.otherCost;
    if (!(amount > 0) && !(bestRate.carrierCode && bestRate.serviceCode)) return null;
    return {
      ...bestRate,
      amount,
      cost: amount,
      providerAccountId: bestRate.shippingProviderId,
      providerAccountNickname: bestRate.carrierNickname,
    };
  } catch {
    return null;
  }
}
