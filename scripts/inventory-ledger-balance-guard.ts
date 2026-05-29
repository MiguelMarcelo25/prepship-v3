import { readFileSync } from 'node:fs';
import { inventoryLedgerBalance } from '../src/services/inventory-stock-math';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const hugrabLikeBalance = inventoryLedgerBalance([
  { type: 'receive', qty: 2520 },
  { type: 'receive', qty: 2520 },
  { type: 'adjust', qty: -2520 },
  { type: 'ship', orderId: 1046, qty: -4 },
  { type: 'ship', orderId: 1046, qty: -4 },
  { type: 'ship', orderId: 1045, qty: -4 },
  { type: 'ship', orderId: 1042, qty: -2 },
  { type: 'ship', orderId: 1042, qty: -2 },
  { type: 'ship', orderId: 1036, qty: -1 },
  { type: 'ship', orderId: 1036, qty: -1 },
  { type: 'ship', orderId: 1034, qty: -1 },
  { type: 'ship', orderId: 1033, qty: -2 },
  { type: 'ship', orderId: 1033, qty: -2 },
  { type: 'ship', orderId: 1030, qty: -1 },
  { type: 'ship', orderId: 1030, qty: -1 },
  { type: 'ship', orderId: 1028, qty: -2 },
  { type: 'ship', orderId: 1028, qty: -2 },
  { type: 'ship', orderId: 1026, qty: -1 },
  { type: 'ship', orderId: 1026, qty: -1 },
  { type: 'ship', orderId: 1023, qty: -1 },
  { type: 'ship', orderId: 1023, qty: -1 },
  { type: 'ship', orderId: 1022, qty: -2 },
  { type: 'ship', orderId: 1019, qty: -1 },
  { type: 'ship', orderId: 1018, qty: -2 },
  { type: 'ship', orderId: 1018, qty: -2 },
  { type: 'ship', orderId: 1017, qty: -1 },
  { type: 'ship', orderId: 1017, qty: -1 },
  { type: 'ship', orderId: 1016, qty: -2 },
  { type: 'ship', orderId: 1016, qty: -2 },
  { type: 'ship', orderId: 1012, qty: -2 },
  { type: 'ship', orderId: 1012, qty: -2 },
  { type: 'ship', orderId: 1010, qty: -2 },
  { type: 'ship', orderId: 1010, qty: -2 },
  { type: 'ship', orderId: 1006, qty: -1 },
  { type: 'ship', orderId: 1006, qty: -1 },
  { type: 'ship', orderId: 1005, qty: -1 },
  { type: 'ship', orderId: 1005, qty: -1 },
  { type: 'ship', orderId: 1004, qty: -1 },
  { type: 'ship', orderId: 1004, qty: -1 },
]);

const hu10LikeBalance = inventoryLedgerBalance([
  { type: 'receive', qty: 1680 },
  { type: 'ship', orderId: 1044, qty: -1 },
  { type: 'ship', orderId: 1044, qty: -1 },
  { type: 'ship', orderId: 1043, qty: -1 },
  { type: 'ship', orderId: 1042, qty: -1 },
]);

assert(
  hu10LikeBalance === 1677,
  'HU-10-style ledger balance counts order-linked duplicate ship rows once per order',
);

assert(
  hugrabLikeBalance === 2486,
  'ledger balance includes receive, manual remove/adjust, and one ship deduction per order/SKU',
);

assert(
  hugrabLikeBalance !== 5006,
  'stock display is not receive-only minus shipped or duplicate sync rows when manual removals exist',
);

const reportingMetrics = readFileSync('src/services/reporting-metrics.ts', 'utf8');
const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const inventoryView = readFileSync('web/src/components/Views/InventoryView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const reconcileScript = readFileSync('scripts/reconcile-inventory-stock.ts', 'utf8');

assert(
  reportingMetrics.includes('ledger_balance') &&
    reportingMetrics.includes('ledger_sold') &&
    reportingMetrics.includes('coalesce(ls.total_sold_all_time, s.total_sold_all_time, 0)::int as total_sold_all_time') &&
    reportingMetrics.includes('coalesce(lb.effective_stock, i.stock_qty, 0)::int as effective_stock'),
  'cached inventory risk metrics compute sold and effective stock from full ledger balance',
);

assert(
  inventoryRoute.includes("app.delete('/ledger/:ledgerId{[0-9]+}'") &&
    inventoryRoute.includes("row.orderId != null || row.type === 'ship'"),
  'inventory API exposes guarded manual history delete and blocks order-linked ship rows',
);

assert(
  inventoryRoute.includes('ledger_balance') &&
    inventoryRoute.includes('const effectiveRows = rows.length') &&
    inventoryRoute.includes('ledger_sells') &&
    inventoryRoute.includes('soldByInventoryId.get(row.id) ?? metric.soldLast30Days') &&
    inventoryRoute.includes('Number(row.effective_stock) || 0'),
  'inventory list computes visible-row stock and sold metrics from the deduped ledger balance',
);

assert(
  inventoryRoute.includes('real_ship_ledger_keys') &&
    inventoryRoute.includes('order_history is a display fallback') &&
    inventoryRoute.includes("existing_ledger.sku_key = lower(item->>'sku')") &&
    inventoryRoute.includes('scoped_inventory.client_id ='),
  'Inventory History suppresses synthetic order_history rows when a real ship ledger exists for the same order/SKU/client scope',
);

assert(
  apiClient.includes('deleteInventoryLedgerEntry') &&
    inventoryView.includes('handleDeleteLedgerEntry') &&
    inventoryView.includes('Delete manual history row'),
  'Inventory History UI includes a delete action for safe manual ledger rows',
);

assert(
  inventoryView.includes('ledgerDeleteModal') &&
    inventoryView.includes('confirmDeleteLedgerEntry') &&
    inventoryView.includes('This will remove the manual inventory movement and reverse its stock impact.'),
  'Inventory History delete uses an in-app confirmation modal before mutating stock',
);

assert(
  inventoryView.includes('<Table<InventoryLedgerEntryDto>') &&
    inventoryView.includes('storageKey="inventory-history-table"') &&
    inventoryView.includes('columns={historyColumns}'),
  'Inventory History uses the shared resizable/reorderable Table component',
);

assert(
  reconcileScript.includes('const effectiveStock = ledgerStock;') &&
    reconcileScript.includes('ledger_sold'),
  'inventory reconciliation dry-run compares cache, sold, and effective stock against ledger balance',
);

if (process.exitCode) process.exit(process.exitCode);
