import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// PS-035 checkpoint L (Order table post-shipment behavior). The OrdersView UI
// read-only flag is intentionally disabled (isReadOnly = false, per the
// 2026-05-06 override), so post-shipment safety now rests ENTIRELY on the
// backend assertOrderEditable() 409 guard. The browser specs only prove the
// entry-point UI state; this guard locks the backend mutation-rejection layer
// so a shipped/cancelled order can never be mutated through the order routes.
// Static/offline (readFileSync only) — safe for the master workflow cert.

const orders = readFileSync('src/routes/orders.ts', 'utf8');
const agents = readFileSync('AGENTS.md', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// 1. The locked-status set is exactly shipped + cancelled.
assert(
  /LOCKED_STATUSES\s*=\s*new Set\(\[\s*'shipped',\s*'cancelled'\s*\]\)/.test(orders),
  "orders.ts must define LOCKED_STATUSES = new Set(['shipped', 'cancelled'])",
);

// 2. The shared editability guard exists.
assert(
  /function assertOrderEditable\b/.test(orders),
  'orders.ts must define the assertOrderEditable() guard',
);

// 3. Every shipped/cancelled-sensitive mutation route calls the guard. AGENTS.md
//    enumerates PATCH /:id, /residential, /selected-pid, /selected-package-id,
//    /best-rate, /shipped-external, /save-dims (7 modification endpoints).
const guardCallSites = (orders.match(/assertOrderEditable\(c, id\)/g) ?? []).length;
assert(
  guardCallSites >= 7,
  `orders.ts must call assertOrderEditable() at every locked mutation route (found ${guardCallSites}, expected >= 7)`,
);

// 4. The lockdown response is a 409-style immutable rejection, and the only
//    bypass is an explicit admin ?force=1 override that is LOGGED.
assert(
  /forceFlag === '1'/.test(orders) && /isAdminEmail|callerIsAdmin/.test(orders),
  'orders.ts lockdown bypass must require an admin ?force=1 override',
);
assert(
  /LOCKDOWN BYPASS/.test(orders),
  'orders.ts must log a warning when the admin force-bypass is used',
);
assert(
  /Shipped and cancelled orders are immutable/.test(orders),
  'orders.ts must return an explicit immutable-order message for locked mutations',
);

// 5. AGENTS.md still documents the locked modification endpoints (source of truth).
for (const route of [
  '/:id/residential',
  '/selected-pid',
  '/selected-package-id',
  '/best-rate',
  '/shipped-external',
  '/save-dims',
]) {
  assert(
    agents.includes(route),
    `AGENTS.md must document the locked modification route ${route}`,
  );
}

// 6. The OrdersView shipped surface still suppresses new-label creation and
//    exposes the read-only reprint/queue actions instead.
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
assert(
  ordersView.includes('shipped-label-actions'),
  'OrdersView must render the read-only shipped-label-actions surface (reprint/queue), not new-label creation',
);

// 7. Self-wiring.
assert.equal(
  pkg.scripts?.['test:order-editable-lockdown'],
  'node scripts/order-editable-lockdown-guard.mjs',
  'package.json must expose the order-editable lockdown guard',
);

// 8. PS-136 (extract-and-delegate): the manual mark-shipped-externally transition is owned by
//    the canonical service, the route still calls assertOrderEditable BEFORE delegating, and the
//    service adds a defense-in-depth forward-only WHERE order_status='awaiting_shipment' guard so
//    the awaiting->shipped flip can never re-flip a shipped/cancelled order.
const markShippedExternally = readFileSync('src/services/fulfillment/mark-shipped-externally.ts', 'utf8');
assert(
  /export async function markOrderShippedExternally\b/.test(markShippedExternally),
  'mark-shipped-externally.ts must export the canonical markOrderShippedExternally() owner',
);
assert(
  /eq\(orders\.orderStatus,\s*'awaiting_shipment'\)/.test(markShippedExternally),
  'markOrderShippedExternally must gate the awaiting->shipped flip with a forward-only WHERE order_status=awaiting_shipment guard',
);
assert(
  orders.includes('markOrderShippedExternally({'),
  'the /shipped-external route must delegate to the canonical markOrderShippedExternally() service',
);
const shippedExternalIdx = orders.indexOf("'/:id{[0-9]+}/shipped-external'");
const delegateIdx = orders.indexOf('markOrderShippedExternally({', shippedExternalIdx);
const guardIdx = orders.indexOf('assertOrderEditable(c, id)', shippedExternalIdx);
assert(
  shippedExternalIdx >= 0 && guardIdx > shippedExternalIdx && delegateIdx > guardIdx,
  'the /shipped-external route must call assertOrderEditable BEFORE delegating to markOrderShippedExternally',
);

console.log('PASS order-editable lockdown guard');
