/**
 * Audit 3.9 / FE-7: one scoped backend snapshot for bulk order actions.
 * Offline only: no DB, providers, labels, notifications, or mutations.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOrderBulkSnapshotDto } from '../src/services/orders-read-model';

const snapshot = buildOrderBulkSnapshotDto(
  [3, 1, 3, 2],
  [
    { id: 2, marker: 'two' },
    { id: 1, marker: 'one' },
  ],
);
assert.deepEqual(snapshot.data.map((row) => row.id), [1, 2], 'rows must follow requested-ID order');
assert.equal(snapshot.requested, 3, 'duplicate request IDs must count once');
assert.equal(snapshot.returned, 2);
assert.deepEqual(snapshot.missingOrderIds, [3], 'missing or out-of-scope IDs must be explicit');
assert.strictEqual(snapshot.orders, snapshot.data, 'orders/data aliases must share the canonical DTO rows');

const route = readFileSync('src/routes/orders.ts', 'utf8');
const client = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const view = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

const sharedStart = route.indexOf('async function ordersListResponse(');
const sharedEnd = route.indexOf("app.get('/', zValidator('query', listQuery)", sharedStart);
const sharedList = route.slice(sharedStart, sharedEnd);
assert.ok(sharedStart >= 0 && sharedEnd > sharedStart, 'shared Orders read-model response function must exist');
assert.match(sharedList, /orderScopePredicate\(orderScope\)/, 'snapshot must retain tenant/client/store scope');
assert.match(sharedList, /assigneeFilter/, 'snapshot must retain order-assignment visibility');
assert.match(sharedList, /requestedOrderIds \? inArray\(orders\.id, requestedOrderIds\)/,
  'snapshot must constrain the shared query to requested IDs');
assert.match(sharedList, /buildOrderBulkSnapshotDto\(requestedOrderIds, rows\)/,
  'shared read path must delegate snapshot ordering/completeness to the read-model owner');

const endpointStart = route.indexOf("app.post('/bulk-snapshot'");
const endpointEnd = route.indexOf('type LatestShipmentRow', endpointStart);
const endpoint = route.slice(endpointStart, endpointEnd);
assert.ok(endpointStart >= 0 && endpointEnd > endpointStart, 'bulk snapshot endpoint must exist');
assert.match(route, /orderIds: z\.array\(z\.number\(\)\.int\(\)\.positive\(\)\)\.min\(1\)\.max\(5000\)/,
  'snapshot input must be positive IDs bounded by the existing selection ceiling');
assert.match(endpoint, /ordersListResponse\(c, \{[\s\S]*includeTotal: false[\s\S]*\}, orderIds\)/,
  'route must remain a thin delegate to the existing canonical list DTO pipeline');
assert.doesNotMatch(endpoint, /assertOrderEditable|\.insert\(|\.update\(|\.delete\(/,
  'read-only snapshot route must not contain mutation or edit-lock logic');
assert.match(route, /Per user override unlock shipped data on 2026-07-14: this read-only endpoint/);

const fetchSnapshotsStart = client.indexOf('async fetchOrderSnapshots(');
const fetchMatchingStart = client.indexOf('async fetchMatchingOrdersForSelection(', fetchSnapshotsStart);
const fetchFullStart = client.indexOf('fetchOrderFull(', fetchMatchingStart);
const fetchSnapshots = client.slice(fetchSnapshotsStart, fetchMatchingStart);
const fetchMatching = client.slice(fetchMatchingStart, fetchFullStart);
assert.match(fetchSnapshots, /api\.post[\s\S]*'\/orders\/bulk-snapshot'/,
  'frontend transport must call the single backend snapshot endpoint');
assert.match(fetchMatching, /fetchMatchingOrderIds/);
assert.match(fetchMatching, /fetchOrderSnapshots\(matching\.ids\)/);
assert.doesNotMatch(fetchMatching, /for \(let page|fetchOrders\(/,
  'matching hydration must not replay sequential full-order pages');

const hydrateStart = view.indexOf('const hydrateSelectedOrdersForActions');
const hydrateEnd = view.indexOf('function clearSelection()', hydrateStart);
const hydrate = view.slice(hydrateStart, hydrateEnd);
assert.match(hydrate, /fetchOrderSnapshots\(missingIds\)/,
  'selected actions must request only missing selected IDs');
assert.doesNotMatch(hydrate, /fetchMatchingOrdersForSelection|fetchOrders\(/,
  'selected hydration must not reload the entire filtered result set');

assert.match(packageJson, /"test:audit-orders-bulk-snapshot"/);
assert.match(guardPack, /'test:audit-orders-bulk-snapshot'/);

console.log('PASS Audit 3.9 Orders bulk-snapshot guard');
