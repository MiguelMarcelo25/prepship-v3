import { createHash } from 'node:crypto';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../db/client';
// PS-457: the shipping margin is money and rounds through the ONE owner. It can be negative
// when a markup rule prices below provider cost, and Math.round() rounds a negative tie the
// wrong way (-1.005 -> -1.00 instead of -1.01).
import { roundMoney } from '../lib/money';
// PS-494 correction: ordinary rate browsing reached the Shipp broker with NO origin, so the
// connector fell through to its configured default or 'US'. Only the label-purchase pre-quote
// was threaded. The card's defect is "transmitted on every quote", and browsing is every
// quote minus one.
import {
  decideDeclaredOrigin,
  resolveOrderCustomsOrigin,
  type CustomsOriginDecision,
  type CustomsOriginResolution,
} from './customs-origin';
import { classifyDestinationCountry } from './billing-destination-international';
import { orders } from '../db/schema/orders';
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
import {
  getShipStationV2LimiterSnapshot,
  type ShipStationRequestPriority,
} from '../lib/shipstation/client';
import { getDefaultShipFrom, withShipFromPhone } from '../lib/ship-from';
import { loadClientIsTest } from './fulfillment/test-label-policy';
import { buildTestFixtureCarrierAccounts, buildTestFixtureRates } from './test-rate-fixture';
import { normalizeConfirmation, normalizeShippingOptions } from '../lib/shipping-options';
import {
  directCarrierVisibleForScope,
  evaluateDirectCarrierScope,
  normalizeProviderKey,
} from '../lib/direct-carrier-scope';
import { buildShippingRateRequestFingerprint } from './shipping-workflow/rate-fingerprint';
import { GLOBAL_SCOPE } from '../lib/client-store-scope';
import { prepareAutomationRateIntent } from './automations/rate-policy';
import { normalizeShippingPostalCode } from './shipping-workflow/postal-code';
import {
  classifyShippingAddress,
  residentialForShipping,
  type AddressClassificationSource,
} from './shipping-workflow/address-classification';
import { KNOWN_CARRIER_ACCOUNTS, carrierIdForProvider, effectiveInsuranceProviderForAccount } from '../lib/carrier-account-registry';
// PS-216: human carrier-family labels for duplicate-nickname disambiguation.
import { carrierFamilyDisplayLabel } from '../lib/carrier-family-label';
import {
  SHIPPING_SERVICE_ELIGIBILITY_VERSION,
  describeShippingService,
  evaluateShippingServiceEligibility,
  filterCarrierAccountsForAutomation,
  filterEligibleShippingServices,
  isHugrabShippingContext,
  resolveHugrabRequestInsurance,
  type ShippingAutomationRule,
  type ShippingServiceEligibilityContext,
  type ShippingServiceDescriptor,
} from '../lib/shipping-service-eligibility';
import {
  BLOCKED_SERVICE_CODES,
  BLOCKED_PACKAGE_TYPES,
  BLOCKED_NAME_RE,
  BLOCKED_CARRIER_IDS,
  MEDIA_MAIL_ALLOWED_STORES,
  isProviderAccountBlocked,
  isServiceOrPackageBlocked,
} from '../lib/rate-block-list';
import { listCarrierAccounts, quoteCarrierRates } from './carrier-connector-orchestrator';
import { expectedCarrierAbsentFromThin } from '../connectors/carrier/observed-missing-carrier-names';
import {
  DIRECT_CARRIER_QUOTE_TIMEOUT_MS,
  withAbortableCarrierQuoteTimeout,
  isPricedRate,
  rateCostTotal as combinedRateCostTotal,
  rateTotal as combinedRateTotal,
} from './rates-combined';
import {
  isTransientCarrierRateError,
  runWithTransientRetry,
  rateResultIsCacheable,
  RATE_ESTIMATE_MAX_RETRIES,
  RATE_ESTIMATE_RETRY_BASE_MS,
} from './carrier-estimate-retry';
import { resolveRateBrowseProviderExecutionPolicy } from './rate-browse-execution-policy';
import { sanitizeRateProviderError } from './rate-browser-timing-diagnostics';
import { rateProviderErrorDetail } from './rate-provider-error-detail.js';
import {
  loadShippingAutomationControls,
  shippingAutomationControlsFingerprint,
} from './automations/shipping-controls';
import { loadOrderAutomationExclusionRules } from './automations/order-exclusion-rules';
import { loadOrderRatePreference, narrowToPreferred, type RatePreference } from './automations/rate-preference';
import { applyInsuranceFloor, loadOrderRatePlanOverlay } from './automations/order-rate-plan-overlay';
import { loadHugrabDefaultInsuranceEnabled } from './shipping-workflow/hugrab-insurance-policy';
import {
  easyPostScheduledPremium,
  enrichRatesWithInsuranceCost,
  insuranceCostConfigFingerprint,
  isRateInsuranceResolved,
} from './shipping-workflow/insurance-cost';
import {
  applyMarkupToAmount,
  isTrueCostUpliftMarkup,
  markupRuleAdjustmentKind,
  parseMarkupSettingValue,
  type MarkupRule,
} from './shipping-workflow/rate-money';
import { normalizeShippingRateMoney } from './shipping-workflow/shipping-rate-money-normalizer';
import { resolveWalmartPurchaseOrder } from './walmart-po-resolution';
// PS-271 (Layer 2): 60s per-carrier union cache (additive backstop for Shipp's non-deterministic
// thin response). Default-OFF; a COLD cache / flag OFF is byte-for-byte identical to today.
import {
  directCarrierRateCacheEnabled,
  readFreshDirectCarrierRates,
  writeDirectCarrierRates,
  type DirectCarrierCacheRow,
} from './direct-carrier-rate-cache';
import { isShopifyShippingDisplayOnlyProvider } from './shopify-rates';
import { decideDirectCarrierCacheUse } from './shipping-workflow/rate-signature-cache-policy';
import { partitionShipStationEstimateBatch } from './shipstation-rate-batch';
import {
  isDirectShippingAccount,
  isStoreScopedCarrierProvider,
  resolveStoreAccountLink,
  safeCarrierAccountIdentifier,
  type StoreAccountIdentity,
} from './carrier-account-identity';
import {
  shippingQuoteCredentialFingerprint,
  type ShippingQuoteAccountAuthorization,
} from './shipping-workflow/shipping-quote-authorization';
import { getOrderHazmatForShipping } from './order-hazmat.js';
import {
  assertHazmatRatingSupported,
  hazmatQuoteFactsForShipping,
  HazmatShippingError,
  resolveHazmatProfile,
} from './shipping-workflow/hazmat-shipping-policy.js';
import {
  sealHazmatQuoteFacts,
  type CanonicalHazmatQuoteFacts,
} from './shipping-workflow/hazmat-declaration.js';
import type { HazmatCapabilities } from './shipping-workflow/hazmat-capability.js';
import { applyShipStationHazmatToShipment } from '../lib/shipstation/hazmat.js';

type Markup = MarkupRule;
const DIRECT_CARRIER_PROVIDER_ID_OFFSET = 10_000_000;
const DIRECT_STORE_PROVIDER_ID_OFFSET = 20_000_000;

// PS-177 (Phase 5): parse normalization moved to the pure canonical owner
// (shipping-workflow/rate-money.ts) and the loader is exported so the orders
// route prices row money from the SAME rules browse responses use.
// 60s TTL cache: the rules were re-read from settings on EVERY /orders and
// browse request. Writes go through PUT/DELETE /settings/:key, which call
// clearCarrierMarkupsCache(), so an edit takes effect immediately in this
// process; other instances converge within the TTL.
const CARRIER_MARKUPS_TTL_MS = 60_000;
let carrierMarkupsCache: { at: number; value: Map<string, Markup> } | null = null;

export function clearCarrierMarkupsCache(): void {
  carrierMarkupsCache = null;
}

export async function loadCarrierMarkups(): Promise<Map<string, Markup>> {
  if (carrierMarkupsCache && Date.now() - carrierMarkupsCache.at < CARRIER_MARKUPS_TTL_MS) {
    return carrierMarkupsCache.value;
  }
  const rows = await db
    .select()
    .from(settings)
    .where(like(settings.key, 'markup.%'));
  const m = new Map<string, Markup>();
  for (const row of rows) {
    const rule = parseMarkupSettingValue(row.value);
    if (rule) m.set(row.key.slice('markup.'.length), rule);
  }
  carrierMarkupsCache = { at: Date.now(), value: m };
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
// backend authority applies it before ranking. Re-exported here to preserve
// this module's historical public surface.
export { BLOCKED_SERVICE_CODES, BLOCKED_PACKAGE_TYPES, BLOCKED_NAME_RE, BLOCKED_CARRIER_IDS, MEDIA_MAIL_ALLOWED_STORES };

// v4 Rate uses snake_case + `service_type` as the display name equivalent of
// v2's `serviceName` (there's no separate serviceName field on the ShipStation
// v2-API rate payload — service_type IS the human label). The media-mail
// store exception short-circuits, then provider-account and service/package rules apply.
export function isBlockedRate(
  rate: Pick<Rate, 'carrier_id' | 'service_code' | 'package_type' | 'service_type'>,
  storeId: number | null = null,
): boolean {
  if (
    rate.service_code === 'usps_media_mail' &&
    storeId != null &&
    MEDIA_MAIL_ALLOWED_STORES.has(storeId)
  ) {
    return false;
  }
  return isProviderAccountBlocked(rate.carrier_id) ||
    isServiceOrPackageBlocked(rate.service_code, rate.package_type, rate.service_type);
}

// Exported for ps-307-direct-rate-markup-behavior-test (drives the real lift+markup ranking
// path). Pure — no behavior change from exporting.
export function applyMarkups(rates: Rate[], markups: Map<string, Markup>): Rate[] {
  if (!markups.size) return rates;
  return rates.map((r) => {
    const providerId = String(r.carrier_id ?? '').match(/^se-(\d+)$/i)?.[1];
    const m = markups.get(String(r.carrier_id ?? '')) ?? (providerId ? markups.get(providerId) : undefined);
    if (!m) return r;
    const shippingComponent = r.shipping_amount.amount;
    const providerAllIn = normalizeShippingRateMoney(r).selectedRateCost ?? shippingComponent;
    // PS-177: same math, one owner (rate-money.applyMarkupToAmount).
    const markedShippingComponent = applyMarkupToAmount(shippingComponent, m);
    const marked = applyMarkupToAmount(providerAllIn, m);
    const rateAdjustmentKind = markupRuleAdjustmentKind(m);
    const selectedRateCost = isTrueCostUpliftMarkup(m) ? marked : providerAllIn;
    const shippingMarginAmount = roundMoney(marked - selectedRateCost);
    const shippingMarginPct =
      Math.abs(shippingMarginAmount) >= 0.005 && marked > 0
        ? Math.round((shippingMarginAmount / marked) * 1000) / 10
        : null;
    return {
      ...r,
      shipping_amount: {
        ...r.shipping_amount,
        amount: markedShippingComponent,
      },
      original_amount: { ...r.shipping_amount },
      markup: m,
      // PS-307/PS-391: stamp the explicit marked CUSTOMER charge so the comparison owner
      // (rates-combined.rateTotal, which pickBestRate/priced.sort delegate to) and
      // downstream consumers read an authoritative customer amount instead of inferring
      // it from shipping_amount. ShipStation add-ons (other/confirmation/insurance) are part
      // of providerAllIn before markup; shipping_amount remains a marked component for legacy
      // component display, while cShippingRateAmount is the all-in customer/ranking total.
      // Direct-carrier rates stay on the same marked-charge basis as ShipStation.
      cShippingRateAmount: marked,
      markedShippingAmount: marked,
      marked_shipping_amount: marked,
      // PS-386: canonical runtime DTOs use cShippingRateAmount for the
      // customer/ranking total. Legacy customerRate aliases are read only by
      // the compatibility normalizer, not emitted here as a second truth.
      customerShippingAmount: marked,
      customer_shipping_amount: marked,
      customerRateSource: rateAdjustmentKind === 'true_cost_uplift' ? 'true_cost_uplift' : 'projected_customer_shipping_rate',
      customer_rate_source: rateAdjustmentKind === 'true_cost_uplift' ? 'true_cost_uplift' : 'projected_customer_shipping_rate',
      rateAdjustmentKind,
      rate_adjustment_kind: rateAdjustmentKind,
      shippingMarginAmount,
      shipping_margin_amount: shippingMarginAmount,
      shippingMarginPct,
      shipping_margin_pct: shippingMarginPct,
      // PS-343: preserve the raw/internal provider cost as backend-owned aliases so Rate Browser
      // consumers do not need to recover it from provider component money fields.
      selectedRateCost,
      rateCostSource: rateAdjustmentKind === 'true_cost_uplift' ? 'carrier_true_cost_uplift' : 'best_rate_internal_cost',
      rate_cost_source: rateAdjustmentKind === 'true_cost_uplift' ? 'carrier_true_cost_uplift' : 'best_rate_internal_cost',
      rawShippingAmount: selectedRateCost,
      raw_shipping_amount: selectedRateCost,
      internalShippingAmount: selectedRateCost,
      internal_shipping_amount: selectedRateCost,
    } as Rate;
  });
}

// PS-perf (DJ 2026-06-23): the saved-rate validity / cache-reuse window. Was a hardcoded 6h,
// which made a saved best rate flip to "not purchasable" purely on elapsed time — a batch built
// over a workday (quote AM, queue PM) then hit a FALSE "Rate changed or expired" at queue/print
// time even though nothing about the shipment changed. Default raised to 24h so a rate quoted any
// time today stays usable all day; env-tunable + instantly reversible (unset env = old 6h). The
// request fingerprint still gates every REAL shipment change, so a genuinely changed order re-rates.
export const CACHE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number.parseInt(
    process.env.RATE_SAVED_TTL_MS
      ?? String((Number.parseInt(process.env.RATE_SAVED_TTL_HOURS ?? '24', 10) || 24) * 3_600_000),
    10,
  ) || 24 * 3_600_000,
); // default 24 hours
const CARRIER_CACHE_MS = 1000 * 60 * 15; // 15 min
export const RATE_FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number.parseInt(process.env.RATE_FETCH_CONCURRENCY ?? '4', 10) || 4)
);
export const DIRECT_CARRIER_RATE_FETCH_CONCURRENCY = Math.max(
  1,
  Math.min(
    8,
    Number.parseInt(
      process.env.DIRECT_CARRIER_RATE_FETCH_CONCURRENCY ?? String(RATE_FETCH_CONCURRENCY),
      10,
    ) || RATE_FETCH_CONCURRENCY,
  )
);
export function shipStationBatchedRateFanoutEnabled(): boolean {
  return /^(1|true|yes)$/i.test(String(process.env.SHIPSTATION_BATCHED_RATE_FANOUT ?? '').trim());
}
// Admission priority is consumed by the canonical ShipStation v2 HTTP gate. This service owns
// only quote-fanout concurrency and passes the same priority through to that gate.
export type RateFetchPriority = ShipStationRequestPriority;
// PS-perf (QA audit 2026-06-23): a STALLED ShipStation carrier used to hold the whole Browse Rates
// fan-out for the full 30s fetch timeout (some accounts intermittently take 25-30s — see the live
// "timed out after 30000ms" reports). Bound the per-carrier rate-estimate call to a tighter budget
// so a stuck carrier fails GRACEFULLY (a per-carrier 'failed' diagnostic) and the rates that DID
// resolve render ~2x sooner instead of waiting on the slowest. The LABEL purchase path keeps the
// longer fetch timeout (a label call must never be cut off). Env-tunable.
const SHIPSTATION_RATE_ESTIMATE_TIMEOUT_MS = Math.max(
  3_000,
  Number.parseInt(process.env.SHIPSTATION_RATE_ESTIMATE_TIMEOUT_MS ?? '15000', 10) || 15_000
);
const RATE_NEGATIVE_CACHE_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RATE_NEGATIVE_CACHE_TTL_MS ?? '600000', 10) || 600_000
);
// PS-108: include the insurance-cost config fingerprint so the cache busts when the
// ParcelGuard schedule/source changes materially (no stale premium can be reused).
// v4 (audit R-10, 2026-07-14): store IDs use sid= instead of the destination-state
// st= namespace. The bump prevents pre-hygiene cache/proof identities from mixing.
const RATE_CACHE_VERSION = `ground-saver-v4|eligibility=${SHIPPING_SERVICE_ELIGIBILITY_VERSION}|ins=${insuranceCostConfigFingerprint()}`;
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
// PS-447: three waiter queues keep operator work ahead of rate batches, and rate batches ahead
// of background sync/polling. The active-permit counting is unchanged; only wake order differs.
const interactiveRateFetchWaiters: Array<() => void> = [];
const batchRateFetchWaiters: Array<() => void> = [];
const backgroundRateFetchWaiters: Array<() => void> = [];

export type RateEngineLimiterSnapshot = {
  source: 'backend-rate-engine';
  generatedAt: string;
  rateFetchConcurrency: number;
  directCarrierRateFetchConcurrency: number;
  activeRateFetches: number;
  interactiveWaiters: number;
  batchWaiters: number;
  backgroundWaiters: number;
  shipStationBudgetWindowMs: number;
  shipStationBudgetUsed: number;
  shipStationBurstLimit: number;
  shipStationPerMinuteLimit: number;
};

async function acquireGlobalRateFetchPermit(priority: RateFetchPriority = 'interactive'): Promise<void> {
  if (globalRateFetchActive < RATE_FETCH_CONCURRENCY) {
    globalRateFetchActive += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    if (priority === 'background') backgroundRateFetchWaiters.push(resolve);
    else if (priority === 'batch') batchRateFetchWaiters.push(resolve);
    else interactiveRateFetchWaiters.push(resolve);
  });
  globalRateFetchActive += 1;
}

function releaseGlobalRateFetchPermit() {
  globalRateFetchActive = Math.max(0, globalRateFetchActive - 1);
  // Strict priority lane: interactive > batch > background. Counting is unchanged, so no
  // permit is lost and active never exceeds the cap.
  const next = interactiveRateFetchWaiters.shift()
    ?? batchRateFetchWaiters.shift()
    ?? backgroundRateFetchWaiters.shift();
  if (next) next();
}

export function getRateEngineLimiterSnapshot(): RateEngineLimiterSnapshot {
  const shipStationLimiter = getShipStationV2LimiterSnapshot();
  return {
    source: 'backend-rate-engine',
    generatedAt: new Date().toISOString(),
    rateFetchConcurrency: RATE_FETCH_CONCURRENCY,
    directCarrierRateFetchConcurrency: DIRECT_CARRIER_RATE_FETCH_CONCURRENCY,
    activeRateFetches: globalRateFetchActive,
    interactiveWaiters: interactiveRateFetchWaiters.length,
    batchWaiters: batchRateFetchWaiters.length,
    backgroundWaiters: backgroundRateFetchWaiters.length,
    shipStationBudgetWindowMs: shipStationLimiter.windowMs,
    shipStationBudgetUsed: shipStationLimiter.budgetUsed,
    shipStationBurstLimit: shipStationLimiter.burstLimit,
    shipStationPerMinuteLimit: shipStationLimiter.perMinuteLimit,
  };
}

// Exported for ps-rate-limiter-priority-behavior-test (proves strict ordering + no deadlock).
export async function runWithGlobalRateLimiter<T>(
  operation: () => Promise<T>,
  priority: RateFetchPriority = 'interactive',
): Promise<T> {
  await acquireGlobalRateFetchPermit(priority);
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
  /** Cooperative cancellation for backend-owned background quote workflows. */
  signal?: AbortSignal;
  weightOz: number;
  toZip: string;
  toCountry?: string;
  toState?: string;
  toCity?: string;
  toAddress?: string;
  toAddress2?: string;
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
  // PS-276 (slice 2b): resolver-supplied trusted evidence (USPS validated business marker /
  // UPS-FedEx provider verdict) fed into the canonical classifier's tiers 4/2. Populated by the
  // address resolver (slice 2b-2) when ADDRESS_RESOLVER=on; absent otherwise (classifier unchanged).
  addressValidation?: { business?: boolean | string | null; dpvConfirmation?: string | null; zipPlus4?: string | null; carrierRoute?: string | null } | null;
  providerMarker?: { classification?: 'residential' | 'commercial' | null; provider?: string | null } | null;
  // PS-127 resolved classification (output of resolveRateInput, for DTO/diagnostics).
  residentialClassification?: 'residential' | 'commercial';
  residentialSource?: AddressClassificationSource;
  /** Canonical address-classification axis used by eligibility and cache identity. */
  destinationPoBox?: boolean;
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
  /** Backend-resolved HUGRAB policy state; null for non-HUGRAB requests. */
  hugrabDefaultInsuranceEnabled?: boolean | null;
  automationRulesVersion?: string | null;
  /** PS-466 backend plan consumers; routes never derive these values. */
  automationExcludedCarrierIds?: string[];
  automationExcludedServiceIds?: string[];
  // Order-backed marketplace context, populated by /rates/browse from the orders row.
  // `sourceProvider` (the marketplace the order came from) gates marketplace-specific carriers —
  // eBay Logistics only prices eBay orders — and `rawOrder` carries the order's stored JSON for
  // connectors that need the marketplace order itself (the eBay ship-to + order id).
  sourceProvider?: string | null;
  sourceAccountId?: string | null;
  rawOrder?: unknown;
  // Whether this is an eBay-marketplace order (sync-path-agnostic; see ebay-order-detection.ts).
  // Gates the eBay Logistics carrier so an eBay order synced via ShipStation still gets eBay rates.
  isEbayMarketplaceOrder?: boolean | null;
  /** Backend-resolved only. Omitted for clear/disabled declarations. */
  hazmatQuoteFacts?: CanonicalHazmatQuoteFacts;
  hazmatCapabilities?: HazmatCapabilities;
};

function normalizeZip(zip: string): string {
  const digits = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  return digits || String(zip ?? '').trim().toUpperCase();
}

// Audit R-7 (2026-07-13): the identity day-bucket is computed in the SHIP-FROM
// operating timezone (America/Los_Angeles — Carson, CA warehouse), not UTC.
// With the UTC bucket, "today" rolled at 4-5pm PT mid-shift: every cache key
// changed at once (fleet-wide re-rate stampede) and every saved fingerprint
// mismatched fresh ones while operators were still shipping. Rolling at local
// midnight moves both to idle hours. Same YYYY-MM-DD format — no version bump.
const SHIP_DATE_BUCKET_TZ = 'America/Los_Angeles';
const shipDateBucketFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHIP_DATE_BUCKET_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export function shipDateBucket(date: Date = new Date()): string {
  return shipDateBucketFormatter.format(date);
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
      street1: input.toAddress,
      street2: input.toAddress2,
      city: input.toCity,
      state: input.toState,
      postalCode: input.toZip,
      country: input.toCountry,
    },
    manualOverrideResidential: input.manualOverrideResidential ?? null,
    sourceResidential:
      input.sourceResidential ?? (typeof input.residential === 'boolean' ? input.residential : null),
    // PS-276 (slice 2b): resolver evidence — the canonical classifier's trusted tiers 4 (USPS
    // validated business) + 2 (UPS/FedEx provider verdict). Undefined until the resolver is wired
    // + ADDRESS_RESOLVER=on (slice 2b-2), so today this is a no-op (tiers stay inactive).
    addressValidation: input.addressValidation ?? undefined,
    providerMarker: input.providerMarker ?? undefined,
  });
}

export async function resolveRateInput(
  input: RateInput,
  // PS-197b: rawManualEstimate = quote the UNINSURED manual baseline (what ShipStation's own
  // Rate Browser shows) for side-by-side comparison. Skips the HUGRAB request-level insurance
  // forcing ONLY for this read-only reference quote — the label-safe path is untouched, and the
  // route never stamps proof/selection keys on manual-estimate rates, so they are structurally
  // non-purchasable.
  opts: { rawManualEstimate?: boolean; priority?: RateFetchPriority } = {},
): Promise<RateInput> {
  input.signal?.throwIfAborted();
  // PS-466: resolveRateInput is the common service boundary used by interactive,
  // background, and direct-carrier rate work. Internal callers that were not
  // already sealed by a scoped route reconcile here before carrier discovery.
  if (input.orderId && !input.automationRulesVersion) {
    input = await prepareAutomationRateIntent(input, GLOBAL_SCOPE);
  }
  const context = await resolveRateCredentialContext(input);
  // Store-level Carrier & Service Controls, plus any carrier/service this
  // specific order's automation plan excluded. Both are the same rule shape and
  // both go through the same eligibility evaluator -- the per-order ones were
  // being computed and persisted but never consulted, so carrier.exclude and
  // service.exclude quoted the excluded carrier anyway.
  const automationRules = [
    ...(await loadShippingAutomationControls()),
    ...(input.orderId
      ? await loadOrderAutomationExclusionRules({
          orderId: input.orderId,
          clientId: context.clientId ?? null,
          storeId: context.storeId ?? null,
        })
      : []),
  ];
  const isHugrab = isHugrabShippingContext({
    clientId: context.clientId,
    storeId: context.storeId,
  });
  const hugrabDefaultInsuranceEnabled = isHugrab
    ? await loadHugrabDefaultInsuranceEnabled()
    : true;
  const insuranceEligibilityContext: ShippingServiceEligibilityContext = {
    clientId: context.clientId,
    storeId: context.storeId,
    hugrabDefaultInsuranceEnabled,
  };
  const discoveredCarriers = await getAllCarriers(context.apiKeyV2, {
    priority: opts.priority,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const excludedAutomationCarriers = new Set((input.automationExcludedCarrierIds ?? []).map((value) => String(value).trim().toLowerCase()));
  const candidateCarriers = (input.carrierIds?.length
    ? discoveredCarriers.filter((carrier) => input.carrierIds!.includes(carrier.carrier_id))
    : discoveredCarriers).filter((carrier) => ![
      carrier.carrier_id,
      carrier.carrier_code,
    ].map((value) => String(value ?? '').trim().toLowerCase()).some((value) => value && excludedAutomationCarriers.has(value)));
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
  const hazmatState = input.orderId != null
    ? await getOrderHazmatForShipping(Number(input.orderId))
    : null;
  const hazmatQuoteFacts = hazmatState ? hazmatQuoteFactsForShipping(hazmatState) : null;
  // Test clients never rate through these carriers: buildTestFixtureRates
  // replaces them wholesale further down. Filtering real ShipStation accounts by
  // hazmat certification here rejected every one of them (none are certified) and
  // threw before the fixture branch was ever reached, so an active declaration
  // produced "5 of 5 carriers checked, 0 with rates" and hazmat could not be
  // exercised on a test order at all. The prepship_test profile still governs the
  // fixture path itself, so this skips a filter that cannot apply rather than
  // relaxing a safety check.
  const hazmatIsTestClient = await loadClientIsTest(context.clientId);
  const hazmatAllowedCarriers = hazmatQuoteFacts && hazmatState && !hazmatIsTestClient
    ? allowedCarriers.filter((carrier) => {
        const profile = resolveHazmatProfile({
          providerFamily: 'shipstation',
          provider: 'shipstation',
          carrierCode: carrier.carrier_code,
          facts: hazmatQuoteFacts,
        });
        try {
          assertHazmatRatingSupported({
            facts: hazmatQuoteFacts,
            profile,
            capabilities: hazmatState.capabilities,
          });
          return true;
        } catch {
          return false;
        }
      })
    : allowedCarriers;
  if (hazmatQuoteFacts && !hazmatIsTestClient && hazmatAllowedCarriers.length === 0) {
    throw new HazmatShippingError(
      'No certified ShipStation carrier is available for this hazmat declaration.',
      'HAZMAT_RATE_UNAVAILABLE',
    );
  }
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
        insuranceEligibilityContext,
        input,
      );
  // insurance.require / confirmation.set from this order's automation plan.
  // Both only ever ADD to what the request already asked for -- see
  // order-rate-plan-overlay.ts.
  const planOverlay = input.orderId
    ? await loadOrderRatePlanOverlay(input.orderId)
    : { insuranceMinimumValue: null, confirmation: null };

  const insuranceProvider = requestInsurance.insuranceProvider as string;
  // A rule can raise cover, never lower it, and never on the deliberately
  // uninsured manual baseline.
  const automationInsuredValue = opts.rawManualEstimate
    ? requestInsurance.insuredValue
    : applyInsuranceFloor(requestInsurance.insuredValue, planOverlay.insuranceMinimumValue);
  const insuredValue = automationInsuredValue;
  const insuranceRaisedByAutomation =
    planOverlay.insuranceMinimumValue != null
    && !opts.rawManualEstimate
    && automationInsuredValue !== requestInsurance.insuredValue;
  const effectiveInsuranceSource = insuranceRaisedByAutomation
    ? ('automation' as const)
    : requestInsurance.source;

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
    // confirmation.set fills in ONLY when the request expressed no preference,
    // so an operator's explicit choice always wins. Set on the resolved input
    // rather than at the two call sites that read it: rateCacheKey and the
    // provider request body both derive from this object, and applying it to
    // one but not the other would let two different confirmations share a
    // cache entry.
    confirmation: normalizeRateConfirmation(input.confirmation)
      ? input.confirmation
      : planOverlay.confirmation ?? input.confirmation,
    // PS-126: canonical rate path keeps the EXACT postal (US ZIP+4 when present) so
    // ShipStation rate quotes match exactly. Falls back to legacy zip5 only if the
    // helper can't produce an exact value. Direct carriers get zip5 at their boundary.
    toZip: normalizeShippingPostalCode(input.toZip, input.toCountry).exact ?? normalizeZip(input.toZip),
    residential,
    residentialClassification: residentialClassification.classification,
    residentialSource: residentialClassification.source,
    destinationPoBox: residentialClassification.poBox,
    storeId: context.storeId,
    clientId: context.clientId,
    apiKeyV2: context.apiKeyV2,
    sourceClientId: context.sourceClientId,
    insuranceProvider,
    insuredValue,
    effectiveInsuranceProvider: insuranceProvider,
    effectiveInsuredValue: insuredValue,
    effectiveInsuranceSource,
    hugrabDefaultInsuranceEnabled: isHugrab ? hugrabDefaultInsuranceEnabled : null,
    automationRulesVersion: input.automationRulesVersion
      ? `${shippingAutomationControlsFingerprint(automationRules)}:${input.automationRulesVersion}`
      : shippingAutomationControlsFingerprint(automationRules),
    carrierIds: hazmatAllowedCarriers.map((carrier) => carrier.carrier_id).sort(),
    ...(hazmatQuoteFacts && hazmatState
      ? { hazmatQuoteFacts, hazmatCapabilities: hazmatState.capabilities }
      : {}),
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
    destinationPoBox: input.destinationPoBox,
    clientId: input.clientId,
    storeId: input.storeId,
    sourceClientId: input.sourceClientId,
    apiKeyFingerprint: input.apiKeyV2 ? apiKeyCacheKey(input.apiKeyV2) : null,
    // Audit C4: bind the EXPLICIT ship-from origin (PS-291 operator-selected) into
    // cache/dedupe/proof identity. Absent shipFrom = account default origin (part
    // omitted -> default-flow keys unchanged). shipFromPostalCode's '90248' fallback
    // is fine here: it is the same value the estimate body sends, so identity still
    // matches what was actually quoted.
    shipFromZip: input.shipFrom ? shipFromPostalCode(input.shipFrom) : null,
    shipFromCountry: input.shipFrom?.country_code ?? null,
    dimsL: input.dimsL,
    dimsW: input.dimsW,
    dimsH: input.dimsH,
    confirmation,
    insuranceProvider: options.insuranceProvider,
    insuredValue: options.insuredValue,
    carrierIds: input.carrierIds,
    automationRulesVersion: input.automationRulesVersion,
    hugrabDefaultInsuranceEnabled: input.hugrabDefaultInsuranceEnabled,
    hazmatSnapshotHash: input.hazmatQuoteFacts?.declarationHash,
  });
}

function rateTotal(rate: Rate): number {
  return combinedRateTotal(rate as any);
}

function rateCostTotal(rate: Rate): number {
  return combinedRateCostTotal(rate as any);
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

// Exported for PS-356 and legacy guards: the persisted Best Rate ranks on the
// marked/customer rate. Internal carrier cost rides separately as Rate Cost.
export function pickBestRate(rates: Rate[], preference?: RatePreference | null): Rate | null {
  // PS-108: never auto-select an insured rate whose ParcelGuard premium could not be
  // proven. Such rates are flagged `insuranceCostUnresolved` by the enricher; excluding
  // them here guarantees the saved bestRate is never a postage-only insured rate.
  // isPricedRate: never select an unpriced/$0 rate as best (root-cause fix for the
  // "Rate unavailable" / "N/A Recommended" symptom). Defense-in-depth — the source
  // lift already drops these, but any other caller of pickBestRate is protected too.
  const selectable = rates.filter((rate) => isRateInsuranceResolved(rate) && isPricedRate(rate));
  if (!selectable.length) return null;
  const ranked = [...selectable].sort((a, b) => (rateTotal(a) - rateTotal(b)) || (rateCostTotal(a) - rateCostTotal(b)));
  // carrier.prefer / service.prefer narrow the ALREADY-RANKED list, so the
  // cheapest preferred rate wins and the canonical ordering is untouched. A
  // preference that matches nothing falls through to the overall cheapest --
  // it is a tie-break, never a filter, so an automation can never leave an
  // order unrated. `preference` is null unless AUTOMATION_PREFERENCE_RANKING
  // is on, so this is a no-op by default.
  return narrowToPreferred(ranked, preference ?? null)[0]!;
}

function rateEligibilityContext(
  input: Pick<RateInput, 'clientId' | 'storeId' | 'hugrabDefaultInsuranceEnabled' | 'destinationPoBox'>,
): ShippingServiceEligibilityContext {
  return {
    clientId: input.clientId ?? null,
    storeId: input.storeId ?? null,
    hugrabDefaultInsuranceEnabled: input.hugrabDefaultInsuranceEnabled ?? null,
    destinationPoBox: input.destinationPoBox ?? null,
  };
}

function rateShippingOptionEligibilityContext(input: Pick<RateInput, 'insuranceProvider' | 'insuredValue'>) {
  return normalizeShippingOptions(input);
}

function genericRateTotal(rate: unknown): number {
  if (!rate || typeof rate !== 'object') return Number.POSITIVE_INFINITY;
  return normalizeShippingRateMoney(rate).cShippingRateAmount ?? Number.POSITIVE_INFINITY;
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

export function filterRatesForAutomationPlan<T>(rates: T[], input: Pick<RateInput, 'automationExcludedCarrierIds' | 'automationExcludedServiceIds'>): T[] {
  const carriers = new Set((input.automationExcludedCarrierIds ?? []).map((value) => String(value).trim().toLowerCase()));
  const services = new Set((input.automationExcludedServiceIds ?? []).map((value) => String(value).trim().toLowerCase()));
  if (carriers.size === 0 && services.size === 0) return rates;
  return rates.filter((rate) => {
    const descriptor = rateToShippingServiceDescriptor(rate);
    const carrierBlocked = [descriptor.carrierId, descriptor.carrierCode]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((value) => value && carriers.has(value));
    const serviceBlocked = [descriptor.serviceCode, descriptor.serviceName]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .some((value) => value && services.has(value));
    return !carrierBlocked && !serviceBlocked;
  });
}

export function sanitizeRateCacheRowForEligibility<T extends { rates?: unknown; bestRate?: unknown }>(
  row: T,
  context: ShippingServiceEligibilityContext,
  shippingOptions?: ReturnType<typeof normalizeShippingOptions>,
  automationRules?: ShippingAutomationRule[] | null,
  // Audit R-2 (2026-07-13): when the stored best is filtered out, the fallback
  // re-pick must rank on the MARKED basis (markup-before-ranking, PS-313) — the
  // old raw-basis sort could crown a different winner than browse/backfill.
  // Optional so legacy callers keep byte-identical behavior until they pass it.
  markups?: Map<string, Markup>,
): T {
  const rawRates = Array.isArray(row.rates) ? row.rates : [];
  const rates = filterRatesForShippingServiceEligibility(rawRates, context, shippingOptions, automationRules)
    .filter((rate) => isPricedRate(rate as Parameters<typeof isPricedRate>[0]));
  const bestRateAllowed =
    row.bestRate != null &&
    evaluateShippingServiceEligibility(context, rateToShippingServiceDescriptor(row.bestRate), shippingOptions, automationRules).allowed &&
    isPricedRate(row.bestRate as Parameters<typeof isPricedRate>[0]);
  const selectable = rates.filter((rate) => isRateInsuranceResolved(rate));
  let fallbackBest: unknown = null;
  if (selectable.length) {
    // Rank on marked totals when markups are supplied; return the RAW row object
    // either way (applyMarkups maps 1:1, so index identity holds).
    const ranked = markups?.size
      ? applyMarkups(selectable as Rate[], markups)
      : (selectable as Rate[]);
    let bestIdx = 0;
    for (let i = 1; i < ranked.length; i += 1) {
      if (genericRateTotal(ranked[i]!) < genericRateTotal(ranked[bestIdx]!)) bestIdx = i;
    }
    fallbackBest = selectable[bestIdx] ?? null;
  }
  const bestRate = bestRateAllowed && isRateInsuranceResolved(row.bestRate)
    ? row.bestRate
    : fallbackBest;
  return {
    ...row,
    rates,
    bestRate,
  };
}

// Audit R-6 (2026-07-13): read-time pricing for the cached fast-paint lane.
// rate_cache.rates is stored RAW; the stored bestRate carries write-time marked
// stamps that go stale when markup rules change. Apply the CURRENT markups and
// recompute the displayed best over the marked, eligibility-sanitized set —
// same "price at read time in the backend" rule as PS-177 — so the fast paint
// can never disagree with what a live browse would select. Lives HERE (not in
// the route) because ranking/marking is backend rate-owner truth (PS-313).
export function markRateCacheRowForDisplay<T extends { rates?: unknown; bestRate?: unknown }>(
  row: T,
  markups: Map<string, Markup>,
): T {
  const raw = Array.isArray(row.rates) ? (row.rates as Rate[]) : [];
  if (!raw.length) return row;
  const marked = applyMarkups(raw, markups);
  return {
    ...row,
    rates: marked,
    bestRate: pickBestRate(marked) ?? row.bestRate ?? null,
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

// PS-206: 'uncached' = the carrier was deliberately NOT quoted in a
// cached-only lookup and has no cached coverage — terminal for the lookup,
// live check required. Never 'loading' (nothing is in flight).
export type CarrierRateDiagnosticStatus =
  | 'ok'
  | 'empty'
  | 'failed'
  | 'cached'
  | 'loading'
  | 'uncached'
  | 'skipped';

export type CarrierRateDiagnostic = {
  carrierId: string;
  accountId?: string;
  carrierCode?: string;
  nickname?: string;
  status: CarrierRateDiagnosticStatus;
  rateCount: number;
  durationMs?: number;
  limiterWaitMs?: number;
  attempts?: number;
  retryable?: boolean;
  requestMode?: 'batch' | 'fallback';
  error?: string;
  // PS-473: the provider's own message, credentials scrubbed and length capped.
  // `error` above stays the sanitized category; this is the detail that tells
  // an operator WHY, e.g. whether USPS refused dangerous goods outright or
  // rejected a field in our hazmat payload. Diagnostic-only -- nothing reads it
  // to make a rating, ranking, or eligibility decision.
  providerDetail?: string;
  // PS-271 (Layer 4): true when this direct-carrier pass was an accepted-thin partial (Shipp Layer 1
  // returned a non-empty-but-thin set). Additive + display-only; absent today and for every non-thin
  // pass. combineCarrierUniverses reads it to mark the carrier status / best as thin/unproven.
  thin?: boolean;
  // PS-271 (Layer 4): the NAMED observed-expected carriers that were absent from the accepted-thin pass
  // (the connector's observedMissing[]) — the out-of-band diagnostic that says WHICH carriers we never
  // saw, not just a thin boolean. Additive + display-only; omitted on every non-thin pass (never empty).
  expectedCarrierAbsent?: string[];
  // RC1: true when this carrier's 'failed' status came from a TRANSIENT error (timeout / 429 / 5xx /
  // network) that EXHAUSTED its retries — as opposed to a TERMINAL 4xx / no-service. RC2 reads it to
  // refuse caching an incomplete (transient-failed) set as authoritative. Additive; absent otherwise.
  transient?: boolean;
};

// Cheap mini-carrier lookup so we can tell stamps_com apart (needs city/state
// in the rate-estimate body). v2 calls discoverCarriers() per request; v4
// reuses its 15-min-cached getAllCarrierIds() + a parallel nickname cache.
type CarrierInfo = { carrier_id: string; carrier_code: string; nickname?: string };
export type RateCarrierAccount = CarrierInfo & {
  friendly_name?: string;
  source_client_id: number | null;
  source_client_name: string;
  display_disambiguator?: string | null;
  direct_carrier_account_id?: number;
  direct_carrier_source_table?: 'carrier_accounts' | 'store_accounts';
  linked_store_account_id?: number | null;
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
  linkedStoreAccountId: number | null;
  displayIdentity: string;
  identityBlockReason: string | null;
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
  authorizationAccounts: ShippingQuoteAccountAuthorization[];
  providerFetches: number;
  usedCachedRates: boolean;
};

function directCarrierQuoteAuthorizationAccount(
  account: DirectCarrierAccountInfo,
  shippingProviderId: number,
): ShippingQuoteAccountAuthorization {
  return {
    providerFamily: 'direct',
    provider: normalizeProviderKey(account.provider),
    shippingProviderId,
    sourceTable: account.sourceTable,
    sourceAccountId: account.id,
    ownerClientId: account.clientId,
    ownerStoreAccountId: account.linkedStoreAccountId,
    credentialSource: account.sourceTable === 'store_accounts' ? 'store_account' : 'carrier_account',
    credentialFingerprint: shippingQuoteCredentialFingerprint(account.credentials),
    environment: process.env.NODE_ENV ?? 'development',
  };
}

// PS-132: derived from the single backend carrier-account registry (src/lib/
// carrier-account-registry.ts) so the rate-carrier display can't drift from Orders/Settings.
const V2_CARRIER_ACCOUNT_OVERRIDES = new Map<string, { carrier_code: string; nickname: string }>(
  KNOWN_CARRIER_ACCOUNTS.map((account) => [
    carrierIdForProvider(account.shippingProviderId),
    { carrier_code: account.carrierCode, nickname: account.nickname },
  ]),
);

async function getAllCarriers(
  apiKeyV2?: string | null,
  options: { priority?: RateFetchPriority; signal?: AbortSignal } = {},
): Promise<CarrierInfo[]> {
  options.signal?.throwIfAborted();
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
      priority: options.priority,
      signal: options.signal,
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
    if (options.signal?.aborted) {
      throw options.signal.reason ?? err;
    }
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
  const testClientId = input.clientId ?? (
    input.storeId != null ? await resolveClientIdForStoreId(input.storeId) : null
  );
  if (testClientId != null && (await loadClientIsTest(testClientId))) {
    return buildTestFixtureCarrierAccounts({
      sourceClientId: testClientId,
      sourceClientName: (await loadClientName(testClientId)) ?? 'PrepShip Test',
    });
  }
  const context = await resolveRateCredentialContext({
    storeId: input.storeId ?? null,
    clientId: input.clientId ?? null,
  });
  const automationRules = await loadShippingAutomationControls();
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
    // PS-216: operator-safe disambiguator for duplicate nicknames — the Rate
    // Browser shows "GREG PAYABILITY 6/17 (USPS)" / "(UPS)", never provider
    // ids like se-442006. Owned here (the carriers-for-store read DTO) so the
    // FE renders backend display facts instead of inventing labels from ids.
    display_disambiguator: carrierFamilyDisplayLabel(carrier.carrier_code),
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

type BatchedCarrierEstimateResult = {
  results: CarrierEstimateResult[];
  missingCarriers: CarrierInfo[];
};

function publicCarrierRateError(err: unknown): string {
  return sanitizeRateProviderError(err);
}

function buildShipStationEstimateBody(
  carriers: readonly CarrierInfo[],
  input: RateInput,
  shipFrom: Address,
): Record<string, unknown> {
  const needsCity = carriers.some((carrier) => carrier.carrier_code === 'stamps_com');
  const body: Record<string, unknown> = {
    carrier_ids: carriers.map((carrier) => carrier.carrier_id),
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
  return body;
}

export function buildShipStationFullRateBody(
  carriers: readonly CarrierInfo[],
  input: RateInput,
  shipFrom: Address,
): Record<string, unknown> {
  if (!input.hazmatQuoteFacts || !input.hazmatCapabilities) {
    throw new Error('Active hazmat rate requests require backend-sealed declaration facts.');
  }
  const profiles = carriers.map((carrier) => {
    const profile = resolveHazmatProfile({
      providerFamily: 'shipstation',
      provider: 'shipstation',
      carrierCode: carrier.carrier_code,
      facts: input.hazmatQuoteFacts!,
    });
    return assertHazmatRatingSupported({
      facts: input.hazmatQuoteFacts!,
      profile,
      capabilities: input.hazmatCapabilities!,
    });
  });
  const uniqueProfiles = [...new Set(profiles)];
  if (uniqueProfiles.length !== 1) {
    throw new Error('Hazmat carriers with different provider profiles must be rated separately.');
  }
  const options = normalizeShippingOptions(input);
  const pkg: Record<string, unknown> = {
    package_code: 'package',
    weight: { value: input.weightOz, unit: 'ounce' },
  };
  if (input.dimsL && input.dimsW && input.dimsH) {
    pkg.dimensions = {
      length: input.dimsL,
      width: input.dimsW,
      height: input.dimsH,
      unit: 'inch',
    };
  }
  if (options.insuranceProvider !== 'none' && options.insuredValue != null) {
    pkg.insured_value = { amount: options.insuredValue, currency: 'usd' };
  }
  const sealed = sealHazmatQuoteFacts(input.hazmatQuoteFacts, uniqueProfiles[0]!);
  const shipment = applyShipStationHazmatToShipment({
    ship_date: shipDateIso(),
    ship_from: shipFrom,
    ship_to: {
      name: input.toName ?? 'Recipient',
      company_name: input.toCompany ?? undefined,
      phone: '000-000-0000',
      address_line1: input.toAddress ?? '',
      address_line2: input.toAddress2 ?? undefined,
      city_locality: input.toCity ?? '',
      state_province: input.toState ?? '',
      postal_code: input.toZip,
      country_code: (input.toCountry ?? 'US').toUpperCase(),
      address_residential_indicator:
        input.residential === true ? 'yes' : input.residential === false ? 'no' : 'unknown',
    },
    packages: [pkg],
    confirmation: options.confirmation,
    ...(options.insuranceProvider !== 'none'
      ? { insurance_provider: options.insuranceProvider }
      : {}),
  }, sealed);
  return {
    rate_options: { carrier_ids: carriers.map((carrier) => carrier.carrier_id) },
    shipment,
  };
}

function buildShipStationRateRequest(
  carriers: readonly CarrierInfo[],
  input: RateInput,
  shipFrom: Address,
): { body: Record<string, unknown>; rateMode?: 'shipment' } {
  if (!input.hazmatQuoteFacts) {
    return { body: buildShipStationEstimateBody(carriers, input, shipFrom) };
  }
  return {
    body: buildShipStationFullRateBody(carriers, input, shipFrom),
    rateMode: 'shipment',
  };
}

function stampEstimateRateCarrier(rate: EstimateRate, carrier: CarrierInfo, input: RateInput): void {
  const override = V2_CARRIER_ACCOUNT_OVERRIDES.get(carrier.carrier_id);
  if (!rate.carrier_id) rate.carrier_id = carrier.carrier_id;
  rate.carrier_code = override?.carrier_code ?? rate.carrier_code ?? carrier.carrier_code;
  rate.carrier_nickname = override?.nickname ?? rate.carrier_nickname ?? carrier.nickname;
  if (input.hazmatQuoteFacts && input.hazmatCapabilities) {
    const profile = resolveHazmatProfile({
      providerFamily: 'shipstation',
      provider: 'shipstation',
      carrierCode: rate.carrier_code ?? carrier.carrier_code,
      facts: input.hazmatQuoteFacts,
    });
    (rate as EstimateRate & { hazmatProfile?: string }).hazmatProfile = assertHazmatRatingSupported({
      facts: input.hazmatQuoteFacts,
      profile,
      capabilities: input.hazmatCapabilities,
    });
  }
}

// Default path: one /v2/rates/estimate call per carrier. Kept intact behind
// SHIPSTATION_BATCHED_RATE_FANOUT=false and reused for targeted batch gaps.
async function fetchEstimateForCarrier(
  carrier: CarrierInfo,
  input: RateInput,
  shipFrom: Address,
  timeoutMs: number,
  priority: RateFetchPriority,
): Promise<CarrierEstimateResult> {
  const startedAt = Date.now();
  const request = buildShipStationRateRequest([carrier], input, shipFrom);
  const options = normalizeShippingOptions(input);
  try {
    // Audit R-4: abortable — the deadline stops the underlying HTTP work.
    const payload = await withAbortableCarrierQuoteTimeout(
      (signal) => quoteCarrierRates('shipstation', {
        body: request.body,
        ...(request.rateMode ? { rateMode: request.rateMode } : {}),
        shippingOptions: options,
        apiKeyV2: input.apiKeyV2 ?? undefined,
        dedupeKey: `rates-estimate:${carrier.carrier_id}:${rateCacheKey(input)}`,
        timeoutMs,
        signal,
        priority,
      }),
      `shipstation:${carrier.carrier_code}`,
      timeoutMs,
      input.signal,
    );
    const rates = payload.rates as EstimateRate[];
    // Single-account responses can safely fill carrier_id when ShipStation omits it.
    for (const r of rates) stampEstimateRateCarrier(r, carrier, input);
    const override = V2_CARRIER_ACCOUNT_OVERRIDES.get(carrier.carrier_id);
    return {
      carrier,
      rates,
      diagnostic: {
        carrierId: carrier.carrier_id,
        accountId: carrier.carrier_id,
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
        accountId: carrier.carrier_id,
        carrierCode: carrier.carrier_code,
        nickname: carrier.nickname,
        status: 'failed',
        rateCount: 0,
        durationMs: Date.now() - startedAt,
        error: message,
        // PS-473: `error` is the sanitized category and stays the display
        // string; this carries the provider's actual words so a hard rejection
        // is legible without a log dive.
        ...(() => {
          const detail = rateProviderErrorDetail(err);
          return detail && detail !== message ? { providerDetail: detail } : {};
        })(),
        transient: isTransientCarrierRateError(err),
        retryable: isTransientCarrierRateError(err),
      },
    };
  }
}

async function fetchEstimateForCarriers(
  carriers: CarrierInfo[],
  input: RateInput,
  shipFrom: Address,
  timeoutMs: number,
  priority: RateFetchPriority,
): Promise<BatchedCarrierEstimateResult> {
  const startedAt = Date.now();
  const request = buildShipStationRateRequest(carriers, input, shipFrom);
  const options = normalizeShippingOptions(input);
  const carrierSetHash = createHash('sha256')
    .update(carriers.map((carrier) => carrier.carrier_id).sort().join('\n'))
    .digest('hex')
    .slice(0, 16);
  // Audit R-4: abortable — a hung batch dies at the deadline instead of
  // shadow-retrying while the per-account fallback also runs.
  const payload = await withAbortableCarrierQuoteTimeout(
    (signal) => quoteCarrierRates('shipstation', {
      body: request.body,
      ...(request.rateMode ? { rateMode: request.rateMode } : {}),
      shippingOptions: options,
      apiKeyV2: input.apiKeyV2 ?? undefined,
      dedupeKey: `rates-estimate:batch:${carrierSetHash}:${rateCacheKey(input)}`,
      timeoutMs,
      signal,
      priority,
    }),
    'shipstation:batch',
    timeoutMs,
    input.signal,
  );
  const rates = payload.rates as EstimateRate[];
  const partition = partitionShipStationEstimateBatch(
    carriers.map((carrier) => carrier.carrier_id),
    rates,
  );
  if (partition.rejectedRates.length > 0) {
    console.warn(
      `[rates-estimate] rejected ${partition.rejectedRates.length} batched rate row(s) without a requested carrier_id`,
    );
  }

  const carrierById = new Map(carriers.map((carrier) => [carrier.carrier_id, carrier]));
  const results: CarrierEstimateResult[] = [];
  for (const [carrierId, carrierRates] of partition.ratesByCarrierId) {
    if (carrierRates.length === 0) continue;
    const carrier = carrierById.get(carrierId);
    if (!carrier) continue;
    for (const rate of carrierRates) stampEstimateRateCarrier(rate, carrier, input);
    const override = V2_CARRIER_ACCOUNT_OVERRIDES.get(carrier.carrier_id);
    results.push({
      carrier,
      rates: carrierRates,
      diagnostic: {
        carrierId: carrier.carrier_id,
        accountId: carrier.carrier_id,
        carrierCode: override?.carrier_code ?? carrier.carrier_code,
        nickname: override?.nickname ?? carrier.nickname,
        status: 'ok',
        rateCount: carrierRates.length,
        durationMs: Date.now() - startedAt,
        requestMode: 'batch',
      },
    });
  }

  const missingSet = new Set(partition.missingCarrierIds);
  return {
    results,
    missingCarriers: carriers.filter((carrier) => missingSet.has(carrier.carrier_id)),
  };
}

// RC1: retry a TRANSIENT per-carrier estimate failure (timeout / 429 / 5xx / network) a bounded number
// of times, re-acquiring the global concurrency slot each attempt. The low-level request helper admits
// every HTTP attempt at the single ShipStation budget gate, and backoff holds no concurrency slot.
// A TERMINAL failure (4xx / no-service) returns on
// the first attempt — never retried. By the retry the initial concurrency burst has usually drained, so
// a merely-slow carrier resolves instead of being permanently dropped to "Rate unavailable".
async function fetchEstimateForCarrierWithRetry(
  carrier: CarrierInfo,
  input: RateInput,
  shipFrom: Address,
  priority: RateFetchPriority,
): Promise<CarrierEstimateResult> {
  const policy = resolveRateBrowseProviderExecutionPolicy({
    priority,
    defaultTimeoutMs: SHIPSTATION_RATE_ESTIMATE_TIMEOUT_MS,
    defaultMaxRetries: RATE_ESTIMATE_MAX_RETRIES,
  });
  const startedAt = Date.now();
  let attempts = 0;
  let limiterWaitMs = 0;
  const result = await runWithTransientRetry(
    () => {
      const waitStartedAt = Date.now();
      return runWithGlobalRateLimiter(() => {
        limiterWaitMs += Date.now() - waitStartedAt;
        attempts += 1;
        return fetchEstimateForCarrier(carrier, input, shipFrom, policy.timeoutMs, priority);
      }, priority);
    },
    (result) => result.diagnostic.status === 'failed' && result.diagnostic.transient === true,
    { maxRetries: policy.maxRetries, baseDelayMs: RATE_ESTIMATE_RETRY_BASE_MS },
  );
  return {
    ...result,
    diagnostic: {
      ...result.diagnostic,
      durationMs: Date.now() - startedAt,
      limiterWaitMs,
      attempts,
    },
  };
}

async function fetchBatchedEstimatesWithFallback(
  carriers: CarrierInfo[],
  input: RateInput,
  shipFrom: Address,
  priority: RateFetchPriority,
): Promise<CarrierEstimateResult[]> {
  const policy = resolveRateBrowseProviderExecutionPolicy({
    priority,
    defaultTimeoutMs: SHIPSTATION_RATE_ESTIMATE_TIMEOUT_MS,
    defaultMaxRetries: RATE_ESTIMATE_MAX_RETRIES,
  });
  const startedAt = Date.now();
  let limiterWaitMs = 0;
  let batchResults: CarrierEstimateResult[] = [];
  let missingCarriers = carriers;

  // Batching-review LOW (2026-07-14): the batch is a PROBE with a per-account
  // fallback behind it — giving it the full per-call budget meant a hung batch
  // burned the whole timeout and THEN ran the full single fan-out (worst-case
  // ~2x flag-off latency). Cap the probe at the smaller of the policy budget
  // and an env-tunable probe budget; the abort threading (audit R-4) kills the
  // HTTP work at that deadline, then the fallback proceeds with full budgets.
  const batchProbeTimeoutMs = Math.min(
    policy.timeoutMs,
    Math.max(3_000, Number.parseInt(process.env.SHIPSTATION_BATCHED_PROBE_TIMEOUT_MS ?? '8000', 10) || 8_000),
  );
  try {
    const waitStartedAt = Date.now();
    const batch = await runWithGlobalRateLimiter(() => {
      limiterWaitMs += Date.now() - waitStartedAt;
      return fetchEstimateForCarriers(carriers, input, shipFrom, batchProbeTimeoutMs, priority);
    }, priority);
    const durationMs = Date.now() - startedAt;
    batchResults = batch.results.map((result) => ({
      ...result,
      diagnostic: {
        ...result.diagnostic,
        durationMs,
        limiterWaitMs,
        attempts: 1,
      },
    }));
    missingCarriers = batch.missingCarriers;
  } catch (err) {
    console.warn(
      `[rates-estimate] batched request failed; falling back to ${carriers.length} single-account request(s):`,
      publicCarrierRateError(err),
    );
  }

  const fallbackResults = await mapWithConcurrency(
    missingCarriers,
    RATE_FETCH_CONCURRENCY,
    (carrier) => fetchEstimateForCarrierWithRetry(carrier, input, shipFrom, priority),
  );
  const markedFallbackResults = fallbackResults.map((result) => ({
    ...result,
    diagnostic: { ...result.diagnostic, requestMode: 'fallback' as const },
  }));

  const resultByCarrierId = new Map(
    [...batchResults, ...markedFallbackResults].map((result) => [result.carrier.carrier_id, result]),
  );
  return carriers
    .map((carrier) => resultByCarrierId.get(carrier.carrier_id))
    .filter((result): result is CarrierEstimateResult => Boolean(result));
}

// Lift the EstimateRate shape (flat from ShipStation) into v4's Rate shape
// (used by the cache + route response).
function toRate(er: EstimateRate): Rate {
  const rate: Rate = {
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
  const hazmatProfile = (er as EstimateRate & { hazmatProfile?: string }).hazmatProfile;
  if (hazmatProfile) (rate as Rate & { hazmatProfile: string }).hazmatProfile = hazmatProfile;
  return rate;
}

export type FetchLiveRatesResult = {
  rates: Rate[];
  carrierDiagnostics: CarrierRateDiagnostic[];
};

export async function fetchLiveRatesWithDiagnostics(
  input: RateInput,
  automationRules: ShippingAutomationRule[] = [],
  priority: RateFetchPriority = 'interactive',
): Promise<FetchLiveRatesResult> {
  input.signal?.throwIfAborted();
  // PS-474: a caller-supplied origin skips getDefaultShipFrom's phone default,
  // and an empty origin phone is a hard 400 on the hazmat full-shipment path.
  const shipFrom = withShipFromPhone(input.shipFrom ?? (await getDefaultShipFrom()));
  input.signal?.throwIfAborted();

  // If the caller restricted carriers via input.carrierIds, filter the
  // discovery list to that set. Otherwise use the full cached list.
  const allCarriers = await getAllCarriers(input.apiKeyV2, {
    priority,
    signal: input.signal,
  });
  const carriers = Array.isArray(input.carrierIds)
    ? allCarriers.filter((c) => input.carrierIds!.includes(c.carrier_id))
    : allCarriers;

  if (!carriers.length) return { rates: [], carrierDiagnostics: [] };

  const batches = !input.hazmatQuoteFacts && shipStationBatchedRateFanoutEnabled() && carriers.length > 1
    ? await fetchBatchedEstimatesWithFallback(carriers, input, shipFrom, priority)
    : await mapWithConcurrency(
        carriers,
        RATE_FETCH_CONCURRENCY,
        // RC1: each carrier's estimate retries a transient timeout/429/5xx (re-acquiring its limiter slot)
        // before being dropped — a merely-slow ShipStation response no longer becomes "Rate unavailable".
        (c) => fetchEstimateForCarrierWithRetry(c, input, shipFrom, priority),
      );
  const lifted: Rate[] = batches.flatMap((batch) => batch.rates).map(toRate);

  // v2-parity: filter blocked service codes + package types + names.
  // Sort cheapest first (v2 sorts by shipmentCost + otherCost; v4 sort
  // uses shipping_amount only since markups apply at read-time later).
  const eligibilityContext = rateEligibilityContext(input);
  const shippingOptionEligibility = rateShippingOptionEligibilityContext(input);
  const eligible = dedupeRates(
    filterRatesForAutomationPlan(filterRatesForShippingServiceEligibility(
      lifted.filter((r) => !isBlockedRate(r, input.storeId ?? null)),
      eligibilityContext,
      shippingOptionEligibility,
      automationRules,
    ), input),
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
  // Root-cause fix (order 1338387): a ShipStation account can answer with rows that
  // carry NO usable amount (shipping_amount missing/null → coerced to 0). An unpriced
  // rate is not a real, chargeable rate — drop it HERE, at the source lift, so it can
  // never enter the combined set, the cache, the cheapest-pick, or the Rate Browser
  // display. The direct-carrier path already did this (toDirectRate drops amount<=0);
  // this makes the guarantee uniform across families. A carrier whose rows were ALL
  // unpriced then has 0 priced rates → its diagnostic falls to 'empty' below (the UI
  // shows it as "unavailable" instead of contributing a phantom $0 winner).
  const priced = filtered.filter(isPricedRate);
  for (const rate of filtered) {
    if (isPricedRate(rate)) continue;
    const reason =
      rate.error_messages?.join('; ') || rate.warning_messages?.join('; ') || 'no shipping amount';
    console.warn(
      `[rates] dropped unpriced ${rate.carrier_code ?? rate.carrier_id} ${rate.service_code ?? ''} rate (${reason})`,
    );
  }
  priced.sort((a, b) => (rateTotal(a) - rateTotal(b)) || (rateCostTotal(a) - rateCostTotal(b)));
  const filteredCounts = new Map<string, number>();
  for (const rate of priced) {
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

  if (priced.length) return { rates: priced, carrierDiagnostics };

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
  hugrabDefaultInsuranceEnabled: boolean | null;
  // PS-197 (residential parity): the backend-resolved classification used for the quote + WHICH
  // evidence tier decided it (manual_override / provider_marker / shipstation_source /
  // address_validation / company_heuristic / fallback_residential) — so the Rate Browser can
  // show WHY a quote was residential vs commercial (e.g. the #1461 $1.02 surcharge axis).
  residential: boolean;
  residentialClassification: string | null;
  residentialSource: string | null;
};

type GetRatesOptions = {
  forceRefresh?: boolean;
  cachedOnly?: boolean;
  // PS-197b: quote the uninsured manual baseline (see resolveRateInput) — reference only.
  rawManualEstimate?: boolean;
  // Operator-driven routes pass interactive; recalculation/backfills pass batch; background is
  // reserved for sync/polling. All tiers share the canonical ShipStation admission owner.
  priority?: RateFetchPriority;
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
        status === 'loading' ||
        status === 'skipped'
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
        // PS-473: this rebuild is field-by-field, so a new field is dropped
        // unless it is named here. Re-scrubbed on the way out so a row written
        // before the redactions existed cannot leak on read.
        providerDetail: typeof row.providerDetail === 'string'
          ? rateProviderErrorDetail(row.providerDetail)
          : undefined,
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
  markups: Map<string, Markup>,
): Promise<void> {
  // QA audit 2026-06-23: pick the PERSISTED best on the MARKED CUSTOMER CHARGE (the same basis the
  // live /rates/browse route and the Recalculate-All backfill use), NOT raw provider cost. The old
  // pickBestRate(rawRates) ranked by cost, so a +15%-markup UPS account cheapest by COST ($11.50)
  // was saved as best over a cheaper-to-the-CUSTOMER rate (USPS $12.87 → $13.22 after markup). Store
  // the winner with its RAW amount restored (original_amount) so read-time display markup applies
  // exactly once and never double-marks — mirrors the PS-203 backfill (rates-backfill.ts:686-690).
  const markedBest = pickBestRate(applyMarkups(rawRates, markups));
  let bestRate: Rate | null = markedBest;
  if (markedBest) {
    const rawAmountBest: Record<string, unknown> = {
      ...markedBest,
      ...((markedBest as { original_amount?: unknown }).original_amount
        ? { shipping_amount: (markedBest as { original_amount?: unknown }).original_amount }
        : {}),
    };
    delete rawAmountBest.original_amount;
    delete rawAmountBest.markup;
    bestRate = rawAmountBest as unknown as Rate;
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
  input.signal?.throwIfAborted();
  const resolvedInput = await resolveRateInput(input, {
    rawManualEstimate: opts.rawManualEstimate === true,
    priority: opts.priority,
  });
  input.signal?.throwIfAborted();
  const key = rateCacheKey(resolvedInput);

  // PS-187: test clients (clients.is_test — the PS-186 authority) get DETERMINISTIC
  // backend fixture rates. This is the canonical owner of what the FE's
  // buildTestRatesForShipment used to fabricate client-side. No carrier API is
  // called, nothing is written to the rate cache, and the PS-186 test-label policy
  // independently forces mock labels for these clients at purchase time — fixtures
  // can never buy postage. Real clients never reach this branch.
  if (resolvedInput.clientId != null && (await loadClientIsTest(Number(resolvedInput.clientId)))) {
    const fixtureRates = buildTestFixtureRates({
      orderId: resolvedInput.orderId ?? null,
      weightOz: Number(resolvedInput.weightOz ?? 0),
      dimsL: Number(resolvedInput.dimsL ?? 0),
      dimsW: Number(resolvedInput.dimsW ?? 0),
      dimsH: Number(resolvedInput.dimsH ?? 0),
    }) as unknown as Rate[];
    return {
      rates: fixtureRates,
      bestRate: pickBestRate(fixtureRates),
      cached: false,
      cacheKey: key,
      fetchedAt: new Date().toISOString(),
      carrierDiagnostics: [],
      effectiveInsuranceProvider: resolvedInput.effectiveInsuranceProvider ?? resolvedInput.insuranceProvider ?? null,
      effectiveInsuredValue: resolvedInput.effectiveInsuredValue ?? resolvedInput.insuredValue ?? null,
      effectiveInsuranceSource: 'test-fixture',
      hugrabDefaultInsuranceEnabled: resolvedInput.hugrabDefaultInsuranceEnabled ?? null,
      residential: resolvedInput.residential === true,
      residentialClassification: resolvedInput.residentialClassification ?? null,
      residentialSource: resolvedInput.residentialSource ?? null,
    };
  }

  const automationRules = await loadShippingAutomationControls();

  // Markups apply at read time so config changes reflect instantly without
  // having to bust the rate cache.
  const markups = await loadCarrierMarkups();

  if (!opts.forceRefresh) {
    const cached = await selectRateCacheByKey(key);
    if (cached) {
      const shippingOptionEligibility = rateShippingOptionEligibilityContext(resolvedInput);
      let cachedRaw = filterRatesForAutomationPlan(filterRatesForShippingServiceEligibility(
        dedupeRates(cached.rates as Rate[], 'cached'),
        rateEligibilityContext(resolvedInput),
        shippingOptionEligibility,
        automationRules,
      ), resolvedInput);
      // PS-264: cached rates must run the SAME insurance enrichment as the live
      // path (see :1078-1096) BEFORE best-rate selection — otherwise a cached
      // HUGRAB/insured rate carries a stale/zero insurance_amount and the
      // cheapest-pick (rateTotal sums the premium) mis-picks by ~$0.99-$1.39 and
      // the Rate Browser shows a wrong total. Same ctx + per-candidate provider
      // hook as live; bind back to cachedRaw so cache-repair, applyMarkups and
      // pickBestRate all see the insured total. Non-insured/non-HUGRAB rates
      // resolve to 'none' (no-op); unresolved insured premiums are dropped from
      // the selectable set, mirroring the live path's unresolved split.
      cachedRaw = enrichRatesWithInsuranceCost(
        cachedRaw,
        {
          insuranceProvider: input.insuranceProvider,
          insuredValue: input.insuredValue,
          toCountry: input.toCountry,
        },
        undefined,
        (rate) => effectiveInsuranceProviderForAccount({
          shippingProviderId: rate.carrier_id ?? null,
          carrierCode: rate.carrier_code ?? null,
          serviceCode: rate.service_code ?? null,
          insuredValue: input.insuredValue,
        }),
      ).resolved;
      cachedRaw = cachedRaw.filter(isPricedRate);
      const cacheAgeMs = Date.now() - cached.fetchedAt.getTime();
      const cacheTtlMs = cachedRaw.length ? CACHE_TTL_MS : RATE_NEGATIVE_CACHE_TTL_MS;
      if (cacheAgeMs >= cacheTtlMs) {
        // Fall through to live refresh. Empty/no-service results are cached
        // only briefly so operators are not stuck with stale carrier failures.
      } else {
        if (cachedRaw.length !== (cached.rates as Rate[]).length) {
          // Audit R-2 (2026-07-13): pick the repaired winner on the MARKED basis,
          // exactly like the original write at writeRateCache — the raw-basis pick
          // here could persist a different best than browse/backfill select
          // (e.g. an $11.50-cost UPS beating a customer-cheaper USPS), violating
          // markup-before-ranking on a persisted surface until the next full
          // rewrite.
          void db
            .update(rateCache)
            .set({
              rates: cachedRaw as unknown[],
              bestRate: pickBestRate(applyMarkups(cachedRaw, markups)),
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
          hugrabDefaultInsuranceEnabled: resolvedInput.hugrabDefaultInsuranceEnabled ?? null,
          residential: resolvedInput.residential === true,
          residentialClassification: resolvedInput.residentialClassification ?? null,
          residentialSource: resolvedInput.residentialSource ?? null,
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
      hugrabDefaultInsuranceEnabled: resolvedInput.hugrabDefaultInsuranceEnabled ?? null,
      residential: resolvedInput.residential === true,
      residentialClassification: resolvedInput.residentialClassification ?? null,
      residentialSource: resolvedInput.residentialSource ?? null,
    };
  }

  const liveResult = await fetchLiveRatesWithDiagnostics(resolvedInput, automationRules, opts.priority ?? 'background');
  const rawRates = liveResult.rates;
  const now = new Date();

  // RC2: a TRANSIENT carrier failure (timeout/429/5xx that exhausted its retries) makes this result
  // INCOMPLETE — caching it would freeze a transient ShipStation blip into a sticky "Rate unavailable"
  // (an all-transient-empty is served as a negative for the cache TTL; a partial would be cached for the
  // full positive TTL — both without re-calling ShipStation). So skip the authoritative write when
  // incomplete; the next request re-rates live instead of serving poison. A clean empty / terminal-failed
  // (real no-service) IS still cached briefly. RAW rates are cached so markup updates show fresh prices.
  if (rateResultIsCacheable(liveResult.carrierDiagnostics)) {
    await writeRateCache(key, resolvedInput, rawRates, liveResult.carrierDiagnostics, now, markups);
  } else {
    const failed = liveResult.carrierDiagnostics.filter((d) => d.status === 'failed' && d.transient).length;
    console.warn(`[rates] skip cache write — ${failed} carrier(s) transient-failed; next request re-rates`);
  }

  const rates = applyMarkups(rawRates, markups);
  // Ranked on the MARKED customer charge, then narrowed to the order's
  // preferred carrier/service if it has one. Null unless
  // AUTOMATION_PREFERENCE_RANKING is on, so this is a no-op by default.
  const ratePreference = resolvedInput.orderId
    ? await loadOrderRatePreference(resolvedInput.orderId)
    : null;
  return {
    rates,
    bestRate: pickBestRate(rates, ratePreference),
    cached: false,
    cacheKey: key,
    fetchedAt: now.toISOString(),
    carrierDiagnostics: liveResult.carrierDiagnostics,
    effectiveInsuranceProvider: resolvedInput.effectiveInsuranceProvider ?? resolvedInput.insuranceProvider ?? null,
    effectiveInsuredValue: resolvedInput.effectiveInsuredValue ?? resolvedInput.insuredValue ?? null,
    effectiveInsuranceSource: resolvedInput.effectiveInsuranceSource ?? null,
    hugrabDefaultInsuranceEnabled: resolvedInput.hugrabDefaultInsuranceEnabled ?? null,
    residential: resolvedInput.residential === true,
    residentialClassification: resolvedInput.residentialClassification ?? null,
    residentialSource: resolvedInput.residentialSource ?? null,
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

function directFiniteAmount(...values: unknown[]): number | null {
  for (const value of values) {
    if (value == null || value === '') continue;
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

function directCustomerShippingAmount(rate: Record<string, unknown>): number {
  return normalizeShippingRateMoney(rate).cShippingRateAmount ?? directFiniteAmount(rate.amount, rate.price, rate.cost) ?? 0;
}

function directRawShippingCost(rate: Record<string, unknown>, fallback: number): number {
  return normalizeShippingRateMoney(rate).selectedRateCost ?? directFiniteAmount(rate.cost, rate.price, fallback) ?? fallback;
}

function toDirectRate(
  rate: Record<string, unknown>,
  account: DirectCarrierAccountInfo,
  requestFingerprint: string,
  fetchedAt: string,
  rateCount: number,
): Rate | null {
  const amount = directCustomerShippingAmount(rate);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rawShippingCost = directRawShippingCost(rate, amount);
  const provider = normalizeProviderKey(account.provider);
  const shippingProviderId = directProviderIdFromAccount(account);
  const service = String(rate.serviceCode ?? rate.service ?? rate.serviceName ?? rate.serviceType ?? provider).trim();
  const serviceName = String(rate.serviceName ?? rate.service_type ?? rate.service ?? service).trim();
  const carrierCode = String(rate.carrierCode ?? rate.carrierType ?? provider).trim();
  const carrierName = String(rate.carrierName ?? account.displayIdentity ?? provider).trim();
  return {
    ...rate,
    rate_id: String(rate.rate_id ?? `${requestFingerprint}:${service}:${amount}`),
    carrier_id: `se-${shippingProviderId}`,
    carrier_code: carrierCode || provider,
    carrier_nickname: account.displayIdentity || carrierName,
    service_code: service || provider,
    service_type: serviceName || service || provider,
    rate_type: serviceName || service || provider,
    cost: rawShippingCost,
    rawShippingAmount: rawShippingCost,
    raw_shipping_amount: rawShippingCost,
    cShippingRateAmount: amount,
    selectedRateCost: rawShippingCost,
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

/**
 * PS-203 (stage 2) — the REQUIRED carrier universe for an order context.
 * A cached ShipStation-only rate row can only be COMPLETE when the order's
 * scope has no visible direct-carrier accounts (Shipp / Walmart Shipping /
 * direct UPS…) that the row never compared. Loads the account tables once and
 * returns a per-context evaluator so bulk callers pay one load per request.
 */
export async function loadDirectCarrierVisibilityEvaluator(): Promise<
  (context: {
    clientId?: number | null;
    storeId?: number | null;
    sourceProvider?: string | null;
    sourceAccountId?: string | null;
  }) => boolean
> {
  let accounts: DirectCarrierAccountInfo[] = [];
  try {
    accounts = await loadVisibleDirectCarrierAccounts({
      includeAllDirectCarriers: true,
    } as RateInput);
  } catch (err) {
    // Best-effort: an account-load failure must never break a cache read —
    // evaluate as "no visible direct carriers" (legacy completeness behavior).
    console.warn('[rates] direct-carrier visibility load skipped:', err instanceof Error ? err.message : err);
    return () => false;
  }
  return (context) =>
    accounts.some((account) =>
      directCarrierVisibleForScope(account, {
        clientId: context.clientId ?? null,
        storeId: context.storeId ?? null,
        sourceProvider: context.sourceProvider ?? null,
        sourceAccountId: context.sourceAccountId ?? null,
        includeAllDirectCarriers: false,
      }),
    );
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
      linkedStoreAccountId: null,
      displayIdentity: safeCarrierAccountIdentifier({
        ...row,
        id: row.id,
        credentials: row.credentials ?? {},
      }),
      identityBlockReason: null,
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
    linkedStoreAccountId: Number(row.id),
    displayIdentity: safeCarrierAccountIdentifier({
      id: Number(row.id),
      clientId: row.client_id ?? null,
      provider: row.provider,
      label: row.label ?? null,
      accountIdentifier: row.account_identifier ?? null,
      credentials: row.credentials ?? {},
      active: row.active,
    }),
    identityBlockReason: null,
  }));

  const identityStores = storeAccounts.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    provider: row.provider,
    label: row.label,
    accountIdentifier: row.accountIdentifier,
    credentials: row.credentials,
    active: true,
  })) satisfies StoreAccountIdentity[];
  const correlatedAccounts = [...directRows, ...storeAccounts].map((row) => {
    if (!isStoreScopedCarrierProvider(row.provider)) return row;
    const link = resolveStoreAccountLink(row, identityStores);
    if (!link.ok) return { ...row, identityBlockReason: link.reason };
    return {
      ...row,
      linkedStoreAccountId: link.store.id,
      displayIdentity: safeCarrierAccountIdentifier({ ...row, linkedStore: link.store }),
      identityBlockReason: null,
    };
  });

  const byKey = new Map(correlatedAccounts.map((row) => [`${row.sourceTable}:${row.id}`, row]));
  if (requestedRefs.length) {
    return requestedRefs
      .map((ref) => byKey.get(`${ref.sourceTable}:${ref.accountId}`))
      .filter((row): row is DirectCarrierAccountInfo => Boolean(
        row &&
        isDirectShippingAccount(row.provider, row.sourceTable) &&
        directCarrierVisibleForScope(row, {
          clientId: input.clientId,
          storeId: input.storeId,
          sourceProvider: input.sourceProvider,
          sourceAccountId: input.sourceAccountId,
          includeAllDirectCarriers: input.includeAllDirectCarriers,
        }),
      ));
  }
  return correlatedAccounts.filter((account) => {
    // Shopify Admin API rates are displayed through the separate Shopify Rates
    // flow. They are not direct-carrier quote rows and must never enter Best Rate.
    if (isShopifyShippingDisplayOnlyProvider(account.provider) || normalizeProviderKey(account.provider) === 'shopify') {
      return false;
    }
    if (!isDirectShippingAccount(account.provider, account.sourceTable)) return false;
    return directCarrierVisibleForScope(account, {
      clientId: input.clientId,
      storeId: input.storeId,
      sourceProvider: input.sourceProvider,
      sourceAccountId: input.sourceAccountId,
      includeAllDirectCarriers: input.includeAllDirectCarriers,
    });
  });
}

export async function getDirectCarrierAccountsForRateContext(
  input: Pick<RateInput, 'storeId' | 'clientId' | 'sourceProvider' | 'sourceAccountId'>,
): Promise<RateCarrierAccount[]> {
  const accounts = await loadVisibleDirectCarrierAccounts({
    ...input,
    includeVisibleDirectCarriers: true,
  } as RateInput);
  return accounts.map((account) => {
    const provider = normalizeProviderKey(account.provider);
    const shippingProviderId = directProviderIdFromAccount(account);
    return {
      carrier_id: `se-${shippingProviderId}`,
      carrier_code: provider,
      nickname: account.displayIdentity,
      friendly_name: account.displayIdentity,
      source_client_id: account.clientId,
      source_client_name: 'Direct carrier accounts',
      display_disambiguator: carrierFamilyDisplayLabel(provider),
      direct_carrier_account_id: account.id,
      direct_carrier_source_table: account.sourceTable,
      linked_store_account_id: account.linkedStoreAccountId,
    };
  });
}

// PS-271 (Layer 2): the per-carrier union dedup key — carrier_code | service_code | amount(4dp).
// Identical to the spec's "dedup by carrier|service|amount.toFixed(4)". Live-wins-per-carrier is
// achieved by inserting the live rates into the map FIRST, then only adding a cached row whose key is
// absent.
function directRateUnionKey(rate: Pick<Rate, 'carrier_code' | 'service_code' | 'shipping_amount'>): string {
  return [
    rateTextKey(rate.carrier_code),
    rateTextKey(rate.service_code),
    rateMoneyKey(rate.shipping_amount?.amount),
  ].join('|');
}

// PS-271 (Layer 2): rebuild a Rate from a fresh-cached row. The cache stores the already-lifted Rate
// (pre-markup), so this is just a typed read with the live carrier_id stamped from the current
// account (the synthetic se-<pid> id is account-derived and stable, but we re-stamp defensively).
function cachedRowToDirectRate(row: DirectCarrierCacheRow, shippingProviderId: number): Rate | null {
  const stored = row.rateJson;
  if (!stored || typeof stored !== 'object') return null;
  const rate = { ...(stored as Record<string, unknown>) } as Rate;
  const amount = Number(rate.shipping_amount?.amount ?? row.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { ...rate, carrier_id: `se-${shippingProviderId}` } as Rate;
}

function applyDirectRatePricing(
  rates: Rate[],
  directMarkups: Map<string, Markup>,
  provider: string,
  shippingOptions: ReturnType<typeof normalizeShippingOptions>,
): Rate[] {
  const markedUp = applyMarkups(rates, directMarkups);
  const easyPostPremium =
    normalizeProviderKey(provider) === 'easypost'
    && shippingOptions.insuranceProvider !== 'none'
    && Number(shippingOptions.insuredValue ?? 0) > 0
      ? easyPostScheduledPremium(Number(shippingOptions.insuredValue ?? 0))
      : null;
  return easyPostPremium != null && easyPostPremium > 0
    ? markedUp.map((rate) => ({
        ...rate,
        insurance_amount: { amount: easyPostPremium, currency: rate.insurance_amount?.currency ?? 'USD' },
      }))
    : markedUp;
}

// PS-271 (Layer 2): union live direct-carrier rates with fresh-cached rows for the SAME
// (account, source_table, request_key) lane. Live wins per carrier|service|amount key (live inserted
// first; a cached row is only added when its key is absent). When the cache is OFF or returns nothing
// fresh, returns `live` UNCHANGED — so a COLD cache / flag OFF is monotonic-additive (identical to
// today). Best-effort: never throws into the rate hot path.
async function unionDirectRatesWithCache(
  live: Rate[],
  account: DirectCarrierAccountInfo,
  shippingProviderId: number,
  requestKey: string,
): Promise<{ rates: Rate[]; usedCachedRates: boolean }> {
  if (!directCarrierRateCacheEnabled() || !requestKey) return { rates: live, usedCachedRates: false };
  let cachedRows: DirectCarrierCacheRow[] = [];
  try {
    cachedRows = await readFreshDirectCarrierRates(account.id, account.sourceTable, requestKey);
  } catch (err) {
    console.warn('[rates] direct-carrier cache union skipped:', err instanceof Error ? err.message : err);
    return { rates: live, usedCachedRates: false };
  }
  if (!cachedRows.length) return { rates: live, usedCachedRates: false };
  const byKey = new Map<string, Rate>();
  for (const rate of live) byKey.set(directRateUnionKey(rate), rate); // live wins
  let usedCachedRates = false;
  for (const row of cachedRows) {
    const rate = cachedRowToDirectRate(row, shippingProviderId);
    if (!rate) continue;
    const key = directRateUnionKey(rate);
    if (!byKey.has(key)) {
      byKey.set(key, rate);
      usedCachedRates = true;
    }
  }
  return { rates: [...byKey.values()], usedCachedRates };
}

// PS-271 (Layer 2): fire-and-forget UPSERT each LIVE direct-carrier rate into the 60s cache. NO-OP
// when the cache is OFF. Stores the lifted (pre-markup) Rate so a later union re-applies the same
// markup uniformly. request_key is REQUIRED (the per-account fingerprint). Never throws.
function writeDirectRatesToCache(
  live: Rate[],
  account: DirectCarrierAccountInfo,
  requestKey: string,
): void {
  if (!directCarrierRateCacheEnabled() || !requestKey || !live.length) return;
  const writes = live.map((rate) => ({
    accountId: account.id,
    sourceTable: account.sourceTable,
    carrierCode: String(rate.carrier_code ?? '').trim().toLowerCase(),
    serviceCode: String(rate.service_code ?? '').trim().toLowerCase(),
    requestKey,
    amount: Number(rate.shipping_amount?.amount ?? 0),
    rateJson: rate,
  })).filter((w) => w.carrierCode && w.serviceCode);
  void writeDirectCarrierRates(writes).catch((err) => {
    console.warn('[rates] direct-carrier cache write skipped:', err instanceof Error ? err.message : err);
  });
}

/**
 * PS-494 correction: what origin may this Shipp quote declare?
 *
 * Loads the order's retained customs items and delegates the ruling to the canonical owner
 * (`decideDeclaredOrigin`) with the canonical destination classification. Nothing is decided
 * here — this only fetches the two inputs the pure policy needs.
 *
 * With no order id there is nothing to resolve, which is the ad-hoc/estimate case: treat it
 * as unknown and let the policy rule on it against the destination.
 */
async function resolveShippDeclaredOrigin(input: RateInput): Promise<CustomsOriginDecision> {
  const destination = classifyDestinationCountry(input.toCountry).destination;
  let resolution: CustomsOriginResolution = { kind: 'unknown' };
  if (input.orderId != null && Number.isFinite(input.orderId)) {
    try {
      const [row] = await db
        .select({ raw: orders.raw })
        .from(orders)
        .where(eq(orders.id, Number(input.orderId)))
        .limit(1);
      if (row) resolution = resolveOrderCustomsOrigin(row);
    } catch (err) {
      // A lookup failure is NOT permission to guess: leave the resolution unknown and let
      // the policy decide, which refuses on any non-domestic destination.
      console.warn(
        '[rates] PS-494 customs-origin lookup failed; treating as unknown:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return decideDeclaredOrigin({ resolution, destination });
}

export async function getDirectCarrierRatesForRateInput(
  input: RateInput,
  options: { cachedOnly?: boolean; cacheFirst?: boolean; priority?: RateFetchPriority } = {},
): Promise<DirectCarrierRatesResult> {
  input.signal?.throwIfAborted();
  const accounts = (await loadVisibleDirectCarrierAccounts(input)).filter((account) => {
    // eBay Logistics ONLY prices a specific eBay order (its shipping_quote API takes an eBay orderId),
    // so it can NEVER quote a non-eBay order. Gate on whether this is an eBay MARKETPLACE order
    // (sync-path-agnostic) — DR Prepper's eBay orders arrive via ShipStation (sourceProvider =
    // 'shipstation'), so the old sourceProvider==='ebay' check wrongly excluded EVERY one of them
    // (no rates, no error, no API call). Off any order (e.g. the Rate Shop calculator)
    // isEbayMarketplaceOrder is falsy → eBay stays excluded, so it never clutters non-eBay orders.
    if (normalizeProviderKey(account.provider) === 'ebay_shipping' && !input.isEbayMarketplaceOrder) {
      return false;
    }
    if (input.hazmatQuoteFacts && input.hazmatCapabilities) {
      const profile = resolveHazmatProfile({
        providerFamily: 'direct',
        provider: account.provider,
        carrierCode: null,
        facts: input.hazmatQuoteFacts,
      });
      return profile != null && input.hazmatCapabilities.profiles[profile].ratingSupported;
    }
    return true;
  });
  if (!accounts.length) {
    return {
      rates: [],
      errors: [],
      metas: [],
      diagnostics: [],
      authorizationAccounts: [],
      providerFetches: 0,
      usedCachedRates: false,
    };
  }
  // PS-459: cached-only and cache-first reads use the same exact per-account request signature.
  // A warm hit returns planning/display rates without invoking a provider; a cached-only miss is
  // terminal `uncached`, while cache-first falls through to the existing live quote owner.
  const shippingOptions = normalizeShippingOptions(input);
  const executionPolicy = resolveRateBrowseProviderExecutionPolicy({
    priority: options.priority ?? 'interactive',
    defaultTimeoutMs: DIRECT_CARRIER_QUOTE_TIMEOUT_MS,
    defaultMaxRetries: 0,
  });
  // PS-203 (stage 3): direct rates pass the SAME markup rules ShipStation rates
  // already get at read time (applyMarkups keys by `se-<pid>` carrier_id —
  // direct synthetic ids included), so the combined best-rate pick compares a
  // uniform CHARGE basis. Before this, /browse compared marked-up ShipStation
  // prices against raw direct prices. Best-effort: a rules-load failure quotes
  // direct rates unmarked (the legacy behavior), never blocks quoting.
  const directMarkups = await loadCarrierMarkups().catch((err) => {
    console.warn('[rates] direct-rate markup load skipped:', err instanceof Error ? err.message : err);
    return new Map<string, Markup>();
  });
  // PS-135(a): resolve residential via the SAME canonical classifier the ShipStation path uses
  // (classifyRateInputResidential), NOT the raw FE input.residential, so direct-carrier (UPS/etc.)
  // quotes apply the SAME residential classification as ShipStation and match the label.
  const directAddressClassification = classifyRateInputResidential(input);
  const resolvedResidential = residentialForShipping(directAddressClassification);
  const directEligibilityContext = rateEligibilityContext({
    ...input,
    destinationPoBox: directAddressClassification.poBox,
  });
  const fetchedAt = new Date().toISOString();
  // Resolve the origin ONCE, mirroring the ShipStation path (fetchLiveRatesWithDiagnostics:
  // `input.shipFrom ?? getDefaultShipFrom()`). Direct carriers (incl. Walmart) must quote from
  // the SAME canonical ship-from as ShipStation — not from an absent input that silently
  // defaults inside each connector (the Walmart Carson/90248 default bug).
  // PS-474: same phone guarantee for the direct-carrier origin.
  const resolvedShipFrom = withShipFromPhone(input.shipFrom ?? (await getDefaultShipFrom()));
  const settled = await mapWithConcurrency(
    accounts,
    DIRECT_CARRIER_RATE_FETCH_CONCURRENCY,
    async (account) => {
    const shippingProviderId = directProviderIdFromAccount(account);
    const label = account.displayIdentity || normalizeProviderKey(account.provider);
    const startedAt = Date.now();
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
        authorizationAccounts: [] as ShippingQuoteAccountAuthorization[],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          accountId: String(account.id),
          carrierCode: normalizeProviderKey(account.provider),
          nickname: label,
          status: 'skipped' as CarrierRateDiagnosticStatus,
          rateCount: 0,
          durationMs: Date.now() - startedAt,
          error: scope.reason,
        },
        providerFetches: 0,
        usedCachedRates: false,
      };
    }
    const requestFingerprint = `${rateCacheKey({
      ...input,
      residential: resolvedResidential,
      carrierIds: [`se-${shippingProviderId}`],
    })}:direct:${account.sourceTable}:${account.id}`;
    const cachedRows = options.cachedOnly || options.cacheFirst
      ? await readFreshDirectCarrierRates(
          account.id,
          account.sourceTable,
          requestFingerprint,
          CACHE_TTL_MS,
        )
      : [];
    const cachedRates = cachedRows
      .map((row) => cachedRowToDirectRate(row, shippingProviderId))
      .filter((rate): rate is Rate => rate != null);
    const cacheDecision = decideDirectCarrierCacheUse({
      cachedOnly: options.cachedOnly === true,
      cacheFirst: options.cacheFirst === true,
      cachedRateCount: cachedRates.length,
    });
    if (cacheDecision === 'cache_hit') {
      const provider = normalizeProviderKey(account.provider);
      const rates = applyDirectRatePricing(cachedRates, directMarkups, provider, shippingOptions);
      const meta = {
        accountId: account.id,
        sourceTable: account.sourceTable,
        provider,
        rateCount: rates.length,
        cacheHit: true,
      };
      return {
        rates,
        errors: [] as DirectCarrierRateError[],
        metas: [{ accountId: account.id, shippingProviderId, sourceTable: account.sourceTable, provider, meta }],
        authorizationAccounts: [directCarrierQuoteAuthorizationAccount(account, shippingProviderId)],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          accountId: String(account.id),
          carrierCode: provider,
          nickname: label,
          status: 'cached' as CarrierRateDiagnosticStatus,
          rateCount: rates.length,
          durationMs: Date.now() - startedAt,
          limiterWaitMs: 0,
          attempts: 0,
        },
        providerFetches: 0,
        usedCachedRates: true,
      };
    }
    if (cacheDecision === 'uncached') {
      return {
        rates: [] as Rate[],
        errors: [] as DirectCarrierRateError[],
        metas: [] as DirectCarrierRateMeta[],
        authorizationAccounts: [] as ShippingQuoteAccountAuthorization[],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          accountId: String(account.id),
          carrierCode: normalizeProviderKey(account.provider),
          nickname: label,
          status: 'uncached' as CarrierRateDiagnosticStatus,
          rateCount: 0,
          durationMs: Date.now() - startedAt,
          limiterWaitMs: 0,
          attempts: 0,
        },
        providerFetches: 0,
        usedCachedRates: false,
      };
    }
    try {
      // PS-199: Walmart Shipping quotes need a Walmart purchaseOrderId + the raw
      // marketplace order. The canonical resolver (body → walmart- prefix →
      // store_orders cache → live Marketplace lookup, no-borrow rule for real
      // orders) lives in walmart-po-resolution; the FE never sends these.
      const walmartPo =
        normalizeProviderKey(account.provider) === 'walmart_shipping'
          ? await resolveWalmartPurchaseOrder(
              {
                purchaseOrderId: input.purchaseOrderId ?? null,
                orderId: input.orderId ?? null,
                externalOrderId: input.externalOrderId ?? null,
                orderNumber: input.orderNumber ?? null,
                credentials: account.credentials,
                storeAccountId: account.sourceTable === 'store_accounts' ? account.id : null,
              },
              'rates',
            )
          : null;
      // PS-494 correction: Shipp transmits a country of origin on EVERY quote, so browsing
      // needs the same resolved answer the label path already gets. Resolved here, in the
      // backend, and handed to the connector — the adapter never decides it (PS-316).
      //
      // A refusal is emitted directly rather than thrown, because the catch below runs every
      // error through `sanitizeRateProviderError`, which would collapse this into "Carrier
      // rate request failed" — indistinguishable from a provider outage. That is precisely
      // the defect PS-472 exists to prevent: a blocked thing must say why it is blocked.
      let shippOrigin: string | null = null;
      if (normalizeProviderKey(account.provider) === 'shipp') {
        const decision = await resolveShippDeclaredOrigin(input);
        if (decision.kind === 'refuse') {
          return {
            rates: [] as Rate[],
            errors: [{
              accountId: account.id,
              shippingProviderId,
              sourceTable: account.sourceTable,
              provider: normalizeProviderKey(account.provider),
              label,
              message: decision.reason,
              meta: null,
            }],
            metas: [] as DirectCarrierRateMeta[],
            authorizationAccounts: [] as ShippingQuoteAccountAuthorization[],
            diagnostic: {
              carrierId: `se-${shippingProviderId}`,
              accountId: String(account.id),
              carrierCode: normalizeProviderKey(account.provider),
              nickname: label,
              status: 'failed' as CarrierRateDiagnosticStatus,
              rateCount: 0,
              durationMs: Date.now() - startedAt,
              limiterWaitMs: 0,
              attempts: 0,
              error: decision.reason,
              transient: false,
              retryable: false,
            },
            // No provider call was made — refused before HTTP, which is the point.
            providerFetches: 0,
            usedCachedRates: false,
          };
        }
        shippOrigin = decision.basis === 'resolved' ? decision.country : null;
      }
      // PS-206: bounded per-carrier quoting — one slow/hung provider becomes a
      // per-account 'failed' diagnostic (caught below) instead of holding the
      // whole combined /browse response open while every other carrier waits.
      input.signal?.throwIfAborted();
      const quoted = await withAbortableCarrierQuoteTimeout((signal) => quoteCarrierRates(account.provider, {
        credentials: account.credentials,
        weightOz: input.weightOz,
        // PS-126: direct carriers (UPS/FedEx/etc.) require 5-digit ZIP — send the zip5
        // compatibility form, NOT the canonical ZIP+4 used for ShipStation quotes.
        toZip: normalizeShippingPostalCode(input.toZip, input.toCountry).zip5 ?? input.toZip,
        fromZip: normalizeShippingPostalCode(
          (resolvedShipFrom as any)?.postal_code ?? (resolvedShipFrom as any)?.postalCode,
          (resolvedShipFrom as any)?.country_code,
        ).zip5 ?? ((resolvedShipFrom as any)?.postal_code ?? (resolvedShipFrom as any)?.postalCode),
        dimsL: input.dimsL,
        dimsW: input.dimsW,
        dimsH: input.dimsH,
        orderId: input.orderId,
        clientId: input.clientId,
        storeId: input.storeId,
        externalOrderId: input.externalOrderId ?? input.orderNumber,
        orderNumber: input.orderNumber,
        purchaseOrderId: walmartPo?.purchaseOrderId ?? input.purchaseOrderId,
        // Marketplace order JSON. Walmart uses its resolved PO order (UNCHANGED); eBay (gated to
        // eBay orders above) uses the order's stored raw JSON so the connector can read the ship-to
        // + order id. Every other carrier keeps the prior behavior (no rawOrder key at all).
        ...(walmartPo?.rawOrder != null ? { rawOrder: walmartPo.rawOrder }
          : normalizeProviderKey(account.provider) === 'ebay_shipping' && input.rawOrder != null ? { rawOrder: input.rawOrder }
          : {}),
        // PS-494 correction: a RESOLVED origin only. `null` means the backend decided this
        // is the domestic-inert case, where the connector may apply its configured default;
        // mixed and unknown-international never reach here, they were refused above.
        ...(shippOrigin != null ? { countryOfManufacture: shippOrigin } : {}),
        shipFrom: resolvedShipFrom,
        // PS-127/PS-135(a): direct carriers rate under the SAME backend-resolved residential
        // classification as ShipStation (classifyRateInputResidential above), NOT the raw FE
        // input.residential, so direct-vs-ShipStation quotes are comparable and the UPS label matches.
        residential: resolvedResidential,
        // PS-271 (Layer 1): the Shipp connector's observed-set retry keys its durable observed-set
        // read + negative-memory cooldown on the account + this per-account request fingerprint. Inert
        // for every other provider (only the Shipp connector reads these).
        directCarrierAccountId: account.id,
        directCarrierSourceTable: account.sourceTable,
        requestKey: requestFingerprint,
        shippingOptions,
        ...(input.hazmatQuoteFacts ? { hazmatQuoteFacts: input.hazmatQuoteFacts } : {}),
        signal,
      }), label, executionPolicy.timeoutMs, input.signal);
      const rawRates = Array.isArray(quoted.rates) ? quoted.rates as Array<Record<string, unknown>> : [];
      const eligible = filterRatesForAutomationPlan(filterRatesForShippingServiceEligibility(
        rawRates,
        directEligibilityContext,
        shippingOptions,
      ), input).filter((rate) => evaluateShippingServiceEligibility(
        directEligibilityContext,
        directRateServiceDescriptor(rate as Record<string, unknown>, account.provider),
        shippingOptions,
      ).allowed);
      // Lift live connector rates into the canonical Rate shape (pre-markup) so the markup applies
      // uniformly to BOTH live and the PS-271 union-cached rows below.
      const liftedLive = eligible
        .map((rate) => toDirectRate(rate as Record<string, unknown>, account, requestFingerprint, fetchedAt, eligible.length))
        .filter((rate): rate is Rate => rate != null);

      // PS-271 (Layer 2): union the live rates with fresh-cached rows (live-wins-per-carrier; dedup by
      // carrier|service|amount(4dp)). When the cache is OFF or COLD this returns liftedLive UNCHANGED
      // (byte-for-byte identical to today). Best-effort: a read failure degrades to live-only and is
      // logged inside the cache module, never thrown into this hot path.
      const liftedUnion = await unionDirectRatesWithCache(
        liftedLive,
        account,
        shippingProviderId,
        requestFingerprint,
      );

      // Fire-and-forget UPSERT of the LIVE rates only (never the cached ones) so the cache always
      // reflects what this account actually returned this pass. NO-OP when the cache is OFF.
      void writeDirectRatesToCache(liftedLive, account, requestFingerprint);

      // PS-261: EasyPost charges its OWN insurance fee and its rates never pass through the
      // ShipStation enrichRatesWithInsuranceCost path (the direct universe is merged AFTER
      // enrichment via combineCarrierUniverses), so an insured EasyPost rate would carry
      // insurance_amount=0 and be compared on bare postage — winning the combined cheapest
      // pick UNFAIRLY against ParcelGuard-priced ShipStation rates. Attach the best-effort
      // EasyPost insurance estimate so the candidate is ranked/displayed fairly. This is
      // rate-time only: accurate post-purchase billing requires the EasyPost connector to
      // report its real fee (a source-of-truth follow-up; createLabelEasyPost discards it).
      const rates = applyDirectRatePricing(
        liftedUnion.rates,
        directMarkups,
        account.provider,
        shippingOptions,
      );
      // PS-271 (Layer 4): the Shipp connector rides a thin-source marker out via quoted.diagnostics
      // when Layer 1 accepted a known-thin partial (a non-empty 200 still missing an observed-expected
      // carrier). Carry it onto the meta AND the diagnostic so the combined-universe owner can mark the
      // pass / a best sourced from it as thin/unproven. Undefined for every other provider and for the
      // OFF Shipp path — meta/diagnostic stay byte-identical to today.
      const observedIncomplete =
        quoted.diagnostics && typeof quoted.diagnostics === 'object'
          ? (quoted.diagnostics as Record<string, unknown>).observedIncomplete
          : undefined;
      const thin =
        observedIncomplete && typeof observedIncomplete === 'object'
          ? { observedIncomplete: true as const, missing: Array.isArray((observedIncomplete as any).missing) ? (observedIncomplete as any).missing.map(String) : [] }
          : null;
      const meta = {
        accountId: account.id,
        sourceTable: account.sourceTable,
        provider: normalizeProviderKey(quoted.provider ?? account.provider),
        rateCount: rates.length,
        // PS-199: surfaced in the Rate Browser ("Resolved on-the-fly via Walmart
        // Marketplace API" / cache badge) — the FE modal already renders it.
        ...(walmartPo ? { purchaseOrderSource: walmartPo.purchaseOrderSource } : {}),
        // PS-271 (Layer 4): display-only thin-source signal (additive; absent today).
        ...(thin ? { thin } : {}),
      };
      return {
        rates,
        errors: [] as DirectCarrierRateError[],
        metas: [{ accountId: account.id, shippingProviderId, sourceTable: account.sourceTable, provider: meta.provider, meta }],
        authorizationAccounts: [directCarrierQuoteAuthorizationAccount(account, shippingProviderId)],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          accountId: String(account.id),
          carrierCode: meta.provider,
          nickname: label,
          status: rates.length ? 'ok' as CarrierRateDiagnosticStatus : 'empty' as CarrierRateDiagnosticStatus,
          rateCount: rates.length,
          durationMs: Date.now() - startedAt,
          limiterWaitMs: 0,
          attempts: 1,
          // PS-271 (Layer 4): the thin signal flows to combineCarrierUniverses via this diagnostic.
          ...(thin ? { thin: true } : {}),
          // PS-271 (Layer 4): surface the NAMED observed-missing carriers (the connector's
          // observedMissing[]) as the out-of-band diagnostic. Omitted on every non-thin pass.
          ...((() => {
            const absent = expectedCarrierAbsentFromThin(thin);
            return absent ? { expectedCarrierAbsent: absent } : {};
          })()),
        },
        providerFetches: 1,
        usedCachedRates: liftedUnion.usedCachedRates,
      };
    } catch (err) {
      const message = publicCarrierRateError(err);
      const retryable = isTransientCarrierRateError(err);
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
        authorizationAccounts: [] as ShippingQuoteAccountAuthorization[],
        diagnostic: {
          carrierId: `se-${shippingProviderId}`,
          accountId: String(account.id),
          carrierCode: normalizeProviderKey(account.provider),
          nickname: label,
          status: 'failed' as CarrierRateDiagnosticStatus,
          rateCount: 0,
          durationMs: Date.now() - startedAt,
          limiterWaitMs: 0,
          attempts: 1,
          error: message,
          transient: retryable,
          retryable,
        },
        providerFetches: 1,
        usedCachedRates: false,
      };
    }
  });
  return {
    rates: settled.flatMap((item) => item.rates),
    errors: settled.flatMap((item) => item.errors),
    metas: settled.flatMap((item) => item.metas),
    diagnostics: settled.map((item) => item.diagnostic),
    authorizationAccounts: settled.flatMap((item) => item.authorizationAccounts),
    providerFetches: settled.reduce((sum, item) => sum + item.providerFetches, 0),
    usedCachedRates: settled.some((item) => item.usedCachedRates),
  };
}
