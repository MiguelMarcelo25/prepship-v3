/**
 * PS-258 (decomposition cert, next slice) — STATIC props/DOM-contract guard for
 * the extracted <OrdersResultsEmptyState> child.
 *
 * As OrdersView.tsx keeps shedding leaves, an *already-extracted* presentational
 * child can still drift: a future "tidy-up" extraction could rename a prop,
 * collapse one of the two mutually-exclusive render branches, or drop a DOM
 * anchor — silently changing the public contract the OrdersView shell depends
 * on. The existing ps-258-component-boundary guard pins the shipped/cancelled
 * *lockdown* gating; this guard pins the *prop shape + render-branch gating* of
 * one concrete extracted child so the contract cannot move underneath callers.
 *
 * READ-ONLY static-source assertion. No DOM, no network, no runtime change. The
 * child is purely presentational (no money/rate/insurance/label verdict lives
 * here — every gating boolean and display value is passed in as a prop), so this
 * guard never has to reason about backend source-of-truth ownership; it only
 * freezes the leaf's public surface.
 *
 * What is pinned:
 *   1. The exported `OrdersResultsEmptyStateProps` type declares EXACTLY the six
 *      known props, each with its expected type (no silent add/drop/rename).
 *   2. The component destructures exactly those six prop names (impl matches the
 *      declared contract).
 *   3. Both mutually-exclusive render branches survive, each gated on the same
 *      `!loading && !error && hasNoFilteredOrders` precondition plus the
 *      `ordersSearching` / `!ordersSearching` split (so a future extraction
 *      cannot collapse the Searching… spinner into the empty state, or vice
 *      versa, which would resurrect the PS-218 false "No orders match" flash).
 *   4. The DOM-contract anchors survive: the spinner's data-testid, the
 *      `searchingState` id, and the `emptyState` id.
 *   5. The caller wires the child with exactly those six prop names at the call
 *      site (the call-site contract matches the declared props). PS-166/PS-306
 *      Wave-3 re-point: the loading/error/empty framing (incl. the
 *      <OrdersResultsEmptyState> render) moved VERBATIM out of OrdersView into
 *      the presentational <OrdersResultsShell>, so the call site now lives in
 *      OrdersResultsShell.tsx. OrdersView renders <OrdersResultsShell> and
 *      forwards the same gating props, so the leaf's public contract is still
 *      pinned at its (now one-hop-removed) caller — intent preserved.
 *
 * Run:
 *   npx tsx scripts/ps-258-orders-empty-state-props-contract-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const CHILD_PATH = 'web/src/components/Views/OrdersResultsEmptyState.tsx';
// PS-166/PS-306 (Wave 3): the <OrdersResultsEmptyState> render moved out of
// OrdersView into the presentational <OrdersResultsShell>, so the call-site
// contract (section 5) is now pinned in OrdersResultsShell.tsx. OrdersView
// still delegates by rendering <OrdersResultsShell> and forwarding the props.
const CALLER_PATH = 'web/src/components/Views/OrdersResultsShell.tsx';

const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

const child = readFileSync(CHILD_PATH, 'utf8');
const caller = readFileSync(CALLER_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');

// The six canonical props that form the public contract of this leaf.
const EXPECTED_PROPS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'loading', type: 'boolean' },
  { name: 'error', type: 'unknown' },
  { name: 'ordersSearching', type: 'boolean' },
  { name: 'hasNoFilteredOrders', type: 'boolean' },
  { name: 'searchQuery', type: 'string' },
  { name: 'isGlobalSearchActive', type: 'boolean' },
];

// ── 1. exported props type exists and declares each prop with its type ──
check('OrdersResultsEmptyState exports the OrdersResultsEmptyStateProps type',
  /export type OrdersResultsEmptyStateProps = \{/.test(child));

// Isolate the props-type body so a stray match elsewhere can't satisfy us.
const propsBlock = child.match(
  /export type OrdersResultsEmptyStateProps = \{([\s\S]*?)\}/,
)?.[1] ?? '';

for (const { name, type } of EXPECTED_PROPS) {
  check(`props type declares \`${name}: ${type}\``,
    new RegExp(`\\b${name}:\\s*${type}\\b`).test(propsBlock));
}

// Exactly six prop members — no silent additions to the contract.
const propMemberCount = (propsBlock.match(/^\s*\w+:/gm) ?? []).length;
check(`props type declares EXACTLY ${EXPECTED_PROPS.length} props (found ${propMemberCount})`,
  propMemberCount === EXPECTED_PROPS.length);

// ── 2. the component destructures exactly those six names ──
const destructure = child.match(
  /export function OrdersResultsEmptyState\(\{([\s\S]*?)\}: OrdersResultsEmptyStateProps\)/,
)?.[1] ?? '';
for (const { name } of EXPECTED_PROPS) {
  check(`component destructures \`${name}\``,
    new RegExp(`\\b${name}\\b`).test(destructure));
}

// ── 3. both mutually-exclusive render branches survive with their gates ──
check('Searching… branch keeps its `hasNoFilteredOrders && ordersSearching` gate',
  /!loading && !error && hasNoFilteredOrders && ordersSearching \?/.test(child));
check('empty-state branch keeps its `!ordersSearching && hasNoFilteredOrders` gate',
  /!loading && !error && !ordersSearching && hasNoFilteredOrders \?/.test(child));

// ── 4. DOM-contract anchors the OrdersView shell / tests depend on ──
check('Searching… region keeps data-testid="orders-searching"',
  /data-testid="orders-searching"/.test(child));
check('Searching… region keeps id="searchingState"',
  /id="searchingState"/.test(child));
check('empty-state region keeps id="emptyState"',
  /id="emptyState"/.test(child));

// ── 5. the caller (OrdersResultsShell) wires the child with EXACTLY those six prop names ──
//    Anchor on the JSX element specifically: the tag name followed by
//    whitespace + a prop char (so the `<OrdersResultsEmptyState>` mention in
//    the file's header comment, which closes immediately with `>`, is skipped),
//    then capture up to the first self-closing `/>`.
const callSite = caller.match(
  /<OrdersResultsEmptyState\s+(\w[\s\S]*?)\/>/,
)?.[1] ?? '';
check('OrdersResultsShell renders <OrdersResultsEmptyState …/>', callSite.length > 0);
for (const { name } of EXPECTED_PROPS) {
  check(`call site passes the \`${name}\` prop`,
    new RegExp(`\\b${name}=\\{`).test(callSite));
}
const callSitePropCount = (callSite.match(/\w+=\{/g) ?? []).length;
check(`call site passes EXACTLY ${EXPECTED_PROPS.length} props (found ${callSitePropCount})`,
  callSitePropCount === EXPECTED_PROPS.length);

// ── 6. OrdersView still delegates: it renders <OrdersResultsShell> and forwards
//    the gating props the shell threads down into <OrdersResultsEmptyState>, so
//    the empty-state contract is reachable from the OrdersView shell (one hop). ──
const shellCallSite = ordersView.match(
  /<OrdersResultsShell\s+(\w[\s\S]*?)>/,
)?.[1] ?? '';
check('OrdersView renders <OrdersResultsShell …> (delegates the results framing)',
  shellCallSite.length > 0);
check('OrdersView forwards hasNoFilteredOrders={orderedFilteredOrders.length === 0} to the shell',
  /hasNoFilteredOrders=\{orderedFilteredOrders\.length === 0\}/.test(shellCallSite));
for (const name of ['ordersSearching', 'searchQuery', 'isGlobalSearchActive'] as const) {
  check(`OrdersView forwards the \`${name}\` empty-state gating prop to the shell`,
    new RegExp(`\\b${name}=\\{`).test(shellCallSite));
}

if (failures > 0) {
  console.error(`\nFAIL PS-258 OrdersResultsEmptyState props-contract guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 OrdersResultsEmptyState props-contract guard');
