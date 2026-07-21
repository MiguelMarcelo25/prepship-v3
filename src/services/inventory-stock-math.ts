import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { orderItems } from '../db/schema/order-items';
import { orders } from '../db/schema/orders';

export type InventoryLedgerBalanceRow = {
  type?: string | null | undefined;
  orderId?: number | string | null | undefined;
  qty: number | string | null | undefined;
};

export function inventoryLedgerBalance(rows: InventoryLedgerBalanceRow[]): number {
  const shipByOrder = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const qty = Number(row.qty ?? 0);
    if (!Number.isFinite(qty)) continue;

    const type = String(row.type ?? '').toLowerCase();
    const orderId = row.orderId == null ? '' : String(row.orderId).trim();
    if (type === 'ship' && orderId) {
      const current = shipByOrder.get(orderId);
      shipByOrder.set(orderId, current == null ? qty : Math.min(current, qty));
      continue;
    }

    total += qty;
  }

  for (const qty of shipByOrder.values()) total += qty;
  return total;
}

export type EffectiveStockEntry = {
  effectiveStock: number;
  totalReceived: number;
  totalSold: number;
};

export type InventoryStockTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InventoryStockExecutor = typeof db | InventoryStockTransaction;

// PS-133: THE canonical backend effective-stock calculation. All consumers (inventory list,
// dashboard inventory-risk, admin reconcile) delegate here so they can never drift.
//
// effective_stock = SUM(all non-ship ledger rows: receive/adjust/remove/damage/pick/return)
//   + SUM(min(qty) per order_id for ship rows)  — the SQL form of inventoryLedgerBalance().
// Falls back to inventory.stock_qty when an inventory row has no ledger history. total_sold
// prefers ledger ship rows, falling back to shipped order_items.
//
// READ-ONLY over inventory_ledger / inventory / order_items / orders — not the
// shipped/cancelled lockdown surface (no order/shipment rows are mutated).
async function computeEffectiveStockForIdsWithExecutor(
  executor: InventoryStockExecutor,
  inventoryIds: number[],
): Promise<Map<number, EffectiveStockEntry>> {
  const result = new Map<number, EffectiveStockEntry>();
  const ids = [...new Set(inventoryIds.filter((n) => Number.isFinite(n)))];
  if (ids.length === 0) return result;

  type EffectiveRow = {
    inventory_id: number;
    total_received: number;
    total_sold: number;
    effective_stock: number;
  };
  const executed = await executor.execute<EffectiveRow>(sql`
    with ids as (
      select unnest(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[]) as id
    ),
    receives as (
      select l.inventory_id as id, coalesce(sum(l.qty), 0)::int as total_received
      from ${inventoryLedger} l
      where l.inventory_id in (select id from ids)
        and l.type = 'receive'
      group by l.inventory_id
    ),
    ledger_balance as (
      select stock_rows.inventory_id as id, coalesce(sum(stock_rows.qty), 0)::int as effective_stock
      from (
        select l.inventory_id, l.qty
        from ${inventoryLedger} l
        where l.inventory_id in (select id from ids)
          and (l.type <> 'ship' or l.order_id is null)
        union all
        select l.inventory_id, min(l.qty)::int as qty
        from ${inventoryLedger} l
        where l.inventory_id in (select id from ids)
          and l.type = 'ship'
          and l.order_id is not null
        group by l.inventory_id, l.order_id
      ) stock_rows
      group by stock_rows.inventory_id
    ),
    ledger_sells as (
      select ship_rows.inventory_id as id, abs(coalesce(sum(ship_rows.qty), 0))::int as total_sold
      from (
        select l.inventory_id, l.order_id, min(l.qty)::int as qty
        from ${inventoryLedger} l
        where l.inventory_id in (select id from ids)
          and l.type = 'ship'
          and l.order_id is not null
        group by l.inventory_id, l.order_id
      ) ship_rows
      group by ship_rows.inventory_id
    ),
    sells as (
      select i.id as id, coalesce(sum(oi.quantity), 0)::int as total_sold
      from ${inventory} i
      join ${orderItems} oi
        on lower(oi.sku) = lower(i.sku)
      join ${orders} o
        on (
          o.id = oi.order_id
          and (
          (i.client_id is null and o.client_id is null)
          or i.client_id = o.client_id
          )
        )
      where i.id in (select id from ids)
        and oi.quantity > 0
        and o.order_status = 'shipped'
      group by i.id
    )
    select
      ids.id as inventory_id,
      coalesce(receives.total_received, 0)::int as total_received,
      coalesce(ledger_sells.total_sold, sells.total_sold, 0)::int as total_sold,
      coalesce(ledger_balance.effective_stock, ${inventory.stockQty}, 0)::int as effective_stock
    from ids
    left join ${inventory} on ${inventory.id} = ids.id
    left join receives on receives.id = ids.id
    left join ledger_balance on ledger_balance.id = ids.id
    left join ledger_sells on ledger_sells.id = ids.id
    left join sells on sells.id = ids.id
  `);
  // postgres-js returns a row array; PGlite returns the same rows under `.rows`.
  const effectiveRows = Array.isArray(executed)
    ? executed
    : (executed as unknown as { rows?: EffectiveRow[] }).rows ?? [];

  for (const row of effectiveRows) {
    result.set(Number(row.inventory_id), {
      effectiveStock: Number(row.effective_stock) || 0,
      totalReceived: Number(row.total_received) || 0,
      totalSold: Number(row.total_sold) || 0,
    });
  }
  return result;
}

export function computeEffectiveStockForIds(
  inventoryIds: number[],
): Promise<Map<number, EffectiveStockEntry>> {
  return computeEffectiveStockForIdsWithExecutor(db, inventoryIds);
}

export function computeEffectiveStockForIdsInTransaction(
  tx: InventoryStockTransaction,
  inventoryIds: number[],
): Promise<Map<number, EffectiveStockEntry>> {
  return computeEffectiveStockForIdsWithExecutor(tx, inventoryIds);
}
