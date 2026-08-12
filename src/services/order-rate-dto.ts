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
 *
 * PS-290 (slice 1): the HUGRAB $100-insurance COVERAGE STATUS verdict is backend-owned. The
 * coverage status/label/tone are populated HERE by delegating to the canonical pure resolver
 * (shipping-workflow/insurance-coverage-status) from the rate's existing insurance fields +
 * an isHugrab signal — the FE only renders the result, it never recomputes the verdict.
 */

import {
  resolveInsuranceCoverageStatus,
  type InsuranceCoverageStatus,
  type InsuranceCoverageBadgeTone,
  type InsuranceCoverageProofSource,
} from './shipping-workflow/insurance-coverage-status';
import { isShippBrokered } from './shipping-workflow/insurance-certainty';
// PS-261 (display slice): the SAME gate the label-purchase preflight uses, so the Rate Browser's
// pre-purchase indicator and the buy-path BLOCK agree by construction. The DTO DELEGATES to it over
// the already-resolved PS-290 coverage status; the FE renders the {allow,reason} verbatim.
import { resolveHugrabLabelPurchaseGate } from './shipping-workflow/hugrab-label-purchase-gate';
// PS-279 (backend-ownership pillar): the rate BLOCK/eligibility REASON is backend-owned. The DTO
// STAMPS the eligibility verdict (delegating to the canonical evaluateShippingServiceEligibility
// owner) so the Rate Browser READS {eligibilityBlocked, eligibilityBlockReason} verbatim instead of
// re-deriving the block-list reason client-side. Inert (UNBLOCKED) until a caller passes ctx.eligibility.
import { resolveRateEligibilityStamp } from './shipping-workflow/rate-eligibility-stamp';
import type { ShippingServiceEligibilityContext } from '../lib/shipping-service-eligibility';
import { roundMoney } from '../lib/money';
import { normalizeShippingRateMoney } from './shipping-workflow/shipping-rate-money-normalizer';
// PS-500: money completeness is classified before the defaulting in this file.
import { classifyRateMoney } from './shipping-workflow/shipping-rate-money-classifier';
import { isPricedRate } from './rates-combined';
import { stampRateSourceDisplay } from './rate-source-display';
// PS-292 (item 2): the backend-owned SHIPP house-tuple freshness verdict. Computed + stamped at SAVE
// (the route has client opt-in + the raw provider); persisted into best_rate_json and round-tripped
// here so the awaiting row renders 'House rate needs refresh' verbatim instead of a plain SHIPP amount.
import type { HouseTupleStatus } from './shipping-workflow/house-tuple-save-policy';

// ── Inlined DTO types (v2 parity) ────────────────────────────────────────────

export interface OrderBestRateDto {
  serviceCode: string | null;
  serviceName: string | null;
  packageType: string | null;
  // PS-500: `shipmentCost` and `otherCost` below are the DISPLAY values and are
  // still defaulted to 0 when the payload omitted them, which is why a consumer
  // cannot tell "the backend sent nothing" from "the backend sent zero" by
  // reading them. The three fields below are classified BEFORE that defaulting
  // and are the only honest answer to "was this money actually supplied".
  //
  // Money only. Selectability also needs quote proof, freshness, eligibility and
  // carrier completeness, which are owned elsewhere — hence the name.
  rateMoneyComplete: boolean;
  rateMoneyUnavailableReason: string | null;
  rateMoneyUnavailableMessage: string | null;
  shipmentCost: number;
  otherCost: number;
  insuranceCost: number | null;
  insuranceProvenance: string | null;
  totalCost: number | null;
  rateDetails: unknown[];
  carrierCode: string | null;
  shippingProviderId: number | null;
  carrierNickname: string | null;
  rateSourceKind: string | null;
  rateSourceLabel: string | null;
  rateSourceDetail: string | null;
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
  selectionRef: string | null;
  // PS-299: generic runner-up rate for Awaiting Shipment. This is the second cheapest
  // eligible/priced result from the SAME finalized backend rate-shopping pass as this
  // bestRate. It is not the house-account nextBestNonHouseRate competitor.
  secondBestRate: SecondBestRateDto | null;
  // PS-220 house-margin (projected): captured at best-rate SAVE when SHIPP wins for an opted-in
  // client. nextBestNonHouseRate = the cheapest ELIGIBLE non-SHIPP rate (the customer_rate basis,
  // portal-OK). houseMargin = customer_rate - drp_cost (>= 0), INTERNAL (redacted from client
  // serializers via RATE_MONEY_FIELD_KEYS). Both null on non-house orders. MUST live on the DTO —
  // normalizeOrderBestRateDto is a whitelist with no spread, so a bare best_rate_json key is dropped.
  nextBestNonHouseRate: NextBestNonHouseRateDto | null;
  houseMargin: number | null;
  // PS-356/PS-367: separated rate money model.
  cShippingRateAmount: number | null;
  selectedRateCost: number | null;
  shippingMarginAmount: number | null;
  shippingMarginPct: number | null;
  houseApplied: boolean | null;
  houseBadgeVisible: boolean | null;
  customerRateSource: string | null;
  rateCostSource: string | null;
  // PS-292 (item 2): backend-owned house-tuple freshness verdict, stamped at SAVE + persisted here.
  // 'needs_refresh' = a SHIPP/house winner for an opted-in client whose competitor tuple is ABSENT
  // (re-rate required); 'present' = tuple resolved (incl. the genuine $0-margin pass-through);
  // 'not_house' = non-house. null on legacy rows never stamped. The FE renders it; it never recomputes.
  houseTupleStatus: HouseTupleStatus | null;
  // PS-290 (slice 1): HUGRAB $100-insurance COVERAGE STATUS verdict — backend-owned, derived
  // from the insurance fields above + isHugrab via resolveInsuranceCoverageStatus. 'not_required'
  // on non-HUGRAB rows; the FE renders insuranceBadgeLabel/insuranceBadgeTone, never recomputes.
  insuranceCoverageStatus: InsuranceCoverageStatus;
  insuranceBadgeLabel: string;
  insuranceBadgeTone: InsuranceCoverageBadgeTone;
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
  // PS-261 (display slice): the HUGRAB label-PURCHASE-GATE verdict for THIS rate — backend-owned,
  // mapped from insuranceCoverageStatus via the SAME PS-261 gate the buy-path preflight uses
  // (resolveHugrabLabelPurchaseGate). true when the mandatory $100 coverage is PROVEN (purchase
  // allowed); false when it is missing / unproven / unsupported (purchase BLOCKED). The Rate Browser
  // renders this pre-purchase so the operator sees the BLOCK before buying — verbatim, no recompute.
  // allow === true + empty reason on non-HUGRAB rows (the indicator renders nothing).
  hugrabPurchaseAllowed: boolean;
  hugrabPurchaseBlockReason: string;
  // PS-279 (backend-ownership pillar): the backend-owned rate BLOCK/eligibility verdict for THIS
  // rate, delegated to evaluateShippingServiceEligibility. eligibilityBlocked === true means the
  // rate fails an eligibility rule (e.g. HUGRAB UPS Ground Saver, an insurance-unsupported carrier,
  // or a disabled Automation service) and must NOT be selectable; eligibilityBlockReason carries the
  // operator-facing reason. The Rate Browser renders this verbatim instead of re-deriving the
  // block-list reason. Defaults to UNBLOCKED (null reason) when no eligibility context is supplied.
  eligibilityBlocked: boolean;
  eligibilityBlockReason: string | null;
}

export interface NextBestNonHouseRateDto {
  carrierCode: string | null;
  serviceCode: string | null;
  shipmentCost: number;
  otherCost: number;
  totalCost: number;
  providerAccountId: number | null;
  // PS-220-D: the REAL number of eligible priced non-SHIPP competitors the resolver saw
  // (competitors.length). Carried verbatim so the realized capture reports the true count instead
  // of the legacy hardcoded `competitor ? 1 : 0`. Optional/null on older stamps (capture falls back).
  competitorCount?: number | null;
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
  // PS-290 (slice 1): HUGRAB $100-insurance COVERAGE STATUS verdict (see OrderBestRateDto).
  insuranceCoverageStatus: InsuranceCoverageStatus;
  insuranceBadgeLabel: string;
  insuranceBadgeTone: InsuranceCoverageBadgeTone;
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
  // PS-261 (display slice): HUGRAB label-PURCHASE-GATE verdict (see OrderBestRateDto).
  hugrabPurchaseAllowed: boolean;
  hugrabPurchaseBlockReason: string;
  // PS-279 (backend-ownership pillar): backend-owned rate BLOCK/eligibility verdict (see OrderBestRateDto).
  eligibilityBlocked: boolean;
  eligibilityBlockReason: string | null;
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

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 10;
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

// PS-290 — derive the HUGRAB signal: an explicit ctx flag wins; otherwise read an
// isHugrab / is_hugrab key the caller stamped onto the rate JSON. Defaults to false so
// non-HUGRAB rows resolve to coverage 'not_required' (no badge).
function readIsHugrab(record: Record<string, unknown>, ctxIsHugrab?: boolean | null): boolean {
  if (typeof ctxIsHugrab === 'boolean') return ctxIsHugrab;
  const raw = record.isHugrab ?? record.is_hugrab;
  return raw === true;
}

// PS-290 — populate the backend-owned HUGRAB $100-insurance coverage triple by delegating to
// the canonical pure resolver. The DTO is the ONLY place that calls it; the FE renders the result.
function resolveCoverageFields(args: {
  isHugrab: boolean;
  insuranceProvider: string | null;
  insuredValue: number | null;
  insuranceCost: number | null;
  insuranceProvenance: string | null;
  insuranceCertainty: unknown;
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
  isShippBrokered: boolean;
}): {
  insuranceCoverageStatus: InsuranceCoverageStatus;
  insuranceBadgeLabel: string;
  insuranceBadgeTone: InsuranceCoverageBadgeTone;
  insuranceCoverageProofSource: InsuranceCoverageProofSource | null;
  // PS-261 (display slice) — the purchase-gate verdict, derived from the SAME coverage status.
  hugrabPurchaseAllowed: boolean;
  hugrabPurchaseBlockReason: string;
} {
  const verdict = resolveInsuranceCoverageStatus({
    isHugrab: args.isHugrab,
    insuranceProvider: args.insuranceProvider,
    insuredValue: args.insuredValue,
    insuranceCost: args.insuranceCost,
    insuranceProvenance: args.insuranceProvenance,
    insuranceCertainty: typeof args.insuranceCertainty === 'string' ? args.insuranceCertainty : null,
    insuranceCoverageProofSource: args.insuranceCoverageProofSource,
    isShippBrokered: args.isShippBrokered,
  });
  // PS-261 — map the PS-290 coverage status to the label-purchase decision with the SAME gate the
  // buy-path preflight uses, so the Rate Browser pre-purchase indicator and the buy-path BLOCK
  // agree by construction. The reason is empty on non-HUGRAB rows (allow + no indicator).
  const gate = resolveHugrabLabelPurchaseGate(verdict.status);
  return {
    insuranceCoverageStatus: verdict.status,
    insuranceBadgeLabel: verdict.badgeLabel,
    insuranceBadgeTone: verdict.badgeTone,
    insuranceCoverageProofSource: verdict.insuranceCoverageProofSource,
    hugrabPurchaseAllowed: gate.allow,
    hugrabPurchaseBlockReason: verdict.status === 'not_required' ? '' : gate.reason,
  };
}

// PS-279 — stamp the backend-owned eligibility BLOCK verdict for this rate, delegating to the
// canonical resolver. Builds the eligibility descriptor from the normalized rate identity + raw
// provider key. Inert (UNBLOCKED) when no eligibility context is supplied — older callers unchanged.
function resolveEligibilityFields(args: {
  record: Record<string, unknown>;
  carrierCode: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  carrierNickname: string | null;
  context?: ShippingServiceEligibilityContext | null;
}): { eligibilityBlocked: boolean; eligibilityBlockReason: string | null } {
  return resolveRateEligibilityStamp({
    context: args.context,
    service: {
      carrierCode: args.carrierCode,
      carrierName: args.carrierNickname,
      provider: readNullableString(args.record.provider ?? null, 'rate.provider'),
      serviceCode: args.serviceCode,
      serviceName: args.serviceName,
      serviceType: readNullableString(args.record.service_type ?? args.record.serviceType ?? null, 'rate.serviceType'),
    },
  });
}

// PS-290 — the insured value / certainty the resolver reads, sourced from the raw rate JSON
// (the normalizers do not otherwise carry insuredValue/certainty as DTO fields).
function readRateInsuredValue(record: Record<string, unknown>): number | null {
  const insuranceMeta = isRecord(record.insuranceCost) ? record.insuranceCost : null;
  return (
    readNullableNumber(
      record.insuredValue ?? record.insured_value ?? insuranceMeta?.insuredValue ?? null,
      'rate.insuredValue',
    )
  );
}

function readRateInsuranceProvider(record: Record<string, unknown>): string | null {
  const insuranceMeta = isRecord(record.insuranceCost) ? record.insuranceCost : null;
  return readNullableString(
    record.insuranceProvider ?? record.insurance_provider ?? insuranceMeta?.insuranceProvider ?? null,
    'rate.insuranceProvider',
  );
}

function readRateInsuranceCertainty(record: Record<string, unknown>): unknown {
  const certaintyMeta = isRecord(record.insuranceCertainty) ? record.insuranceCertainty : null;
  return certaintyMeta?.certainty ?? record.insuranceCertainty ?? null;
}

export interface SecondBestRateDto {
  carrierCode: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  carrierNickname: string | null;
  shippingProviderId: number | null;
  rateSourceKind: string | null;
  rateSourceLabel: string | null;
  rateSourceDetail: string | null;
  shipmentCost: number;
  otherCost: number;
  insuranceCost: number | null;
  totalCost: number | null;
  requestFingerprint: string | null;
  cacheKey: string | null;
  cacheCreatedAt: string | null;
  cacheExpiresAt: string | null;
  eligibilityVersion: string | null;
  isComplete: boolean | null;
  rateCount: number | null;
  matchType: string | null;
  proofSource: string | null;
  rateQuoteId: string | null;
  selectedRateKey: string | null;
  selectionRef: string | null;
}

function readRateInsuranceCoverageProofSource(record: Record<string, unknown>): InsuranceCoverageProofSource | null {
  const raw = record.insuranceCoverageProofSource ?? record.insurance_coverage_proof_source ?? null;
  return raw === 'shipp_customs_value' ? 'shipp_customs_value' : null;
}

function readRateIsShippBrokered(record: Record<string, unknown>): boolean {
  return isShippBrokered({
    provider: readNullableString(record.provider ?? null, 'rate.provider'),
    accountIdentity: readNullableString(
      record.accountIdentity ?? record.carrierNickname ?? record.carrier_nickname ?? record._carrierName ?? null,
      'rate.accountIdentity',
    ),
    serviceCode: readNullableString(record.serviceCode ?? record.service_code ?? null, 'rate.serviceCode'),
  });
}

function normalizeRateSourceDisplay(
  record: Record<string, unknown>,
  path: string,
): Pick<OrderBestRateDto, 'rateSourceKind' | 'rateSourceLabel' | 'rateSourceDetail'> {
  // Provider identity is backend truth. Re-stamp from the verbatim backend
  // rate when Apply wrapped it, instead of trusting a client-supplied label.
  const backendRate = isRecord(record.raw) ? record.raw : record;
  const stamped = stampRateSourceDisplay(backendRate);
  return {
    rateSourceKind: readNullableString(stamped.rateSourceKind ?? null, `${path}.rateSourceKind`),
    rateSourceLabel: readNullableString(stamped.rateSourceLabel ?? null, `${path}.rateSourceLabel`),
    rateSourceDetail: readNullableString(stamped.rateSourceDetail ?? null, `${path}.rateSourceDetail`),
  };
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
// PS-220: normalize the projected next-best (competitor) rate carried on best_rate_json. Tolerates
// camelCase + snake_case; returns null when absent so non-house orders carry null.
function normalizeNextBestNonHouseRate(value: unknown, path = 'bestRate.nextBestNonHouseRate'): NextBestNonHouseRateDto | null {
  if (!isRecord(value)) return null;
  const shipmentCost = readNumber(value.shipmentCost ?? value.shipment_cost ?? 0, `${path}.shipmentCost`);
  const otherCost = readNumber(value.otherCost ?? value.other_cost ?? 0, `${path}.otherCost`);
  return {
    carrierCode: readNullableString(value.carrierCode ?? value.carrier_code ?? null, `${path}.carrierCode`),
    serviceCode: readNullableString(value.serviceCode ?? value.service_code ?? null, `${path}.serviceCode`),
    shipmentCost,
    otherCost,
    totalCost: readNullableNumber(value.totalCost ?? value.total_cost ?? null, `${path}.totalCost`) ?? shipmentCost + otherCost,
    providerAccountId: readNullableProviderAccountId(
      value.providerAccountId ?? value.provider_account_id ?? value.shippingProviderId ?? null,
      `${path}.providerAccountId`,
    ),
    // PS-220-D: the REAL eligible-priced-non-SHIPP competitor count from the resolver, threaded
    // through verbatim (null on older stamps that did not carry it).
    competitorCount: readNullableNumber(value.competitorCount ?? value.competitor_count ?? null, `${path}.competitorCount`),
  };
}

function normalizeSecondBestRate(value: unknown, path = 'bestRate.secondBestRate'): SecondBestRateDto | null {
  if (!isRecord(value)) return null;
  const shippingAmount = isRecord(value.shipping_amount) ? value.shipping_amount : null;
  const otherAmount = isRecord(value.other_amount) ? value.other_amount : null;
  const confirmationAmount = isRecord(value.confirmation_amount) ? value.confirmation_amount : null;
  const insuranceAmount = isRecord(value.insurance_amount) ? value.insurance_amount : null;
  const insuranceCost = readMoneyAmount(value.insuranceCost ?? value.insuranceAmount ?? insuranceAmount) ?? null;
  const shipmentCost = readNumber(
    value.shipmentCost ?? shippingAmount?.amount ?? value.cost ?? value.amount ?? 0,
    `${path}.shipmentCost`,
  );
  const otherCost =
    readNumber(value.otherCost ?? otherAmount?.amount ?? 0, `${path}.otherCost`) +
    (typeof confirmationAmount?.amount === 'number' && Number.isFinite(confirmationAmount.amount)
      ? confirmationAmount.amount
      : 0) +
    (typeof value.otherCost === 'number'
      ? 0
      : typeof insuranceAmount?.amount === 'number' && Number.isFinite(insuranceAmount.amount)
        ? insuranceAmount.amount
        : 0);
  const rate: SecondBestRateDto = {
    carrierCode: readNullableString(value.carrierCode ?? value.carrier_code ?? value.carrier ?? null, `${path}.carrierCode`),
    serviceCode: readNullableString(value.serviceCode ?? value.service_code ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(
      value.serviceName ?? value.service_type ?? value.serviceCode ?? value.service_code ?? null,
      `${path}.serviceName`,
    ),
    carrierNickname: readNullableString(
      value.carrierNickname ?? value.carrier_nickname ?? value._carrierName ?? null,
      `${path}.carrierNickname`,
    ),
    shippingProviderId: readNullableProviderAccountId(
      value.shippingProviderId ?? value.providerAccountId ?? value.carrier_id ?? null,
      `${path}.shippingProviderId`,
    ),
    ...normalizeRateSourceDisplay(value, path),
    shipmentCost,
    otherCost,
    insuranceCost,
    totalCost: readNullableNumber(value.totalCost ?? value.total_cost ?? null, `${path}.totalCost`) ?? shipmentCost + otherCost,
    requestFingerprint: readNullableString(value.requestFingerprint ?? null, `${path}.requestFingerprint`),
    cacheKey: readNullableString(value.cacheKey ?? null, `${path}.cacheKey`),
    cacheCreatedAt: readNullableString(value.cacheCreatedAt ?? null, `${path}.cacheCreatedAt`),
    cacheExpiresAt: readNullableString(value.cacheExpiresAt ?? null, `${path}.cacheExpiresAt`),
    eligibilityVersion: readNullableString(value.eligibilityVersion ?? null, `${path}.eligibilityVersion`),
    isComplete: value.isComplete == null ? null : readBoolean(value.isComplete, `${path}.isComplete`),
    rateCount: readNullableNumber(value.rateCount ?? null, `${path}.rateCount`),
    matchType: readNullableString(value.matchType ?? null, `${path}.matchType`),
    proofSource: readNullableString(value.proofSource ?? null, `${path}.proofSource`),
    rateQuoteId: readNullableString(value.rateQuoteId ?? null, `${path}.rateQuoteId`),
    selectedRateKey: readNullableString(value.selectedRateKey ?? null, `${path}.selectedRateKey`),
    selectionRef: readNullableString(value.selectionRef ?? null, `${path}.selectionRef`),
  };
  return rate.serviceCode || rate.carrierCode || rate.shippingProviderId != null || rate.shipmentCost + rate.otherCost > 0
    ? rate
    : null;
}

export function normalizeOrderBestRateDto(
  value: unknown,
  path = 'bestRate',
  // PS-290 — optional HUGRAB signal. When omitted, isHugrab is read off an isHugrab/is_hugrab
  // key on the rate JSON (defaulting to false), so non-HUGRAB rows resolve to 'not_required'.
  // PS-279 — optional eligibility context (client/store identity). When supplied, the DTO stamps
  // the backend-owned eligibility block verdict; when omitted, the rate defaults to UNBLOCKED.
  ctx?: { isHugrab?: boolean | null; eligibility?: ShippingServiceEligibilityContext | null },
): OrderBestRateDto | null {
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
  const totalCost =
    readNullableNumber(record.totalCost ?? record.total_cost ?? null, `${path}.totalCost`) ?? shipmentCost + otherCost;
  const nextBestNonHouseRate = normalizeNextBestNonHouseRate(record.nextBestNonHouseRate, `${path}.nextBestNonHouseRate`);
  const houseMargin = readNullableNumber(record.houseMargin ?? null, `${path}.houseMargin`);
  const shippingRateMoney = normalizeShippingRateMoney({
    ...record,
    shipmentCost,
    otherCost,
    cShippingRateAmount: record.cShippingRateAmount ?? nextBestNonHouseRate?.totalCost,
    selectedRateCost: record.selectedRateCost ?? totalCost,
  });
  const rawHouseApplied = record.houseApplied ?? record.house_applied ?? null;
  const houseApplied = rawHouseApplied == null ? (houseMargin != null ? true : null) : readBoolean(rawHouseApplied, `${path}.houseApplied`);
  const rawHouseBadgeVisible = record.houseBadgeVisible ?? record.house_badge_visible ?? null;
  const houseBadgeVisible =
    rawHouseBadgeVisible == null ? (houseApplied === true ? true : null) : readBoolean(rawHouseBadgeVisible, `${path}.houseBadgeVisible`);
  // PS-500: classify BEFORE any defaulting. `record` is the payload as received.
  const verdict = classifyRateMoney(record);
  const moneyVerdict = {
    rateMoneyComplete: verdict.rateMoneyComplete,
    rateMoneyUnavailableReason: verdict.rateMoneyUnavailableReason,
    rateMoneyUnavailableMessage: verdict.rateMoneyUnavailableMessage,
  };
  const rate: OrderBestRateDto = {
    serviceCode: readNullableString(record.serviceCode ?? record.service_code ?? null, `${path}.serviceCode`),
    serviceName: readNullableString(
      record.serviceName ?? record.service_type ?? record.serviceCode ?? record.service_code ?? null,
      `${path}.serviceName`,
    ),
    packageType: readNullableString(record.packageType ?? record.package_type ?? null, `${path}.packageType`),
    // PS-500: classified from the ORIGINAL record, before the defaulting above
    // turned an absent shipmentCost/otherCost into 0. Reading the normalized
    // values here would be circular — they can no longer say whether the
    // backend supplied anything.
    ...moneyVerdict,
    shipmentCost,
    otherCost,
    insuranceCost,
    insuranceProvenance,
    totalCost,
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
    ...normalizeRateSourceDisplay(record, path),
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
    selectionRef: readNullableString(record.selectionRef ?? null, `${path}.selectionRef`),
    secondBestRate: normalizeSecondBestRate(record.secondBestRate ?? record.second_best_rate, `${path}.secondBestRate`),
    nextBestNonHouseRate,
    houseMargin,
    cShippingRateAmount: shippingRateMoney.cShippingRateAmount,
    selectedRateCost: shippingRateMoney.selectedRateCost,
    shippingMarginAmount: shippingRateMoney.shippingMarginAmount,
    shippingMarginPct: shippingRateMoney.shippingMarginPct,
    houseApplied,
    houseBadgeVisible,
    customerRateSource: readNullableString(
      record.customerRateSource ??
        record.customer_rate_source ??
        (houseApplied === true ? 'projected_customer_shipping_rate' : 'best_rate_marked_amount'),
      `${path}.customerRateSource`,
    ),
    rateCostSource: readNullableString(
      record.rateCostSource ?? record.rate_cost_source ?? (houseApplied === true ? 'shipp_house_internal_cost' : 'best_rate_internal_cost'),
      `${path}.rateCostSource`,
    ),
    // PS-292 (item 2): round-trip the persisted house-tuple verdict (stamped at SAVE). Unknown/absent
    // (legacy rows) => null, byte-identical for non-house rows.
    houseTupleStatus:
      record.houseTupleStatus === 'present' ||
      record.houseTupleStatus === 'needs_refresh' ||
      record.houseTupleStatus === 'not_house'
        ? (record.houseTupleStatus as HouseTupleStatus)
        : null,
    // PS-290 — backend-owned HUGRAB $100-insurance coverage verdict (delegated to the resolver).
    ...resolveCoverageFields({
      isHugrab: readIsHugrab(record, ctx?.isHugrab),
      insuranceProvider: readRateInsuranceProvider(record),
      insuredValue: readRateInsuredValue(record),
      insuranceCost,
      insuranceProvenance,
      insuranceCertainty: readRateInsuranceCertainty(record),
      insuranceCoverageProofSource: readRateInsuranceCoverageProofSource(record),
      isShippBrokered: readRateIsShippBrokered(record),
    }),
    // PS-279 — backend-owned rate BLOCK/eligibility verdict (delegated to the canonical evaluator).
    ...resolveEligibilityFields({
      record,
      carrierCode: readNullableString(record.carrierCode ?? record.carrier_code ?? record.carrier ?? null, `${path}.carrierCode`),
      serviceCode: readNullableString(record.serviceCode ?? record.service_code ?? null, `${path}.serviceCode`),
      serviceName: readNullableString(
        record.serviceName ?? record.service_type ?? record.serviceCode ?? record.service_code ?? null,
        `${path}.serviceName`,
      ),
      carrierNickname: readNullableString(
        record.carrierNickname ?? record.carrier_nickname ?? record._carrierName ?? null,
        `${path}.carrierNickname`,
      ),
      context: ctx?.eligibility,
    }),
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
  // PS-290 — optional HUGRAB signal (same semantics as normalizeOrderBestRateDto).
  // PS-279 — optional eligibility context (same semantics as normalizeOrderBestRateDto).
  ctx?: { isHugrab?: boolean | null; eligibility?: ShippingServiceEligibilityContext | null },
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
    // PS-290 — backend-owned HUGRAB $100-insurance coverage verdict (delegated to the resolver).
    ...resolveCoverageFields({
      isHugrab: readIsHugrab(record, ctx?.isHugrab),
      insuranceProvider: readRateInsuranceProvider(record),
      insuredValue: readRateInsuredValue(record),
      insuranceCost,
      insuranceProvenance,
      insuranceCertainty: readRateInsuranceCertainty(record),
      insuranceCoverageProofSource: readRateInsuranceCoverageProofSource(record),
      isShippBrokered: readRateIsShippBrokered(record),
    }),
    // PS-279 — backend-owned rate BLOCK/eligibility verdict (delegated to the canonical evaluator).
    ...resolveEligibilityFields({
      record,
      carrierCode: readNullableString(record.carrierCode ?? fallback?.carrierCode ?? null, `${path}.carrierCode`),
      serviceCode: readNullableString(record.serviceCode ?? fallback?.serviceCode ?? null, `${path}.serviceCode`),
      serviceName: readNullableString(
        record.serviceName ?? record.serviceCode ?? fallback?.serviceCode ?? null,
        `${path}.serviceName`,
      ),
      carrierNickname: readNullableString(record.providerAccountNickname ?? null, `${path}.providerAccountNickname`),
      context: ctx?.eligibility,
    }),
  };

  return hasAnyMeaningfulSelectedRateField(rate) ? rate : null;
}

// PS-137: the Orders list/export bestRate normalizer, co-located with its owner
// normalizeOrderBestRateDto (rate truth lives in this service per ARCHITECTURE.md). Thin wrapper:
// normalize, reject a non-chargeable rate (no positive amount), then add the list DTO aliases
// (amount/cost/providerAccountId/providerAccountNickname). Consumed by GET '/' (list) and GET '/export'.
// Root-cause fix (order 1338387): a $0 best rate that still carries a carrier+service (an unpriced
// ShipStation UPS account) must NOT be emitted as a list best — it fails every downstream
// positive-amount display gate and renders as "Rate unavailable". A best rate with no positive
// amount is not a usable best rate, regardless of whether carrier/service are present.
export function normalizeListBestRate(value: unknown) {
  try {
    const bestRate = normalizeOrderBestRateDto(value);
    if (!bestRate) return null;
    if (!isPricedRate(value as Parameters<typeof isPricedRate>[0])) return null;
    const amount = bestRate.shipmentCost + bestRate.otherCost;
    if (!(amount > 0)) return null;
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
