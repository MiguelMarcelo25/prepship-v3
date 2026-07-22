import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { applyInventoryMovement, type InventoryMovementInput } from './inventory-movement';

export type StockMovement = InventoryMovementInput;

// Compatibility entry point. Canonical stock/ledger transaction lives in inventory-movement.
export async function applyMovement(move: StockMovement) {
  return applyInventoryMovement(move);
}

export async function inventoryStats(clientId?: number, scopePredicate: SQL = sql`true`) {
  const where = clientId !== undefined ? sql`client_id = ${clientId}` : sql`true`;
  const rows = await db.execute<{
    total: number;
    low_stock: number;
    out_of_stock: number;
    total_units: number;
  }>(sql`
    select
      count(*)::int            as total,
      count(*) filter (where inventory_quantity <= reorder_level and inventory_quantity > 0)::int as low_stock,
      count(*) filter (where inventory_quantity <= 0)::int as out_of_stock,
      coalesce(sum(inventory_quantity), 0)::int as total_units
    from (
      select i.*, coalesce(sum(movement.qty), 0)::int as inventory_quantity
      from inventory i
      left join inventory_ledger movement on movement.inventory_id = i.id
      group by i.id
    ) inventory
    where ${where}
      and ${scopePredicate}
      and active = true
      and (
        client_id is null
        or exists (
          select 1 from clients visible_client
          where visible_client.id = inventory.client_id
            and coalesce(visible_client.active, true) = true
        )
      )
  `);
  return (
    rows[0] ?? { total: 0, low_stock: 0, out_of_stock: 0, total_units: 0 }
  );
}
