import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { ensureInventoryLedgerSchema } from './inventory-ledger-schema';
import { movementDirectionError } from '../lib/inventory-movement-direction';

export type InventoryMovementInput = {
  inventoryId: number;
  qty: number;
  type: 'receive' | 'adjust' | 'pick' | 'ship' | 'return' | 'damage';
  orderId?: number | null;
  note?: string | null;
  createdBy: string;
  effectiveAt: Date;
  idempotencyKey: string;
  sourceEntity: string;
  sourceId: string;
  nameIfMissing?: string | null;
};

export type InventoryMovementTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Canonical quantity mutation boundary. It appends exactly one signed movement and
 * derives the returned quantity from the ledger inside the same transaction.
 */
export async function applyInventoryMovementInTransaction(
  tx: InventoryMovementTransaction,
  move: InventoryMovementInput,
) {
  if (!Number.isInteger(move.qty) || move.qty === 0) {
    throw new Error('Inventory movement quantity must be a non-zero integer');
  }
  const directionError = movementDirectionError(move.type, move.qty);
  if (directionError) throw new Error(`INVENTORY_MOVEMENT_DIRECTION_INVALID: ${directionError}`);
  const [item] = await tx.select().from(inventory).where(eq(inventory.id, move.inventoryId)).limit(1);
  if (!item) throw new Error('Inventory item not found');

  const [ledger] = await tx
    .insert(inventoryLedger)
    .values({
      inventoryId: move.inventoryId,
      clientId: item.clientId,
      sku: item.sku,
      type: move.type,
      qty: move.qty,
      orderId: move.orderId ?? null,
      note: move.note ?? null,
      createdBy: move.createdBy,
      effectiveAt: move.effectiveAt,
      idempotencyKey: move.idempotencyKey,
      sourceEntity: move.sourceEntity,
      sourceId: move.sourceId,
    })
    .onConflictDoNothing()
    .returning();

  if (!ledger) {
    const [existing] = await tx
      .select({
        inventoryId: inventoryLedger.inventoryId,
        type: inventoryLedger.type,
        qty: inventoryLedger.qty,
        orderId: inventoryLedger.orderId,
        sourceEntity: inventoryLedger.sourceEntity,
        sourceId: inventoryLedger.sourceId,
      })
      .from(inventoryLedger)
      .where(or(
        eq(inventoryLedger.idempotencyKey, move.idempotencyKey),
        and(
          eq(inventoryLedger.sourceEntity, move.sourceEntity),
          eq(inventoryLedger.sourceId, move.sourceId),
          eq(inventoryLedger.inventoryId, move.inventoryId),
          eq(inventoryLedger.type, move.type),
        ),
      ))
      .limit(1);
    const sameIntent = existing
      && existing.inventoryId === move.inventoryId
      && existing.type === move.type
      && existing.qty === move.qty
      && (existing.orderId ?? null) === (move.orderId ?? null)
      && existing.sourceEntity === move.sourceEntity
      && existing.sourceId === move.sourceId;
    if (!sameIntent) {
      throw new Error('INVENTORY_IDEMPOTENCY_CONFLICT: movement identity was reused with different intent');
    }
  }

  if (move.nameIfMissing && !item.name) {
    await tx
      .update(inventory)
      .set({ name: move.nameIfMissing, updatedAt: new Date() })
      .where(eq(inventory.id, move.inventoryId));
  }
  const [quantity] = await tx
    .select({ inventoryQuantity: sql<number>`coalesce(sum(${inventoryLedger.qty}), 0)::int` })
    .from(inventoryLedger)
    .where(eq(inventoryLedger.inventoryId, move.inventoryId));
  const inventoryWithQuantity = {
    ...item,
    name: item.name ?? move.nameIfMissing ?? null,
    inventoryQuantity: Number(quantity?.inventoryQuantity ?? 0),
  };

  return ledger
    ? { status: 'applied' as const, inventory: inventoryWithQuantity, ledger }
    : { status: 'already_applied' as const, inventory: inventoryWithQuantity, ledger: null };
}

export async function applyInventoryMovement(move: InventoryMovementInput) {
  await ensureInventoryLedgerSchema();
  return db.transaction((tx) => applyInventoryMovementInTransaction(tx, move));
}
