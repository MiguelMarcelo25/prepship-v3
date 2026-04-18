import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { rateCache } from '../db/schema/rates';
import {
  ssRequest,
  type RatesResponse,
  type Rate,
  type Address,
  type Parcel,
} from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { getDefaultShipFrom } from '../lib/ship-from';

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

  return res.rate_response.rates ?? [];
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

  if (!opts.forceRefresh) {
    const [cached] = await db
      .select()
      .from(rateCache)
      .where(eq(rateCache.cacheKey, key))
      .limit(1);
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
      return {
        rates: cached.rates as Rate[],
        bestRate: (cached.bestRate as Rate | null) ?? null,
        cached: true,
        cacheKey: key,
        fetchedAt: cached.fetchedAt.toISOString(),
      };
    }
  }

  const rates = await fetchLiveRates(input);
  const bestRate = pickBestRate(rates);
  const now = new Date();

  await db
    .insert(rateCache)
    .values({
      cacheKey: key,
      weightOz: input.weightOz,
      toZip: input.toZip,
      rates: rates as unknown[],
      bestRate,
      weightVersion: 1,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: rateCache.cacheKey,
      set: {
        rates: rates as unknown[],
        bestRate,
        fetchedAt: now,
      },
    });

  return {
    rates,
    bestRate,
    cached: false,
    cacheKey: key,
    fetchedAt: now.toISOString(),
  };
}
