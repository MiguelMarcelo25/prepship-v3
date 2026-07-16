// 🔒 AI-LOCKED FILE — Shipped data protection
// This file is part of the shipped/cancelled lockdown declared in
// AGENTS.md. AI agents must NOT refactor, "clean up," or rewrite the
// kill-switch logic (`isInventoryAutoDeductEnabled`,
// `deductInventoryForOrder`, `deductPackageForShipment`) without the
// user explicitly typing `unlock shipped data` in the conversation.
// Read freely — modify only with explicit human override.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { env } from '../lib/env';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { fulfillmentLineClaims, orderLifecycleEvents } from '../db/schema/order-lifecycle';
import { orders } from '../db/schema/orders';
import { consumeOutboundPackage } from './package-consumption';
import { applyInventoryMovementInTransaction } from './inventory-movement';
import { ensureInventoryLedgerSchema } from './inventory-ledger-schema';

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
  // Lockdown also covers the package_ledger — same env flag governs both
  // inventory and package auto-deduction so the "shipped orders shouldn't
  // touch ledger tables" rule is consistent across all on-ship side-effects.
  // Per user override unlock shipped data on 2026-07-11: legacy callers now
  // delegate package identity, idempotency, stock mutation, and ledger writes
  // to the PS-413 canonical package-consumption owner.
  const result = await consumeOutboundPackage({
    shipmentId: input.shipmentId,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    source: 'legacy_label',
    effectiveAt: new Date(),
    selectedPackageId: input.packageId,
  });
  return result.status === 'consumed'
    ? { deducted: true, balanceAfter: result.balanceAfter }
    : { deducted: false, reason: result.status };

}

// ════════════════════════════════════════════════════════════════════
// KILL SWITCH for inventory auto-deduction on shipped orders
// ────────────────────────────────────────────────────────────────────
// Set INVENTORY_AUTO_DEDUCT=false in env to LOCK DOWN the inventory_ledger
// table — shipping an order will NOT touch inventory rows or write a
// `'ship'` ledger entry. Used after the negative-balance audit revealed
// that auto-deducting against zero-baseline SKUs created a long tail of
// negative stock counts (every SKU that wasn't manually received first
// went into the red as soon as it shipped).
//
// What still works when disabled:
//   - Order status transitions (orders can still flip to 'shipped')
//   - Shipment record creation (shipments table still gets rows)
//   - Manual Receive entries (the Inventory tab's Receive flow is
//     untouched — those write to inventory_ledger directly via the
//     /inventory/:id/movement endpoint)
//
// What stops:
//   - Auto-creation of inventory rows on first ship of an unknown SKU
//   - All `'ship'` type entries in inventory_ledger
//   - All stockQty mutations triggered by the label/sync paths
//
// Default (unset or any other value) preserves the original behavior so
// existing deployments aren't surprised. Flip the flag in Vercel/Render
// env vars + redeploy when you want the lockdown.
// ════════════════════════════════════════════════════════════════════
// Per user override unlock shipped data on 2026-07-13 (audit PL-8): the kill
// switch now reads the zod-validated env layer instead of raw process.env.
// OLD behavior: only the exact strings false/0/off/no disabled it — a typo
// ('fasle', 'disabled') silently left auto-deduction ON, so the documented
// emergency lockdown could appear engaged while inert, with no boot evidence
// of the effective value. NEW: booleanFlag(true) — unset stays ON (unchanged
// default); only true/1/yes enable, so a typo fails TOWARD the switch's
// purpose (deductions stop, loudly visible below) instead of ignoring the
// operator. The kill-switch CONTRACT and both governed functions are
// unchanged; this is the value-resolution swap only.
let inventoryAutoDeductLogged = false;
function isInventoryAutoDeductEnabled(): boolean {
  const enabled = env.INVENTORY_AUTO_DEDUCT;
  if (!inventoryAutoDeductLogged) {
    inventoryAutoDeductLogged = true;
    console.log(
      `[fulfillment-deductions] INVENTORY_AUTO_DEDUCT resolved: ${enabled ? 'ON (auto-deduct active)' : 'OFF (kill switch engaged — no inventory/ledger writes from ship paths)'}`,
    );
  }
  return enabled;
}

export type FulfillmentClaimApplicationResult = {
  applied: number;
  alreadyApplied: number;
  lockedDown: boolean;
};

/**
 * Per user override unlock shipped data on 2026-07-16 (PS-424): apply the
 * immutable per-shipment/per-line claims created by OrderLifecycleCommand.
 * The existing validated INVENTORY_AUTO_DEDUCT resolver remains the only kill
 * switch, and stock still changes only through the canonical movement owner.
 */
export async function applyInventoryClaimsForLifecycleEvent(
  lifecycleEventId: number,
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<FulfillmentClaimApplicationResult> {
  if (!isInventoryAutoDeductEnabled()) {
    return { applied: 0, alreadyApplied: 0, lockedDown: true };
  }
  if (conn !== db && process.env.NODE_ENV !== 'test') {
    throw new Error('Inventory claim executor may only be injected in tests');
  }
  if (conn === db) await ensureInventoryLedgerSchema();

  return conn.transaction(async (tx) => {
    const [event] = await tx
      .select({ orderId: orderLifecycleEvents.orderId, effectiveAt: orderLifecycleEvents.effectiveAt })
      .from(orderLifecycleEvents)
      .where(eq(orderLifecycleEvents.id, lifecycleEventId))
      .limit(1);
    if (!event) throw new Error(`Lifecycle event ${lifecycleEventId} does not exist`);

    const claims = await tx
      .select()
      .from(fulfillmentLineClaims)
      .where(and(
        eq(fulfillmentLineClaims.lifecycleEventId, lifecycleEventId),
        eq(fulfillmentLineClaims.status, 'pending'),
      ))
      .orderBy(fulfillmentLineClaims.id)
      .for('update');
    if (claims.length === 0) return { applied: 0, alreadyApplied: 0, lockedDown: false };

    const [order] = await tx
      .select({
        id: orders.id,
        clientId: orders.clientId,
        orderNumber: orders.orderNumber,
        orderDate: orders.orderDate,
      })
      .from(orders)
      .where(eq(orders.id, event.orderId))
      .limit(1);
    if (!order) throw new Error(`Fulfillment claim order ${event.orderId} no longer exists`);

    let applied = 0;
    let alreadyApplied = 0;
    for (const claim of claims) {
      let inventoryId = claim.inventoryId;
      if (claim.direction === 'deduct') {
        if (!claim.sku) {
          await tx
            .update(fulfillmentLineClaims)
            .set({ status: 'review', lastError: 'missing_sku', updatedAt: new Date() })
            .where(eq(fulfillmentLineClaims.id, claim.id));
          continue;
        }
        const skuMatches = sql`lower(${inventory.sku}) = lower(${claim.sku})`;
        let row: { id: number } | null = null;
        if (order.clientId != null) {
          const [exact] = await tx
            .select({ id: inventory.id })
            .from(inventory)
            .where(and(eq(inventory.clientId, order.clientId), skuMatches, eq(inventory.active, true)))
            .limit(1);
          row = exact ?? null;
        }
        if (!row) {
          const [global] = await tx
            .select({ id: inventory.id })
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
              sku: claim.sku,
              name: claim.name,
              stockQty: 0,
              active: true,
            })
            .returning({ id: inventory.id });
          if (!created) throw new Error(`Failed to create inventory row for ${claim.sku}`);
          row = created;
        }
        inventoryId = row.id;
      }

      if (!inventoryId) {
        await tx
          .update(fulfillmentLineClaims)
          .set({ status: 'review', lastError: 'missing_inventory_identity', updatedAt: new Date() })
          .where(eq(fulfillmentLineClaims.id, claim.id));
        continue;
      }

      const movement = await applyInventoryMovementInTransaction(tx, {
        inventoryId,
        type: claim.direction === 'deduct' ? 'ship' : 'return',
        qty: claim.direction === 'deduct' ? -claim.quantity : claim.quantity,
        orderId: order.id,
        note:
          `${claim.direction === 'deduct' ? 'Fulfill' : 'Void'} order ${order.orderNumber ?? order.id}` +
          `${claim.shipmentId ? ` / shipment ${claim.shipmentId}` : ''} / line ${claim.lineKey}`,
        createdBy: `order_lifecycle:${claim.direction}`,
        effectiveAt: event.effectiveAt,
        idempotencyKey: claim.idempotencyKey,
        nameIfMissing: claim.name,
      });
      const appliedAt = new Date();
      await tx
        .update(fulfillmentLineClaims)
        .set({
          inventoryId,
          status: 'applied',
          attempts: sql`${fulfillmentLineClaims.attempts} + 1`,
          lastError: null,
          appliedAt,
          updatedAt: appliedAt,
        })
        .where(eq(fulfillmentLineClaims.id, claim.id));
      if (claim.direction === 'reverse' && claim.originalClaimId) {
        await tx
          .update(fulfillmentLineClaims)
          .set({ status: 'reversed', updatedAt: appliedAt })
          .where(eq(fulfillmentLineClaims.id, claim.originalClaimId));
      }
      if (movement.status === 'already_applied') alreadyApplied += 1;
      else applied += 1;
    }

    return { applied, alreadyApplied, lockedDown: false };
  });
}

export async function deductInventoryForOrder(
  order: OrderForDeduction,
  input: { shipmentId?: number; source?: string; effectiveAt?: Date; skus?: string[] } = {},
) {
  // Lockdown: short-circuit before touching ANY inventory rows or the
  // ledger. Returns the same shape callers expect (`{deducted, skipped}`)
  // so existing call sites at src/routes/orders.ts:1761,
  // src/services/labels.ts:622, and src/services/shipment-sync.ts:478
  // don't need a single line of changes.
  if (!isInventoryAutoDeductEnabled()) {
    return { deducted: 0, skipped: true, lockedDown: true };
  }

  const skuFilter = input.skus?.length
    ? new Set(input.skus.map((sku) => sku.trim().toLowerCase()).filter(Boolean))
    : undefined;
  const lines = buildDeductionLines(order.items, skuFilter);
  if (!lines.length) return { deducted: 0, skipped: true };

  // Per user override unlock shipped data on 2026-07-11: PS-414 prepares
  // additive effective-date/idempotency schema before any shipped stock write.
  await ensureInventoryLedgerSchema();

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

      // PS-247 (Per user override unlock shipped data on 2026-06-16): ATOMIC decrement.
      // Pre-PS-247 this read row.stockQty (the un-locked SELECT above) and wrote a pre-computed
      // balanceAfter, so two concurrent ship-deductions both read the same start value and one
      // decrement was LOST (read-modify-write race under READ COMMITTED — the SELECT takes no row
      // lock). `stock_qty - qty` applies in-DB under the row lock, so concurrent deductions compose.
      // No floor — negative stock is an intentional backorder signal (PS-224, boss directive). The
      // (orderId, inventoryId) ship-ledger idempotency guard above still blocks double-deducting the
      // SAME order; this only fixes the cross-order concurrency race.
      // Per user override unlock shipped data on 2026-07-11: claim the stable
      // order/inventory identity before the atomic decrement. Concurrent retries
      // get already_applied; they cannot double-decrement stock.
      const movement = await applyInventoryMovementInTransaction(tx, {
        inventoryId: row.id,
        type: 'ship',
        qty: -line.qty,
        orderId: order.id,
        note: `Order ${order.orderNumber ?? order.id}${input.shipmentId ? ` / shipment ${input.shipmentId}` : ''}`,
        createdBy: input.source ?? 'label',
        effectiveAt: input.effectiveAt ?? toMovementDate(order.orderDate) ?? new Date(),
        idempotencyKey: `inventory:ship:order:${order.id}:inventory:${row.id}`,
        nameIfMissing: line.name,
      });
      if (movement.status === 'already_applied') {
        skipped += line.qty;
        continue;
      }
      deducted += line.qty;
    }

    return { deducted, skipped: deducted === 0, skippedUnits: skipped };
  });
}
