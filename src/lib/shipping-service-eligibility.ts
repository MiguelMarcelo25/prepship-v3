import { normalizeInsurance, type NormalizedInsuranceProvider } from './shipping-options.js';
import { effectiveInsuranceProviderForAccount, resolveAccountInsuranceCapability } from './carrier-account-registry.js';

export const SHIPPING_SERVICE_ELIGIBILITY_VERSION = 'ps-057-hugrab-ground-saver-v1';

// PS-072: HUGRAB default insured value (USD) for supported ground services.
export const HUGRAB_DEFAULT_INSURED_VALUE = 100;

export const HUGRAB_GROUND_SAVER_BLOCK_REASON =
  'UPS Ground Saver is disabled for HUGRAB orders. Choose UPS Ground or another service.';

export const UPS_GROUND_SAVER_INSURANCE_BLOCK_REASON =
  'Insurance is not available for UPS Ground Saver/SurePost. Choose UPS Ground or higher.';

export const HUGRAB_CARRIER_DISABLE_PROTECTED_REASON =
  'PS-057 locks services, not whole UPS carrier accounts. Leave the carrier enabled and keep Ground Saver/SurePost disabled.';

const HUGRAB_CLIENT_IDS = new Set([4]);
const HUGRAB_STORE_IDS = new Set([378060]);
const HUGRAB_NORMALIZED_NAMES = new Set(['hugrab']);
const HUGRAB_GROUND_SAVER_RULE_ID = 'hugrab-ups-ground-saver';

const HUGRAB_BLOCKED_SERVICE_CODES = new Set([
  'ups_ground_saver',
  'ups_surepost',
  'ups_surepost_1_lb_or_greater',
  'ups_surepost_less_than_1_lb',
  'easypost_ups_upsdap_upsgroundsavergreaterthan1lb',
  '92',
  '93',
]);

export type ShippingServiceEligibilityContext = {
  clientId?: number | string | null;
  clientName?: string | null;
  storeId?: number | string | null;
  /** Backend-resolved operator setting. Missing preserves the legacy enabled policy. */
  hugrabDefaultInsuranceEnabled?: boolean | null;
};

export type ShippingServiceOptionEligibilityContext = {
  insuranceProvider?: string | null;
  insuredValue?: number | string | null;
};

export type ShippingServiceDescriptor = {
  carrierId?: string | null;
  carrierCode?: string | null;
  carrierName?: string | null;
  provider?: string | null;
  serviceCode?: string | number | null;
  serviceName?: string | null;
  serviceType?: string | null;
};

export type ShippingAutomationRule = {
  type: 'carrier' | 'service';
  clientId?: number | string | null;
  storeId?: number | string | null;
  carrierId?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | number | null;
  serviceName?: string | null;
  disabled: boolean;
  reason?: string | null;
  locked?: boolean;
  source?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export type ShippingServiceEligibilityResult = {
  allowed: boolean;
  version: string;
  ruleId?: string;
  reason?: string;
};

function finiteNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeName(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeServiceKey(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeServiceIdentity(value: string | number | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchesContext(
  rule: Pick<ShippingAutomationRule, 'clientId' | 'storeId'>,
  context: ShippingServiceEligibilityContext | null | undefined,
): boolean {
  const ruleClientId = finiteNumber(rule.clientId);
  const contextClientId = finiteNumber(context?.clientId);
  if (ruleClientId != null && ruleClientId !== contextClientId) return false;
  const ruleStoreId = finiteNumber(rule.storeId);
  const contextStoreId = finiteNumber(context?.storeId);
  if (ruleStoreId != null && ruleStoreId !== contextStoreId) return false;
  return ruleClientId != null || ruleStoreId != null;
}

function matchesCarrierRule(
  rule: ShippingAutomationRule,
  service: ShippingServiceDescriptor | null | undefined,
): boolean {
  if (!service) return false;
  const ruleCarrierId = normalizeServiceIdentity(rule.carrierId);
  if (ruleCarrierId && ruleCarrierId === normalizeServiceIdentity(service.carrierId)) return true;
  const ruleCarrierCode = normalizeServiceIdentity(rule.carrierCode);
  if (ruleCarrierCode && ruleCarrierCode === normalizeServiceIdentity(service.carrierCode)) return true;
  if (!ruleCarrierId && !ruleCarrierCode) return false;
  return false;
}

function matchesServiceRule(
  rule: ShippingAutomationRule,
  service: ShippingServiceDescriptor | null | undefined,
): boolean {
  if (!service) return false;
  if (!matchesCarrierRule(rule, service) && (rule.carrierId || rule.carrierCode)) return false;
  const ruleCode = normalizeServiceKey(rule.serviceCode);
  if (ruleCode && ruleCode === normalizeServiceKey(service.serviceCode)) return true;
  const ruleName = normalizeServiceIdentity(rule.serviceName);
  if (ruleName) {
    return [
      service.serviceName,
      service.serviceType,
      service.serviceCode,
    ].map(normalizeServiceIdentity).some((value) => value === ruleName);
  }
  return false;
}

function matchingDisabledAutomationRule(
  rules: ShippingAutomationRule[] | null | undefined,
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
): ShippingAutomationRule | null {
  if (!rules?.length) return null;
  return rules.find((rule) => (
    rule.disabled === true &&
    rule.type === 'service' &&
    matchesContext(rule, context) &&
    matchesServiceRule(rule, service)
  )) ?? null;
}

export function isHugrabShippingContext(context: ShippingServiceEligibilityContext | null | undefined): boolean {
  if (!context) return false;
  const clientId = finiteNumber(context.clientId);
  if (clientId != null && HUGRAB_CLIENT_IDS.has(clientId)) return true;
  const storeId = finiteNumber(context.storeId);
  if (storeId != null && HUGRAB_STORE_IDS.has(storeId)) return true;
  return HUGRAB_NORMALIZED_NAMES.has(normalizeName(context.clientName));
}

/** True only when this is HUGRAB and its persisted automatic-insurance policy is active. */
export function isHugrabDefaultInsuranceRequired(
  context: ShippingServiceEligibilityContext | null | undefined,
): boolean {
  return isHugrabShippingContext(context) && context?.hugrabDefaultInsuranceEnabled !== false;
}

export function isUpsGroundSaverOrSurePostService(
  service: ShippingServiceDescriptor | null | undefined,
): boolean {
  if (!service) return false;
  const serviceCode = normalizeServiceKey(service.serviceCode);
  if (HUGRAB_BLOCKED_SERVICE_CODES.has(serviceCode)) return true;
  const identities = [
    service.serviceCode,
    service.serviceName,
    service.serviceType,
    service.carrierName,
    service.carrierCode,
    service.provider,
  ].map(normalizeServiceIdentity);
  return identities.some((value) => value.includes('groundsaver') || value.includes('surepost'));
}

export function isUpsCarrierAccount(service: ShippingServiceDescriptor | null | undefined): boolean {
  if (!service) return false;
  return [
    service.carrierCode,
    service.carrierName,
    service.provider,
  ].map(normalizeServiceIdentity).some((value) => value === 'ups' || value.includes('upswalleted'));
}

export function isHugrabCarrierDisableProtected(
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
): boolean {
  return isHugrabShippingContext(context) && isUpsCarrierAccount(service);
}

// PS-072: detect UPS Ground (NOT Ground Saver / SurePost, which PS-057 blocks).
export function isUpsGroundService(service: ShippingServiceDescriptor | null | undefined): boolean {
  if (!service) return false;
  if (isUpsGroundSaverOrSurePostService(service)) return false; // PS-057 — never default insurance here
  const isUps = [service.carrierCode, service.carrierName, service.provider]
    .map(normalizeServiceIdentity)
    .some((value) => value === 'ups' || value.includes('ups'));
  if (!isUps) return false;
  const svc = [service.serviceCode, service.serviceName, service.serviceType]
    .map(normalizeServiceIdentity)
    .join(' ');
  return svc.includes('upsground') || svc.includes('ground');
}

// PS-072: detect USPS Ground / Ground Advantage (NOT a UPS service).
export function isUspsGroundService(service: ShippingServiceDescriptor | null | undefined): boolean {
  if (!service) return false;
  if (isUpsGroundSaverOrSurePostService(service)) return false;
  const isUsps = [service.carrierCode, service.carrierName, service.provider]
    .map(normalizeServiceIdentity)
    .some((value) => value.includes('usps') || value.includes('stamps') || value === 'uspsdotcom');
  if (!isUsps) return false;
  const svc = [service.serviceCode, service.serviceName, service.serviceType]
    .map(normalizeServiceIdentity)
    .join(' ');
  return svc.includes('groundadvantage') || svc.includes('ground') || svc.includes('parcelselect');
}

export type EffectiveInsurance = {
  insuranceProvider: NormalizedInsuranceProvider;
  insuredValue: number | null;
  /** Where the effective value came from. */
  source: 'none' | 'operator' | 'hugrab-default';
  reason?: string;
};

/**
 * PS-072 → PS-214 — single source of truth for the effective insurance on a
 * shipment. Both rate quoting and label purchase MUST call this so the
 * displayed price and the purchased label agree.
 *
 * Rules:
 *  - Non-HUGRAB or policy disabled: pass the operator's selection through untouched.
 *  - HUGRAB + policy enabled + ANY service -> $100 coverage (or higher operator
 *    value). PS-214: the old rule only forced UPS Ground + USPS Ground —
 *    Shipp/FedEx/EasyPost ground-like services fell through to the operator
 *    passthrough and order #1476 shipped a Shipp/FedEx label UNINSURED while
 *    its rate fingerprint said parcelguard/$100. HUGRAB policy is "$100 on
 *    every label", not "only insure UPS/USPS". ParcelGuard is third-party
 *    coverage, so it needs NO carrier support; the capability resolver below
 *    picks carrier declared value only where that is verified-valid.
 *  - HUGRAB + Ground Saver/SurePost -> NEVER defaulted (PS-057); operator
 *    value passed through (evaluateShippingServiceEligibility blocks the
 *    service for HUGRAB anyway).
 *  - An operator-selected higher value (e.g. $250) is preserved via Math.max.
 *  - An operator selecting "none" on a HUGRAB service is still forced to the
 *    $100 default (HUGRAB policy).
 */
export function resolveEffectiveInsurance(
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
  operatorSelection?: { insuranceProvider?: unknown; insuredValue?: unknown; insurance?: unknown; insuranceValue?: unknown } | null,
): EffectiveInsurance {
  const operator = normalizeInsurance({
    insuranceProvider: operatorSelection?.insuranceProvider ?? operatorSelection?.insurance,
    insuredValue: operatorSelection?.insuredValue ?? operatorSelection?.insuranceValue,
  });
  const passthrough: EffectiveInsurance = {
    insuranceProvider: operator.insuranceProvider,
    insuredValue: operator.insuredValue,
    source: operator.insuranceProvider === 'none' ? 'none' : 'operator',
  };

  if (!isHugrabDefaultInsuranceRequired(context)) return passthrough;
  // PS-057: Ground Saver / SurePost are disabled for HUGRAB and cannot carry
  // insurance — never apply the default to them.
  if (isUpsGroundSaverOrSurePostService(service)) return passthrough;

  const operatorValue = operator.insuredValue ?? 0;
  const insuredValue = Number(Math.max(HUGRAB_DEFAULT_INSURED_VALUE, operatorValue).toFixed(2));
  const keptOperatorHigher = operatorValue > HUGRAB_DEFAULT_INSURED_VALUE;
  // PS-170: the PROVIDER is decided by the account's capability AND the insured value, not
  // hardcoded. A direct-UPS account that can purchase $0 carrier declared value resolves to
  // 'carrier' ONLY within the free $100 tier; above the cap (and any brokered account, or
  // while the verify gate is off) it resolves to 'parcelguard'. Always insured — never 'none'.
  const provider: NormalizedInsuranceProvider = effectiveInsuranceProviderForAccount({
    shippingProviderId: service?.carrierId ?? null,
    carrierCode: service?.carrierCode ?? null,
    serviceCode: service?.serviceCode ?? null,
    insuredValue,
  });
  const providerLabel = provider === 'carrier' ? 'carrier declared value' : 'Parcel Guard';
  const serviceFamily = isUpsGroundService(service)
    ? 'UPS Ground'
    : isUspsGroundService(service)
      ? 'USPS Ground'
      : `${service?.carrierCode ?? service?.provider ?? 'carrier'} service`;

  return {
    insuranceProvider: provider,
    insuredValue,
    source: keptOperatorHigher ? 'operator' : 'hugrab-default',
    reason: `HUGRAB default $${HUGRAB_DEFAULT_INSURED_VALUE} insurance via ${providerLabel} (${serviceFamily})`,
  };
}

/**
 * PS-170 — request-level HUGRAB insurance intent. The rate REQUEST spans every carrier,
 * so there is no single service/account yet: this sets the ParcelGuard request-level
 * provider + the $100-floored value used for the cache fingerprint and saved best-rate
 * proof. The PER-CANDIDATE provider (ParcelGuard vs direct-UPS carrier declared value)
 * is refined later during rate enrichment via resolveAccountInsuranceCapability.
 *
 * Single owner: services/rates.ts delegates here instead of duplicating the forcing.
 * A disabled persisted policy passes operator intent through unchanged.
 * Aligns the request-level value with the label's $100 floor (resolveEffectiveInsurance),
 * so a sub-$100 operator selection on a HUGRAB order no longer prices the rate below the
 * $100 the label actually insures.
 */
export function resolveHugrabRequestInsurance(
  context: ShippingServiceEligibilityContext | null | undefined,
  operatorSelection?: { insuranceProvider?: unknown; insuredValue?: unknown; insurance?: unknown; insuranceValue?: unknown } | null,
): EffectiveInsurance {
  const operator = normalizeInsurance({
    insuranceProvider: operatorSelection?.insuranceProvider ?? operatorSelection?.insurance,
    insuredValue: operatorSelection?.insuredValue ?? operatorSelection?.insuranceValue,
  });
  if (!isHugrabDefaultInsuranceRequired(context)) {
    return {
      insuranceProvider: operator.insuranceProvider,
      insuredValue: operator.insuredValue,
      source: operator.insuranceProvider === 'none' ? 'none' : 'operator',
    };
  }
  const operatorValue = operator.insuredValue ?? 0;
  const insuredValue = Number(Math.max(HUGRAB_DEFAULT_INSURED_VALUE, operatorValue).toFixed(2));
  const keptOperatorHigher = operatorValue > HUGRAB_DEFAULT_INSURED_VALUE;
  return {
    insuranceProvider: 'parcelguard',
    insuredValue,
    source: keptOperatorHigher ? 'operator' : 'hugrab-default',
    reason: `HUGRAB default $${HUGRAB_DEFAULT_INSURED_VALUE} insurance (ParcelGuard request-level; per-candidate provider refined at rate enrichment)`,
  };
}

export function evaluateShippingServiceEligibility(
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
  shippingOptions?: ShippingServiceOptionEligibilityContext | null,
  automationRules?: ShippingAutomationRule[] | null,
): ShippingServiceEligibilityResult {
  if (isHugrabShippingContext(context) && isUpsGroundSaverOrSurePostService(service)) {
    return {
      allowed: false,
      version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      ruleId: HUGRAB_GROUND_SAVER_RULE_ID,
      reason: HUGRAB_GROUND_SAVER_BLOCK_REASON,
    };
  }
  const automationRule = matchingDisabledAutomationRule(automationRules, context, service);
  if (automationRule) {
    return {
      allowed: false,
      version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      ruleId: 'automation-service-disabled',
      reason: automationRule.reason ?? 'Shipping service is disabled by Automation settings.',
    };
  }
  const insuranceProvider = String(shippingOptions?.insuranceProvider ?? 'none').trim().toLowerCase();
  const insuredValue = typeof shippingOptions?.insuredValue === 'number'
    ? shippingOptions.insuredValue
    : Number(shippingOptions?.insuredValue ?? 0);
  if (
    isUpsGroundSaverOrSurePostService(service) &&
    insuranceProvider !== 'none' &&
    Number.isFinite(insuredValue) &&
    insuredValue > 0
  ) {
    return {
      allowed: false,
      version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      ruleId: 'ups-ground-saver-insurance',
      reason: UPS_GROUND_SAVER_INSURANCE_BLOCK_REASON,
    };
  }
  // PS-262b (Per user override unlock shipped data on 2026-06-14): an INSURED order
  // cannot ship on a direct carrier that can't actually buy insurance. The capability
  // resolver returns 'blocked' for those (e.g. Walmart Shipping, which hardcodes
  // insurance:false and would otherwise ship uninsured). Block it here rather than
  // silently shipping uninsured or faking ParcelGuard. Ground Saver insured is already
  // blocked above; this catches the non-Ground-Saver blocked carriers.
  if (insuranceProvider !== 'none' && Number.isFinite(insuredValue) && insuredValue > 0) {
    const capability = resolveAccountInsuranceCapability({
      shippingProviderId: service?.carrierId ?? null,
      carrierCode: service?.carrierCode ?? null,
      serviceCode: service?.serviceCode ?? null,
    });
    if (capability.required === 'blocked') {
      return {
        allowed: false,
        version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
        ruleId: 'insurance-unsupported-carrier',
        reason: capability.reason,
      };
    }
  }
  return {
    allowed: true,
    version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  };
}

export function describeShippingService(service: unknown): ShippingServiceDescriptor {
  const row = (service && typeof service === 'object' ? service : {}) as Record<string, any>;
  const raw = row.raw && typeof row.raw === 'object' ? row.raw as Record<string, any> : {};
  return {
    carrierCode: row.carrier_code ?? row.carrierCode ?? raw.carrier_code ?? raw.carrierCode ?? null,
    carrierId: row.carrier_id ?? row.carrierId ?? raw.carrier_id ?? raw.carrierId ?? null,
    carrierName: row.carrier_name ?? row.carrierName ?? raw.carrier_name ?? raw.carrierName ?? null,
    provider: row.provider ?? raw.provider ?? row.providerAccountNickname ?? row.carrierNickname ?? null,
    serviceCode: row.service_code ?? row.serviceCode ?? raw.service_code ?? raw.serviceCode ?? null,
    serviceName:
      row.service_name ??
      row.serviceName ??
      row.service_type ??
      raw.service_name ??
      raw.serviceName ??
      raw.service_type ??
      null,
    serviceType: row.service_type ?? row.serviceType ?? raw.service_type ?? raw.serviceType ?? null,
  };
}

export function assertShippingServiceEligible(
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
  shippingOptions?: ShippingServiceOptionEligibilityContext | null,
  automationRules?: ShippingAutomationRule[] | null,
): void {
  const eligibility = evaluateShippingServiceEligibility(context, service, shippingOptions, automationRules);
  if (!eligibility.allowed) {
    const error = new Error(eligibility.reason ?? 'Shipping service is not eligible') as Error & {
      code?: string;
      ruleId?: string;
      eligibilityVersion?: string;
    };
    error.code = 'SHIPPING_SERVICE_NOT_ELIGIBLE';
    error.ruleId = eligibility.ruleId;
    error.eligibilityVersion = eligibility.version;
    throw error;
  }
}

export function filterEligibleShippingServices<T>(
  services: T[],
  context: ShippingServiceEligibilityContext | null | undefined,
  describe: (service: T) => ShippingServiceDescriptor,
  shippingOptions?: ShippingServiceOptionEligibilityContext | null,
  automationRules?: ShippingAutomationRule[] | null,
): T[] {
  return services.filter((service) => evaluateShippingServiceEligibility(context, describe(service), shippingOptions, automationRules).allowed);
}

export function filterCarrierAccountsForAutomation<T>(
  carriers: T[],
  context: ShippingServiceEligibilityContext | null | undefined,
  automationRules: ShippingAutomationRule[] | null | undefined,
  describe: (carrier: T) => ShippingServiceDescriptor,
): T[] {
  if (!automationRules?.length) return carriers;
  return carriers.filter((carrier) => {
    const descriptor = describe(carrier);
    const disabledRule = automationRules.find((rule) => (
      rule.disabled === true &&
      rule.type === 'carrier' &&
      matchesContext(rule, context) &&
      matchesCarrierRule(rule, descriptor) &&
      !isHugrabCarrierDisableProtected(context, descriptor)
    ));
    return !disabledRule;
  });
}
