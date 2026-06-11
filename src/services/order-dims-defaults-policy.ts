/**
 * PS-177 (Phase 5, part 3) — pure policy for deriving shipment dims defaults
 * from per-SKU product defaults. ZERO imports (offline guard-importable).
 *
 * Exact port of the FE deriveShipmentDimsFromProductDefaults that OrdersView's
 * shipment panel ran client-side after an N-per-panel product fetch loop:
 * every sku'd line must resolve complete positive defaults or the whole
 * derivation yields null (a partial guess must never under-size a box);
 * the combined parcel is footprint-max length/width with stacked height
 * (sum of each line's height × quantity), rounded to 2dp.
 */

export type DimsDefaultItem = { sku?: string | null; quantity?: number | null };

export type DerivedShipmentDims = { length: number; width: number; height: number };

function readPositive(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function deriveShipmentDimsFromProductDefaults(
  items: DimsDefaultItem[],
  defaultsBySku: ReadonlyMap<string, Record<string, unknown>>,
): DerivedShipmentDims | null {
  const resolved = items
    .map((item) => {
      const sku = (item.sku ?? '').trim().toLowerCase();
      const defaults = sku ? defaultsBySku.get(sku) : null;
      const quantity = Math.max(1, Number(item.quantity ?? 1) || 1);
      const length = readPositive(defaults?.length);
      const width = readPositive(defaults?.width);
      const height = readPositive(defaults?.height);
      if (!length || !width || !height) return null;
      return { length, width, height, quantity };
    })
    .filter((item): item is { length: number; width: number; height: number; quantity: number } =>
      Boolean(item),
    );

  if (resolved.length !== items.length || resolved.length === 0) return null;

  return {
    length: Number(Math.max(...resolved.map((item) => item.length)).toFixed(2)),
    width: Number(Math.max(...resolved.map((item) => item.width)).toFixed(2)),
    height: Number(resolved.reduce((sum, item) => sum + item.height * item.quantity, 0).toFixed(2)),
  };
}
