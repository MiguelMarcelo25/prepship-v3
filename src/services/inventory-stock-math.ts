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
