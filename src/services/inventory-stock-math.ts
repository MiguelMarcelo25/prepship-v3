export type InventoryLedgerBalanceRow = {
  qty: number | string | null | undefined;
};

export function inventoryLedgerBalance(rows: InventoryLedgerBalanceRow[]): number {
  return rows.reduce((sum, row) => {
    const qty = Number(row.qty ?? 0);
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);
}
