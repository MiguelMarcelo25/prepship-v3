import { rateCostTotal, rateTotal } from './rates-combined';
import {
  resolveHugrabLabelPurchasePreflight,
  resolveShippCustomsValueProofSource,
} from './shipping-workflow/hugrab-label-purchase-preflight';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text ? text : null;
  }
  return null;
}

function readMoneyObjectAmount(value: unknown): number {
  if (!isPlainRecord(value)) return 0;
  const amount = Number(value.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

function readFiniteRateNumber(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function roundRateMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function toRateProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stampRateBrowserDisplayAlias(rate: Record<string, unknown>): Record<string, unknown> {
  const otherCost = roundRateMoney(
    readMoneyObjectAmount(rate.other_amount) +
    readMoneyObjectAmount(rate.confirmation_amount) +
    readMoneyObjectAmount(rate.insurance_amount)
  );
  const total = roundRateMoney(rateTotal(rate));
  const rateCostAmount = roundRateMoney(rateCostTotal(rate));
  const shipmentCost = roundRateMoney(total - otherCost);
  const carrierCode = readText(rate.carrierCode ?? rate.carrier_code ?? rate.provider ?? null);
  const serviceCode = readText(rate.serviceCode ?? rate.service_code ?? rate.service ?? null);
  const serviceName = readText(rate.serviceName ?? rate.service_type ?? rate.serviceCode ?? rate.service_code ?? null);
  const carrierNickname = readText(
    rate.carrierNickname ??
    rate.carrier_nickname ??
    rate.providerAccountNickname ??
    rate.accountNickname ??
    rate.accountIdentity ??
    rate._carrierName ??
    null
  );
  const shippingProviderId = toRateProviderAccountId(
    rate.shippingProviderId ?? rate.providerAccountId ?? rate.carrier_id ?? null
  );

  return {
    ...rate,
    ...(carrierCode ? { carrierCode } : {}),
    ...(serviceCode ? { serviceCode } : {}),
    ...(serviceName ? { serviceName } : {}),
    ...(carrierNickname ? { carrierNickname } : {}),
    ...(shippingProviderId != null ? { shippingProviderId } : {}),
    amount: readFiniteRateNumber(rate.amount) ?? total,
    shipmentCost: readFiniteRateNumber(rate.shipmentCost) ?? shipmentCost,
    otherCost: readFiniteRateNumber(rate.otherCost) ?? otherCost,
    customerRateAmount: readFiniteRateNumber(rate.customerRateAmount) ?? readFiniteRateNumber(rate.customer_rate_amount) ?? total,
    customer_rate_amount: readFiniteRateNumber(rate.customer_rate_amount) ?? readFiniteRateNumber(rate.customerRateAmount) ?? total,
    rateCostAmount: readFiniteRateNumber(rate.rateCostAmount) ?? readFiniteRateNumber(rate.rate_cost_amount) ?? rateCostAmount,
    rate_cost_amount: readFiniteRateNumber(rate.rate_cost_amount) ?? readFiniteRateNumber(rate.rateCostAmount) ?? rateCostAmount,
    secondBestRate: isPlainRecord(rate.secondBestRate)
      ? stampRateBrowserDisplayAlias(rate.secondBestRate)
      : rate.secondBestRate,
  };
}

export function stampRateBrowserDisplayAliases<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => (
      isPlainRecord(entry) ? stampRateBrowserDisplayAlias(entry) : entry
    )) as T;
  }
  if (isPlainRecord(value)) {
    return stampRateBrowserDisplayAlias(value) as T;
  }
  return value;
}

function readRateInsuranceCost(rate: Record<string, unknown>): number {
  const meta = isPlainRecord(rate.insuranceCost) ? rate.insuranceCost : null;
  const metaAmount = Number(meta?.amount ?? NaN);
  if (Number.isFinite(metaAmount)) return metaAmount;
  return readMoneyObjectAmount(rate.insurance_amount);
}

function readRateInsuranceProvenance(rate: Record<string, unknown>): string | null {
  const meta = isPlainRecord(rate.insuranceCost) ? rate.insuranceCost : null;
  return readText(meta?.provenance ?? rate.insuranceProvenance ?? rate.insurance_provenance ?? null);
}

export function stampHugrabCoverageDisplayFields<T extends Record<string, unknown>>(
  rate: T,
  context: {
    isHugrab: boolean;
    insuranceProvider: string | null;
    insuredValue: number | null;
    shippCustomsValueProofEnabled: boolean;
  },
): T {
  const provider = readText(rate.provider ?? rate.carrierProvider ?? rate.carrier_code ?? null);
  const accountIdentity = readText(
    rate.accountIdentity ?? rate.carrierNickname ?? rate.carrier_nickname ?? rate._carrierName ?? null,
  );
  const serviceCode = readText(rate.serviceCode ?? rate.service_code ?? null);
  const proofSource = resolveShippCustomsValueProofSource({
    enabled: context.shippCustomsValueProofEnabled,
    provider,
    accountIdentity,
    serviceCode,
    insuredValue: context.insuredValue,
  });
  const preflight = resolveHugrabLabelPurchasePreflight({
    isHugrab: context.isHugrab,
    insuranceProvider: context.insuranceProvider,
    insuredValue: context.insuredValue,
    insuranceCost: readRateInsuranceCost(rate),
    insuranceProvenance: readRateInsuranceProvenance(rate),
    provider,
    accountIdentity,
    serviceCode,
    isDirectVerifiedAccount: context.insuranceProvider === 'carrier' && provider !== 'shipp',
    insuranceCoverageProofSource: proofSource,
  });
  return {
    ...rate,
    insuranceProvider: context.insuranceProvider,
    insuredValue: context.insuredValue,
    insuranceCoverageStatus: preflight.status,
    insuranceBadgeLabel: preflight.insuranceBadgeLabel,
    insuranceBadgeTone: preflight.insuranceBadgeTone,
    insuranceCoverageProofSource: preflight.insuranceCoverageProofSource,
    hugrabPurchaseAllowed: preflight.allow,
    hugrabPurchaseBlockReason: preflight.status === 'not_required' ? '' : preflight.reason,
  };
}
