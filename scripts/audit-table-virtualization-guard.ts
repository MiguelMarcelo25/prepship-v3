import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getVirtualTablePadding,
  shouldVirtualizeTable,
} from '../web/src/components/ui/table-virtualization';

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const packageJson = read('package.json');
const owner = read('web/src/components/ui/table-virtualization.ts');
const table = read('web/src/components/ui/Table.tsx');
const ordersTable = read('web/src/components/Views/OrdersTable.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const ordersShell = read('web/src/components/Views/OrdersResultsShell.tsx');
const inventory = read('web/src/components/Views/InventoryView.tsx');
const ordersBrowser = read('web/e2e/orders-dom-parity.spec.js');
const inventoryBrowser = read('web/e2e/inventory-ux.spec.js');
const doc = read('docs/ps-tickets/audit-5.4-table-virtualization.md');
const audit = read('AUDIT-2026-07-13.md');

assert.match(packageJson, /"@tanstack\/react-virtual"/);
assert.match(packageJson, /"test:audit-table-virtualization"/);
assert.match(packageJson, /"test:audit-table-virtualization:browser"/);

assert.equal(shouldVirtualizeTable(40), false, 'small tables keep the legacy DOM path');
assert.equal(shouldVirtualizeTable(41), true, 'large tables activate virtualization');
assert.deepEqual(
  getVirtualTablePadding([{ start: 120, end: 180 }, { start: 300, end: 360 }], 1_000),
  { paddingTop: 120, paddingBottom: 640 },
  'spacer rows preserve the full scroll range around the rendered window',
);
assert.deepEqual(getVirtualTablePadding([], 1_000), { paddingTop: 0, paddingBottom: 0 });

assert.match(owner, /TABLE_VIRTUALIZATION_THRESHOLD\s*=\s*40/);
assert.match(owner, /export function shouldVirtualizeTable/);
assert.match(owner, /export function getVirtualTablePadding/);

for (const source of [table, ordersTable]) {
  assert.match(source, /useVirtualizer/);
  assert.match(source, /shouldVirtualizeTable/);
  assert.match(source, /getVirtualTablePadding/);
  assert.match(source, /measureElement/);
  assert.match(source, /data-index/);
}

assert.match(ordersView, /ordersScrollRef/);
assert.match(ordersShell, /scrollRef/);
assert.match(ordersTable, /scrollElementRef/);
assert.match(ordersTable, /scrollToIndex/);
assert.match(ordersTable, /isReadOnly \? null/);
assert.match(inventory, /<Table[\s\S]*?virtualized[\s\S]*?storageKey="inventory-stock-levels"|storageKey="inventory-stock-levels"[\s\S]*?virtualized/);
assert.match(ordersBrowser, /virtualizes large Orders pages and reaches the final loaded row/);
assert.match(ordersBrowser, /mountedRows\.count\(\)\)\.toBeLessThan\(50\)/);
assert.match(inventoryBrowser, /virtualizes large Inventory pages and reaches the final loaded row/);
assert.match(inventoryBrowser, /mountedRows\.count\(\)\)\.toBeLessThan\(40\)/);

for (const field of [
  'Business rule/workflow being changed',
  'Canonical backend/domain/read-model/policy owner',
  'Current duplicated/unsafe owners',
  'Where bad/stale/incomplete data can enter',
  'Callers that must delegate to the owner',
  'Wrapper/resolver/helper logic to delete or explicitly forbid',
  'Frontend role: display/action only; no authoritative business logic',
  'Backend boundary tests required',
  'Workflow/UI proof required',
]) {
  assert.ok(doc.includes(field), `placement record includes ${field}`);
}

assert.match(audit, /- \[x\] 5\.4 \*\*Orders and Inventory table virtualization complete\*\*/);

console.log('PASS Audit 5.4 table virtualization guard');
