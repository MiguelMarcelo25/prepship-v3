import { createHash } from 'node:crypto';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { carrierAccountClients, carrierAccounts } from '../db/schema/carrier-accounts';
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
import { normalizeConfirmation, normalizeShippingOptions } from '../lib/shipping-options';
import {
  directCarrierVisibleForScope,
  evaluateDirectCarrierScope,
  normalizeProviderKey,
} from '../lib/direct-carrier-scope';
import { buildShippingRateRequestFingerprint } from './shipping-workflow/rate-fingerprint';
import { normalizeShippingPostalCode } from './shipping-workflow/postal-code';
import {
  classifyShippingAddress,
  residentialForShipping,
  type AddressClassificationSource,
} from './shipping-workflow/address-classification';
import { KNOWN_CARRIER_ACCOUNTS, carrierIdForProvider, effectiveInsuranceProviderForAccount } from '../lib/carrier-account-registry';
import {
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  describeShippingService,
  evaluateShippingServiceEligibility,
  filterCarrierAccountsForAutomation,
  filterEligibleShippingServices,
  resolveHugrabRequestInsurance,
  type ShippingAutomationRule,
  type ShippingServiceEligibilityContext,
  type ShippingServiceDescriptor,
} from '../lib/shipping-service-eligibility';
import {
  BLOCKED_SERVICE_CODES,
  BLOCKED_PACKAGE_TYPES,
  BLOCKED_NAME_RE,
  MEDIA_MAIL_ALLOWED_STORES,
  isServiceOrPackageBlocked,
} from '../lib/rate-block-list';
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
const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;

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

// PS-135(b): Policy-B block list moved to the canonical owner (src/lib/rate-block-list.ts) so this
// backend authority and the FE (web/src/utils/markups.ts) cannot drift. Re-exported here to preserve
// this module's historical public surface.
export { BLOCKED_SERVICE_CODES, BLOCKED_PACKAGE_TYPES, BLOCKED_NAME_RE, MEDIA_MAIL_ALLOWED_STORES };

// v4 Rate uses snake_case + `service_type` as the display name equivalent of
// v2's `serviceName` (there's no separate serviceName field on the ShipStation
// v2-API rate payload — service_type IS the human label). Behavior is unchanged: the media-mail
// store exception short-circuits, then the shared service/package/name predicate applies.
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
  return isServiceOrPackageBlocked(rate.service_code, rate.package_type, rate.service_type);
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
  toCompany?: string | null;
  // PS-127 residential/commercial evidence. `residential` is the legacy resolved flag a
  // caller may pass (treated as a trusted source signal for back-compat). The fields below
  // let order-backed callers supply richer evidence the canonical classifier ranks.
  residential?: boolean;
  /** Operator manual override (order_overrides.residential): true=residential, false=commercial. */
  manualOverrideResidential?: boolean | null;
  /** Trusted source flag (e.g. ShipStation raw shipTo.residential). */
  sourceResidential?: boolean | null;
  // PS-127 resolved classification (output of resolveRateInput, for DTO/diagnostics).
  residentialClassification?: 'residential' | 'commercial';
  residentialSource?: AddressClassificationSource;
  dimsL?: number;
  dimsW?: number;
  dimsH?: number;
  carrierIds?: string[];
  shipFrom?: Address;
  storeId?: number | null;
  clientId?: number | null;
  orderId?: number | null;
  externalOrderId?: string | null;
  orderNumber?: string | null;
  purchaseOrderId?: string | null;
  includeVisibleDirectCarriers?: boolean;
  includeAllDirectCarriers?: boolean;
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

// PS-127 / PS-135(a): the canonical residential classification for a rate request. DETERMINISTIC on
// the request's to* fields + manual override + source flag — NO order load, so the cache key stays
// stable between the cached-bulk lookup and the live fetch. Single source used by BOTH the ShipStation
// path (resolveRateInput) and the direct-carrier path (getDirectCarrierRatesForRateInput), so a UPS/
// direct quote uses the SAME residential as ShipStation; the label path re-classifies from the order's
// authoritative evidence and enforces parity. clientId/storeId are passed for context only — they do
// not affect the residential decision (classifyShippingAddress decides from shipTo/source/override).
function classifyRateInputResidential(input: RateInput) {
  return classifyShippingAddress({
    orderId: input.orderId,
    clientId: input.clientId ?? null,
    storeId: input.storeId ?? null,
    shipTo: {
      name: input.toName,
      company: input.toCompany ?? null,
      city: input.toCity,
      state: input.toState,
      postalCode: input.toZip,
      country: input.toCountry,
    },
    manualOverrideResidential: input.manualOverrideResidential ?? null,
    sourceResidential:
      input.sourceResidential ?? (typeof input.residential === 'boolean' ? input.residential : null),
  });
}

export async function resolveRateInput(
  input: RateInput,
  // PS-197b: rawManualEstimate = quote the UNINSURED manual baseline (what ShipStation's own
  // Rate Browser shows) for side-by-side comparison. Skips the HUGRAB request-level insurance
  // forcing ONLY for this read-only reference quote — the label-safe path is untouched, and the
  // route never stamps proof/selection keys on manual-estimate rates, so they are structurally
  // non-purchasable.
  opts: { rawManualEstimate?: boolean } = {},
): Promise<RateInput> {
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
  // PS-123 / PS-170: the backend owns the effective HUGRAB insurance used for rate
  // shopping, cache fingerprints, saved best-rate proof, and label parity. Frontend
  // callers pass operator intent only. The eligibility module is the SINGLE owner of the
  // request-level intent (was duplicated here pre-PS-170); the per-candidate provider
  // (ParcelGuard vs direct-UPS carrier declared value) is refined during enrichment below.
  const requestInsurance = opts.rawManualEstimate
    ? // PS-197b: the manual baseline is deliberately UNINSURED (parity with ShipStation's
      // manual Rate Browser). Reference-only — never label-safe, never purchasable.
      { insuranceProvider: 'none' as const, insuredValue: null, source: 'manual-estimate' as const }
    : resolveHugrabRequestInsurance(
        { clientId: context.clientId, storeId: context.storeId },
        input,
      );
  const insuranceProvider = requestInsurance.insuranceProvider as string;
  const insuredValue = requestInsurance.insuredValue;
  const effectiveInsuranceSource = requestInsurance.source;

  // PS-127: the backend owns residential/commercial classification. Stop blindly
  // defaulting every request to residential (`input.residential !== false`). Run the
  // canonical classifier on whatever evidence the caller supplied (manual override,
  // trusted source flag, or — back-compat — an explicit `residential` boolean treated as
  // a source signal), then apply the shipping consumption policy (commercial only on
  // TRUSTED evidence; residential-safe otherwise). This stays DETERMINISTIC on the inputs
  // — no hidden order load — so the cache key is identical between the cached-bulk lookup
  // and the live fetch (a hidden load would diverge them and break rate caching). The
  // label path re-classifies from the order's authoritative evidence and enforces parity.
  const residentialClassification = classifyRateInputResidential({
    ...input,
    clientId: context.clientId,
    storeId: context.storeId,
  });
  const residential = residentialForShipping(residentialClassification);

  return {
    ...input,
    // PS-126: canonical rate path keeps the EXACT postal (US ZIP+4 when present) so
    // ShipStation rate quotes match exactly. Falls back to legacy zip5 only if the
    // helper can't produce an exact value. Direct carriers get zip5 at their boundary.
    toZip: normalizeShippingPostalCode(input.toZip, input.toCountry).exact ?? normalizeZip(input.toZip),
    residential,
    residentialClassification: residentialClassification.classification,
    residentialSource: residentialClassification.source,
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

type DirectCarrierAccountInfo = {
  id: number;
  clientId: number | null;
  provider: string;
  label: string | null;
  accountIdentifier: string | null;
  credentials: Record<string, unknown>;
  sourceTable: 'carrier_accounts' | 'store_accounts';
  assignedClientIds: number[];
};

export type DirectCarrierRateError = {
  accountId: number;
  shippingProviderId: number;
  sourceTable: DirectCarrierAccountInfo['sourceTable'];
  provider: string;
  label: string;
  message: string;
  meta?: Record<string, unknown> | null;
};

export type DirectCarrierRateMeta = {
  accountId: number;
  shippingProviderId: number;
  sourceTable: DirectCarrierAccountInfo['sourceTable'];
  provider: string;
  meta: Record<string, unknown>;
};

export type DirectCarrierRatesResult = {
  rates: Rate[];
  errors: DirectCarrierRateError[];
  metas: DirectCarrierRateMeta[];
  diagnostics: CarrierRateDiagnostic[];
};

// PS-132: derived from the single backend carrier-account registry (src/lib/
// carrier-account-registry.ts) so the rate-carrier display can't drift from Orders/Settings.
const V2_CARRIER_ACCOUNT_OVERRIDES = new Map<string, { carrier_code: string; nickname: string }>(
  KNOWN_CARRIER_ACCOUNTS.map((account) => [
    carrierIdForProvider(account.shippingProviderId),
    { carrier_code: account.carrierCode, nickname: account.nickname },
  ]),
);

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
  const { resolved: filtered, unresolved } = enrichRatesWithInsuranceCost(
    eligible,
    {
      insuranceProvider: input.insuranceProvider,
      insuredValue: input.insuredValue,
      toCountry: input.toCountry,
    },
    undefined,
    // PS-170: per-candidate provider — each rate runs on its own carrier account, so a
    // direct-UPS candidate can resolve to $0 carrier declared value while ShipStation-
    // brokered candidates stay on ParcelGuard. Gated by the verify flag (off → all ParcelGuard)
    // AND the $100 free-tier cap (insuredValue > $100 → ParcelGuard, correctly priced).
    (rate) => effectiveInsuranceProviderForAccount({
      shippingProviderId: rate.carrier_id ?? null,
      carrierCode: rate.carrier_code ?? null,
      serviceCode: rate.service_code ?? null,
      insuredValue: input.insuredValue,
    }),
  );
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

// PS-139: removed dead back-compat wrapper fetchLiveRates (0 callers; routes use
// fetchLiveRatesWithDiagnostics directly).
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
  // PS-197b: quote the uninsured manual baseline (see resolveRateInput) — reference only.
  rawManualEstimate?: boolean;
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
  const resolvedInput = await resolveRateInput(input, {
    rawManualEstimate: opts.rawManualEstimate === true,
  });
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

function directProviderIdFromAccount(account: Pick<DirectCarrierAccountInfo, 'id' | 'sourceTable'>): number {
  return (account.sourceTable === 'store_accounts' ? DIRECT_STORE_PROVIDER_ID_OFFSET : DIRECT_CARRIER_PROVIDER_ID_OFFSET) + account.id;
}

function directAccountRefFromCarrierId(value: string): { accountId: number; sourceTable: DirectCarrierAccountInfo['sourceTable'] } | null {
  const match = String(value ?? '').match(/^se-(\d+)$/i);
  const providerId = Number.parseInt(match?.[1] ?? String(value ?? ''), 10);
  if (!Number.isFinite(providerId)) return null;
  if (providerId >= DIRECT_STORE_PROVIDER_ID_OFFSET) {
    const accountId = providerId - DIRECT_STORE_PROVIDER_ID_OFFSET;
    return accountId > 0 ? { accountId, sourceTable: 'store_accounts' } : null;
  }
  if (providerId >= DIRECT_CARRIER_PROVIDER_ID_OFFSET) {
    const accountId = providerId - DIRECT_CARRIER_PROVIDER_ID_OFFSET;
    return accountId > 0 ? { accountId, sourceTable: 'carrier_accounts' } : null;
  }
  return null;
}

function directRateServiceDescriptor(rate: Record<string, unknown>, provider: string) {
  return {
    provider,
    carrierCode: String(rate.carrierCode ?? rate.carrierType ?? rate.carrierName ?? provider),
    carrierName: rate.carrierName != null || rate.carrierType != null ? String(rate.carrierName ?? rate.carrierType) : null,
    serviceCode: rate.serviceCode != null || rate.service_code != null || rate.service != null
      ? String(rate.serviceCode ?? rate.service_code ?? rate.service)
      : null,
    serviceName: rate.serviceName != null || rate.service_type != null || rate.service != null
      ? String(rate.serviceName ?? rate.service_type ?? rate.service)
      : null,
    serviceType: rate.service_type != null || rate.service != null ? String(rate.service_type ?? rate.service) : null,
  };
}

function toDirectRate(
  rate: Record<string, unknown>,
  account: DirectCarrierAccountInfo,
  requestFingerprint: string,
  fetchedAt: string,
  rateCount: number,
): Rate | null {
  const amount = Number(rate.cost ?? rate.price ?? rate.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const provider = normalizeProviderKey(account.provider);
  const shippingProviderId = directProviderIdFromAccount(account);
  const service = String(rate.serviceCode ?? rate.service ?? rate.serviceName ?? rate.serviceType ?? provider).trim();
  const serviceName = String(rate.serviceName ?? rate.service_type ?? rate.service ?? service).trim();
  const carrierCode = String(rate.carrierCode ?? rate.carrierType ?? provider).trim();
  const carrierName = String(rate.carrierName ?? account.label ?? provider).trim();
  return {
    ...rate,
    rate_id: String(rate.rate_id ?? `${requestFingerprint}:${service}:${amount}`),
    carrier_id: `se-${shippingProviderId}`,
    carrier_code: carrierCode || provider,
    carrier_nickname: account.label ?? account.accountIdentifier ?? carrierName,
    service_code: service || provider,
    service_type: serviceName || service || provider,
    rate_type: serviceName || service || provider,
    shipping_amount: { amount, currency: String(rate.currency ?? 'USD') },
    other_amount: { amount: Number(rate.otherCost ?? 0) || 0, currency: String(rate.currency ?? 'USD') },
    confirmation_amount: { amount: Number(rate.confirmationCost ?? 0) || 0, currency: String(rate.currency ?? 'USD') },
    insurance_amount: { amount: Number(rate.insuranceCost ?? 0) || 0, currency: String(rate.currency ?? 'USD') },
    requestFingerprint,
    cacheKey: requestFingerprint,
    cacheCreatedAt: fetchedAt,
    cacheExpiresAt: new Date(Date.parse(fetchedAt) + CACHE_TTL_MS).toISOString(),
    proofSource: 'backend_rate_response',
    isComplete: true,
    rateCount,
    matchType: 'direct-live',
    shippingProviderId,
    directCarrierAccountId: account.id,
    directCarrierSourceTable: account.sourceTable,
    provider,
  } as unknown as Rate;
}

async function loadVisibleDirectCarrierAccounts(input: RateInput): Promise<DirectCarrierAccountInfo[]> {
  const requestedRefs = (input.carrierIds ?? [])
    .map(directAccountRefFromCarrierId)
    .filter((ref): ref is { accountId: number; sourceTable: DirectCarrierAccountInfo['sourceTable'] } => ref != null);
  const includeVisible = input.includeVisibleDirectCarriers === true || input.includeAllDirectCarriers === true;
  if (!requestedRefs.length && !includeVisible) return [];

  const carrierRows = await db
    .select({
      id: carrierAccounts.id,
      clientId: carrierAccounts.clientId,
      provider: carrierAccounts.provider,
      label: carrierAccounts.label,
      accountIdentifier: carrierAccounts.accountIdentifier,
      credentials: carrierAccounts.credentials,
      active: carrierAccounts.active,
    })
    .from(carrierAccounts);
  const assignments = await db
    .select({
      carrierAccountId: carrierAccountClients.carrierAccountId,
      clientId: carrierAccountClients.clientId,
    })
    .from(carrierAccountClients);
  const assignedByAccount = new Map<number, number[]>();
  for (const row of assignments) {
    const next = assignedByAccount.get(row.carrierAccountId) ?? [];
    next.push(row.clientId);
    assignedByAccount.set(row.carrierAccountId, next);
  }

  const directRows: DirectCarrierAccountInfo[] = carrierRows
    .filter((row) => row.active !== false)
    .map((row) => ({
      id: row.id,
      clientId: row.clientId ?? null,
      provider: row.provider,
      label: row.label ?? null,
      accountIdentifier: row.accountIdentifier ?? null,
      credentials: row.credentials ?? {},
      sourceTable: 'carrier_accounts' as const,
      assignedClientIds: assignedByAccount.get(row.id) ?? [],
    }));

  const storeRows = await db.execute(sql<{
    id: number;
    client_id: number | null;
    provider: string;
    label: string | null;
    account_identifier: string | null;
    credentials: Record<string, unknown>;
    active: boolean;
  }>`SELECT id, client_id, provider, label, account_identifier, credentials, active FROM store_accounts WHERE active = true`);
  const storeList = Array.isArray(storeRows) ? storeRows : (storeRows as any).rows ?? [];
  const storeAccounts: DirectCarrierAccountInfo[] = (storeList as Array<{
    id: number;
    client_id: number | null;
    provider: string;
    label: string | null;
    account_identifier: string | null;
    credentials: Record<string, unknown> | null;
    active: boolean;
  }>).map((row) => ({
    id: Number(row.id),
    clientId: row.client_id ?? null,
    provider: row.provider,
    label: row.label ?? null,
    accountIdentifier: row.account_identifier ?? null,
    credentials: row.credentials ?? {},
    sourceTable: 'store_accounts' as const,
    assignedClientIds: row.client_id != null ? [Number(row.client_id)] : [],
  }));

  const byKey = new Map([...directRows, ...storeAccounts].map((row) => [`${row.sourceTable}:${row.id}`, row]));
  if (requestedRefs.length) {
    return requestedRefs
      .map((ref) => byKey.get(`${ref.sourceTable}:${ref.accountId}`))
      .filter((row): row is DirectCarrierAccountInfo => Boolean(row));
  }
  return [...directRows, ...storeAccounts].filter((account) =>
    directCarrierVisibleForScope(account, {
      clientId: input.clientId,
      storeId: input.storeId,
      includeAllDirectCarriers: input.includeAllDirectCarriers,
    })
  );
}

export async function getDirectCarrierRatesForRateInput(input: RateInput): Promise<DirectCarrierRatesResult> {
  const accounts = await loadVisibleDirectCarrierAccounts(input);
  if (!accounts.length) return { rates: [], errors: [], metas: [], diagnostics: [] };
  const shippingOptions = normalizeShippingOptions(input);
  // PS-135(a): resolve residential via the SAME canonical classifier the ShipStation path uses
  // (classifyRateInputResidential), NOT the raw FE input.residential, so direct-carrier (UPS/etc.)
  // quotes apply the SAME residential classification as ShipStation and match the label.
  const resolvedResidential = residentialForShipping(classifyRateInputResidential(input));
  const fetchedAt = new Date().toISOString();
  const calls = accounts.map(async (account) => {
    const shippingProviderId = directProviderIdFromAccount(account);
    const label = account.label || account.accountIdentifier || account.provider;
    const scope = evaluateDirectCarrierScope(account, input);
    if (!scope.allowed) {
      return {
        rates: [] as Rate[],
        errors: [{
          accountId: account.id,
          shippingProviderId,
          sourceTable: account.sourceTable,
          provider: normalizeProviderKey(account.provider),
          label,
          message: scope.reason,
          meta: null,
        }],
        metas: [] as DirectCarrierRateMeta[],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          carrierCode: normalizeProviderKey(account.provider),
          nickname: label,
          status: 'failed' as CarrierRateDiagnosticStatus,
          rateCount: 0,
          error: scope.reason,
        },
      };
    }
    const requestFingerprint = `${rateCacheKey({ ...input, carrierIds: [`se-${shippingProviderId}`] })}:direct:${account.sourceTable}:${account.id}`;
    try {
      const quoted = await quoteCarrierRates(account.provider, {
        credentials: account.credentials,
        weightOz: input.weightOz,
        // PS-126: direct carriers (UPS/FedEx/etc.) require 5-digit ZIP — send the zip5
        // compatibility form, NOT the canonical ZIP+4 used for ShipStation quotes.
        toZip: normalizeShippingPostalCode(input.toZip, input.toCountry).zip5 ?? input.toZip,
        fromZip: normalizeShippingPostalCode(
          (input.shipFrom as any)?.postal_code ?? (input.shipFrom as any)?.postalCode,
          (input.shipFrom as any)?.country_code,
        ).zip5 ?? ((input.shipFrom as any)?.postal_code ?? (input.shipFrom as any)?.postalCode),
        dimsL: input.dimsL,
        dimsW: input.dimsW,
        dimsH: input.dimsH,
        orderId: input.orderId,
        clientId: input.clientId,
        storeId: input.storeId,
        externalOrderId: input.externalOrderId ?? input.orderNumber,
        orderNumber: input.orderNumber,
        purchaseOrderId: input.purchaseOrderId,
        shipFrom: input.shipFrom,
        // PS-127/PS-135(a): direct carriers rate under the SAME backend-resolved residential
        // classification as ShipStation (classifyRateInputResidential above), NOT the raw FE
        // input.residential, so direct-vs-ShipStation quotes are comparable and the UPS label matches.
        residential: resolvedResidential,
        shippingOptions,
      });
      const rawRates = Array.isArray(quoted.rates) ? quoted.rates as Array<Record<string, unknown>> : [];
      const eligible = filterRatesForShippingServiceEligibility(
        rawRates,
        { clientId: input.clientId ?? null, storeId: input.storeId ?? null },
        shippingOptions,
      ).filter((rate) => evaluateShippingServiceEligibility(
        { clientId: input.clientId ?? null, storeId: input.storeId ?? null },
        directRateServiceDescriptor(rate as Record<string, unknown>, account.provider),
        shippingOptions,
      ).allowed);
      const rates = eligible
        .map((rate) => toDirectRate(rate as Record<string, unknown>, account, requestFingerprint, fetchedAt, eligible.length))
        .filter((rate): rate is Rate => rate != null);
      const meta = {
        accountId: account.id,
        sourceTable: account.sourceTable,
        provider: normalizeProviderKey(quoted.provider ?? account.provider),
        rateCount: rates.length,
      };
      return {
        rates,
        errors: [] as DirectCarrierRateError[],
        metas: [{ accountId: account.id, shippingProviderId, sourceTable: account.sourceTable, provider: meta.provider, meta }],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          carrierCode: meta.provider,
          nickname: label,
          status: rates.length ? 'ok' as CarrierRateDiagnosticStatus : 'empty' as CarrierRateDiagnosticStatus,
          rateCount: rates.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        rates: [] as Rate[],
        errors: [{
          accountId: account.id,
          shippingProviderId,
          sourceTable: account.sourceTable,
          provider: normalizeProviderKey(account.provider),
          label,
          message,
          meta: null,
        }],
        metas: [] as DirectCarrierRateMeta[],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          carrierCode: normalizeProviderKey(account.provider),
          nickname: label,
          status: 'failed' as CarrierRateDiagnosticStatus,
          rateCount: 0,
          error: message,
        },
      };
    }
  });
  const settled = await Promise.all(calls);
  return {
    rates: settled.flatMap((item) => item.rates),
    errors: settled.flatMap((item) => item.errors),
    metas: settled.flatMap((item) => item.metas),
    diagnostics: settled.map((item) => item.diagnostic),
  };
}
