/**
 * PS-210 guard — Orders search is GLOBAL across Awaiting / Shipped / Cancelled.
 *
 * Operator report: searching a customer from Awaiting returned nothing while
 * the same search found the order on Shipped. The UI claimed "Searching all
 * orders" and the bulk-selection matcher already searched globally, but the
 * visible table query pinned `order_status = <active tab>` — main-table
 * search and selection matching disagreed.
 *
 * Certifies (offline — no DB writes, no postage, read-only semantics):
 *   1. The pure status-scope owner: a NON-EMPTY search + searchScope=global
 *      resolves to the lifecycle union (awaiting/shipped/cancelled) from ANY
 *      tab; empty search / missing scope keeps tab-local behavior (clearing
 *      search restores the tab); legacy callers without the param are
 *      unchanged.
 *   2. The route wires the owner BEFORE pagination/totals, keeps the awaiting
 *      visibility predicate inside the global awaiting arm, and leaves every
 *      other predicate (auth scope, assignee, client/store, store visibility,
 *      test exclusion) in place.
 *   3. Shipped/cancelled mutation gates are untouched: assertOrderEditable
 *      still guards the modification endpoints.
 *   4. The FE declares intent (searchScope=global) on BOTH the visible table
 *      fetch and the selection matcher, renders the real-status pill on
 *      off-tab rows, and the search pill no longer overclaims.
 *
 *   npx tsx scripts/ps-210-global-orders-search-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GLOBAL_SEARCH_LIFECYCLE_STATUSES,
  resolveOrdersStatusScope,
} from '../src/services/orders-search-scope';

// ── (1) The status-scope owner ──────────────────────────────────────────────
assert.deepEqual(
  [...GLOBAL_SEARCH_LIFECYCLE_STATUSES],
  ['awaiting_shipment', 'shipped', 'cancelled'],
  'global search spans exactly the lifecycle tabs',
);

// THE regression case: searching from Awaiting must be able to reach Shipped
// (and Cancelled) — the active tab no longer constrains a global search.
for (const tab of ['awaiting_shipment', 'shipped', 'cancelled']) {
  const scope = resolveOrdersStatusScope({ status: tab, search: 'riley fixture', searchScope: 'global' });
  assert.equal(scope.mode, 'global_lifecycle', `non-empty global search from ${tab} must widen`);
  const statuses = (scope as { statuses: readonly string[] }).statuses;
  assert.ok(statuses.includes('shipped') && statuses.includes('cancelled') && statuses.includes('awaiting_shipment'),
    `global search from ${tab} must span the whole lifecycle`);
}
// Clearing search restores tab-local behavior — scope WITHOUT search is inert.
assert.deepEqual(
  resolveOrdersStatusScope({ status: 'awaiting_shipment', search: '', searchScope: 'global' }),
  { mode: 'single_status', status: 'awaiting_shipment' },
  'an empty search must stay tab-local even if a stale scope param rides along',
);
assert.deepEqual(
  resolveOrdersStatusScope({ status: 'awaiting_shipment', search: '   ', searchScope: 'global' }),
  { mode: 'single_status', status: 'awaiting_shipment' },
  'whitespace-only search must stay tab-local',
);
// Legacy callers (no searchScope) are byte-for-byte unchanged: search stays
// tab-scoped exactly as before this ticket.
assert.deepEqual(
  resolveOrdersStatusScope({ status: 'shipped', search: 'riley', searchScope: null }),
  { mode: 'single_status', status: 'shipped' },
  'search without the explicit global scope must keep the old tab-local behavior',
);
assert.deepEqual(resolveOrdersStatusScope({}), { mode: 'unfiltered' });

// ── (2) Route wiring ────────────────────────────────────────────────────────
const ordersRoute = readFileSync('src/routes/orders.ts', 'utf8');

assert.ok(ordersRoute.includes("searchScope: z.enum(['active_status', 'global']).optional()"),
  'the list query must accept the explicit searchScope param');
assert.ok(/resolveOrdersStatusScope\(\{\s*status: q\.status,\s*search,\s*searchScope: q\.searchScope,?\s*\}\)/.test(ordersRoute),
  'the list route must delegate status semantics to the single owner');
// The global predicate is a lifecycle union whose awaiting arm KEEPS the
// awaiting visibility predicate — search can never surface awaiting rows the
// tab itself would hide.
// Re-anchored 2026-07-08: PS-387 moved the arm from raw orders.orderStatus to
// the effective-status owner (listEffectiveStatusSql = orderLifecycle-
// EffectiveStatusSql()); this pin rotted then (the guard crashed here on a
// clean stable checkout) and was repointed during the API-audit Phase 3 search
// work. Same invariants: awaiting arm keeps the visibility predicate, global
// spans shipped + cancelled.
assert.ok(ordersRoute.includes("(${listEffectiveStatusSql} = 'awaiting_shipment' and ${visibleAwaitingOrdersPredicate('orders')})"),
  'the global awaiting arm must keep visibleAwaitingOrdersPredicate');
assert.ok(ordersRoute.includes("or ${listEffectiveStatusSql} in ('shipped', 'cancelled')"),
  'the global predicate must span shipped + cancelled');
// No-search awaiting keeps its visibility predicate on the single-status path.
assert.ok(ordersRoute.includes("statusScope.mode === 'single_status' && statusScope.status === 'awaiting_shipment'"),
  'tab-local awaiting must still apply visibleAwaitingOrdersPredicate');
// The widened predicate is part of the SAME where that feeds the page query,
// the idsOnly selection query, AND the count — global search happens
// server-side BEFORE pagination/totals, never as client-side page filtering.
const scopeIdx = ordersRoute.indexOf('const statusScope = resolveOrdersStatusScope');
const whereIdx = ordersRoute.indexOf('const where = and(', scopeIdx);
const idsOnlyIdx = ordersRoute.indexOf("'ordersIdsOnlyPage'", whereIdx);
const pageIdx = ordersRoute.indexOf("'ordersPage'", whereIdx);
assert.ok(scopeIdx > -1 && whereIdx > scopeIdx && idsOnlyIdx > whereIdx && pageIdx > whereIdx,
  'the status scope must resolve into the shared where BEFORE the paged/selection/count queries');
// Auth/RBAC + client/store scope + assignee + store-visibility predicates all
// stay inside the same where composition.
const whereBlock = ordersRoute.slice(whereIdx, ordersRoute.indexOf('].filter', whereIdx));
for (const predicate of [
  'orderScopePredicate(orderScope)',
  'assigneeFilter',
  'eq(orders.clientId, q.clientId)',
  'eq(orders.storeId, q.storeId)',
  'visibleStorePredicate',
]) {
  assert.ok(whereBlock.includes(predicate), `global search must still apply ${predicate}`);
}

// ── (3) Mutation gates untouched (read-only ticket) ─────────────────────────
assert.ok((ordersRoute.match(/assertOrderEditable\(/g) ?? []).length >= 5,
  'the shipped/cancelled mutation gates must remain on the modification endpoints');

// ── (4) FE intent + display safety ──────────────────────────────────────────
const useOrdersHook = readFileSync('web/src/hooks/useOrders.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');

assert.ok(useOrdersHook.includes('const effectiveSearchScope = trimmedSearch ? searchScope : undefined'),
  'the hook must only send scope with a real search');
assert.ok(useOrdersHook.includes('searchScope: effectiveSearchScope'),
  'the hook must forward the scope to /orders');
assert.ok(ordersView.includes("searchScope: isGlobalSearchActive ? 'global' : undefined"),
  'the visible table fetch must declare global intent during search');
assert.ok(ordersView.includes('storeId: isGlobalSearchActive ? undefined : activeStore ?? undefined'),
  'search must drop the store-sidebar scoping (matching the selection matcher)');
assert.ok(ordersView.includes("{ searchScope: 'global' as const }"),
  'the bulk-selection matcher must declare the SAME global intent as the table');
// The pill no longer overclaims. (PS-166 Wave 2b re-anchor: the search bar
// renders from OrdersSearchBar.tsx with byte-identical markup; OrdersView
// threads the same props.)
const searchBar = readFileSync('web/src/components/Views/OrdersSearchBar.tsx', 'utf8');
assert.ok(searchBar.includes('Searching all statuses &amp; stores'),
  'the search pill must state the true scope');
assert.ok(!searchBar.includes('<span>Searching all orders</span>') &&
  !ordersView.includes('<span>Searching all orders</span>'),
  'the old overclaiming pill text must be gone');
// PS-166 Wave 4 re-anchor: the <OrdersSearchBar> call site moved into
// OrdersFilterToolbar.tsx; OrdersView now renders <OrdersFilterToolbar> and
// forwards searchQuery down to it. Accept the search bar rendered in the toolbar
// AND OrdersView forwarding searchQuery into the toolbar (contract unbroken).
const filterToolbar = readFileSync('web/src/components/Views/OrdersFilterToolbar.tsx', 'utf8');
assert.ok(/OrdersSearchBar\s+searchQuery=\{searchQuery\}/.test(filterToolbar.replace(/\n\s*/g, ' ')) ||
  filterToolbar.includes('<OrdersSearchBar'),
  'OrdersFilterToolbar must render the extracted search bar');
assert.ok(/<OrdersFilterToolbar[\s\S]*?searchQuery=\{searchQuery\}/.test(ordersView),
  'OrdersView must forward searchQuery into <OrdersFilterToolbar>');
// Off-tab rows are labeled with their REAL status, gated on the row (not the
// tab). PS-166 Wave 2c1 re-anchor: the Order # cell (and its off-tab pill)
// moved VERBATIM to OrdersTableCells.tsx; OrdersView threads currentStatus +
// isGlobalSearchActive into it via the renderOrderCell context.
const tableCells = readFileSync('web/src/components/Views/OrdersTableCells.tsx', 'utf8');
assert.ok(tableCells.includes('data-testid="off-tab-status-pill"'),
  'mixed-status rows must render the real-status pill');
assert.ok(tableCells.includes('isGlobalSearchActive && order.orderStatus && order.orderStatus !== currentStatus'),
  'the pill must key on the ROW status differing from the active tab during search');
assert.ok(/renderOrderCell\(order, \{[\s\S]{0,200}isGlobalSearchActive,[\s\S]{0,80}currentStatus,/.test(ordersView),
  'OrdersView must thread isGlobalSearchActive + currentStatus into the Order # cell');

// ── (5) Browser/workflow proof exists and follows the mocked-only harness ───
const spec = readFileSync('web/e2e/orders-global-search.spec.js', 'utf8');
for (const pin of [
  "searchScope === 'global'",
  'off-tab-status-pill',
  'page.route',
  "searchAndExpectGlobalMatches(page, 'awaiting_shipment'",
  "searchAndExpectGlobalMatches(page, 'shipped'",
  "searchAndExpectGlobalMatches(page, 'cancelled'",
  'Riley Globalsearch',
]) {
  assert.ok(spec.includes(pin), `e2e spec must include ${pin}`);
}
assert.ok(!/buyLabel|purchaseLabel|createLabel\(|notifyMarketplace/i.test(spec),
  'the e2e spec must stay read-only (no label purchase / marketplace calls)');

// npm wiring.
assert.ok(readFileSync('package.json', 'utf8').includes('"test:ps-210-global-orders-search"'),
  'guard must be wired into package.json');

console.log('PASS ps-210 global orders search guard');
