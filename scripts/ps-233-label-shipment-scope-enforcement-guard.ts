/**
 * PS-233 / PS-240 guard — caller-scope enforcement on label/shipment + order/client
 * WRITE paths.
 *
 * Per user override unlock shipped data on 2026-06-13: the label/shipment services
 * and the order/client write routes now refuse cross-tenant access. A restricted
 * principal (client_user / read_only_support) that calls these endpoints directly
 * must get a 404 (no existence leak) and must never buy/void postage or mutate
 * another tenant's order/client. This guard source-pins that the enforcement is
 * wired so it cannot silently regress.
 *
 *   npx tsx scripts/ps-233-label-shipment-scope-enforcement-guard.ts
 *
 * PS-259 (Card 14) BEHAVIORAL: the block below imports the REAL enforcement owner
 * (src/lib/client-store-scope + src/lib/scope-predicates) and RUNS it on
 * representative inputs, asserting the security verdict. These assertions FAIL if the
 * scope-derivation or the in-scope check is deleted/broken — not a substring match.
 * The static route/source checks underneath remain and are NOT weakened.
 */
import { readFileSync } from 'node:fs';
import {
  getClientStoreScope,
  getInternalOpsClientStoreScope,
  GLOBAL_SCOPE,
} from '../src/lib/client-store-scope';
import {
  assertResourceInScope,
  isResourceInScope,
  ResourceScopeError,
} from '../src/lib/scope-predicates';

let behavioralFailures = 0;
function behavioral(name: string, cond: boolean): void {
  if (!cond) { behavioralFailures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── BEHAVIORAL: run the real scope owner on representative principals ───────────────
// A restricted client_user scoped to client 7 is DENIED an out-of-scope resource
// (client 99) — the core cross-tenant defense. Fails if assertResourceInScope or the
// isRestricted derivation is removed.
const restricted = getClientStoreScope({ role: 'client_user', clientIds: [7] });
behavioral('client_user scope is restricted', restricted.isRestricted === true && restricted.isGlobal === false);

let denied = false;
try {
  assertResourceInScope(restricted, { clientId: 99, storeId: 99 }, 'Order not found');
} catch (e) {
  denied = e instanceof ResourceScopeError;
}
behavioral('restricted client_user is DENIED an out-of-scope order (ResourceScopeError)', denied);
behavioral('restricted client_user is denied via isResourceInScope (cross-tenant)',
  isResourceInScope(restricted, { clientId: 99, storeId: 99 }) === false);

// The SAME restricted scope ALLOWS its own in-scope resource (client 7) — proves the
// check discriminates, not a blanket deny.
let inScopeThrew = false;
try {
  assertResourceInScope(restricted, { clientId: 7, storeId: 1 }, 'Order not found');
} catch {
  inScopeThrew = true;
}
behavioral('restricted client_user is ALLOWED its own in-scope order', inScopeThrew === false);
behavioral('restricted client_user passes isResourceInScope for in-scope client',
  isResourceInScope(restricted, { clientId: 7, storeId: 1 }) === true);
const restrictedQueueWriter = getInternalOpsClientStoreScope({
  role: 'client_user',
  permissions: ['print_queue:write'],
  clientIds: [7],
});
behavioral('print_queue:write alone does not widen a client principal to global scope',
  restrictedQueueWriter.isRestricted === true &&
  restrictedQueueWriter.isGlobal === false &&
  isResourceInScope(restrictedQueueWriter, { clientId: 99, storeId: 99 }) === false);

// An admin / GLOBAL caller passes any resource (no per-tenant restriction) — proves
// global callers are not falsely blocked.
const adminScope = getClientStoreScope({ role: 'admin' });
behavioral('admin scope is global (unrestricted)', adminScope.isGlobal === true && adminScope.isRestricted === false);
behavioral('admin scope passes an arbitrary resource', isResourceInScope(adminScope, { clientId: 99, storeId: 99 }) === true);
behavioral('GLOBAL_SCOPE (trusted worker) passes an arbitrary resource',
  isResourceInScope(GLOBAL_SCOPE, { clientId: 12345, storeId: 67890 }) === true);

if (behavioralFailures > 0) {
  console.error(`\nFAIL PS-233 BEHAVIORAL scope enforcement (${behavioralFailures} failing) — real owner verdict wrong`);
  process.exit(1);
}

const scopePredicates = readFileSync('src/lib/scope-predicates.ts', 'utf8');
const clientStoreScope = readFileSync('src/lib/client-store-scope.ts', 'utf8');
const labelsSvc = readFileSync('src/services/labels.ts', 'utf8');
const labelsRoute = readFileSync('src/routes/labels.ts', 'utf8');
const shipmentsRoute = readFileSync('src/routes/shipments.ts', 'utf8');
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');
const clientsRoute = readFileSync('src/routes/clients.ts', 'utf8');
const printQueueSvc = readFileSync('src/services/print-queue.ts', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// 1. Shared primitive exists.
check('scope-predicates exports isResourceInScope', scopePredicates.includes('export function isResourceInScope('));
check('scope-predicates exports assertResourceInScope', scopePredicates.includes('export function assertResourceInScope('));
check('scope-predicates exports ResourceScopeError', scopePredicates.includes('export class ResourceScopeError'));
check('ResourceScopeError default message is 404-style', /Resource not found/.test(scopePredicates));
check('client-store-scope exports GLOBAL_SCOPE', clientStoreScope.includes('export const GLOBAL_SCOPE'));

// 2. Every label service takes a scope param (the attack surface).
check('createLabelV2 takes scope', /createLabelV2\([\s\S]*?scope: ClientStoreScope/.test(labelsSvc));
check('createBatchV2 takes scope', /createBatchV2\([\s\S]*?scope: ClientStoreScope/.test(labelsSvc));
check('voidLabelV2 takes scope', /voidLabelV2\([\s\S]*?scope: ClientStoreScope/.test(labelsSvc));
check('createReturnLabelV2 takes scope', /createReturnLabelV2\([\s\S]*?scope: ClientStoreScope/.test(labelsSvc));
check('retrieveLabelV2 takes scope', /retrieveLabelV2\([\s\S]*?scope: ClientStoreScope/.test(labelsSvc));
check('lookupLabel takes scope', /lookupLabel\(lookup: string, scope: ClientStoreScope/.test(labelsSvc));

// 3. Each service actually enforces the scope.
check('createLabelV2 asserts order scope', labelsSvc.includes("assertResourceInScope(scope, { clientId: order.clientId, storeId: order.storeId }, 'Order not found')"));
check('shipment-keyed services use assertShipmentInScope', count(labelsSvc, 'await assertShipmentInScope(row, scope') >= 3);
check('lookupLabel filters by scope', labelsSvc.includes('return rows.filter((r) =>') && labelsSvc.includes('isResourceInScope(scope,'));
check('createBatchV2 forwards scope into per-order createLabelV2', /\}, scope\);/.test(labelsSvc));

// 4. Routes pass the caller scope into every service call (no unscoped call).
check('labels route derives labelsScopeFromContext', labelsRoute.includes('function labelsScopeFromContext('));
check(
  'labels route passes scope to createLabelV2',
  count(labelsRoute, 'createLabelV2(body, labelsScopeFromContext(c))') >= 1 &&
    count(labelsRoute, "return createLabelRouteResponse(c, c.req.valid('json'));") >= 2,
);
check('labels route passes scope to createBatchV2', labelsRoute.includes('createBatchV2(body, labelsScopeFromContext(c))'));
check('labels route passes scope to voidLabelV2', labelsRoute.includes('voidLabelV2(id, labelsScopeFromContext(c))'));
check('labels route passes scope to createReturnLabelV2', labelsRoute.includes('createReturnLabelV2(id, body, labelsScopeFromContext(c))'));
check('labels route passes scope to retrieveLabelV2', labelsRoute.includes('retrieveLabelV2(lookup, fresh, labelsScopeFromContext(c))'));
check('labels route passes scope to lookupLabel', labelsRoute.includes('lookupLabel(lookup, labelsScopeFromContext(c))'));
// No service is called without a scope argument (catches a future unscoped call).
check('no unscoped createLabelV2(body) in labels route', !/createLabelV2\(body\)/.test(labelsRoute));
check('no unscoped voidLabelV2(id) in labels route', !/voidLabelV2\(id\)/.test(labelsRoute));

// 5. Defense-in-depth: portal roles blocked from label mutations.
check('label mutation routes use requireInternalPermission', count(labelsRoute, "requireInternalPermission('print_queue:write')") >= 5);

// 6. PS-422: the durable worker preserves the initiating tenant scope.
check('print-queue worker derives labelPurchaseScope from the queued route scope',
  /const labelPurchaseScope = queueWorkerClientStoreScope\(scope\)/.test(printQueueSvc));
check('print-queue worker passes labelPurchaseScope to createLabelV2',
  /createLabelV2\(\{[\s\S]*?\}, labelPurchaseScope\)/.test(printQueueSvc));
check('print-queue worker does not import or pass GLOBAL_SCOPE',
  !printQueueSvc.includes("import { GLOBAL_SCOPE }") &&
  !printQueueSvc.includes('}, GLOBAL_SCOPE);'));

// 7. Shipments routes scoped (list + detail) — both were unscoped before.
check('shipments list applies shipmentScopePredicate', shipmentsRoute.includes('shipmentScopePredicate(shipmentScopeFromContext(c))'));
check('shipments detail scope-checks the row', shipmentsRoute.includes('shipmentScopeFromContext(c)') && /isResourceInScope\(scope, \{ clientId: row\.clientId/.test(shipmentsRoute));

// 8. PS-240 — orders write paths scoped via assertOrderEditable (covers all subroutes).
check('assertOrderEditable selects clientId + storeId', /select\(\{[\s\S]*?clientId: orders\.clientId,[\s\S]*?storeId: orders\.storeId,/.test(ordersRoute));
check('assertOrderEditable enforces order scope before force-override', ordersRoute.includes('const editScope = ordersScopeFromContext(c);') && ordersRoute.includes('if (!isResourceInScope(editScope, { clientId: row.clientId, storeId: row.storeId }))'));
check('POST /manual blocks portal roles', /app\.post\('\/manual', requireInternalPermission\('print_queue:write'\)/.test(ordersRoute));

// 9. PS-240 — clients write paths gated + scope-checked.
check('clients POST gated', /app\.post\('\/', requireInternalPermission\('settings:write'\)/.test(clientsRoute));
check('clients PATCH gated + scope-checked', /app\.patch\('\/:id\{\[0-9\]\+\}', requireInternalPermission\('settings:write'\)/.test(clientsRoute) && count(clientsRoute, 'isClientVisibleToScope(publicClient(') >= 3);
check('clients DELETE gated', /app\.delete\('\/:id\{\[0-9\]\+\}', requireInternalPermission\('settings:write'\)/.test(clientsRoute));
check('clients backfill gated', /backfill-orders',\s*requireInternalPermission\('settings:write'\)/.test(clientsRoute));

// 10. Lockdown citation present on the touched locked surfaces.
check('labels service cites the override', labelsSvc.includes('unlock shipped data on 2026-06-13'));
check('orders route cites the override', ordersRoute.includes('unlock shipped data on 2026-06-13'));

// Self-wiring.
check('package.json exposes test:label-shipment-scope-enforcement', /test:label-shipment-scope-enforcement/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-233/PS-240 scope enforcement guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-233/PS-240 scope enforcement guard');
