import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildQueueAddPayload,
  groupPrintQueueEntries,
  type PrintQueueEntryDto,
} from '../web/src/components/Views/orders-parity';

function queuedEntry(overrides: Partial<PrintQueueEntryDto>): PrintQueueEntryDto {
  return {
    queue_entry_id: overrides.queue_entry_id ?? crypto.randomUUID(),
    order_id: overrides.order_id ?? '1',
    order_number: overrides.order_number ?? null,
    client_id: overrides.client_id ?? 11,
    label_url: overrides.label_url ?? 'https://example.com/label.pdf',
    sku_group_id: overrides.sku_group_id ?? 'SKU:UNKNOWN',
    primary_sku: overrides.primary_sku ?? null,
    item_description: overrides.item_description ?? null,
    order_qty: overrides.order_qty ?? 1,
    multi_sku_data: overrides.multi_sku_data ?? null,
    status: overrides.status ?? 'queued',
    print_count: overrides.print_count ?? 0,
    last_printed_at: overrides.last_printed_at ?? null,
    queued_at: overrides.queued_at ?? '2026-06-01T12:00:00.000Z',
  };
}

const singleBooster = queuedEntry({
  queue_entry_id: 'single-booster-x2',
  order_id: '9001',
  sku_group_id: 'SKU:Booster-gel-001',
  primary_sku: 'Booster-gel-001',
  item_description: 'Booster Gel',
  order_qty: 2,
});

const comboBoosterHu10 = queuedEntry({
  queue_entry_id: 'combo-booster-hu10-a',
  order_id: '1149',
  sku_group_id: 'SKU:Booster-gel-001',
  primary_sku: 'Booster-gel-001',
  item_description: 'Booster Gel',
  order_qty: 2,
  multi_sku_data: [
    { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
    { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
  ],
});

const duplicateCombo = queuedEntry({
  queue_entry_id: 'combo-booster-hu10-b',
  order_id: '1150',
  sku_group_id: 'SKU:Booster-gel-001',
  primary_sku: 'Booster-gel-001',
  item_description: 'Booster Gel',
  order_qty: 2,
  multi_sku_data: [
    { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
    { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
  ],
});

const duplicateSkuLines = queuedEntry({
  queue_entry_id: 'combo-duplicate-sku-lines',
  order_id: '1151',
  sku_group_id: 'SKU:Booster-gel-001',
  primary_sku: 'Booster-gel-001',
  item_description: 'Booster Gel',
  order_qty: 4,
  multi_sku_data: [
    { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 2 },
    { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
    { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
  ],
});

const groups = groupPrintQueueEntries([singleBooster, comboBoosterHu10, duplicateCombo]);

assert.equal(
  groups.length,
  2,
  'Booster x2 must not group with Booster x1 + HU-10 x1 even when stale sku_group_id matches first SKU',
);

const comboGroup = groups.find((group) => group.orders.some((entry) => entry.order_id === '1149'));
assert.ok(comboGroup, 'multi-SKU combo group should exist');
assert.equal(comboGroup.orders.length, 2, 'identical SKU+qty combos should merge regardless of input line order');
assert.match(comboGroup.groupId, /^COMBO:booster-gel-001:1\|hu-10:1\|qty:2$/);
assert.deepEqual(
  comboGroup.skuLines?.map((line) => `${line.sku} x${line.qty}`),
  ['Booster-gel-001 x1', 'HU-10 x1'],
  'multi-SKU group should expose one visible SKU+qty line per unique SKU',
);
assert.equal(comboGroup.isMultiSku, true, 'combo group should be flagged as multi-SKU for bordered Batch Header rendering');
assert.ok(comboGroup.searchText.includes('hu-10'), 'search text should include non-primary SKUs like HU-10');

const collapsedGroup = groupPrintQueueEntries([duplicateSkuLines])[0];
assert.deepEqual(
  collapsedGroup.skuLines?.map((line) => `${line.sku} x${line.qty}`),
  ['Booster-gel-001 x3', 'HU-10 x1'],
  'duplicate SKU lines should collapse before display/header rendering',
);

const payload = buildQueueAddPayload({
  orderId: 1149,
  orderNumber: '1149',
  clientId: 11,
  items: [
    { sku: 'Booster-gel-001', name: 'Booster Gel', quantity: 1 },
    { sku: 'HU-10', name: 'Leeds Line V2', quantity: 1 },
  ],
} as any, 'https://example.com/1149.pdf');

assert.equal(payload.sku_group_id, 'COMBO:booster-gel-001:1|hu-10:1');
assert.deepEqual(
  payload.multi_sku_data,
  [
    { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
    { sku: 'HU-10', description: 'Leeds Line V2', qty: 1 },
  ],
  'queue add payload should persist collapsed multi_sku_data with every SKU and qty',
);

const ordersViewSource = fs.readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
assert.match(
  ordersViewSource,
  /border border-brand\/35 bg-brand\/5/,
  'Print Queue UI should render bordered SKU+qty chips for multi-SKU groups',
);
assert.match(
  ordersViewSource,
  /group\.searchText\.includes\(pqSearchLower\)/,
  'Print Queue search should include normalized all-SKU group search text',
);
assert.match(
  ordersViewSource,
  /Search order #, ID, SKU/,
  'Print Queue search placeholder should tell operators SKU search is supported',
);

const printQueueServiceSource = fs.readFileSync('src/services/print-queue.ts', 'utf8');
assert.match(
  printQueueServiceSource,
  /page\.drawRectangle\(\{[\s\S]*borderColor:[\s\S]*borderWidth:[\s\S]*chipText/,
  'PDF Batch Header should draw a bordered block for each multi-SKU SKU+qty line',
);
assert.match(
  printQueueServiceSource,
  /const isMultiSkuHeader = skuLines\.length > 1/,
  'PDF Batch Header should apply bordered chip treatment only to multi-SKU groups',
);

console.log('PS-063 print queue SKU grouping guard passed');
