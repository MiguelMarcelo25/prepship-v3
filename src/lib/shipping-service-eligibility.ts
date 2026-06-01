export const SHIPPING_SERVICE_ELIGIBILITY_VERSION = 'ps-057-hugrab-ground-saver-v1';

export const HUGRAB_GROUND_SAVER_BLOCK_REASON =
  'UPS Ground Saver is disabled for HUGRAB orders. Choose UPS Ground or another service.';

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
};

export type ShippingServiceDescriptor = {
  carrierCode?: string | null;
  carrierName?: string | null;
  provider?: string | null;
  serviceCode?: string | number | null;
  serviceName?: string | null;
  serviceType?: string | null;
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

export function isHugrabShippingContext(context: ShippingServiceEligibilityContext | null | undefined): boolean {
  if (!context) return false;
  const clientId = finiteNumber(context.clientId);
  if (clientId != null && HUGRAB_CLIENT_IDS.has(clientId)) return true;
  const storeId = finiteNumber(context.storeId);
  if (storeId != null && HUGRAB_STORE_IDS.has(storeId)) return true;
  return HUGRAB_NORMALIZED_NAMES.has(normalizeName(context.clientName));
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

export function evaluateShippingServiceEligibility(
  context: ShippingServiceEligibilityContext | null | undefined,
  service: ShippingServiceDescriptor | null | undefined,
): ShippingServiceEligibilityResult {
  if (isHugrabShippingContext(context) && isUpsGroundSaverOrSurePostService(service)) {
    return {
      allowed: false,
      version: SHIPPING_SERVICE_ELIGIBILITY_VERSION,
      ruleId: HUGRAB_GROUND_SAVER_RULE_ID,
      reason: HUGRAB_GROUND_SAVER_BLOCK_REASON,
    };
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
): void {
  const eligibility = evaluateShippingServiceEligibility(context, service);
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
): T[] {
  return services.filter((service) => evaluateShippingServiceEligibility(context, describe(service)).allowed);
}
