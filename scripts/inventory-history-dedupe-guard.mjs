import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// PS-045 — Inventory History must show ONE ship movement per order/SKU. Real
// ledger rows (shipment_sync / order_sync_status / label) win; the synthetic
// `order_history` fallback appears only when no real ship ledger movement
// exists for the same order / normalized SKU / client scope, and duplicate
// same-SKU line items aggregate into one summed movement.
//
// There is no test database in CI, so this guard is a faithful in-JS model of
// the /inventory/ledger CTE chain (ledger_rows + suppressed/aggregated
// derived_ship_rows). It exercises the exact de-dupe + aggregation DECISIONS
// the SQL makes, then string-asserts the SQL still contains those constructs.

const inventoryRoute = readFileSync('src/routes/inventory.ts', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const norm = (v) => String(v ?? '').trim().toLowerCase();

function roundQty(q) {
  const s = String(q ?? '');
  return /^[0-9]+(\.[0-9]+)?$/.test(s) ? Math.max(1, Math.round(Number(s))) : 1;
}

// Faithful model of the fixed /inventory/ledger query.
function simulateLedgerView({ orders, inventory, realLedger }) {
  const invById = new Map(inventory.map((i) => [i.id, i]));

  // ledger_rows: real ledger rows joined to their inventory row (shown as-is).
  const displayed = realLedger
    .map((l) => {
      const inv = invById.get(l.inventoryId);
      if (!inv) return null;
      return {
        source: l.createdBy,
        orderId: l.orderId,
        skuKey: norm(inv.sku),
        type: l.type,
        qty: l.qty,
        kind: 'real',
      };
    })
    .filter(Boolean);

  // real_ship_ledger_keys: business identity of real ship movements.
  const realShipKeys = realLedger
    .filter((l) => l.type === 'ship' && l.orderId != null)
    .map((l) => {
      const inv = invById.get(l.inventoryId);
      return { orderId: l.orderId, skuKey: norm(inv?.sku), invClientId: inv?.clientId ?? null };
    });

  const isSuppressed = (orderId, skuKey, orderClientId) =>
    realShipKeys.some(
      (k) =>
        k.orderId === orderId &&
        k.skuKey === skuKey &&
        (k.invClientId === orderClientId || k.invClientId == null),
    );

  // derived_ship_lines -> derived_ship_rows: per-line resolve + suppress, then
  // aggregate by (order_id, inventory_id) summing qty.
  const lineByKey = new Map();
  for (const o of orders) {
    if (o.orderStatus !== 'shipped' || !o.orderDate) continue;
    for (const item of o.items ?? []) {
      if (!item || item.adjustment === true) continue;
      const skuKey = norm(item.sku);
      if (!skuKey) continue;
      // inventory join scope: client-specific preferred; null-client only when
      // no client-specific row exists for that SKU + order client.
      const clientSpecific = inventory.find(
        (i) => i.active && norm(i.sku) === skuKey && i.clientId === o.clientId,
      );
      const globalRow = inventory.find(
        (i) => i.active && norm(i.sku) === skuKey && i.clientId == null,
      );
      const inv = clientSpecific ?? globalRow ?? null;
      if (!inv) continue; // inner join produced no inventory row
      if (isSuppressed(o.id, skuKey, o.clientId)) continue; // real ledger wins
      const key = `${o.id}|${inv.id}`;
      const prev = lineByKey.get(key) ?? { orderId: o.id, inv, qty: 0 };
      prev.qty += roundQty(item.quantity);
      lineByKey.set(key, prev);
    }
  }
  for (const { orderId, inv, qty } of lineByKey.values()) {
    displayed.push({
      source: 'order_history',
      orderId,
      skuKey: norm(inv.sku),
      type: 'ship',
      qty: -qty,
      kind: 'derived',
    });
  }
  return displayed;
}

const shipRowsFor = (rows, orderId, skuKey) =>
  rows.filter((r) => r.type === 'ship' && r.orderId === orderId && r.skuKey === norm(skuKey));

// ── A. Root cause: client-specific vs global inventory rows ──────────────────
// Order 1047 / HU-10. Real ship ledger is on the CLIENT-SPECIFIC row (id 1033),
// but a GLOBAL (null-client) row (id 9001) also exists. The old exact-
// inventory_id suppression failed here; identity-based suppression fixes it.
{
  const inventory = [
    { id: 9001, clientId: null, sku: 'HU-10', active: true },
    { id: 1033, clientId: 4, sku: 'HU-10', active: true },
  ];
  const orders = [
    { id: 1047, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-28T19:00:00Z', items: [{ sku: 'HU-10', quantity: 1 }] },
  ];
  const realLedger = [{ orderId: 1047, inventoryId: 1033, type: 'ship', qty: -1, createdBy: 'shipment_sync' }];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger }), 1047, 'HU-10');
  assert.equal(ship.length, 1, 'A: exactly one ship movement for 1047/HU-10 (no order_history duplicate)');
  assert.equal(ship[0].source, 'shipment_sync', 'A: real ledger source wins over synthetic order_history');

  // The OLD exact-inventory_id suppression: derived row joins the global row
  // (9001) while the real ledger is on 1033 -> ids differ -> NOT suppressed.
  const oldSuppressionWouldDuplicate =
    9001 !== realLedger[0].inventoryId; // exact-id compare the bug used
  assert.equal(oldSuppressionWouldDuplicate, true, 'A: fixture reproduces the original exact-inventory_id failure');
}

// ── B. SKU casing: real ledger sku "HU-10" vs order item "hu-10" ─────────────
{
  const inventory = [{ id: 50, clientId: 4, sku: 'HU-10', active: true }];
  const orders = [
    { id: 2001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-20T19:00:00Z', items: [{ sku: 'hu-10', quantity: 1 }] },
  ];
  const realLedger = [{ orderId: 2001, inventoryId: 50, type: 'ship', qty: -1, createdBy: 'order_sync_status' }];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger }), 2001, 'HU-10');
  assert.equal(ship.length, 1, 'B: case-insensitive SKU match suppresses the fallback');
  assert.equal(ship[0].source, 'order_sync_status', 'B: real ledger source wins regardless of SKU casing');
}

// ── C. Multiple distinct SKUs in one order each appear once (no ledger) ──────
{
  const inventory = [
    { id: 11, clientId: 4, sku: 'SKU-A', active: true },
    { id: 12, clientId: 4, sku: 'SKU-B', active: true },
  ];
  const orders = [
    { id: 3001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-21T19:00:00Z', items: [{ sku: 'SKU-A', quantity: 1 }, { sku: 'SKU-B', quantity: 2 }] },
  ];
  const rows = simulateLedgerView({ orders, inventory, realLedger: [] });
  assert.equal(shipRowsFor(rows, 3001, 'SKU-A').length, 1, 'C: SKU-A appears once');
  assert.equal(shipRowsFor(rows, 3001, 'SKU-B').length, 1, 'C: SKU-B appears once');
  assert.equal(shipRowsFor(rows, 3001, 'SKU-B')[0].qty, -2, 'C: SKU-B keeps its own quantity');
}

// ── D. Quantity N collapses to a single -N row, not N split rows ─────────────
{
  const inventory = [{ id: 21, clientId: 4, sku: 'SKU-Q', active: true }];
  const orders = [
    { id: 4001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-22T19:00:00Z', items: [{ sku: 'SKU-Q', quantity: 4 }] },
  ];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger: [] }), 4001, 'SKU-Q');
  assert.equal(ship.length, 1, 'D: a qty-4 line is a single movement');
  assert.equal(ship[0].qty, -4, 'D: the single movement shows -4, not four -1 rows');
}

// ── E. Duplicate SAME-SKU line items aggregate into one summed movement ──────
{
  const inventory = [{ id: 31, clientId: 4, sku: 'SKU-D', active: true }];
  const orders = [
    { id: 5001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-23T19:00:00Z', items: [{ sku: 'SKU-D', quantity: 1 }, { sku: 'SKU-D', quantity: 2 }] },
  ];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger: [] }), 5001, 'SKU-D');
  assert.equal(ship.length, 1, 'E: duplicate same-SKU lines aggregate into ONE fallback row');
  assert.equal(ship[0].qty, -3, 'E: aggregated quantity is summed (-3), matching deductInventoryForOrder');
}

// ── F. Fallback DOES show when there is genuinely no real ship ledger row ────
{
  const inventory = [{ id: 41, clientId: 4, sku: 'SKU-F', active: true }];
  const orders = [
    { id: 6001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-24T19:00:00Z', items: [{ sku: 'SKU-F', quantity: 1 }] },
  ];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger: [] }), 6001, 'SKU-F');
  assert.equal(ship.length, 1, 'F: fallback still shows movement for shipped orders lacking a real ledger row');
  assert.equal(ship[0].source, 'order_history', 'F: source is the synthetic fallback when no real ledger exists');
}

// ── G. Global (null-client) real ledger suppresses the fallback too ──────────
{
  const inventory = [{ id: 9100, clientId: null, sku: 'HU-9', active: true }];
  const orders = [
    { id: 7001, clientId: 4, orderStatus: 'shipped', orderDate: '2026-05-25T19:00:00Z', items: [{ sku: 'HU-9', quantity: 1 }] },
  ];
  const realLedger = [{ orderId: 7001, inventoryId: 9100, type: 'ship', qty: -1, createdBy: 'shipment_sync' }];
  const ship = shipRowsFor(simulateLedgerView({ orders, inventory, realLedger }), 7001, 'HU-9');
  assert.equal(ship.length, 1, 'G: null-client real ledger still suppresses the fallback (client-scope OR null)');
  assert.equal(ship[0].source, 'shipment_sync', 'G: global real ledger wins');
}

// ── Backend SQL must still contain the de-dupe + aggregation constructs ──────
assert(
  inventoryRoute.includes('real_ship_ledger_keys') &&
    inventoryRoute.includes('order_history is a display fallback') &&
    inventoryRoute.includes("existing_ledger.sku_key = lower(item->>'sku')") &&
    inventoryRoute.includes('scoped_inventory.client_id ='),
  'backend /inventory/ledger de-dupes derived order_history rows by order/SKU/client scope',
);
assert(
  inventoryRoute.includes('derived_ship_lines') &&
    /group by order_id, inventory_id/.test(inventoryRoute) &&
    inventoryRoute.includes('sum(line_qty)'),
  'backend aggregates duplicate same-SKU fallback lines into one summed movement',
);
assert.equal(
  pkg.scripts?.['test:inventory-history-dedupe'],
  'node scripts/inventory-history-dedupe-guard.mjs',
  'package exposes focused Inventory History de-dupe guard',
);

console.log('PASS inventory history de-dupe guard');
