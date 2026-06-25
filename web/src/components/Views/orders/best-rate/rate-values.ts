// PS-317: small pure rate-value extractors, moved verbatim out of OrdersView.
// getAppliedRateDims / getAppliedRateWeightOz read dims/weight off a backend rate object
// (used by the apply-rate persist fallback); sanitizeRecalculateError formats a recalc error.
import { toRecord, toNumberValue } from '../../orders-row-display';

export function getAppliedRateDims(rate: Record<string, unknown>) {
  const dims = toRecord(rate.dims);
  const length = toNumberValue(dims?.length) ?? toNumberValue(rate.length) ?? toNumberValue(rate.dimsL);
  const width = toNumberValue(dims?.width) ?? toNumberValue(rate.width) ?? toNumberValue(rate.dimsW);
  const height = toNumberValue(dims?.height) ?? toNumberValue(rate.height) ?? toNumberValue(rate.dimsH);
  return length && width && height ? { length, width, height } : null;
}

export function getAppliedRateWeightOz(rate: Record<string, unknown>) {
  const weight = toRecord(rate.weight);
  const lb = toNumberValue(weight?.lb);
  const oz = toNumberValue(weight?.oz);
  if (lb != null || oz != null) return Math.max(0, (lb ?? 0) * 16 + (oz ?? 0));
  return toNumberValue(rate.weightOz) ?? toNumberValue(rate.weight_oz) ?? null;
}

export function sanitizeRecalculateError(error: unknown, fallback = 'Failed to recalculate best rate') {
  return error instanceof Error
    ? error.message.replace(/\s+/g, ' ').trim().slice(0, 160) || fallback
    : fallback;
}
