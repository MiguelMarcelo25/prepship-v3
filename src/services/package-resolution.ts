/**
 * package-resolution.ts — PS-221 (slice 2): the single label-time package resolver.
 *
 * "Which box is this shipment consuming?" must agree across deduction, billing, and
 * display. This resolves a packages.id with the SAME precedence the canonical
 * package-facts (PS-205) and billing (PS-207) already use, so the label path stops
 * dims-guessing in isolation:
 *
 *   1. operator's explicit pick (body.customPackageId)               — highest
 *   2. the order's canonical selected package (order_overrides
 *      .selected_package_id — the PS-205 combo/sku/dims resolution
 *      materialized at import), resolved by packages.id OR package_code
 *   3. a dims ±0.1" match against the catalog                        — fallback
 *   4. null (caller deducts nothing / persists null)
 *
 * Read-only: this slice does NOT auto-create a package or save a default (that
 * find-or-create+save is a later slice). The id it returns is what PS-221 slice 1
 * persists to shipments.selected_package_id AND deducts — so persisted == deducted.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { packages } from '../db/schema/packages';
import { orderOverrides } from '../db/schema/orders';

const DIMS_TOLERANCE = 0.1;

function toPositiveInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve a stored order_overrides.selected_package_id (text: a packages.id OR a
 *  package_code) to a real packages.id, verifying the package exists. */
async function resolvePackageRef(ref: string | null): Promise<number | null> {
  if (!ref) return null;
  const asId = toPositiveInt(ref);
  if (asId != null) {
    const [row] = await db.select({ id: packages.id }).from(packages).where(eq(packages.id, asId)).limit(1);
    return row?.id ?? null;
  }
  const [byCode] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.packageCode, ref))
    .limit(1);
  return byCode?.id ?? null;
}

async function findPackageByDims(
  length: number | null,
  width: number | null,
  height: number | null,
): Promise<number | null> {
  if (!length || !width || !height) return null;
  const [match] = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(
        sql`abs(${packages.length} - ${length}) <= ${DIMS_TOLERANCE}`,
        sql`abs(${packages.width} - ${width}) <= ${DIMS_TOLERANCE}`,
        sql`abs(${packages.height} - ${height}) <= ${DIMS_TOLERANCE}`,
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

export async function resolveOrderLabelPackageId(args: {
  orderId: number | null;
  customPackageId?: number | string | null;
  length: number | null;
  width: number | null;
  height: number | null;
}): Promise<number | null> {
  // 1. Operator's explicit pick wins.
  const explicit = toPositiveInt(args.customPackageId);
  if (explicit != null) return explicit;

  // 2. The order's canonical selected package (PS-205 resolution at import).
  if (args.orderId != null) {
    const [ov] = await db
      .select({ selectedPackageId: orderOverrides.selectedPackageId })
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, args.orderId))
      .limit(1);
    const canonical = await resolvePackageRef(ov?.selectedPackageId ?? null);
    if (canonical != null) return canonical;
  }

  // 3. Dims ±0.1" catalog match.
  return findPackageByDims(args.length, args.width, args.height);
}
