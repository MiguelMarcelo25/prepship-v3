import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { ensureInventoryLedgerSchema } from './inventory-ledger-schema';

export type InventoryMovementInput = {
  inventoryId: number;
  qty: number;
  type: 'receive' | 'adjust' | 'pick' | 'ship' | 'return' | 'damage';
  orderId?: number | null;
  note?: string | null;
  createdBy?: string | null;
  effectiveAt?: Date;
  idempotencyKey?: string | null;
  nameIfMissing?: string | null;
};

export type InventoryMovementTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function applyInventoryMovementInTransaction(
  tx: InventoryMovementTransaction,
  move: InventoryMovementInput,
) {
  const insert = tx.insert(inventoryLedger).values({
    inventoryId: move.inventoryId,
    type: move.type,
    qty: move.qty,
    orderId: move.orderId ?? null,
    note: move.note ?? null,
    createdBy: move.createdBy ?? null,
    effectiveAt: move.effectiveAt ?? new Date(),
    idempotencyKey: move.idempotencyKey ?? null,
  });
  const [ledger] = move.idempotencyKey
    ? await insert.onConflictDoNothing().returning()
    : await insert.returning();
  if (!ledger) return { status: 'already_applied' as const };

  const patch: Record<string, unknown> = {
    stockQty: sql`${inventory.stockQty} + ${move.qty}`,
    updatedAt: new Date(),
  };
  if (move.nameIfMissing) {
    patch.name = sql`coalesce(${inventory.name}, ${move.nameIfMissing})`;
  }
  const [updated] = await tx
    .update(inventory)
    .set(patch)
    .where(eq(inventory.id, move.inventoryId))
    .returning();
  if (!updated) throw new Error('Inventory item not found');

  return { status: 'applied' as const, inventory: updated, ledger };
}

export async function applyInventoryMovement(move: InventoryMovementInput) {
  await ensureInventoryLedgerSchema();
  return db.transaction((tx) => applyInventoryMovementInTransaction(tx, move));
}
