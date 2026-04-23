import { eq, like } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import { settings } from '../db/schema/settings';
import {
  ssRequest,
  type RatesResponse,
  type Rate,
  type Address,
  type Parcel,
} from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { getDefaultShipFrom } from '../lib/ship-from';

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
      if (
        (p.type === 'amount' || p.type === 'percent') &&
        typeof p.value === 'number' &&
        p.value !== 0
      ) {
        m.set(id, p as Markup);
      }
    } catch {
      // ignore unparseable values
    }
  }
  return m;
}

// ── v2-parity rate filters ────────────────────────────────────────────────
// Ported from v2's apps/api/src/common/prepship-config.ts. v4 previously had
// NO rate filtering — all blocked service codes / flat-rate package types
// leaked into best-rate selection, which could silently undercharge vs v2
// (e.g. UPS SurePost lightweight <1lb rates selectable where v2 blocks them).

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
  'ups_surepost_1_lb_or_greater',
  'ups_surepost_less_than_1_lb',
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
    const m = markups.get(r.carrier_id);
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

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const CARRIER_CACHE_MS = 1000 * 60 * 15; // 15 min

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
  const res = await ssRequest<CarriersResponse>('/v2/carriers', {
    dedupeKey: 'carriers:list',
  });
  // Only include carriers that can rate arbitrary orders. Skip:
  //  - amazon_*: requires amazon_order_item_id per line — fails for non-Amazon orders
  //  - voucher-*: client-shared carriers that don't respond to the rate API
  //  - tusk and similar resellers that sometimes fail on generic payloads
  //  - fedex_walleted: One Balance wallet; duplicate of fedex for rating
  const ALLOWED_CODES = new Set(['usps', 'ups', 'fedex', 'dhl_express', 'stamps_com']);
  const ids = res.carriers
    .filter((c) => !c.disabled_by_billing_plan)
    .filter((c) => ALLOWED_CODES.has((c.carrier_code ?? '').toLowerCase()))
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
};

export function rateCacheKey(input: RateInput): string {
  const parts: string[] = [
    `w=${Math.round(input.weightOz * 10)}`,
    `z=${(input.toZip ?? '').replace(/\s+/g, '').toUpperCase()}`,
    `co=${(input.toCountry ?? 'US').toUpperCase()}`,
  ];
  if (input.residential === true) parts.push('r=1');
  else if (input.residential === false) parts.push('r=0');
  if (input.dimsL) parts.push(`l=${Math.round(input.dimsL * 10)}`);
  if (input.dimsW) parts.push(`dw=${Math.round(input.dimsW * 10)}`);
  if (input.dimsH) parts.push(`h=${Math.round(input.dimsH * 10)}`);
  if (input.carrierIds?.length) {
    parts.push(`c=${[...input.carrierIds].sort().join(',')}`);
  }
  return parts.join('|');
}

function pickBestRate(rates: Rate[]): Rate | null {
  if (!rates.length) return null;
  return [...rates].sort(
    (a, b) => a.shipping_amount.amount - b.shipping_amount.amount
  )[0]!;
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

// Cheap mini-carrier lookup so we can tell stamps_com apart (needs city/state
// in the rate-estimate body). v2 calls discoverCarriers() per request; v4
// reuses its 15-min-cached getAllCarrierIds() + a parallel nickname cache.
type CarrierInfo = { carrier_id: string; carrier_code: string; nickname?: string };
let cachedCarriers: CarrierInfo[] | null = null;
let cachedCarriersAt = 0;

async function getAllCarriers(): Promise<CarrierInfo[]> {
  if (cachedCarriers && Date.now() - cachedCarriersAt < CARRIER_CACHE_MS) {
    return cachedCarriers;
  }
  const res = await ssRequest<CarriersResponse>('/v2/carriers', {
    dedupeKey: 'carriers:list',
  });
  const ALLOWED_CODES = new Set(['usps', 'ups', 'fedex', 'dhl_express', 'stamps_com']);
  cachedCarriers = res.carriers
    .filter((c) => !c.disabled_by_billing_plan)
    .filter((c) => ALLOWED_CODES.has((c.carrier_code ?? '').toLowerCase()))
    .map((c) => ({
      carrier_id: c.carrier_id,
      carrier_code: c.carrier_code,
      nickname: c.nickname ?? c.friendly_name ?? undefined,
    }));
  cachedCarriersAt = Date.now();
  return cachedCarriers;
}

function shipFromPostalCode(addr: Address): string {
  return addr.postal_code ?? '90248';
}

function shipDateIso(): string {
  return new Date().toISOString();
}

// v2-parity: one /v2/rates/estimate call per carrier with v2's flat body.
// Returns v2-shaped EstimateRate[] flattened across all carriers.
async function fetchEstimateForCarrier(
  carrier: CarrierInfo,
  input: RateInput,
  shipFrom: Address,
): Promise<EstimateRate[]> {
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
  try {
    const payload = await ssRequest<EstimateRate[] | { rates?: EstimateRate[] }>(
      '/v2/rates/estimate',
      {
        method: 'POST',
        body,
        dedupeKey: `rates-estimate:${carrier.carrier_id}:${rateCacheKey(input)}`,
      },
    );
    const rates = Array.isArray(payload) ? payload : (payload.rates ?? []);
    // Ensure carrier metadata is on every row (ShipStation sometimes omits)
    for (const r of rates) {
      if (!r.carrier_id) r.carrier_id = carrier.carrier_id;
      if (!r.carrier_code) r.carrier_code = carrier.carrier_code;
      if (!r.carrier_nickname && carrier.nickname) r.carrier_nickname = carrier.nickname;
    }
    return rates;
  } catch (err) {
    console.warn(
      `[rates-estimate] carrier ${carrier.carrier_code} (${carrier.carrier_id}) failed:`,
      err instanceof Error ? err.message : err,
    );
    return [];
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

export async function fetchLiveRates(input: RateInput): Promise<Rate[]> {
  const shipFrom = input.shipFrom ?? (await getDefaultShipFrom());

  // v2-parity: /v2/rates/estimate takes ONE carrier_id per call. Issue N
  // parallel calls (one per allowed carrier) and flatten. Mirrors
  // apps/api/src/modules/rates/data/shipstation-rate-shopper.ts:fetchRates().
  //
  // If the caller restricted carriers via input.carrierIds, filter the
  // discovery list to that set. Otherwise use the full cached list.
  const allCarriers = await getAllCarriers();
  const carriers = input.carrierIds?.length
    ? allCarriers.filter((c) => input.carrierIds!.includes(c.carrier_id))
    : allCarriers;

  if (!carriers.length) {
    throw new Error(
      'No ShipStation carriers available — connect a carrier account in ShipStation first.',
    );
  }

  const batches = await Promise.all(
    carriers.map((c) => fetchEstimateForCarrier(c, input, shipFrom)),
  );
  const lifted: Rate[] = batches.flat().map(toRate);

  // v2-parity: filter blocked service codes + package types + names.
  // Sort cheapest first (v2 sorts by shipmentCost + otherCost; v4 sort
  // uses shipping_amount only since markups apply at read-time later).
  const filtered = lifted.filter((r) => !isBlockedRate(r));
  filtered.sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount);

  if (filtered.length) return filtered;

  // v2's /rates/estimate returns empty array when no rates exist for the
  // route — treat that as a normal "no service" condition, not an error.
  // (v4's previous /v2/rates endpoint surfaced this via rate_response.errors;
  // the estimate endpoint just omits them.)
  throw new Error(
    `No rates returned for ${input.toZip} at ${input.weightOz}oz — carriers may not serve this route`,
  );
}

export type GetRatesResult = {
  rates: Rate[];
  bestRate: Rate | null;
  cached: boolean;
  cacheKey: string;
  fetchedAt: string;
};

export async function getRates(
  input: RateInput,
  opts: { forceRefresh?: boolean } = {}
): Promise<GetRatesResult> {
  const key = rateCacheKey(input);

  // Markups apply at read time so config changes reflect instantly without
  // having to bust the rate cache.
  const markups = await loadCarrierMarkups();

  if (!opts.forceRefresh) {
    const [cached] = await db
      .select()
      .from(rateCache)
      .where(eq(rateCache.cacheKey, key))
      .limit(1);
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
      const cachedRaw = cached.rates as Rate[];
      const cachedRates = applyMarkups(cachedRaw, markups);
      return {
        rates: cachedRates,
        bestRate: pickBestRate(cachedRates),
        cached: true,
        cacheKey: key,
        fetchedAt: cached.fetchedAt.toISOString(),
      };
    }
  }

  const rawRates = await fetchLiveRates(input);
  const now = new Date();

  // Cache the RAW rates so markup updates always show fresh prices.
  await db
    .insert(rateCache)
    .values({
      cacheKey: key,
      weightOz: input.weightOz,
      toZip: input.toZip,
      rates: rawRates as unknown[],
      bestRate: pickBestRate(rawRates),
      weightVersion: 1,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: rateCache.cacheKey,
      set: {
        rates: rawRates as unknown[],
        bestRate: pickBestRate(rawRates),
        fetchedAt: now,
      },
    });

  const rates = applyMarkups(rawRates, markups);
  return {
    rates,
    bestRate: pickBestRate(rates),
    cached: false,
    cacheKey: key,
    fetchedAt: now.toISOString(),
  };
}
