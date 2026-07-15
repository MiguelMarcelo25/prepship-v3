/**
 * Audit 5.2: local, empirical tariff estimates built from live calibration.
 *
 * This module is deliberately pure and advisory. It does not return a Rate,
 * choose a cheapest service, mint selected-rate proof, or participate in label
 * purchase. Official Best Rate remains owned by combineCarrierUniverses.
 */

export const LOCAL_TARIFF_MODEL_VERSION = 'local-tariff-v1' as const;

export type LocalTariffDimensions = {
  length: number;
  width: number;
  height: number;
};

export type LocalTariffCalibrationRate = {
  carrierId: string;
  carrierCode: string;
  rateType: string;
  serviceCode: string;
  serviceType: string;
  packageType: string | null;
  currency: string;
  customerAmount: number;
};

export type LocalTariffCalibrationPoint = {
  requestKey: string;
  fromZip: string;
  toZip: string;
  residential: boolean;
  dimensions: LocalTariffDimensions;
  weightOz: number;
  capturedAt: string;
  rates: LocalTariffCalibrationRate[];
};

export type LocalTariffModel = {
  version: typeof LOCAL_TARIFF_MODEL_VERSION;
  authority: 'advisory_only';
  source: 'nightly_live_normalized_quotes';
  generatedAt: string;
  points: LocalTariffCalibrationPoint[];
};

export type LocalTariffEstimateInput = {
  fromZip: string;
  toZip: string;
  residential: boolean;
  dimensions: LocalTariffDimensions;
  weightOz: number;
};

export type LocalTariffEstimate = {
  authority: 'advisory_only';
  purchasable: false;
  selectedRateProof: null;
  source: 'nightly_live_calibration';
  modelVersion: typeof LOCAL_TARIFF_MODEL_VERSION;
  modelGeneratedAt: string;
  carrierId: string;
  carrierCode: string;
  rateType: string;
  serviceCode: string;
  serviceType: string;
  packageType: string | null;
  currency: string;
  estimatedCustomerAmount: number;
  interpolation: 'exact' | 'linear';
  lowerWeightOz: number;
  upperWeightOz: number;
};

type RateSeriesRow = {
  weightOz: number;
  rate: LocalTariffCalibrationRate;
};

function normalizedZip(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '').slice(0, 5);
  return digits || String(value ?? '').trim().toUpperCase();
}

function sameDimensions(left: LocalTariffDimensions, right: LocalTariffDimensions): boolean {
  return left.length === right.length && left.width === right.width && left.height === right.height;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function rateIdentity(rate: LocalTariffCalibrationRate): string {
  return [
    rate.carrierId,
    rate.carrierCode,
    rate.rateType,
    rate.serviceCode,
    rate.serviceType,
    rate.packageType ?? '',
    rate.currency.toLowerCase(),
  ].join('|');
}

function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function buildLocalTariffModel(
  points: LocalTariffCalibrationPoint[],
  generatedAt: string,
): LocalTariffModel {
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error('local tariff model generatedAt must be an ISO timestamp');
  }
  if (points.length === 0) {
    throw new Error('local tariff model requires at least one calibration point');
  }
  for (const point of points) {
    if (!finitePositive(point.weightOz) || point.rates.length === 0) {
      throw new Error('every local tariff calibration point requires weight and priced rates');
    }
  }
  return {
    version: LOCAL_TARIFF_MODEL_VERSION,
    authority: 'advisory_only',
    source: 'nightly_live_normalized_quotes',
    generatedAt,
    points,
  };
}

export function isLocalTariffModel(value: unknown): value is LocalTariffModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<LocalTariffModel>;
  return row.version === LOCAL_TARIFF_MODEL_VERSION
    && row.authority === 'advisory_only'
    && row.source === 'nightly_live_normalized_quotes'
    && typeof row.generatedAt === 'string'
    && Number.isFinite(Date.parse(row.generatedAt))
    && Array.isArray(row.points)
    && row.points.length > 0;
}

/**
 * Estimate only inside an exactly calibrated route/package/residential lane.
 * Weight may be exact or interpolated between two observed weights. The engine
 * never extrapolates and never converts the result into an official Rate.
 */
export function estimateLocalTariffs(
  model: LocalTariffModel,
  input: LocalTariffEstimateInput,
): LocalTariffEstimate[] {
  if (!finitePositive(input.weightOz)) return [];

  const matchingPoints = model.points.filter((point) =>
    normalizedZip(point.fromZip) === normalizedZip(input.fromZip)
    && normalizedZip(point.toZip) === normalizedZip(input.toZip)
    && point.residential === input.residential
    && sameDimensions(point.dimensions, input.dimensions)
    && finitePositive(point.weightOz)
  );

  const series = new Map<string, RateSeriesRow[]>();
  for (const point of matchingPoints) {
    for (const rate of point.rates) {
      if (!finitePositive(rate.customerAmount)) continue;
      const identity = rateIdentity(rate);
      const rows = series.get(identity) ?? [];
      rows.push({ weightOz: point.weightOz, rate });
      series.set(identity, rows);
    }
  }

  const estimates: LocalTariffEstimate[] = [];
  for (const rows of series.values()) {
    rows.sort((left, right) => left.weightOz - right.weightOz);
    const exact = rows.find((row) => row.weightOz === input.weightOz);
    const lower = exact ?? [...rows].reverse().find((row) => row.weightOz < input.weightOz);
    const upper = exact ?? rows.find((row) => row.weightOz > input.weightOz);
    if (!lower || !upper) continue;

    const interpolation = lower.weightOz === upper.weightOz ? 'exact' : 'linear';
    const fraction = interpolation === 'exact'
      ? 0
      : (input.weightOz - lower.weightOz) / (upper.weightOz - lower.weightOz);
    const amount = lower.rate.customerAmount
      + ((upper.rate.customerAmount - lower.rate.customerAmount) * fraction);
    estimates.push({
      authority: 'advisory_only',
      purchasable: false,
      selectedRateProof: null,
      source: 'nightly_live_calibration',
      modelVersion: LOCAL_TARIFF_MODEL_VERSION,
      modelGeneratedAt: model.generatedAt,
      carrierId: lower.rate.carrierId,
      carrierCode: lower.rate.carrierCode,
      rateType: lower.rate.rateType,
      serviceCode: lower.rate.serviceCode,
      serviceType: lower.rate.serviceType,
      packageType: lower.rate.packageType,
      currency: lower.rate.currency,
      estimatedCustomerAmount: roundAmount(amount),
      interpolation,
      lowerWeightOz: lower.weightOz,
      upperWeightOz: upper.weightOz,
    });
  }

  // Stable identity order only. Money ordering would look like a second Best
  // Rate selector, which this advisory engine is explicitly forbidden to be.
  return estimates.sort((left, right) =>
    [left.carrierId, left.serviceCode, left.packageType ?? ''].join('|')
      .localeCompare([right.carrierId, right.serviceCode, right.packageType ?? ''].join('|'))
  );
}
