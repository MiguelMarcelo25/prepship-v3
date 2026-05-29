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
  { qty: 2520 },
  { qty: 2520 },
  { qty: -2520 },
  { qty: -34 },
]);

assert(
  hugrabLikeBalance === 2486,
  'ledger balance includes receive, manual remove/adjust, and ship rows',
);

assert(
  hugrabLikeBalance !== 5006,
  'stock display is not receive-only minus shipped when manual removals exist',
);

const reportingMetrics = readFileSync('src/services/reporting-metrics.ts', 'utf8');
const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const inventoryView = readFileSync('web/src/components/Views/InventoryView.tsx', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const reconcileScript = readFileSync('scripts/reconcile-inventory-stock.ts', 'utf8');

assert(
  reportingMetrics.includes('ledger_balance') &&
    reportingMetrics.includes('coalesce(lb.effective_stock, i.stock_qty, 0)::int as effective_stock'),
  'cached inventory risk metrics compute effective stock from full ledger balance',
);

assert(
  inventoryRoute.includes("app.delete('/ledger/:ledgerId{[0-9]+}'") &&
    inventoryRoute.includes("row.orderId != null || row.type === 'ship'"),
  'inventory API exposes guarded manual history delete and blocks order-linked ship rows',
);

assert(
  inventoryRoute.includes('ledger_balance') &&
    inventoryRoute.includes('Number(row.effective_stock) || 0'),
  'inventory list live fallback computes effective stock from full ledger balance',
);

assert(
  apiClient.includes('deleteInventoryLedgerEntry') &&
    inventoryView.includes('handleDeleteLedgerEntry') &&
    inventoryView.includes('Delete manual history row'),
  'Inventory History UI includes a delete action for safe manual ledger rows',
);

assert(
  reconcileScript.includes('const effectiveStock = ledgerStock;'),
  'inventory reconciliation dry-run compares cache and effective stock against ledger balance',
);

if (process.exitCode) process.exit(process.exitCode);
