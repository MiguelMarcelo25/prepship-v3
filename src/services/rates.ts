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
  const ids = res.carriers
    .filter((c) => !c.disabled_by_billing_plan)
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

export async function fetchLiveRates(input: RateInput): Promise<Rate[]> {
  const shipFrom = input.shipFrom ?? (await getDefaultShipFrom());
  const carrierIds = input.carrierIds?.length
    ? input.carrierIds
    : await getAllCarrierIds();

  const res = await ssRequest<RatesResponse>('/v2/rates', {
    method: 'POST',
    dedupeKey: `rates:${rateCacheKey(input)}`,
    body: {
      rate_options: { carrier_ids: carrierIds },
      shipment: {
        validate_address: 'no_validation',
        ship_to: buildShipTo(input),
        ship_from: shipFrom,
        packages: buildPackages(input),
      },
    },
  });

  const rates = res.rate_response.rates ?? [];
  if (!rates.length) {
    const errs = res.rate_response.errors ?? [];
    if (errs.length) {
      const msg = errs
        .map((e) => `${e.error_source}/${e.error_type}: ${e.message}`)
        .join('; ');
      throw new Error(`ShipStation rate errors: ${msg}`);
    }
    const invalid = res.rate_response.invalid_rates ?? [];
    if (invalid.length) {
      // Carriers returned rates but ShipStation rejected them all (often
      // warnings like service unavailable for destination).
      throw new Error(
        `All ${invalid.length} carrier rates rejected as invalid — likely unsupported destination, weight, or dimensions`
      );
    }
    throw new Error(
      `No rates returned (status=${res.rate_response.status}) — carriers may not serve this route`
    );
  }
  return rates;
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
