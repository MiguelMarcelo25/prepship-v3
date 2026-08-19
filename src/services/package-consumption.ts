/**
 * PS-413 canonical outbound package-consumption owner.
 *
 * Per user override unlock shipped data on 2026-07-11: this service records one
 * package movement for one real outbound shipment. It never edits shipment/order
 * history. Callers may run it inside the transaction that creates a new shipment.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { packageConsumptionReviews } from '../db/schema/package-consumption-reviews';
import { orderOverrides } from '../db/schema/orders';
import { packageLedger } from '../db/schema/package-ledger';
import { packages } from '../db/schema/packages';
import { ensurePackageConsumptionSchema } from './package-consumption-schema';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QueryExecutor = typeof db | DbTransaction;

export type OutboundPackageDimensions = {
  length: number | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
};

export type OutboundPackageSelection =
  | { status: 'matched'; packageId: number; matchedBy: 'selected_package' | 'order_selected_package' | 'exact_dimensions' | 'auto_provision' }
  | { status: 'review'; reason: 'invalid_selected_package' | 'invalid_order_selected_package' | 'ambiguous_selected_package' | 'ambiguous_order_selected_package' | 'ambiguous_dimensions' }
  | { status: 'skip'; reason: 'missing_dimensions' | 'no_package_match' };

export type OutboundPackageConsumptionInput = {
  shipmentId: number;
  orderId?: number | null;
  orderNumber?: string | null;
  source: string;
  sourceAccountId?: number | string | null;
  providerShipmentId?: number | string | null;
  /** Use the globally unique local shipment PK when provider ids are not globally scoped. */
  idempotencyIdentity?: 'provider_shipment' | 'local_shipment';
  effectiveAt: Date | string;
  selectedPackageId?: number | string | null;
  dimensions?: OutboundPackageDimensions | null;
  voided?: boolean;
  isReturn?: boolean;
  isTest?: boolean;
};

export type OutboundPackageConsumptionResult =
  | { status: 'consumed'; packageId: number; balanceAfter: number; idempotencyKey: string }
  | { status: 'already_consumed'; packageId: number; idempotencyKey: string }
  | { status: 'review'; reason: 'invalid_selected_package' | 'invalid_order_selected_package' | 'ambiguous_selected_package' | 'ambiguous_order_selected_package' | 'ambiguous_dimensions' | 'missing_dimensions' | 'no_package_match' }
  | { status: 'skipped'; reason: 'lockdown' | 'voided' | 'return' | 'test' | 'invalid_identity' | 'invalid_effective_at' };

const EXACT_DIMS_TOLERANCE = 0.001;

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizedText(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

type PackageRefResolution =
  | { status: 'matched'; packageId: number }
  | { status: 'missing' | 'ambiguous' };

async function resolvePackageRef(ref: number | string, conn: QueryExecutor): Promise<PackageRefResolution> {
  const asId = positiveInt(ref);
  if (asId != null) {
    const [row] = await conn.select({ id: packages.id }).from(packages).where(eq(packages.id, asId)).limit(1);
    return row ? { status: 'matched', packageId: row.id } : { status: 'missing' };
  }
  const code = normalizedText(ref);
  if (!code) return { status: 'missing' };
  const rows = await conn
    .select({ id: packages.id })
    .from(packages)
    .where(eq(packages.packageCode, code))
    .limit(2);
  if (rows.length > 1) return { status: 'ambiguous' };
  return rows[0]
    ? { status: 'matched', packageId: rows[0].id }
    : { status: 'missing' };
}

export async function resolveOutboundPackageSelection(
  input: Pick<OutboundPackageConsumptionInput, 'orderId' | 'selectedPackageId' | 'dimensions'>,
  conn: QueryExecutor = db,
): Promise<OutboundPackageSelection> {
  if (input.selectedPackageId != null && normalizedText(input.selectedPackageId)) {
    const selected = await resolvePackageRef(input.selectedPackageId, conn);
    if (selected.status === 'ambiguous') return { status: 'review', reason: 'ambiguous_selected_package' };
    return selected.status === 'matched'
      ? { status: 'matched', packageId: selected.packageId, matchedBy: 'selected_package' }
      : { status: 'review', reason: 'invalid_selected_package' };
  }

  const orderId = positiveInt(input.orderId);
  if (orderId != null) {
    const [row] = await conn
      .select({ selectedPackageId: orderOverrides.selectedPackageId })
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, orderId))
      .limit(1);
    if (row?.selectedPackageId) {
      const selected = await resolvePackageRef(row.selectedPackageId, conn);
      if (selected.status === 'ambiguous') return { status: 'review', reason: 'ambiguous_order_selected_package' };
      return selected.status === 'matched'
        ? { status: 'matched', packageId: selected.packageId, matchedBy: 'order_selected_package' }
        : { status: 'review', reason: 'invalid_order_selected_package' };
    }
  }

  const length = positiveNumber(input.dimensions?.length);
  const width = positiveNumber(input.dimensions?.width);
  const height = positiveNumber(input.dimensions?.height);
  if (length == null || width == null || height == null) {
    return { status: 'skip', reason: 'missing_dimensions' };
  }

  const matches = await conn
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(
        sql`abs(${packages.length} - ${length}) <= ${EXACT_DIMS_TOLERANCE}`,
        sql`abs(${packages.width} - ${width}) <= ${EXACT_DIMS_TOLERANCE}`,
        sql`abs(${packages.height} - ${height}) <= ${EXACT_DIMS_TOLERANCE}`,
      ),
    )
    .limit(2);

  if (matches.length > 1) return { status: 'review', reason: 'ambiguous_dimensions' };
  if (matches.length === 0) return { status: 'skip', reason: 'no_package_match' };
  return { status: 'matched', packageId: matches[0]!.id, matchedBy: 'exact_dimensions' };
}

export function buildPackageConsumptionIdempotencyKey(
  input: Pick<
    OutboundPackageConsumptionInput,
    'shipmentId' | 'source' | 'sourceAccountId' | 'providerShipmentId' | 'idempotencyIdentity'
  >,
): string | null {
  const shipmentId = positiveInt(input.shipmentId);
  const source = normalizedText(input.source)?.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  if (!shipmentId || !source) return null;
  const providerShipmentId = normalizedText(input.providerShipmentId);
  const sourceAccountId = normalizedText(input.sourceAccountId) ?? 'default';
  return providerShipmentId && input.idempotencyIdentity !== 'local_shipment'
    ? `package-consumption:v1:${source}:${sourceAccountId}:provider:${providerShipmentId}`
    : `package-consumption:v1:${source}:local:${shipmentId}`;
}

export function isPackageAutoDeductEnabled(): boolean {
  const raw = (process.env.INVENTORY_AUTO_DEDUCT ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(raw);
}

async function recordConsumptionReview(
  input: OutboundPackageConsumptionInput,
  reason: 'invalid_selected_package' | 'invalid_order_selected_package' | 'ambiguous_selected_package' | 'ambiguous_order_selected_package' | 'ambiguous_dimensions' | 'missing_dimensions' | 'no_package_match',
  identity: { shipmentId: number; orderId: number | null; idempotencyKey: string; effectiveAt: Date },
  tx: DbTransaction,
): Promise<OutboundPackageConsumptionResult> {
  await tx
    .insert(packageConsumptionReviews)
    .values({
      shipmentId: identity.shipmentId,
      orderId: identity.orderId,
      source: normalizedText(input.source) ?? 'unknown',
      sourceAccountId: normalizedText(input.sourceAccountId),
      providerShipmentId: normalizedText(input.providerShipmentId),
      effectiveAt: identity.effectiveAt,
      idempotencyKey: identity.idempotencyKey,
      reason,
      selectedPackageRef: normalizedText(input.selectedPackageId),
      dimsL: positiveNumber(input.dimensions?.length),
      dimsW: positiveNumber(input.dimensions?.width),
      dimsH: positiveNumber(input.dimensions?.height),
      status: 'pending',
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: packageConsumptionReviews.idempotencyKey,
      set: { reason, status: 'pending', updatedAt: new Date() },
    });
  return { status: 'review', reason };
}

async function consumeWithExecutor(
  input: OutboundPackageConsumptionInput,
  tx: DbTransaction,
): Promise<OutboundPackageConsumptionResult> {
  if (!isPackageAutoDeductEnabled()) return { status: 'skipped', reason: 'lockdown' };
  if (input.voided === true) return { status: 'skipped', reason: 'voided' };
  if (input.isReturn === true) return { status: 'skipped', reason: 'return' };
  if (input.isTest === true) return { status: 'skipped', reason: 'test' };

  const shipmentId = positiveInt(input.shipmentId);
  const orderId = positiveInt(input.orderId);
  const idempotencyKey = buildPackageConsumptionIdempotencyKey(input);
  if (!shipmentId || !idempotencyKey) {
    return { status: 'skipped', reason: 'invalid_identity' };
  }
  const effectiveAt = input.effectiveAt instanceof Date ? input.effectiveAt : new Date(input.effectiveAt);
  if (Number.isNaN(effectiveAt.getTime())) return { status: 'skipped', reason: 'invalid_effective_at' };

  // Retry identity wins before mutable package selection. Catalog/default changes
  // cannot turn an already-consumed shipment back into review work.
  const [existingClaim] = await tx
    .select({ packageId: packageLedger.packageId })
    .from(packageLedger)
    .where(eq(packageLedger.idempotencyKey, idempotencyKey))
    .limit(1);
  if (existingClaim) {
    await tx
      .update(packageConsumptionReviews)
      .set({ status: 'resolved', updatedAt: new Date() })
      .where(eq(packageConsumptionReviews.idempotencyKey, idempotencyKey));
    return { status: 'already_consumed', packageId: existingClaim.packageId, idempotencyKey };
  }

  const selection = await resolveOutboundPackageSelection(input, tx);
  const identity = { shipmentId, orderId, idempotencyKey, effectiveAt };
  if (selection.status === 'review') {
    return recordConsumptionReview(input, selection.reason, identity, tx);
  }
  if (selection.status === 'skip') {
    return recordConsumptionReview(input, selection.reason, identity, tx);
  }

  const [claim] = await tx
    .insert(packageLedger)
    .values({
      packageId: selection.packageId,
      changeType: 'ship',
      qtyDelta: -1,
      balanceAfter: 0,
      note: `Shipment ${shipmentId} for order ${input.orderNumber ?? orderId ?? 'unmatched'}`,
      shipmentId,
      orderId,
      source: normalizedText(input.source),
      sourceAccountId: normalizedText(input.sourceAccountId),
      providerShipmentId: normalizedText(input.providerShipmentId),
      effectiveAt,
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning({ id: packageLedger.id });

  if (!claim) {
    const [existing] = await tx
      .select({ packageId: packageLedger.packageId })
      .from(packageLedger)
      .where(eq(packageLedger.idempotencyKey, idempotencyKey))
      .limit(1);
    if (!existing) throw new Error(`Package consumption claim conflict without ledger row: ${idempotencyKey}`);
    await tx
      .update(packageConsumptionReviews)
      .set({ status: 'resolved', updatedAt: new Date() })
      .where(eq(packageConsumptionReviews.idempotencyKey, idempotencyKey));
    return { status: 'already_consumed', packageId: existing.packageId, idempotencyKey };
  }

  const [updated] = await tx
    .update(packages)
    .set({ stockQty: sql`${packages.stockQty} - 1`, updatedAt: new Date() })
    .where(eq(packages.id, selection.packageId))
    .returning({ balanceAfter: packages.stockQty });
  if (!updated) throw new Error(`Package ${selection.packageId} disappeared during consumption`);

  await tx
    .update(packageLedger)
    .set({ balanceAfter: updated.balanceAfter })
    .where(eq(packageLedger.id, claim.id));
  await tx
    .update(packageConsumptionReviews)
    .set({ status: 'resolved', updatedAt: new Date() })
    .where(eq(packageConsumptionReviews.idempotencyKey, idempotencyKey));

  return {
    status: 'consumed',
    packageId: selection.packageId,
    balanceAfter: updated.balanceAfter,
    idempotencyKey,
  };
}

export function consumeOutboundPackageInTransaction(
  input: OutboundPackageConsumptionInput,
  tx: DbTransaction,
): Promise<OutboundPackageConsumptionResult> {
  return consumeWithExecutor(input, tx);
}

export function consumeOutboundPackage(
  input: OutboundPackageConsumptionInput,
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<OutboundPackageConsumptionResult> {
  const run = async () => conn.transaction((tx) => consumeWithExecutor(input, tx));
  return conn === db
    ? ensurePackageConsumptionSchema().then(run)
    : run();
}

export async function reverseOutboundPackageConsumptionInTransaction(
  shipmentIdInput: number,
  voidedAt: Date,
  tx: DbTransaction,
): Promise<{ status: 'reversed'; packageId: number; balanceAfter: number } | { status: 'already_reversed' | 'not_consumed' | 'lockdown' }> {
  if (!isPackageAutoDeductEnabled()) return { status: 'lockdown' };
  const shipmentId = positiveInt(shipmentIdInput);
  if (!shipmentId) return { status: 'not_consumed' };
  const [original] = await tx
    .select()
    .from(packageLedger)
    .where(and(
      eq(packageLedger.shipmentId, shipmentId),
      eq(packageLedger.changeType, 'ship'),
      eq(packageLedger.qtyDelta, -1),
    ))
    .orderBy(desc(packageLedger.id))
    .limit(1);
  if (!original?.idempotencyKey) {
    await tx
      .update(packageConsumptionReviews)
      .set({ status: 'voided', updatedAt: voidedAt })
      .where(eq(packageConsumptionReviews.shipmentId, shipmentId));
    return { status: 'not_consumed' };
  }

  const reversalKey = `${original.idempotencyKey}:void`;
  const [claim] = await tx
    .insert(packageLedger)
    .values({
      packageId: original.packageId,
      changeType: 'ship_void',
      qtyDelta: 1,
      balanceAfter: 0,
      note: `Void shipment ${shipmentId}`,
      shipmentId,
      orderId: original.orderId,
      source: original.source,
      sourceAccountId: original.sourceAccountId,
      providerShipmentId: original.providerShipmentId,
      effectiveAt: voidedAt,
      idempotencyKey: reversalKey,
    })
    .onConflictDoNothing()
    .returning({ id: packageLedger.id });
  if (!claim) return { status: 'already_reversed' };

  const [updated] = await tx
    .update(packages)
    .set({ stockQty: sql`${packages.stockQty} + 1`, updatedAt: voidedAt })
    .where(eq(packages.id, original.packageId))
    .returning({ balanceAfter: packages.stockQty });
  if (!updated) throw new Error(`Package ${original.packageId} disappeared during void reversal`);
  await tx
    .update(packageLedger)
    .set({ balanceAfter: updated.balanceAfter })
    .where(eq(packageLedger.id, claim.id));
  await tx
    .update(packageConsumptionReviews)
    .set({ status: 'voided', updatedAt: voidedAt })
    .where(eq(packageConsumptionReviews.shipmentId, shipmentId));
  return { status: 'reversed', packageId: original.packageId, balanceAfter: updated.balanceAfter };
}
