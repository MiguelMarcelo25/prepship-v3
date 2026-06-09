// PS-137: pure coercion + canonical-source provenance primitives extracted VERBATIM from
// routes/orders.ts (no behavior change). These are shared by the orders list row-map, the
// /export handler, the order-detail payload, and buildCanonicalOrderModel — so they belong in a
// shared service module rather than inline in the route. All functions are PURE (no DB, no I/O);
// the route now imports them. The se-NNN regex, the null-coalescing chains, and the
// sourceOf('local','null',...) provenance default are byte-load-bearing — kept identical.

export type CanonicalSourceVersion = 'v1' | 'v2' | 'local' | 'derived';

export type CanonicalFieldSource = {
  version: CanonicalSourceVersion;
  source: string;
  via: string;
  note?: string;
};

export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function providerIdOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/^se-(\d+)$/i);
  const parsed = Number.parseInt(match?.[1] ?? value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rateAmount(value: unknown): number | null {
  const rate = recordOrNull(value);
  if (!rate) return null;
  const shippingAmount = recordOrNull(rate.shipping_amount);
  const otherAmount = recordOrNull(rate.other_amount);
  const shipmentCost =
    finiteNumberOrNull(rate.shipmentCost) ??
    finiteNumberOrNull(shippingAmount?.amount) ??
    finiteNumberOrNull(rate.cost) ??
    finiteNumberOrNull(rate.amount);
  const otherCost = finiteNumberOrNull(rate.otherCost) ?? finiteNumberOrNull(otherAmount?.amount) ?? 0;
  return shipmentCost != null ? shipmentCost + otherCost : null;
}

export function sourceOf(
  version: CanonicalSourceVersion,
  source: string,
  via: string,
  note?: string,
): CanonicalFieldSource {
  return note ? { version, source, via, note } : { version, source, via };
}

export function pickStringSource(
  candidates: Array<{ value: unknown; source: CanonicalFieldSource }>,
): { value: string | null; source: CanonicalFieldSource } {
  for (const candidate of candidates) {
    const value = stringOrNull(candidate.value);
    if (value != null) return { value, source: candidate.source };
  }
  return {
    value: null,
    source: sourceOf('local', 'null', 'no populated source field'),
  };
}

export function pickNumberSource(
  candidates: Array<{ value: unknown; source: CanonicalFieldSource }>,
): { value: number | null; source: CanonicalFieldSource } {
  for (const candidate of candidates) {
    const value = finiteNumberOrNull(candidate.value);
    if (value != null) return { value, source: candidate.source };
  }
  return {
    value: null,
    source: sourceOf('local', 'null', 'no populated source field'),
  };
}
