import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { orderItems } from '../db/schema/order-items';
import {
  clientComboPackageDefaults,
  type ClientComboPackageDefault,
} from '../db/schema/client-combo-package-defaults';
import { computeComboKey, isMultiSkuCombo, type ComboItemInput } from '../lib/package-combo';

// PS-037 — Service for per-client SKU+qty-combination package defaults.
//
// SOURCE OF TRUTH: the combo key is always derived here from real order data
// (canonical order_items, falling back to orders.items jsonb) — never trusted
// from the client. Scope is enforced by clientId; uniqueness on
// (clientId, comboKey) makes save an idempotent upsert and prevents any
// cross-client leakage.

export interface OrderComboContext {
  clientId: number | null;
  comboKey: string;
  multiSku: boolean;
}

async function loadComboItems(orderId: number, fallbackItems: unknown): Promise<ComboItemInput[]> {
  // Canonical per-line table first.
  const rows = await db
    .select({ sku: orderItems.sku, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  if (rows.length) {
    return rows.map((r) => ({ sku: r.sku, quantity: r.quantity }));
  }
  // Fallback: raw orders.items jsonb (always present on import).
  return Array.isArray(fallbackItems) ? (fallbackItems as ComboItemInput[]) : [];
}

/** Derive {clientId, comboKey, multiSku} for an order, server-side. */
export async function deriveOrderComboContext(orderId: number): Promise<OrderComboContext> {
  const [ord] = await db
    .select({ clientId: orders.clientId, items: orders.items })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!ord) return { clientId: null, comboKey: '', multiSku: false };
  const items = await loadComboItems(orderId, ord.items);
  return {
    clientId: ord.clientId ?? null,
    comboKey: computeComboKey(items),
    multiSku: isMultiSkuCombo(items),
  };
}

export interface SaveComboDefaultInput {
  packageId?: number | null;
  packageCode?: string | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  weightOz?: number | null;
}

export interface SaveComboDefaultResult {
  saved: boolean;
  reason?: string;
  clientId?: number;
  comboKey?: string;
}

/**
 * Upsert the package default for an order's exact (client, SKU+qty combo).
 * No-ops (saved:false) when the order has no client or no resolvable combo
 * (e.g. empty/adjustment-only items) so we never write a meaningless key.
 */
export async function saveComboPackageDefault(
  orderId: number,
  input: SaveComboDefaultInput,
): Promise<SaveComboDefaultResult> {
  const { clientId, comboKey } = await deriveOrderComboContext(orderId);
  if (clientId == null) return { saved: false, reason: 'order has no client scope' };
  if (!comboKey) return { saved: false, reason: 'order has no resolvable SKU+qty combination' };

  const now = new Date();
  await db
    .insert(clientComboPackageDefaults)
    .values({
      clientId,
      comboKey,
      packageId: input.packageId ?? null,
      packageCode: input.packageCode ?? null,
      length: input.length ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      weightOz: input.weightOz ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [clientComboPackageDefaults.clientId, clientComboPackageDefaults.comboKey],
      set: {
        packageId: input.packageId ?? null,
        packageCode: input.packageCode ?? null,
        length: input.length ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        weightOz: input.weightOz ?? null,
        updatedAt: now,
      },
    });

  return { saved: true, clientId, comboKey };
}

export interface ComboPackageDefaultDto {
  packageId: number | null;
  packageCode: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weightOz: number | null;
  comboKey: string;
}

/** Resolve the saved combo default for an order (null when none / not applicable). */
export async function getComboPackageDefaultForOrder(
  orderId: number,
): Promise<ComboPackageDefaultDto | null> {
  const { clientId, comboKey } = await deriveOrderComboContext(orderId);
  if (clientId == null || !comboKey) return null;
  const [row] = await db
    .select()
    .from(clientComboPackageDefaults)
    .where(
      and(
        eq(clientComboPackageDefaults.clientId, clientId),
        eq(clientComboPackageDefaults.comboKey, comboKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  const r = row as ClientComboPackageDefault;
  return {
    packageId: r.packageId ?? null,
    packageCode: r.packageCode ?? null,
    length: r.length ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    weightOz: r.weightOz ?? null,
    comboKey: r.comboKey,
  };
}
