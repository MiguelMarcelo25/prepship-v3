/**
 * PS-258 (decomposition cert, next slice) — STATIC props/DOM-contract guard for
 * the extracted <OrdersSearchBar> child.
 *
 * OrdersView.tsx keeps shedding leaves. <OrdersSearchBar> was pulled out in the
 * PS-166 Wave-2b extraction with BYTE-IDENTICAL markup: its ids (#searchInput,
 * #searchClear), placeholder text, and the PS-210 global-search pill are pinned
 * by the e2e suites and the ps-210 guard. But ps-210 only certifies the *pill
 * text / global-search semantics* — nothing yet pins the leaf's **public prop
 * contract**, its destructuring, the two mutually-exclusive render branches, or
 * the call-site prop shape OrdersView wires it with. A future "tidy-up"
 * extraction could rename `onSearchQueryChange`, drop the `dateRange` prop,
 * collapse the clear-button branch, or change the call site — silently moving
 * the contract underneath the OrdersView shell. This guard freezes that surface.
 *
 * READ-ONLY static-source assertion. No DOM, no network, no runtime change. The
 * child is purely presentational (search state lives in Home and is threaded in
 * as props — no money/rate/insurance/label verdict is computed here), so this
 * guard never reasons about backend source-of-truth ownership; it only freezes
 * the leaf's public surface so callers cannot drift.
 *
 * What is pinned:
 *   1. The inline props type declares EXACTLY the three known props, each with
 *      its expected type (no silent add/drop/rename).
 *   2. The component destructures exactly those three prop names (impl matches
 *      the declared contract).
 *   3. Both conditional render branches survive with their gates: the clear
 *      button under `searchQuery ?`, and the PS-210 global-search hint pill
 *      under `searchQuery.trim() ?` (so a future extraction cannot collapse the
 *      pill into the input, or show the clear button when the field is empty).
 *   4. The DOM-contract anchors the OrdersView shell / e2e suites depend on
 *      survive: id="searchInput", id="searchClear", and the placeholder text.
 *   5. OrdersView wires the child with EXACTLY those three prop names at the
 *      call site (the call-site contract matches the declared props).
 *
 * Run:
 *   npx tsx scripts/ps-258-orders-search-bar-contract-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const CHILD_PATH = 'web/src/components/Views/OrdersSearchBar.tsx';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

const child = readFileSync(CHILD_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');

// The three canonical props that form the public contract of this leaf.
const EXPECTED_PROPS: ReadonlyArray<{ name: string; type: RegExp }> = [
  { name: 'searchQuery', type: /searchQuery:\s*string/ },
  { name: 'onSearchQueryChange', type: /onSearchQueryChange\?:\s*\(value:\s*string\)\s*=>\s*void/ },
  { name: 'dateRange', type: /dateRange:\s*\{\s*start\?:\s*string;\s*end\?:\s*string\s*\}/ },
];

// Isolate the inline props-type body (the `}: { … }` annotation on the export)
// so a stray match elsewhere in the file can't satisfy us.
const propsBlock = child.match(
  /\}:\s*\{([\s\S]*?)\}\s*\)\s*\{/,
)?.[1] ?? '';
check('OrdersSearchBar declares an inline props type annotation', propsBlock.length > 0);

// ── 1. props type declares each prop with its expected type ──
for (const { name, type } of EXPECTED_PROPS) {
  check(`props type declares \`${name}\` with its expected type`, type.test(propsBlock));
}

// Exactly three prop members — no silent additions to the contract.
const propMemberCount = (propsBlock.match(/^\s*\w+\??:/gm) ?? []).length;
check(`props type declares EXACTLY ${EXPECTED_PROPS.length} props (found ${propMemberCount})`,
  propMemberCount === EXPECTED_PROPS.length);

// ── 2. the component destructures exactly those three names ──
const destructure = child.match(
  /export function OrdersSearchBar\(\{([\s\S]*?)\}:/,
)?.[1] ?? '';
check('OrdersSearchBar destructures its props', destructure.length > 0);
for (const { name } of EXPECTED_PROPS) {
  check(`component destructures \`${name}\``,
    new RegExp(`\\b${name}\\b`).test(destructure));
}

// ── 3. both conditional render branches survive with their gates ──
check('clear button branch keeps its `searchQuery ?` gate',
  /\{searchQuery \? \(/.test(child));
check('global-search pill branch keeps its `searchQuery.trim() ?` gate',
  /\{searchQuery\.trim\(\) \? \(/.test(child));

// ── 4. DOM-contract anchors the OrdersView shell / e2e suites depend on ──
check('search input keeps id="searchInput"', /id="searchInput"/.test(child));
check('clear button keeps id="searchClear"', /id="searchClear"/.test(child));
check('search input keeps its placeholder text',
  /placeholder="Search orders, SKUs, names…"/.test(child));

// ── 5. OrdersView wires the child with EXACTLY those three prop names ──
//    Anchor on the JSX element: tag name + whitespace + a prop char, up to the
//    first self-closing `/>` (the header-comment mention closes with `>`).
const callSite = ordersView.match(
  /<OrdersSearchBar\s+(\w[\s\S]*?)\/>/,
)?.[1] ?? '';
check('OrdersView renders <OrdersSearchBar …/>', callSite.length > 0);
for (const { name } of EXPECTED_PROPS) {
  check(`call site passes the \`${name}\` prop`,
    new RegExp(`\\b${name}=\\{`).test(callSite));
}
const callSitePropCount = (callSite.match(/\w+=\{/g) ?? []).length;
check(`call site passes EXACTLY ${EXPECTED_PROPS.length} props (found ${callSitePropCount})`,
  callSitePropCount === EXPECTED_PROPS.length);

if (failures > 0) {
  console.error(`\nFAIL PS-258 OrdersSearchBar props-contract guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 OrdersSearchBar props-contract guard');
