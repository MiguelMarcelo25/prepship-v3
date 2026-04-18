import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';

export type StockMovement = {
  inventoryId: number;
  qty: number;
  type: 'receive' | 'adjust' | 'pick' | 'return';
  orderId?: number;
  note?: string;
  createdBy?: string;
};

export async function applyMovement(move: StockMovement) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: inventory.id, stockQty: inventory.stockQty })
      .from(inventory)
      .where(eq(inventory.id, move.inventoryId))
      .limit(1);
    if (!current) throw new Error('Inventory item not found');

    const newQty = current.stockQty + move.qty;
    if (newQty < 0) {
      throw new Error(
        `Stock would go negative (${current.stockQty} + ${move.qty} = ${newQty})`
      );
    }

    const [updated] = await tx
      .update(inventory)
      .set({ stockQty: newQty, updatedAt: new Date() })
      .where(eq(inventory.id, move.inventoryId))
      .returning();

    const [ledger] = await tx
      .insert(inventoryLedger)
      .values({
        inventoryId: move.inventoryId,
        type: move.type,
        qty: move.qty,
        orderId: move.orderId ?? null,
        note: move.note ?? null,
        createdBy: move.createdBy ?? null,
      })
      .returning();

    return { inventory: updated, ledger };
  });
}

export async function inventoryStats(clientId?: number) {
  const where = clientId !== undefined ? sql`client_id = ${clientId}` : sql`true`;
  const rows = await db.execute<{
    total: number;
    low_stock: number;
    out_of_stock: number;
    total_units: number;
  }>(sql`
    select
      count(*)::int            as total,
      count(*) filter (where stock_qty <= reorder_level and stock_qty > 0)::int as low_stock,
      count(*) filter (where stock_qty <= 0)::int                                as out_of_stock,
      coalesce(sum(stock_qty), 0)::int                                           as total_units
    from inventory
    where ${where} and active = true
  `);
  return (
    rows[0] ?? { total: 0, low_stock: 0, out_of_stock: 0, total_units: 0 }
  );
}
