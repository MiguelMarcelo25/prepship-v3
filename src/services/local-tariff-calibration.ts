import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { analyticsCache } from '../db/schema/analytics-cache.js';
import { env } from '../lib/env.js';
import { getDefaultShipFrom } from '../lib/ship-from.js';
import { normalizeShippingPostalCode } from './shipping-workflow/postal-code.js';
import {
  applyMarkups,
  fetchLiveRatesWithDiagnostics,
  loadCarrierMarkups,
  rateCacheKey,
  resolveRateInput,
} from './rates.js';
import { rateTotal } from './rates-combined.js';
import {
  buildLocalTariffModel,
  estimateLocalTariffs,
  isLocalTariffModel,
  type LocalTariffCalibrationPoint,
  type LocalTariffCalibrationRate,
  type LocalTariffModel,
} from './local-tariff-engine.js';

export const LOCAL_TARIFF_MODEL_CACHE_KEY = 'audit-5.2.local-tariff-model.v1';
const LOCAL_TARIFF_MODEL_TTL_MS = 8 * 24 * 60 * 60 * 1_000;
const PROBE_DIMENSIONS = { length: 12, width: 10, height: 6 } as const;

export type LocalTariffCalibrationSummary = {
  enabled: boolean;
  published: boolean;
  generatedAt: string | null;
  probeCount: number;
  rateCount: number;
  comparedRateCount: number;
  maxDriftPercent: number | null;
};

type ProbeRequest = {
  fromZip: string;
  toZip: string;
  residential: true;
  dimensions: typeof PROBE_DIMENSIONS;
  weightOz: number;
};

function parsePostalCodes(value: string): string[] {
  const normalized = value
    .split(',')
    .map((item) => normalizeShippingPostalCode(item.trim(), 'US').zip5)
    .filter((item): item is string => Boolean(item));
  const unique = [...new Set(normalized)];
  if (unique.length === 0) throw new Error('local tariff calibration requires destination ZIPs');
  return unique;
}

function parseWeights(value: string): number[] {
  const weights = [...new Set(value.split(',').map((item) => Number(item.trim())))];
  if (weights.length === 0 || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('local tariff calibration weights must be positive numbers');
  }
  return weights.sort((left, right) => left - right);
}

export function buildLocalTariffProbeMatrix(fromZip: string): ProbeRequest[] {
  const destinations = parsePostalCodes(env.LOCAL_TARIFF_CALIBRATION_DESTINATIONS);
  const weights = parseWeights(env.LOCAL_TARIFF_CALIBRATION_WEIGHTS_OZ);
  const probes = destinations.flatMap((toZip) => weights.map((weightOz) => ({
    fromZip,
    toZip,
    residential: true as const,
    dimensions: PROBE_DIMENSIONS,
    weightOz,
  })));
  if (probes.length > env.LOCAL_TARIFF_CALIBRATION_MAX_PROBES) {
    throw new Error(
      `local tariff calibration matrix has ${probes.length} probes; max is ${env.LOCAL_TARIFF_CALIBRATION_MAX_PROBES}`,
    );
  }
  return probes;
}

function normalizeCalibrationRates(rates: Awaited<ReturnType<typeof fetchLiveRatesWithDiagnostics>>['rates']): LocalTariffCalibrationRate[] {
  const normalized = rates
    .map((rate): LocalTariffCalibrationRate | null => {
      const customerAmount = rateTotal(rate as unknown as Record<string, unknown>);
      if (!Number.isFinite(customerAmount) || customerAmount <= 0) return null;
      return {
        carrierId: String(rate.carrier_id ?? '').trim(),
        carrierCode: String(rate.carrier_code ?? '').trim(),
        rateType: String(rate.rate_type ?? '').trim(),
        serviceCode: String(rate.service_code ?? '').trim(),
        serviceType: String(rate.service_type ?? '').trim(),
        packageType: rate.package_type ? String(rate.package_type) : null,
        currency: String(rate.shipping_amount?.currency ?? 'usd').toLowerCase(),
        customerAmount,
      };
    })
    .filter((rate): rate is LocalTariffCalibrationRate => Boolean(
      rate?.carrierId && rate.serviceCode && rate.customerAmount > 0,
    ));

  const byIdentity = new Map<string, LocalTariffCalibrationRate>();
  for (const rate of normalized) {
    const identity = [rate.carrierId, rate.rateType, rate.serviceCode, rate.packageType ?? '', rate.currency].join('|');
    const existing = byIdentity.get(identity);
    if (!existing || rate.customerAmount < existing.customerAmount) byIdentity.set(identity, rate);
  }
  return [...byIdentity.values()];
}

async function loadLocalTariffModel(): Promise<LocalTariffModel | null> {
  const [row] = await db
    .select({ payload: analyticsCache.payload })
    .from(analyticsCache)
    .where(and(
      eq(analyticsCache.cacheKey, LOCAL_TARIFF_MODEL_CACHE_KEY),
      gt(analyticsCache.expiresAt, new Date()),
    ))
    .limit(1);
  return isLocalTariffModel(row?.payload) ? row.payload : null;
}

async function publishLocalTariffModel(model: LocalTariffModel): Promise<void> {
  const now = new Date(model.generatedAt);
  await db
    .insert(analyticsCache)
    .values({
      cacheKey: LOCAL_TARIFF_MODEL_CACHE_KEY,
      payload: model,
      expiresAt: new Date(now.getTime() + LOCAL_TARIFF_MODEL_TTL_MS),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: analyticsCache.cacheKey,
      set: {
        payload: model,
        expiresAt: new Date(now.getTime() + LOCAL_TARIFF_MODEL_TTL_MS),
        updatedAt: now,
      },
    });
}

function calibrationDrift(previous: LocalTariffModel | null, points: LocalTariffCalibrationPoint[]): {
  comparedRateCount: number;
  maxDriftPercent: number | null;
} {
  if (!previous) return { comparedRateCount: 0, maxDriftPercent: null };
  let comparedRateCount = 0;
  let maxDriftPercent = 0;
  for (const point of points) {
    const estimates = estimateLocalTariffs(previous, point);
    const byIdentity = new Map(estimates.map((estimate) => [[
      estimate.carrierId,
      estimate.rateType,
      estimate.serviceCode,
      estimate.packageType ?? '',
      estimate.currency,
    ].join('|'), estimate]));
    for (const rate of point.rates) {
      const estimate = byIdentity.get([
        rate.carrierId,
        rate.rateType,
        rate.serviceCode,
        rate.packageType ?? '',
        rate.currency,
      ].join('|'));
      if (!estimate || estimate.estimatedCustomerAmount <= 0) continue;
      comparedRateCount += 1;
      const drift = Math.abs(rate.customerAmount - estimate.estimatedCustomerAmount)
        / estimate.estimatedCustomerAmount * 100;
      maxDriftPercent = Math.max(maxDriftPercent, drift);
    }
  }
  return {
    comparedRateCount,
    maxDriftPercent: comparedRateCount > 0
      ? Math.round((maxDriftPercent + Number.EPSILON) * 100) / 100
      : null,
  };
}

/**
 * Worker-only nightly calibration. Provider calls are sequential, background
 * priority, and read-only. A partial/empty matrix is never published.
 */
export async function runLocalTariffCalibrationTick(
  signal?: AbortSignal,
): Promise<LocalTariffCalibrationSummary> {
  if (!env.ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER) {
    return {
      enabled: false,
      published: false,
      generatedAt: null,
      probeCount: 0,
      rateCount: 0,
      comparedRateCount: 0,
      maxDriftPercent: null,
    };
  }

  const shipFrom = await getDefaultShipFrom();
  const fromZip = normalizeShippingPostalCode(shipFrom.postal_code, shipFrom.country_code).zip5;
  if (!fromZip) throw new Error('local tariff calibration requires a valid ship-from ZIP');

  const probes = buildLocalTariffProbeMatrix(fromZip);
  const markups = await loadCarrierMarkups();
  const generatedAt = new Date().toISOString();
  const points: LocalTariffCalibrationPoint[] = [];

  for (const probe of probes) {
    signal?.throwIfAborted();
    const resolvedInput = await resolveRateInput({
      weightOz: probe.weightOz,
      toZip: probe.toZip,
      toCountry: 'US',
      residential: probe.residential,
      dimsL: probe.dimensions.length,
      dimsW: probe.dimensions.width,
      dimsH: probe.dimensions.height,
      shipFrom,
    });
    const live = await fetchLiveRatesWithDiagnostics(resolvedInput, [], 'background');
    signal?.throwIfAborted();
    const rates = normalizeCalibrationRates(applyMarkups(live.rates, markups));
    if (rates.length === 0) {
      throw new Error(`local tariff calibration returned no priced rates for ${probe.toZip} at ${probe.weightOz} oz`);
    }
    points.push({
      requestKey: rateCacheKey(resolvedInput),
      fromZip: probe.fromZip,
      toZip: probe.toZip,
      residential: probe.residential,
      dimensions: probe.dimensions,
      weightOz: probe.weightOz,
      capturedAt: generatedAt,
      rates,
    });
  }

  const previous = await loadLocalTariffModel();
  const drift = calibrationDrift(previous, points);
  const model = buildLocalTariffModel(points, generatedAt);
  await publishLocalTariffModel(model);

  const rateCount = points.reduce((sum, point) => sum + point.rates.length, 0);
  console.log('[local-tariff-calibration] published advisory model', {
    generatedAt,
    probeCount: points.length,
    rateCount,
    ...drift,
  });
  return {
    enabled: true,
    published: true,
    generatedAt,
    probeCount: points.length,
    rateCount,
    ...drift,
  };
}
