import { createHash } from 'node:crypto';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { rateCache } from '../db/schema/rates';
import { settings } from '../db/schema/settings';
import {
  type Rate,
  type Address,
  type Parcel,
} from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { loadClientCredentials } from '../lib/shipstation/credentials';
import { getDefaultShipFrom } from '../lib/ship-from';
import { normalizeConfirmation, normalizeInsurance, normalizeShippingOptions } from '../lib/shipping-options';
import { buildShippingRateRequestFingerprint } from './shipping-workflow/rate-fingerprint';
import {
  HUGRAB_DEFAULT_INSURED_VALUE,
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  describeShippingService,
  evaluateShippingServiceEligibility,
  filterCarrierAccountsForAutomation,
  filterEligibleShippingServices,
  isHugrabShippingContext,
  type ShippingAutomationRule,
  type ShippingServiceEligibilityContext,
  type ShippingServiceDescriptor,
} from '../lib/shipping-service-eligibility';
import { listCarrierAccounts, quoteCarrierRates } from './carrier-connector-orchestrator';
import {
  loadShippingAutomationRules,
  shippingAutomationRulesFingerprint,
} from './shipping-automation';
import {
  enrichRatesWithInsuranceCost,
  insuranceCostConfigFingerprint,
  isRateInsuranceResolved,
} from './shipping-workflow/insurance-cost';

type Markup = { type: 'amount' | 'percent'; value: number };

async function loadCarrierMarkups(): Promise<Map<string, Markup>> {
  const rows = await db
    .select()
    .from(settings)
    .where(like(settings.key, 'markup.%'));
  const m = new Map<string, Markup>();
  for (const row of rows) {
    if (!row.value) continue;
    const id = row.key.slice('markup.'.length);
    try {
      const p = JSON.parse(row.value);
      const value = Number(p.value);
      if (!Number.isFinite(value) || value === 0) continue;
      if (p.type === 'amount' || p.type === 'flat') {
        m.set(id, { type: 'amount', value });
      } else if (p.type === 'percent' || p.type === 'pct') {
        m.set(id, { type: 'percent', value });
      }
    } catch {
      // ignore unparseable values
    }
  }
  return m;
}

// ── v2-parity rate filters ────────────────────────────────────────────────
// Ported from v2's apps/api/src/common/prepship-config.ts. v4 previously had
// NO rate filtering — blocked service codes / flat-rate package types leaked
// into best-rate selection, which could silently undercharge vs v2. UPS
// SurePost/Ground Saver is not blocked; ShipStation now returns it as the
// correct economy service for several UPS accounts.

// v2-parity: ShipStation-provided baseline carrier accounts (vs. client-owned
// carrier accounts). Billing/cost-vs-charge accounting uses this to flag rows
// sourced from baseline carriers so they can be surfaced at ShipStation's
// wholesale cost rather than the marked-up charge price. v2 source:
// apps/api/src/common/prepship-config.ts:L6.
export const SS_BASELINE_CARRIER_CODES = new Set<string>([
  'stamps_com',
  'ups_walleted',
]);

export const BLOCKED_SERVICE_CODES = new Set<string>([
  'usps_media_mail',
  'usps_first_class_mail',
  'usps_library_mail',
  'usps_parcel_select',
  'usps_parcel_select_lightweight',
]);

export const BLOCKED_PACKAGE_TYPES = new Set<string>([
  'flat_rate_envelope',
  'flat_rate_legal_envelope',
  'flat_rate_padded_envelope',
  'small_flat_rate_box',
  'medium_flat_rate_box',
  'large_flat_rate_box',
  'regional_rate_box_a',
  'regional_rate_box_b',
]);

export const BLOCKED_NAME_RE = /flat[\s-]?rate|flat rate|\bbox\b/i;
export const MEDIA_MAIL_ALLOWED_STORES = new Set<number>([376759]);

// v4 Rate uses snake_case + `service_type` as the display name equivalent of
// v2's `serviceName` (there's no separate serviceName field on the ShipStation
// v2-API rate payload — service_type IS the human label).
export function isBlockedRate(
  rate: Pick<Rate, 'service_code' | 'package_type' | 'service_type'>,
  storeId: number | null = null,
): boolean {
  if (
    rate.service_code === 'usps_media_mail' &&
    storeId != null &&
    MEDIA_MAIL_ALLOWED_STORES.has(storeId)
  ) {
    return false;
  }
  return (
    BLOCKED_SERVICE_CODES.has(rate.service_code ?? '') ||
    BLOCKED_PACKAGE_TYPES.has(rate.package_type ?? '') ||
    BLOCKED_NAME_RE.test(rate.service_type ?? '')
  );
}

function applyMarkups(rates: Rate[], markups: Map<string, Markup>): Rate[] {
  if (!markups.size) return rates;
  return rates.map((r) => {
    const providerId = String(r.carrier_id ?? '').match(/^se-(\d+)$/i)?.[1];
    const m = markups.get(String(r.carrier_id ?? '')) ?? (providerId ? markups.get(providerId) : undefined);
    if (!m) return r;
    const orig = r.shipping_amount.amount;
    const newAmount =
      m.type === 'percent' ? orig * (1 + m.value / 100) : orig + m.value;
    return {
      ...r,
      shipping_amount: {
        ...r.shipping_amount,
        amount: Math.round(newAmount * 100) / 100,
      },
      original_amount: { ...r.shipping_amount },
      markup: m,
    };
  });
}

export const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const CARRIER_CACHE_MS = 1000 * 60 * 15; // 15 min
export const RATE_FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.RATE_FETCH_CONCURRENCY ?? '4', 10) || 4)
);
export const SHIPSTATION_RATE_LIMIT_PER_MINUTE = Math.max(
  1,
  Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_PER_MINUTE ?? '160', 10) || 160
);
export const SHIPSTATION_RATE_LIMIT_BURST = Math.max(
  1,
  Math.min(
    SHIPSTATION_RATE_LIMIT_PER_MINUTE,
    Number.parseInt(process.env.SHIPSTATION_RATE_LIMIT_BURST ?? '20', 10) || 20
  )
);
const SHIPSTATION_RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_NEGATIVE_CACHE_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RATE_NEGATIVE_CACHE_TTL_MS ?? '600000', 10) || 600_000
);
// PS-108: include the insurance-cost config fingerprint so the cache busts when the
// ParcelGuard schedule/source changes materially (no stale premium can be reused).
const RATE_CACHE_VERSION = `ground-saver-v2|eligibility=${SHIPPING_SERVICE_ELIGIBILITY_VERSION}|ins=${insuranceCostConfigFingerprint()}`;
const RATE_CONFIRMATIONS = new Set([
  'none',
  'delivery',
  'signature',
  'adult_signature',
  'direct_signature',
  'delivery_mailed',
  'verbal_confirmation',
  'delivery_code',
  'age_verification_16_plus',
]);
const RATEABLE_CARRIER_CODES = new Set([
  'usps',
  'ups',
  'ups_walleted',
  'fedex',
  'fedex_walleted',
  'dhl_express',
  'stamps_com',
]);

let globalRateFetchActive = 0;
const globalRateFetchWaiters: Array<() => void> = [];
const shipStationRateLimitTimestamps: number[] = [];

function trimShipStationRateLimitTimestamps(now = Date.now()) {
  while (
    shipStationRateLimitTimestamps.length > 0 &&
    now - shipStationRateLimitTimestamps[0]! >= SHIPSTATION_RATE_LIMIT_WINDOW_MS
  ) {
    shipStationRateLimitTimestamps.shift();
  }
}

function nextShipStationRateBudgetDelayMs(now = Date.now()) {
  trimShipStationRateLimitTimestamps(now);
  const burstWindowMs = Math.ceil(
    (SHIPSTATION_RATE_LIMIT_WINDOW_MS * SHIPSTATION_RATE_LIMIT_BURST) /
      SHIPSTATION_RATE_LIMIT_PER_MINUTE
  );
  const recentBurst = shipStationRateLimitTimestamps.filter((timestamp) => now - timestamp < burstWindowMs);
  if (recentBurst.length >= SHIPSTATION_RATE_LIMIT_BURST) {
    return Math.max(0, burstWindowMs - (now - recentBurst[0]!));
  }
  if (shipStationRateLimitTimestamps.length < SHIPSTATION_RATE_LIMIT_PER_MINUTE) return 0;
  return Math.max(0, SHIPSTATION_RATE_LIMIT_WINDOW_MS - (now - shipStationRateLimitTimestamps[0]!));
}

async function acquireShipStationRateBudget(): Promise<void> {
  for (;;) {
    const delayMs = nextShipStationRateBudgetDelayMs();
    if (delayMs <= 0) {
      shipStationRateLimitTimestamps.push(Date.now());
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
}

async function acquireGlobalRateFetchPermit(): Promise<void> {
  if (globalRateFetchActive < RATE_FETCH_CONCURRENCY) {
    globalRateFetchActive += 1;
    return;
  }
  await new Promise<void>((resolve) => globalRateFetchWaiters.push(resolve));
  globalRateFetchActive += 1;
}

function releaseGlobalRateFetchPermit() {
  globalRateFetchActive = Math.max(0, globalRateFetchActive - 1);
  const next = globalRateFetchWaiters.shift();
  if (next) next();
}

async function runWithGlobalRateLimiter<T>(operation: () => Promise<T>): Promise<T> {
  await acquireShipStationRateBudget();
  await acquireGlobalRateFetchPermit();
  try {
    return await operation();
  } finally {
    releaseGlobalRateFetchPermit();
  }
}

let cachedCarrierIds: string[] | null = null;
let carriersFetchedAt = 0;

async function getAllCarrierIds(): Promise<string[]> {
  if (
    cachedCarrierIds &&
    cachedCarrierIds.length &&
    Date.now() - carriersFetchedAt < CARRIER_CACHE_MS
  ) {
    return cachedCarrierIds;
  }
  const res = await listCarrierAccounts('shipstation', {
    dedupeKey: 'carriers:list',
  }) as CarriersResponse;
  // Only include carriers that can rate arbitrary orders. Skip:
  //  - amazon_*: requires amazon_order_item_id per line — fails for non-Amazon orders
  //  - voucher-*: client-shared carriers that don't respond to the rate API
  //  - tusk and similar resellers that sometimes fail on generic payloads
  //  - fedex_walleted: One Balance wallet; duplicate of fedex for rating
  const ids = res.carriers
    .filter((c) => !c.disabled_by_billing_plan)
    .filter((c) => RATEABLE_CARRIER_CODES.has((c.carrier_code ?? '').toLowerCase()))
    .map((c) => c.carrier_id);
  if (!ids.length) {
    throw new Error(
      'No ShipStation carriers available — connect a carrier account in ShipStation first.'
    );
  }
  cachedCarrierIds = ids;
  carriersFetchedAt = Date.now();
  return ids;
}

export type RateInput = {
  weightOz: number;
  toZip: string;
  toCountry?: string;
  toState?: string;
  toCity?: string;
  toAddress?: string;
  toName?: string;
  residential?: boolean;
  dimsL?: number;
  dimsW?: number;
  dimsH?: number;
  carrierIds?: string[];
  shipFrom?: Address;
  storeId?: number | null;
  clientId?: number | null;
  sourceClientId?: number | null;
  apiKeyV2?: string | null;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
  effectiveInsuranceProvider?: string | null;
  effectiveInsuredValue?: number | null;
  effectiveInsuranceSource?: string | null;
  automationRulesVersion?: string | null;
};

function normalizeZip(zip: string): string {
  const digits = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  return digits || String(zip ?? '').trim().toUpperCase();
}

export function shipDateBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function apiKeyCacheKey(apiKeyV2?: string | null): string {
  if (!apiKeyV2) return 'env';
  return createHash('sha256').update(apiKeyV2).digest('hex').slice(0, 16);
}

function normalizeRateConfirmation(value?: string | null): string | undefined {
  const normalized = normalizeConfirmation(value, 'none');
  return RATE_CONFIRMATIONS.has(normalized) && normalized !== 'none' ? normalized : undefined;
}

async function resolveClientIdForStoreId(storeId?: number | null): Promise<number | null> {
  if (storeId == null) return null;
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(sql`${clients.storeIds} @> ${[storeId]}::integer[]`)
    .limit(1);
  return row?.id ?? null;
}

export async function resolveRateInput(input: RateInput): Promise<RateInput> {
  const context = await resolveRateCredentialContext(input);
  const automationRules = await loadShippingAutomationRules();
  const discoveredCarriers = await getAllCarriers(context.apiKeyV2);
  const candidateCarriers = input.carrierIds?.length
    ? discoveredCarriers.filter((carrier) => input.carrierIds!.includes(carrier.carrier_id))
    : discoveredCarriers;
  const allowedCarriers = filterCarrierAccountsForAutomation(
    candidateCarriers,
    { clientId: context.clientId, storeId: context.storeId },
    automationRules,
    (carrier) => ({
      carrierId: carrier.carrier_id,
      carrierCode: carrier.carrier_code,
      carrierName: carrier.nickname,
    }),
  );
  // PS-123: backend owns the effective HUGRAB insurance used for rate shopping,
  // cache fingerprints, saved best-rate proof, and label parity. Frontend callers
  // pass operator intent only; this service resolves the final provider/value.
  const operatorInsurance = normalizeInsurance(input);
  let insuranceProvider = operatorInsurance.insuranceProvider as string;
  let insuredValue = operatorInsurance.insuredValue;
  let effectiveInsuranceSource = operatorInsurance.insuranceProvider === 'none' ? 'none' : 'operator';
  if (isHugrabShippingContext({ clientId: context.clientId, storeId: context.storeId })) {
    if (operatorInsurance.insuranceProvider === 'none') {
      insuranceProvider = 'parcelguard';
      insuredValue = HUGRAB_DEFAULT_INSURED_VALUE;
      effectiveInsuranceSource = 'hugrab-default';
    } else {
      insuranceProvider = 'parcelguard';
      insuredValue = operatorInsurance.insuredValue;
      effectiveInsuranceSource = 'operator';
    }
  }

  return {
    ...input,
    toZip: normalizeZip(input.toZip),
    residential: input.residential !== false,
    storeId: context.storeId,
    clientId: context.clientId,
    apiKeyV2: context.apiKeyV2,
    sourceClientId: context.sourceClientId,
    insuranceProvider,
    insuredValue,
    effectiveInsuranceProvider: insuranceProvider,
    effectiveInsuredValue: insuredValue,
    effectiveInsuranceSource,
    automationRulesVersion: shippingAutomationRulesFingerprint(automationRules),
    carrierIds: allowedCarriers.map((carrier) => carrier.carrier_id).sort(),
  };
}

export function rateCacheKey(input: RateInput): string {
  const confirmation = normalizeRateConfirmation(input.confirmation);
  const options = normalizeShippingOptions(input);
  return buildShippingRateRequestFingerprint({
    version: RATE_CACHE_VERSION,
    shipDateBucket: shipDateBucket(),
    weightOz: input.weightOz,
    toZip: input.toZip,
    toCountry: input.toCountry,
    toState: input.toState,
    toCity: input.toCity,
    residential: input.residential,
    clientId: input.clientId,
    storeId: input.storeId,
    sourceClientId: input.sourceClientId,
    apiKeyFingerprint: input.apiKeyV2 ? apiKeyCacheKey(input.apiKeyV2) : null,
    dimsL: input.dimsL,
    dimsW: input.dimsW,
    dimsH: input.dimsH,
    confirmation,
    insuranceProvider: options.insuranceProvider,
    insuredValue: options.insuredValue,
    carrierIds: input.carrierIds,
    automationRulesVersion: input.automationRulesVersion,
  });
}

function rateTotal(rate: Rate): number {
  return (
    Number(rate.shipping_amount?.amount ?? 0) +
    Number(rate.confirmation_amount?.amount ?? 0) +
    Number(rate.insurance_amount?.amount ?? 0) +
    Number(rate.other_amount?.amount ?? 0)
  );
}

function rateMoneyKey(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

function rateTextKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function rateDedupeKey(rate: Rate): string {
  const serviceKey = rateTextKey(rate.service_code || rate.service_type);
  return [
    rateTextKey(rate.carrier_id),
    rateTextKey(rate.carrier_code),
    serviceKey,
    rateMoneyKey(rate.shipping_amount?.amount),
    rateMoneyKey(rate.confirmation_amount?.amount),
    rateMoneyKey(rate.insurance_amount?.amount),
    rateMoneyKey(rate.other_amount?.amount),
    rateTextKey(rate.estimated_delivery_date ?? rate.delivery_days),
  ].join('|');
}

function dedupeRates(rates: Rate[], source: string): Rate[] {
  const byKey = new Map<string, Rate>();
  for (const rate of rates) {
    const key = rateDedupeKey(rate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rate);
      continue;
    }
    if (!existing.rate_id && rate.rate_id) {
      byKey.set(key, rate);
    }
  }

  const unique = [...byKey.values()];
  const removed = rates.length - unique.length;
  if (removed > 0) {
    console.info(`[rates] removed ${removed} duplicate ${source} rate${removed === 1 ? '' : 's'}`);
  }
  return unique;
}

function pickBestRate(rates: Rate[]): Rate | null {
  // PS-108: never auto-select an insured rate whose ParcelGuard premium could not be
  // proven. Such rates are flagged `insuranceCostUnresolved` by the enricher; excluding
  // them here guarantees the saved bestRate is never a postage-only insured rate.
  const selectable = rates.filter((rate) => isRateInsuranceResolved(rate));
  if (!selectable.length) return null;
  return [...selectable].sort((a, b) => rateTotal(a) - rateTotal(b))[0]!;
}

function rateEligibilityContext(input: Pick<RateInput, 'clientId' | 'storeId'>): ShippingServiceEligibilityContext {
  return {
    clientId: input.clientId ?? null,
    storeId: input.storeId ?? null,
  };
}

function rateShippingOptionEligibilityContext(input: Pick<RateInput, 'insuranceProvider' | 'insuredValue'>) {
  return normalizeShippingOptions(input);
}

function genericRateTotal(rate: unknown): number {
  if (!rate || typeof rate !== 'object') return Number.POSITIVE_INFINITY;
  const row = rate as Record<string, any>;
  return (
    Number(row.shipping_amount?.amount ?? row.shipmentCost ?? row.amount ?? row.cost ?? 0) +
    Number(row.other_amount?.amount ?? row.otherCost ?? 0) +
    Number(row.confirmation_amount?.amount ?? row.confirmationCost ?? 0) +
    Number(row.insurance_amount?.amount ?? row.insuranceCost ?? 0)
  );
}

export function rateToShippingServiceDescriptor(rate: unknown): ShippingServiceDescriptor {
  return describeShippingService(rate);
}

export function eligibilityReason(
  context: ShippingServiceEligibilityContext,
  rate: unknown,
  shippingOptions?: ReturnType<typeof normalizeShippingOptions>,
  automationRules?: ShippingAutomationRule[] | null,
): string | null {
  const eligibility = evaluateShippingServiceEligibility(context, rateToShippingServiceDescriptor(rate), shippingOptions, automationRules);
  return eligibility.allowed ? null : eligibility.reason ?? 'Shipping service is not eligible';
}

export function filterRatesForShippingServiceEligibility<T>(
  rates: T[],
  context: ShippingServiceEligibilityContext,
  shippingOptions?: ReturnType<typeof normalizeShippingOptions>,
  automationRules?: ShippingAutomationRule[] | null,
): T[] {
  return filterEligibleShippingServices(rates, context, rateToShippingServiceDescriptor, shippingOptions, automationRules);
}

export function sanitizeRateCacheRowForEligibility<T extends { rates?: unknown; bestRate?: unknown }>(
  row: T,
  context: ShippingServiceEligibilityContext,
  shippingOptions?: ReturnType<typeof normalizeShippingOptions>,
  automationRules?: ShippingAutomationRule[] | null,
): T {
  const rawRates = Array.isArray(row.rates) ? row.rates : [];
  const rates = filterRatesForShippingServiceEligibility(rawRates, context, shippingOptions, automationRules);
  const bestRateAllowed =
    row.bestRate != null &&
    evaluateShippingServiceEligibility(context, rateToShippingServiceDescriptor(row.bestRate), shippingOptions, automationRules).allowed;
  const selectable = rates.filter((rate) => isRateInsuranceResolved(rate));
  const bestRate = bestRateAllowed && isRateInsuranceResolved(row.bestRate)
    ? row.bestRate
    : [...selectable].sort((a, b) => genericRateTotal(a) - genericRateTotal(b))[0] ?? null;
  return {
    ...row,
    rates,
    bestRate,
  };
}

function buildShipTo(input: RateInput): Address {
  const addr: Address = {
    postal_code: input.toZip,
    country_code: (input.toCountry ?? 'US').toUpperCase(),
    address_residential_indicator:
      input.residential === true
        ? 'yes'
        : input.residential === false
          ? 'no'
          : 'unknown',
  };
  if (input.toName) addr.name = input.toName;
  if (input.toAddress) addr.address_line1 = input.toAddress;
  if (input.toCity) addr.city_locality = input.toCity;
  if (input.toState) addr.state_province = input.toState;
  return addr;
}

function buildPackages(input: RateInput): Parcel[] {
  const parcel: Parcel = {
    weight: { value: input.weightOz, unit: 'ounce' },
  };
  if (input.dimsL && input.dimsW && input.dimsH) {
    parcel.dimensions = {
      unit: 'inch',
      length: input.dimsL,
      width: input.dimsW,
      height: input.dimsH,
    };
  }
  return [parcel];
}

// v2-parity: what a single rate row looks like after /v2/rates/estimate.
// ShipStation returns a flat array (not wrapped in rate_response). Shape
// matches apps/api/src/modules/rates/data/shipstation-rate-shopper.ts:99-114.
type EstimateRate = {
  rate_id?: string;
  service_code?: string;
  service_type?: string;
  package_type?: string | null;
  carrier_id?: string;
  carrier_code?: string;
  carrier_nickname?: string;
  shipping_amount?: { amount?: number; currency?: string };
  other_amount?: { amount?: number; currency?: string };
  insurance_amount?: { amount?: number; currency?: string };
  confirmation_amount?: { amount?: number; currency?: string };
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
  zone?: number | string | null;
  guaranteed_service?: boolean;
  warning_messages?: string[];
  error_messages?: string[];
  rate_details?: unknown[];
};

export type CarrierRateDiagnosticStatus = 'ok' | 'empty' | 'failed' | 'cached' | 'loading';

export type CarrierRateDiagnostic = {
  carrierId: string;
  carrierCode?: string;
  nickname?: string;
  status: CarrierRateDiagnosticStatus;
  rateCount: number;
  durationMs?: number;
  error?: string;
};

// Cheap mini-carrier lookup so we can tell stamps_com apart (needs city/state
// in the rate-estimate body). v2 calls discoverCarriers() per request; v4
// reuses its 15-min-cached getAllCarrierIds() + a parallel nickname cache.
type CarrierInfo = { carrier_id: string; carrier_code: string; nickname?: string };
export type RateCarrierAccount = CarrierInfo & {
  friendly_name?: string;
  source_client_id: number | null;
  source_client_name: string;
};
const scopedCarrierCache = new Map<string, { carriers: CarrierInfo[]; fetchedAt: number }>();

const V2_CARRIER_ACCOUNT_OVERRIDES = new Map<
  string,
  { carrier_code: string; nickname: string }
>([
  ['se-433542', { carrier_code: 'stamps_com', nickname: 'USPS Chase x7439' }],
  ['se-433543', { carrier_code: 'ups_walleted', nickname: 'Chase x7439' }],
  ['se-565326', { carrier_code: 'ups', nickname: 'GG6381' }],
  ['se-565377', { carrier_code: 'ups', nickname: 'G19Y32' }],
  ['se-596001', { carrier_code: 'ups', nickname: 'ORION' }],
  ['se-604209', { carrier_code: 'ups', nickname: 'ROCEL' }],
  ['se-607855', { carrier_code: 'ups', nickname: 'ROCEL C81F70' }],
  ['se-598840', { carrier_code: 'fedex', nickname: 'FedEx' }],
  ['se-585004', { carrier_code: 'fedex_walleted', nickname: 'FedEx One Balance' }],
  ['se-442006', { carrier_code: 'stamps_com', nickname: 'GREG PAYABILITY 6/17' }],
  ['se-461890', { carrier_code: 'ups', nickname: 'ROCEL C81F70' }],
  ['se-565317', { carrier_code: 'ups', nickname: 'GG6381' }],
  ['se-595995', { carrier_code: 'ups', nickname: 'ORI Account' }],
  ['se-442007', { carrier_code: 'ups', nickname: 'GREG PAYABILITY 6/17' }],
  ['se-442013', { carrier_code: 'fedex', nickname: 'FedEx' }],
  ['se-585334', { carrier_code: 'fedex_walleted', nickname: 'FedEx One Balance' }],
]);

async function getAllCarriers(apiKeyV2?: string | null): Promise<CarrierInfo[]> {
  const cacheKey = apiKeyCacheKey(apiKeyV2);
  const cached = scopedCarrierCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CARRIER_CACHE_MS) {
    return cached.carriers;
  }
  let carriers: CarrierInfo[] = [];
  try {
    const res = await listCarrierAccounts('shipstation', {
      apiKey: apiKeyV2 ?? undefined,
      dedupeKey: `carriers:list:${cacheKey}`,
    }) as CarriersResponse;
    carriers = (res.carriers ?? [])
      .filter((c) => !c.disabled_by_billing_plan)
      .filter((c) => RATEABLE_CARRIER_CODES.has((c.carrier_code ?? '').toLowerCase()))
      .map((c) => {
        const override = V2_CARRIER_ACCOUNT_OVERRIDES.get(c.carrier_id);
        return {
          carrier_id: c.carrier_id,
          carrier_code: override?.carrier_code ?? c.carrier_code,
          nickname: override?.nickname ?? c.nickname ?? c.friendly_name ?? undefined,
        };
      });
  } catch (err) {
    console.warn(
      '[rates] carrier discovery failed:',
      err instanceof Error ? err.message : err,
    );
  }
  scopedCarrierCache.set(cacheKey, { carriers, fetchedAt: Date.now() });
  return carriers;
}

type RateCredentialContext = {
  storeId: number | null;
  clientId: number | null;
  apiKeyV2: string | null;
  sourceClientId: number | null;
  sourceClientName: string;
};

async function loadClientName(clientId: number | null | undefined): Promise<string | null> {
  if (!clientId) return null;
  const [row] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return row?.name ?? null;
}

async function resolveRateCredentialContext(
  input: Pick<RateInput, 'storeId' | 'clientId' | 'sourceClientId' | 'apiKeyV2'>,
): Promise<RateCredentialContext> {
  const storeId = input.storeId ?? null;
  const clientId =
    input.clientId ?? (storeId != null ? await resolveClientIdForStoreId(storeId) : null);
  const credentials = await loadClientCredentials(clientId, {
    storeId: storeId ?? undefined,
  });
  const apiKeyV2 = input.apiKeyV2 ?? credentials.apiKeyV2 ?? null;
  const sourceClientId =
    input.sourceClientId ?? credentials.sourceClientId ?? (apiKeyV2 && clientId ? clientId : null);
  const sourceClientName = (await loadClientName(sourceClientId)) ?? 'DR PREPPER';
  return {
    storeId,
    clientId,
    apiKeyV2,
    sourceClientId,
    sourceClientName,
  };
}

export async function getCarrierAccountsForRateContext(
  input: Pick<RateInput, 'storeId' | 'clientId'>,
  options: { includeAutomationDisabled?: boolean } = {},
): Promise<RateCarrierAccount[]> {
  const context = await resolveRateCredentialContext({
    storeId: input.storeId ?? null,
    clientId: input.clientId ?? null,
  });
  const automationRules = await loadShippingAutomationRules();
  const carriers = await getAllCarriers(context.apiKeyV2);
  const allowedCarriers = options.includeAutomationDisabled
    ? carriers
    : filterCarrierAccountsForAutomation(
        carriers,
        { clientId: context.clientId, storeId: context.storeId },
        automationRules,
        (carrier) => ({
          carrierId: carrier.carrier_id,
          carrierCode: carrier.carrier_code,
          carrierName: carrier.nickname,
        }),
      );
  return allowedCarriers.map((carrier) => ({
    ...carrier,
    friendly_name: carrier.nickname,
    source_client_id: context.sourceClientId,
    source_client_name: context.sourceClientName,
  }));
}

function shipFromPostalCode(addr: Address): string {
  return addr.postal_code ?? '90248';
}

function shipDateIso(): string {
  return new Date().toISOString();
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

type CarrierEstimateResult = {
  carrier: CarrierInfo;
  rates: EstimateRate[];
  diagnostic: CarrierRateDiagnostic;
};

function publicCarrierRateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Carrier rate request failed');
  return raw.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').slice(0, 240);
}

// v2-parity: one /v2/rates/estimate call per carrier with v2's flat body.
// Returns v2-shaped EstimateRate[] plus carrier diagnostics so the UI can
// distinguish "no service" from "carrier failed".
async function fetchEstimateForCarrier(
  carrier: CarrierInfo,
  input: RateInput,
  shipFrom: Address,
): Promise<CarrierEstimateResult> {
  const startedAt = Date.now();
  const needsCity = carrier.carrier_code === 'stamps_com';
  const body: Record<string, unknown> = {
    carrier_ids: [carrier.carrier_id],
    from_country_code: (shipFrom.country_code ?? 'US').toUpperCase(),
    from_postal_code: shipFromPostalCode(shipFrom),
    to_country_code: (input.toCountry ?? 'US').toUpperCase(),
    to_postal_code: input.toZip,
    weight: { value: input.weightOz, unit: 'ounce' },
    address_residential_indicator:
      input.residential === true ? 'yes' : input.residential === false ? 'no' : 'unknown',
    ship_date: shipDateIso(),
  };
  if (needsCity) {
    if (input.toCity) body.to_city_locality = input.toCity;
    if (input.toState) body.to_state_province = input.toState;
  }
  if (input.dimsL && input.dimsW && input.dimsH) {
    body.dimensions = {
      length: input.dimsL,
      width: input.dimsW,
      height: input.dimsH,
      unit: 'inch',
    };
  }
  const confirmation = normalizeRateConfirmation(input.confirmation);
  if (confirmation) body.confirmation = confirmation;
  const options = normalizeShippingOptions(input);
  if (options.insuranceProvider !== 'none' && options.insuredValue != null) {
    body.insurance_provider = options.insuranceProvider;
    body.insured_value = options.insuredValue;
  }
  try {
    const payload = await quoteCarrierRates('shipstation', {
      body,
      shippingOptions: options,
      apiKeyV2: input.apiKeyV2 ?? undefined,
      dedupeKey: `rates-estimate:${carrier.carrier_id}:${rateCacheKey(input)}`,
    });
    const rates = payload.rates as EstimateRate[];
    // Ensure carrier metadata is on every row (ShipStation sometimes omits)
    const override = V2_CARRIER_ACCOUNT_OVERRIDES.get(carrier.carrier_id);
    for (const r of rates) {
      if (!r.carrier_id) r.carrier_id = carrier.carrier_id;
      r.carrier_code = override?.carrier_code ?? r.carrier_code ?? carrier.carrier_code;
      r.carrier_nickname = override?.nickname ?? r.carrier_nickname ?? carrier.nickname;
    }
    return {
      carrier,
      rates,
      diagnostic: {
        carrierId: carrier.carrier_id,
        carrierCode: override?.carrier_code ?? carrier.carrier_code,
        nickname: override?.nickname ?? carrier.nickname,
        status: rates.length ? 'ok' : 'empty',
        rateCount: rates.length,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    const message = publicCarrierRateError(err);
    console.warn(
      `[rates-estimate] carrier ${carrier.carrier_code} (${carrier.carrier_id}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return {
      carrier,
      rates: [],
      diagnostic: {
        carrierId: carrier.carrier_id,
        carrierCode: carrier.carrier_code,
        nickname: carrier.nickname,
        status: 'failed',
        rateCount: 0,
        durationMs: Date.now() - startedAt,
        error: message,
      },
    };
  }
}

// Lift the EstimateRate shape (flat from ShipStation) into v4's Rate shape
// (used by the cache + route response).
function toRate(er: EstimateRate): Rate {
  return {
    rate_id: String(er.rate_id ?? ''),
    rate_type: 'shipment',
    carrier_id: String(er.carrier_id ?? ''),
    carrier_code: String(er.carrier_code ?? ''),
    carrier_nickname: er.carrier_nickname,
    service_type: String(er.service_type ?? er.service_code ?? ''),
    service_code: String(er.service_code ?? ''),
    shipping_amount: {
      currency: er.shipping_amount?.currency ?? 'usd',
      amount: Number(er.shipping_amount?.amount ?? 0),
    },
    insurance_amount: er.insurance_amount
      ? { currency: er.insurance_amount.currency ?? 'usd', amount: Number(er.insurance_amount.amount ?? 0) }
      : undefined,
    confirmation_amount: er.confirmation_amount
      ? {
          currency: er.confirmation_amount.currency ?? 'usd',
          amount: Number(er.confirmation_amount.amount ?? 0),
        }
      : undefined,
    other_amount: er.other_amount
      ? { currency: er.other_amount.currency ?? 'usd', amount: Number(er.other_amount.amount ?? 0) }
      : undefined,
    delivery_days: er.delivery_days ?? null,
    estimated_delivery_date: er.estimated_delivery_date ?? null,
    warning_messages: er.warning_messages,
    error_messages: er.error_messages,
    package_type: er.package_type ?? undefined,
  };
}

export type FetchLiveRatesResult = {
  rates: Rate[];
  carrierDiagnostics: CarrierRateDiagnostic[];
};

export async function fetchLiveRatesWithDiagnostics(
  input: RateInput,
  automationRules: ShippingAutomationRule[] = [],
): Promise<FetchLiveRatesResult> {
  const shipFrom = input.shipFrom ?? (await getDefaultShipFrom());

  // v2-parity: /v2/rates/estimate takes ONE carrier_id per call. Issue N
  // parallel calls (one per allowed carrier) and flatten. Mirrors
  // apps/api/src/modules/rates/data/shipstation-rate-shopper.ts:fetchRates().
  //
  // If the caller restricted carriers via input.carrierIds, filter the
  // discovery list to that set. Otherwise use the full cached list.
  const allCarriers = await getAllCarriers(input.apiKeyV2);
  const carriers = Array.isArray(input.carrierIds)
    ? allCarriers.filter((c) => input.carrierIds!.includes(c.carrier_id))
    : allCarriers;

  if (!carriers.length) return { rates: [], carrierDiagnostics: [] };

  const batches = await mapWithConcurrency(
    carriers,
    RATE_FETCH_CONCURRENCY,
    (c) => runWithGlobalRateLimiter(() => fetchEstimateForCarrier(c, input, shipFrom)),
  );
  const lifted: Rate[] = batches.flatMap((batch) => batch.rates).map(toRate);

  // v2-parity: filter blocked service codes + package types + names.
  // Sort cheapest first (v2 sorts by shipmentCost + otherCost; v4 sort
  // uses shipping_amount only since markups apply at read-time later).
  const eligibilityContext = rateEligibilityContext(input);
  const shippingOptionEligibility = rateShippingOptionEligibilityContext(input);
  const eligible = dedupeRates(
    filterRatesForShippingServiceEligibility(
      lifted.filter((r) => !isBlockedRate(r, input.storeId ?? null)),
      eligibilityContext,
      shippingOptionEligibility,
      automationRules,
    ),
    'live'
  );
  // PS-108: enrich insured rates with the authoritative ParcelGuard premium BEFORE
  // best-rate selection so rateTotal/pickBestRate/cache/proof all see the insured total.
  // Insured rates whose premium cannot be proven are split out (never selected as raw
  // postage) and surfaced as an explicit carrier error diagnostic (requirement #6).
  const { resolved: filtered, unresolved } = enrichRatesWithInsuranceCost(eligible, {
    insuranceProvider: input.insuranceProvider,
    insuredValue: input.insuredValue,
    toCountry: input.toCountry,
  });
  filtered.sort((a, b) => rateTotal(a) - rateTotal(b));
  const filteredCounts = new Map<string, number>();
  for (const rate of filtered) {
    filteredCounts.set(rate.carrier_id, (filteredCounts.get(rate.carrier_id) ?? 0) + 1);
  }
  const unresolvedInsuranceByCarrier = new Map<string, string>();
  for (const rate of unresolved) {
    const carrierId = String(rate.carrier_id ?? '');
    if (carrierId && !unresolvedInsuranceByCarrier.has(carrierId)) {
      unresolvedInsuranceByCarrier.set(carrierId, rate.insuranceCostError);
    }
  }
  const carrierDiagnostics = batches.map(({ carrier, diagnostic }) => {
    if (diagnostic.status !== 'ok') return diagnostic;
    const rateCount = filteredCounts.get(carrier.carrier_id) ?? 0;
    if (rateCount === 0 && unresolvedInsuranceByCarrier.has(carrier.carrier_id)) {
      return {
        ...diagnostic,
        status: 'failed',
        rateCount: 0,
        error: unresolvedInsuranceByCarrier.get(carrier.carrier_id),
      } satisfies CarrierRateDiagnostic;
    }
    return {
      ...diagnostic,
      status: rateCount > 0 ? 'ok' : 'empty',
      rateCount,
    } satisfies CarrierRateDiagnostic;
  });

  if (filtered.length) return { rates: filtered, carrierDiagnostics };

  // v2's /rates/estimate returns empty array when no rates exist for the
  // route — treat that as a normal "no service" condition, not an error.
  // (v4's previous /v2/rates endpoint surfaced this via rate_response.errors;
  // the estimate endpoint just omits them.)
  return { rates: [], carrierDiagnostics };
}

export async function fetchLiveRates(input: RateInput): Promise<Rate[]> {
  return (await fetchLiveRatesWithDiagnostics(input)).rates;
}

export type GetRatesResult = {
  rates: Rate[];
  bestRate: Rate | null;
  cached: boolean;
  cacheKey: string;
  fetchedAt: string;
  cacheAgeMs?: number;
  carrierDiagnostics: CarrierRateDiagnostic[];
  effectiveInsuranceProvider: string | null;
  effectiveInsuredValue: number | null;
  effectiveInsuranceSource: string | null;
};

type GetRatesOptions = {
  forceRefresh?: boolean;
  cachedOnly?: boolean;
};

function cachedDiagnosticsFromRates(rates: Rate[]): CarrierRateDiagnostic[] {
  const byCarrier = new Map<string, CarrierRateDiagnostic>();
  for (const rate of rates) {
    const carrierId = String(rate.carrier_id ?? '');
    if (!carrierId) continue;
    const existing = byCarrier.get(carrierId);
    if (existing) {
      existing.rateCount += 1;
      continue;
    }
    byCarrier.set(carrierId, {
      carrierId,
      carrierCode: rate.carrier_code,
      nickname: rate.carrier_nickname,
      status: 'cached',
      rateCount: 1,
    });
  }
  return [...byCarrier.values()];
}

function cachedDiagnosticsFromCache(value: unknown, rates: Rate[]): CarrierRateDiagnostic[] {
  if (!Array.isArray(value)) return cachedDiagnosticsFromRates(rates);
  const diagnostics = value
    .map((item): CarrierRateDiagnostic | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const carrierId = String(row.carrierId ?? '').trim();
      if (!carrierId) return null;
      const status = String(row.status ?? 'cached');
      const safeStatus: CarrierRateDiagnosticStatus =
        status === 'ok' ||
        status === 'empty' ||
        status === 'failed' ||
        status === 'cached' ||
        status === 'loading'
          ? status
          : 'cached';
      const rateCount = Number(row.rateCount ?? 0);
      const durationMs = Number(row.durationMs);
      return {
        carrierId,
        carrierCode: typeof row.carrierCode === 'string' ? row.carrierCode : undefined,
        nickname: typeof row.nickname === 'string' ? row.nickname : undefined,
        status: safeStatus,
        rateCount: Number.isFinite(rateCount) ? rateCount : 0,
        durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        error: typeof row.error === 'string' ? publicCarrierRateError(row.error) : undefined,
      };
    })
    .filter((item): item is CarrierRateDiagnostic => Boolean(item));
  return diagnostics.length ? diagnostics : cachedDiagnosticsFromRates(rates);
}

type RateCacheReadRow = {
  cacheKey: string;
  weightOz: number | null;
  toZip: string | null;
  rates: unknown[];
  bestRate: unknown;
  diagnostics?: unknown[] | null;
  weightVersion: number | null;
  fetchedAt: Date;
};

const rateCacheReadColumns = {
  cacheKey: rateCache.cacheKey,
  weightOz: rateCache.weightOz,
  toZip: rateCache.toZip,
  rates: rateCache.rates,
  bestRate: rateCache.bestRate,
  diagnostics: rateCache.diagnostics,
  weightVersion: rateCache.weightVersion,
  fetchedAt: rateCache.fetchedAt,
};

const legacyRateCacheReadColumns = {
  cacheKey: rateCache.cacheKey,
  weightOz: rateCache.weightOz,
  toZip: rateCache.toZip,
  rates: rateCache.rates,
  bestRate: rateCache.bestRate,
  weightVersion: rateCache.weightVersion,
  fetchedAt: rateCache.fetchedAt,
};

function isMissingRateCacheDiagnosticsColumnError(err: unknown): boolean {
  const row = err as { code?: string; message?: string };
  const message = String(row?.message ?? '');
  return row?.code === '42703' && /diagnostics/i.test(message);
}

async function selectRateCacheByKey(cacheKey: string): Promise<RateCacheReadRow | null> {
  try {
    const [cached] = await db
      .select(rateCacheReadColumns)
      .from(rateCache)
      .where(eq(rateCache.cacheKey, cacheKey))
      .limit(1);
    return cached ?? null;
  } catch (err) {
    if (!isMissingRateCacheDiagnosticsColumnError(err)) throw err;
    console.warn(
      '[rates] rate_cache.diagnostics column missing; reading legacy rate cache row without diagnostics'
    );
    const [cached] = await db
      .select(legacyRateCacheReadColumns)
      .from(rateCache)
      .where(eq(rateCache.cacheKey, cacheKey))
      .limit(1);
    return cached ? { ...cached, diagnostics: null } : null;
  }
}

async function writeRateCache(
  cacheKey: string,
  input: RateInput,
  rawRates: Rate[],
  carrierDiagnostics: CarrierRateDiagnostic[],
  fetchedAt: Date,
): Promise<void> {
  const bestRate = pickBestRate(rawRates);
  try {
    await db
      .insert(rateCache)
      .values({
        cacheKey,
        weightOz: input.weightOz,
        toZip: input.toZip,
        rates: rawRates as unknown[],
        bestRate,
        diagnostics: carrierDiagnostics as unknown[],
        weightVersion: 1,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: rateCache.cacheKey,
        set: {
          rates: rawRates as unknown[],
          bestRate,
          diagnostics: carrierDiagnostics as unknown[],
          fetchedAt,
        },
      });
    return;
  } catch (err) {
    if (!isMissingRateCacheDiagnosticsColumnError(err)) {
      console.warn('[rates] rate cache write failed:', err instanceof Error ? err.message : err);
      return;
    }
    console.warn(
      '[rates] rate_cache.diagnostics column missing; retrying rate cache write without diagnostics'
    );
  }

  try {
    await db
      .insert(rateCache)
      .values({
        cacheKey,
        weightOz: input.weightOz,
        toZip: input.toZip,
        rates: rawRates as unknown[],
        bestRate,
        weightVersion: 1,
        fetchedAt,
      })
      .onConflictDoUpdate({
        target: rateCache.cacheKey,
        set: {
          rates: rawRates as unknown[],
          bestRate,
          fetchedAt,
        },
      });
  } catch (err) {
    console.warn(
      '[rates] legacy rate cache write failed:',
      err instanceof Error ? err.message : err
    );
  }
}

export async function getRates(
  input: RateInput,
  opts: GetRatesOptions = {}
): Promise<GetRatesResult> {
  const resolvedInput = await resolveRateInput(input);
  const key = rateCacheKey(resolvedInput);
  const automationRules = await loadShippingAutomationRules();

  // Markups apply at read time so config changes reflect instantly without
  // having to bust the rate cache.
  const markups = await loadCarrierMarkups();

  if (!opts.forceRefresh) {
    const cached = await selectRateCacheByKey(key);
    if (cached) {
      const shippingOptionEligibility = rateShippingOptionEligibilityContext(resolvedInput);
      const cachedRaw = filterRatesForShippingServiceEligibility(
        dedupeRates(cached.rates as Rate[], 'cached'),
        rateEligibilityContext(resolvedInput),
        shippingOptionEligibility,
        automationRules,
      );
      const cacheAgeMs = Date.now() - cached.fetchedAt.getTime();
      const cacheTtlMs = cachedRaw.length ? CACHE_TTL_MS : RATE_NEGATIVE_CACHE_TTL_MS;
      if (cacheAgeMs >= cacheTtlMs) {
        // Fall through to live refresh. Empty/no-service results are cached
        // only briefly so operators are not stuck with stale carrier failures.
      } else {
        if (cachedRaw.length !== (cached.rates as Rate[]).length) {
          void db
            .update(rateCache)
            .set({
              rates: cachedRaw as unknown[],
              bestRate: pickBestRate(cachedRaw),
            })
            .where(eq(rateCache.cacheKey, key))
            .catch((err) =>
              console.warn('[rates] duplicate rate cache repair failed:', err instanceof Error ? err.message : err)
            );
        }
        const cachedRates = applyMarkups(cachedRaw, markups);
        return {
          rates: cachedRates,
          bestRate: pickBestRate(cachedRates),
          cached: true,
          cacheKey: key,
          fetchedAt: cached.fetchedAt.toISOString(),
          cacheAgeMs,
          carrierDiagnostics: cachedDiagnosticsFromCache(cached.diagnostics, cachedRates),
          effectiveInsuranceProvider: resolvedInput.effectiveInsuranceProvider ?? resolvedInput.insuranceProvider ?? null,
          effectiveInsuredValue: resolvedInput.effectiveInsuredValue ?? resolvedInput.insuredValue ?? null,
          effectiveInsuranceSource: resolvedInput.effectiveInsuranceSource ?? null,
        };
      }
    }
  }

  if (opts.cachedOnly) {
    const now = new Date();
    return {
      rates: [],
      bestRate: null,
      cached: false,
      cacheKey: key,
      fetchedAt: now.toISOString(),
      cacheAgeMs: undefined,
      carrierDiagnostics: [],
      effectiveInsuranceProvider: resolvedInput.effectiveInsuranceProvider ?? resolvedInput.insuranceProvider ?? null,
      effectiveInsuredValue: resolvedInput.effectiveInsuredValue ?? resolvedInput.insuredValue ?? null,
      effectiveInsuranceSource: resolvedInput.effectiveInsuranceSource ?? null,
    };
  }

  const liveResult = await fetchLiveRatesWithDiagnostics(resolvedInput, automationRules);
  const rawRates = liveResult.rates;
  const now = new Date();

  // Cache the RAW rates so markup updates always show fresh prices. Empty
  // results are cached briefly to prevent repeated live calls for carrier
  // accounts that already returned no service for this shipment.
  await writeRateCache(key, resolvedInput, rawRates, liveResult.carrierDiagnostics, now);

  const rates = applyMarkups(rawRates, markups);
  return {
    rates,
    bestRate: pickBestRate(rates),
    cached: false,
    cacheKey: key,
    fetchedAt: now.toISOString(),
    carrierDiagnostics: liveResult.carrierDiagnostics,
    effectiveInsuranceProvider: resolvedInput.effectiveInsuranceProvider ?? resolvedInput.insuranceProvider ?? null,
    effectiveInsuredValue: resolvedInput.effectiveInsuredValue ?? resolvedInput.insuredValue ?? null,
    effectiveInsuranceSource: resolvedInput.effectiveInsuranceSource ?? null,
  };
}
