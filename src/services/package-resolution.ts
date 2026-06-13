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
// PS-221 slice 3: save the auto-provisioned box as the order's combo default.
import { saveComboPackageDefault } from './combo-package-defaults';

const DIMS_TOLERANCE = 0.1;

// PS-221 slice 3 — auto-provision is DARK by default. When OFF (the default), a
// dims-present order with no catalog match resolves to null exactly as before
// (zero prod behavior change). When DJ flips PACKAGE_AUTO_PROVISION=true (after
// reviewing the dry-run, scripts/ps-221-auto-provision-dry-run.ts), a no-match
// label auto-creates the package + saves it as the order's combo default so future
// imports of that SKU+qty resolve it. Kill-switch style, like INVENTORY_AUTO_DEDUCT.
export function isPackageAutoProvisionEnabled(): boolean {
  const raw = (process.env.PACKAGE_AUTO_PROVISION ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Find-or-create a catalog box for these dims (±0.1"); returns its packages.id.
 *  Mirrors POST /packages/auto-create. */
export async function findOrCreatePackageForDims(
  length: number,
  width: number,
  height: number,
): Promise<number | null> {
  const existing = await findPackageByDims(length, width, height);
  if (existing != null) return existing;
  const [row] = await db
    .insert(packages)
    .values({
      name: `Custom ${length}x${width}x${height}`,
      type: 'box',
      length,
      width,
      height,
      tareWeightOz: 0,
      source: 'custom',
    })
    .returning({ id: packages.id });
  return row?.id ?? null;
}

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
  const dimsMatch = await findPackageByDims(args.length, args.width, args.height);
  if (dimsMatch != null) return dimsMatch;

  // 3b. PS-221 slice 3 — DARK by default (PACKAGE_AUTO_PROVISION). Dims present but
  //     no catalog match → auto-create the box + save it as the order's combo
  //     default so future imports of this SKU+qty resolve it. When the flag is OFF
  //     (default) this returns null exactly as before — zero prod behavior change.
  if (isPackageAutoProvisionEnabled() && args.length && args.width && args.height) {
    const created = await findOrCreatePackageForDims(args.length, args.width, args.height);
    if (created != null && args.orderId != null) {
      await saveComboPackageDefault(args.orderId, {
        packageId: created,
        length: args.length,
        width: args.width,
        height: args.height,
      }).catch((err) => {
        console.warn(
          '[package-resolution] auto-provision save-default failed:',
          err instanceof Error ? err.message : err,
        );
      });
    }
    return created;
  }

  return null;
}
