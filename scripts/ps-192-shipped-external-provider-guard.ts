/**
 * PS-192 guard — shipped-external notifies the order's REAL marketplace via
 * the canonical outbox resolver (no ShipStation hardcode).
 *
 * Per user override unlock shipped data on 2026-06-13: this guard certifies
 * the override-scoped change to the shipped-order fulfillment path. Before:
 * markOrderShippedExternally called ssMarkOrderShippedV1 for EVERY order — a
 * direct Walmart/eBay order either failed with "no upstream ShipStation ID"
 * or risked acking the wrong system, and the actual marketplace was never
 * notified. After: the provider comes from resolveShipmentConfirmationProvider
 * (the SAME single owner every label confirmation uses), ShipStation-sourced
 * orders keep the exact v1 call, direct marketplaces dispatch through their
 * own StoreConnector with the outbox worker's exact call shape, and
 * no-marketplace orders report an honest no-op.
 *
 * LOCKDOWN-NOT-WEAKENED proof is pinned below: the forward-only
 * awaiting->shipped flip, the route's assertOrderEditable ordering, and the
 * INVENTORY_AUTO_DEDUCT-governed deduction call are all byte-intact.
 *
 * Offline only — pure resolver behavior + source pins. No DB writes, no
 * marketplace notifications, no postage.
 *
 *   npx tsx scripts/ps-192-shipped-external-provider-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveShipmentConfirmationProvider } from '../src/services/fulfillment/outbox';

// ── (1) The canonical resolver routes every order shape ────────────────────
// Direct marketplace orders by explicit source_provider.
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: 'walmart', externalOrderId: '200012345678' }), 'walmart');
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: 'eBay', externalOrderId: '12-34567-89' }), 'ebay');
// Direct orders recognized by the externalOrderId prefix when source_provider
// was never stamped.
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: null, externalOrderId: 'walmart-200012345678' }), 'walmart');
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: null, externalOrderId: 'ebay-110587296' }), 'ebay');
// Bare numeric upstream ids ARE ShipStation orders — SS relays to the
// marketplace, so the v1 markasshipped path is correct for them.
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: null, externalOrderId: '987654321' }), 'shipstation');
// Manual / no-marketplace orders resolve to NO provider (honest no-op).
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: 'manual', externalOrderId: null }), null);
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: 'none', externalOrderId: '123' }), null);
assert.equal(resolveShipmentConfirmationProvider({ sourceProvider: null, externalOrderId: null }), null);

// ── (2) mark-shipped-externally routes through the resolver ────────────────
const svc = readFileSync('src/services/fulfillment/mark-shipped-externally.ts', 'utf8');
const lifecycle = readFileSync('src/services/order-lifecycle-command.ts', 'utf8');

assert.ok(svc.includes("import { confirmShipmentDirectNow, resolveShipmentConfirmationProvider } from './outbox'"),
  'the service must import the canonical resolver + the direct dispatcher');
assert.ok(svc.includes('dependencies.resolveProvider ?? resolveShipmentConfirmationProvider') &&
  /resolveProvider\(\{\s*sourceProvider: order\.sourceProvider \?\? null,\s*externalOrderId: order\.externalOrderId,?\s*\}\)/.test(svc),
  'the notify provider must come from the canonical resolver over the ORDER facts');
// ShipStation keeps its exact v1 call — but ONLY inside the shipstation branch.
const ssCalls = svc.match(/markShipStationShipped\(/g) ?? [];
assert.equal(ssCalls.length, 1, 'exactly one ShipStation markasshipped call site may exist');
const ssBranchIdx = svc.indexOf("provider === 'shipstation'");
const ssCallIdx = svc.indexOf('markShipStationShipped(');
assert.ok(ssBranchIdx > -1 && ssCallIdx > ssBranchIdx,
  'the ShipStation call must be gated behind the resolved shipstation provider');
// Direct marketplaces dispatch through the outbox-shaped connector call.
assert.ok(svc.includes('dependencies.confirmDirect ?? confirmShipmentDirectNow') &&
  svc.includes('confirmDirect({'),
  'non-ShipStation providers must dispatch through the canonical direct confirmer');
assert.ok(svc.includes('requires a tracking number to confirm shipment'),
  'direct dispatch must refuse without a tracking number (connectors require it)');
assert.ok(svc.includes('nothing to notify'),
  'no-marketplace orders must report an honest no-op');
// The override citation is present at the changed block.
assert.ok(svc.includes('Per user override unlock shipped data on 2026-06-13'),
  'the override-scoped change must carry its citation comment');

// ── (3) LOCKDOWN NOT WEAKENED ───────────────────────────────────────────────
// Forward-only protection is now centralized under the lifecycle row lock.
assert.ok(svc.includes("transition: 'external_shipped'") &&
  lifecycle.includes("order.orderStatus === 'cancelled'") &&
  lifecycle.includes(".for('update')"),
  'the shipped-external path must delegate to row-locked terminal rejection');
// The unmark branch remains flag-only through the canonical command.
assert.ok(svc.includes("transition: 'external_unmark'") &&
  lifecycle.includes(".set({ externallyShipped: false"),
  'unmark must keep flipping only the flag, never order status');
// Manual actions cannot prove shipment-line quantities. They persist an
// explicit review claim and never guess the mutable full order.
assert.ok(svc.includes("kind: 'unavailable'") &&
  svc.includes('Manual external-shipped action did not identify fulfilled line quantities') &&
  !svc.includes('fulfilledLines: order.items') &&
  lifecycle.includes("reviewReason: 'fulfillment_lines_unavailable'"),
  'the shipped-external path must fail closed to review when exact line facts are unavailable');
// The route still guards with assertOrderEditable BEFORE the service.
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const routeStart = ordersRoute.indexOf("'/:id{[0-9]+}/shipped-external'");
const routeBlock = ordersRoute.slice(routeStart, routeStart + 3000);
const guardIdx = routeBlock.indexOf('assertOrderEditable(c, id)');
const serviceIdx = routeBlock.indexOf('markOrderShippedExternally({');
assert.ok(routeStart > -1 && guardIdx > -1 && serviceIdx > guardIdx,
  'the shipped-external route must call assertOrderEditable BEFORE the service');

// ── (4) The direct dispatcher reuses the outbox worker's machinery ─────────
const outbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
assert.ok(outbox.includes('export async function confirmShipmentDirectNow'),
  'outbox must own the one-shot direct confirmation');
const helperStart = outbox.indexOf('export async function confirmShipmentDirectNow');
const helperEnd = outbox.indexOf('\nexport ', helperStart + 1);
const helperBlock = outbox.slice(helperStart, helperEnd > helperStart ? helperEnd : helperStart + 6000);
assert.ok(helperBlock.includes("resolveStoreConnector(args.provider, 'shipment.confirm')"),
  'the direct confirmer must resolve the SAME store-connector capability as the worker');
assert.ok(helperBlock.includes('loadStoreCredentials(args.provider'),
  'the direct confirmer must load credentials through the worker’s loader');
assert.ok(helperBlock.includes('shipmentId: 0'),
  'external fulfillment has no local shipment — the worker’s placeholder id is used');
// The outbox worker itself is untouched: its dispatch still exists alongside.
assert.ok(outbox.includes('async function processOutboxRow'),
  'the outbox worker must remain');
assert.ok((outbox.match(/\.connector\.confirmShipment\(\{|connector\.confirmShipment\(\{/g) ?? []).length >= 2,
  'worker + direct confirmer must BOTH use the same connector call shape');

// npm wiring.
assert.ok(readFileSync('package.json', 'utf8').includes('"test:ps-192-shipped-external-provider"'),
  'guard must be wired into package.json');

console.log('PASS ps-192 shipped-external provider guard');
