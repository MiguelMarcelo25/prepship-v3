// PS-271 (Layer 4) — thin-source honesty marker for a Shipp rate array.
//
// When Layer 1's observed-set retry ACCEPTS a partial at the cap (a non-empty-but-thin 200 still
// missing an observed-expected carrier), the rate ARRAY is unchanged — a real, cheaper rate that came
// back is always better than an error. But the result is now KNOWN-THIN, and the rest of the pipeline
// should be able to say so honestly (display "thin/unproven", and refuse to call the best rate
// COMPLETE) instead of silently presenting a thin pass as a full comparison.
//
// The marker rides as a NON-ENUMERABLE property on the returned array so the `getRates(): RateResult[]`
// contract is byte-identical: JSON.stringify, spread, .map, Object.keys, and a plain array consumer all
// see exactly today's array. Only a caller that explicitly reads the marker sees it. DEFAULT-INERT: the
// marker is only ever attached when Layer 1 ran (per-account opt-in flag ON) AND accepted a thin
// partial — with the flag OFF nothing here is invoked and the array is the same object as today.

const OBSERVED_INCOMPLETE_KEY = '__ps271ObservedIncomplete';

export type ObservedIncompleteMarker = {
  observedIncomplete: true;
  missing: string[];
};

/**
 * Attach a thin-source marker to a rate array WITHOUT changing its enumerable contents. Returns the
 * SAME array reference. No-op (returns the array unchanged) when `missing` is empty.
 */
export function attachObservedIncomplete<T>(rates: T[], missing: string[]): T[] {
  const cleaned = missing.map((m) => String(m ?? '').trim().toLowerCase()).filter(Boolean);
  if (!cleaned.length) return rates;
  Object.defineProperty(rates, OBSERVED_INCOMPLETE_KEY, {
    value: { observedIncomplete: true, missing: cleaned } as ObservedIncompleteMarker,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return rates;
}

/** Read the thin-source marker off a rate array, or null when none was attached (today's default). */
export function readObservedIncomplete(rates: unknown): ObservedIncompleteMarker | null {
  if (!Array.isArray(rates)) return null;
  const marker = (rates as unknown as Record<string, unknown>)[OBSERVED_INCOMPLETE_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const m = marker as Partial<ObservedIncompleteMarker>;
  if (m.observedIncomplete !== true || !Array.isArray(m.missing)) return null;
  return { observedIncomplete: true, missing: m.missing.map(String) };
}
