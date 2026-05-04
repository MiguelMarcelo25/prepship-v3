import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { packageLedger } from '../db/schema/package-ledger';
import { packages } from '../db/schema/packages';

type OrderForDeduction = {
  id: number;
  clientId: number | null;
  orderNumber: string | null;
  orderDate?: Date | string | null;
  items: unknown[];
};

type DeductionLine = {
  sku: string;
  name: string | null;
  qty: number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toQuantity(value: unknown) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.max(1, Math.round(parsed));
}

function toMovementDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function buildDeductionLines(items: unknown[], skuFilter?: Set<string>): DeductionLine[] {
  const bySku = new Map<string, DeductionLine>();

  for (const rawItem of items) {
    const item = toRecord(rawItem);
    if (!item || item.adjustment === true) continue;

    const sku = toStringValue(item.sku);
    if (!sku) continue;

    const key = sku.toLowerCase();
    if (skuFilter && !skuFilter.has(key)) continue;
    const existing = bySku.get(key);
    const qty = toQuantity(item.quantity);
    if (existing) {
      existing.qty += qty;
      continue;
    }

    bySku.set(key, {
      sku,
      name: toStringValue(item.name),
      qty,
    });
  }

  return [...bySku.values()];
}

export async function deductPackageForShipment(input: {
  packageId: number | string | null | undefined;
  shipmentId: number;
  orderId: number;
  orderNumber?: string | null;
}) {
  const packageId = Number.parseInt(String(input.packageId ?? ''), 10);
  if (!Number.isFinite(packageId) || packageId <= 0) {
    return { deducted: false, reason: 'no-package' as const };
  }

  return db.transaction(async (tx) => {
    const [pkg] = await tx
      .select({ id: packages.id, stockQty: packages.stockQty })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);

    if (!pkg) return { deducted: false, reason: 'package-not-found' as const };

    const balanceAfter = pkg.stockQty - 1;
    await tx
      .update(packages)
      .set({ stockQty: balanceAfter, updatedAt: new Date() })
      .where(eq(packages.id, packageId));

    await tx.insert(packageLedger).values({
      packageId,
      changeType: 'ship',
      qtyDelta: -1,
      balanceAfter,
      note: `Shipment ${input.shipmentId} for order ${input.orderNumber ?? input.orderId}`,
    });

    return { deducted: true, balanceAfter };
  });
}

export async function deductInventoryForOrder(
  order: OrderForDeduction,
  input: { shipmentId?: number; source?: string; createdAt?: Date; skus?: string[] } = {},
) {
  const skuFilter = input.skus?.length
    ? new Set(input.skus.map((sku) => sku.trim().toLowerCase()).filter(Boolean))
    : undefined;
  const lines = buildDeductionLines(order.items, skuFilter);
  if (!lines.length) return { deducted: 0, skipped: true };

  return db.transaction(async (tx) => {
    let deducted = 0;
    let skipped = 0;
    for (const line of lines) {
      const skuMatches = sql`lower(${inventory.sku}) = lower(${line.sku})`;
      let row: { id: number; stockQty: number } | null = null;
      if (order.clientId != null) {
        const [exact] = await tx
          .select({ id: inventory.id, stockQty: inventory.stockQty })
          .from(inventory)
          .where(and(eq(inventory.clientId, order.clientId), skuMatches, eq(inventory.active, true)))
          .limit(1);
        row = exact ?? null;
      }
      if (!row) {
        const [global] = await tx
          .select({ id: inventory.id, stockQty: inventory.stockQty })
          .from(inventory)
          .where(and(isNull(inventory.clientId), skuMatches, eq(inventory.active, true)))
          .limit(1);
        row = global ?? null;
      }

      if (!row) {
        const [created] = await tx
          .insert(inventory)
          .values({
            clientId: order.clientId ?? null,
            sku: line.sku,
            name: line.name,
            stockQty: 0,
            active: true,
          })
          .returning({ id: inventory.id, stockQty: inventory.stockQty });
        if (!created) throw new Error(`Failed to create inventory row for ${line.sku}`);
        row = created;
      }

      const [existingShipLine] = await tx
        .select({ id: inventoryLedger.id })
        .from(inventoryLedger)
        .where(
          and(
            eq(inventoryLedger.orderId, order.id),
            eq(inventoryLedger.type, 'ship'),
            eq(inventoryLedger.inventoryId, row.id)
          )
        )
        .limit(1);

      if (existingShipLine) {
        skipped += line.qty;
        continue;
      }

      const balanceAfter = row.stockQty - line.qty;
      const patch: Record<string, unknown> = {
        stockQty: balanceAfter,
        updatedAt: new Date(),
      };
      if (line.name) {
        patch.name = sql`coalesce(${inventory.name}, ${line.name})`;
      }

      await tx
        .update(inventory)
        .set(patch)
        .where(eq(inventory.id, row.id));

      await tx.insert(inventoryLedger).values({
        inventoryId: row.id,
        type: 'ship',
        qty: -line.qty,
        orderId: order.id,
        note: `Order ${order.orderNumber ?? order.id}${input.shipmentId ? ` / shipment ${input.shipmentId}` : ''}`,
        createdBy: input.source ?? 'label',
        createdAt: input.createdAt ?? toMovementDate(order.orderDate) ?? new Date(),
      });
      deducted += line.qty;
    }

    return { deducted, skipped: deducted === 0, skippedUnits: skipped };
  });
}
