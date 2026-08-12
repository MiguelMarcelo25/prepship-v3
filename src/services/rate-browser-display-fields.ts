import { stampPurchaseCustomerRateAliases } from './shipping-workflow/purchase-customer-rate-aliases.js';
// PS-500: the common live/cache browse boundary must carry the money verdict too.
import { classifyRateMoney } from './shipping-workflow/shipping-rate-money-classifier';
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

function toRateProviderAccountId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stampRateBrowserDisplayAlias(rate: Record<string, unknown>): Record<string, unknown> {
  // PS-500: classify from the ORIGINAL row, before this function and
  // stampPurchaseCustomerRateAliases default anything. Otherwise a live row with
  // `amount: 9.75, otherCost: 1.50` and no shipmentCost is laundered into
  // `shipmentCost: 9.75` — the exact total-as-component substitution this ticket
  // removes — and still reaches handleRateClick(), because the availability
  // check inspects proof and eligibility but never money completeness.
  const moneyVerdict = classifyRateMoney(rate);
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

  const stamped = stampPurchaseCustomerRateAliases({
    ...rate,
    ...(carrierCode ? { carrierCode } : {}),
    ...(serviceCode ? { serviceCode } : {}),
    ...(serviceName ? { serviceName } : {}),
    ...(carrierNickname ? { carrierNickname } : {}),
    ...(shippingProviderId != null ? { shippingProviderId } : {}),
    secondBestRate: isPlainRecord(rate.secondBestRate)
      ? stampRateBrowserDisplayAlias(rate.secondBestRate)
      : rate.secondBestRate,
  });

  // PS-500: applied to the RESULT, not folded into the literal above, so the
  // verdict cannot be overwritten by the alias stamper it wraps — that stamper
  // is the thing that derives `purchaseShipmentCost = purchaseTotal - otherCost`
  // and defaults missing money, so its output must not be able to claim the
  // money was complete. The verdict describes `rate` as received.
  return {
    ...stamped,
    rateMoneyComplete: moneyVerdict.rateMoneyComplete,
    rateMoneyUnavailableReason: moneyVerdict.rateMoneyUnavailableReason,
    rateMoneyUnavailableMessage: moneyVerdict.rateMoneyUnavailableMessage,
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
