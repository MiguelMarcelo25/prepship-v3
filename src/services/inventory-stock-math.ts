import { sql, type SQLWrapper } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';

export type InventoryLedgerQuantityRow = {
  qty: number | string | null | undefined;
};

/** Pure form of the canonical quantity rule: sum every persisted signed movement. */
export function inventoryLedgerQuantity(rows: InventoryLedgerQuantityRow[]): number {
  return rows.reduce((total, row) => {
    const quantity = Number(row.qty ?? 0);
    return Number.isFinite(quantity) ? total + quantity : total;
  }, 0);
}

export type InventoryQuantityEntry = {
  inventoryQuantity: number;
  totalReceived: number;
  totalShipped: number;
};

export type InventoryStockTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InventoryStockExecutor = typeof db | InventoryStockTransaction;

/** The only canonical SQL quantity expression: signed persisted ledger movements. */
export function inventoryQuantitySql(inventoryId: SQLWrapper) {
  return sql<number>`coalesce((
    select sum(quantity_ledger.qty)::int
    from ${inventoryLedger} quantity_ledger
    where quantity_ledger.inventory_id = ${inventoryId}
  ), 0)::int`;
}

// PS-439: this owner has no stored balance, order-history reconstruction, cache, or
// fallback. Missing history intentionally means zero. The discrepancy report identifies
// missing historical movements for a separately reviewed append-only repair plan.
async function computeInventoryQuantityForIdsWithExecutor(
  executor: InventoryStockExecutor,
  inventoryIds: number[],
): Promise<Map<number, InventoryQuantityEntry>> {
  const result = new Map<number, InventoryQuantityEntry>();
  const ids = [...new Set(inventoryIds.filter((value) => Number.isInteger(value) && value > 0))];
  if (ids.length === 0) return result;

  type QuantityRow = {
    inventory_id: number;
    total_received: number;
    total_shipped: number;
    inventory_quantity: number;
  };
  const executed = await executor.execute<QuantityRow>(sql`
    with ids as (
      select unnest(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]) as id
    ),
    ledger_totals as (
      select
        movement.inventory_id as id,
        coalesce(sum(movement.qty), 0)::int as inventory_quantity,
        coalesce(sum(movement.qty) filter (where movement.type = 'receive'), 0)::int as total_received,
        abs(coalesce(sum(movement.qty) filter (where movement.type = 'ship'), 0))::int as total_shipped
      from ${inventoryLedger} movement
      where movement.inventory_id in (select id from ids)
      group by movement.inventory_id
    )
    select
      ids.id as inventory_id,
      coalesce(ledger_totals.total_received, 0)::int as total_received,
      coalesce(ledger_totals.total_shipped, 0)::int as total_shipped,
      coalesce(ledger_totals.inventory_quantity, 0)::int as inventory_quantity
    from ids
    join ${inventory} on ${inventory.id} = ids.id
    left join ledger_totals on ledger_totals.id = ids.id
  `);
  const rows = Array.isArray(executed)
    ? executed
    : (executed as unknown as { rows?: QuantityRow[] }).rows ?? [];

  for (const row of rows) {
    result.set(Number(row.inventory_id), {
      inventoryQuantity: Number(row.inventory_quantity) || 0,
      totalReceived: Number(row.total_received) || 0,
      totalShipped: Number(row.total_shipped) || 0,
    });
  }
  return result;
}

export function computeInventoryQuantityForIds(
  inventoryIds: number[],
): Promise<Map<number, InventoryQuantityEntry>> {
  return computeInventoryQuantityForIdsWithExecutor(db, inventoryIds);
}

export function computeInventoryQuantityForIdsInTransaction(
  tx: InventoryStockTransaction,
  inventoryIds: number[],
): Promise<Map<number, InventoryQuantityEntry>> {
  return computeInventoryQuantityForIdsWithExecutor(tx, inventoryIds);
}
