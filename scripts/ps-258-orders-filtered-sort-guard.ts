/**
 * PS-258 / PS-166 guard — the Awaiting orders ORDER/sort logic is a pure, single-owner
 * computation (computeOrderedFilteredOrders) that the OrdersView `orderedFilteredOrders`
 * useMemo delegates to. Pins the pure behavior (snapshot rank branch + immutability) AND
 * the OrdersView delegation (no inline sort body left in the useMemo).
 *
 *   npx tsx scripts/ps-258-orders-filtered-sort-guard.ts
 */
import { readFileSync } from 'node:fs';
import { computeOrderedFilteredOrders } from '../web/src/components/Views/orders-filtered-sort';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const base = {
  skuSortActive: false,
  sortState: { key: 'orderId', dir: 'asc' },
  orderDetailsById: new Map<number, any>(),
  shippingAccounts: [] as any,
};
// Injected per-order accessors (the real ones chain to the Vite-only api-base; the pure
// owner takes them as deps so it stays an offline-testable leaf). getSortValue stub reads
// the named key off the order so the default-sort branch is exercised deterministically.
const stubDeps = {
  getActiveItems: (o: any) => o.items ?? [],
  getOrderSortTimeMs: (o: any) => o.t ?? 0,
  isEbayOrder: () => false,
  getSortValue: (o: any, _d: any, key: string) => o[key],
};

// ── snapshot branch: restore the pre-SKU order via the rank map ──
{
  const input = [{ orderId: 3 }, { orderId: 1 }, { orderId: 2 }];
  const out = computeOrderedFilteredOrders({ ...base, searchedOrders: input, preSkuSortSnapshot: [1, 2, 3] }, stubDeps);
  check('snapshot branch reorders to the snapshot rank', out.map((o) => o.orderId).join(',') === '1,2,3');
  check('returns a NEW array (input not mutated)', out !== input && input.map((o) => o.orderId).join(',') === '3,1,2');
}
{
  // an id absent from the snapshot sorts LAST (Number.MAX_SAFE_INTEGER rank).
  const out = computeOrderedFilteredOrders({ ...base, searchedOrders: [{ orderId: 9 }, { orderId: 1 }], preSkuSortSnapshot: [1] }, stubDeps);
  check('snapshot: an id not in the snapshot sorts last', out.map((o) => o.orderId).join(',') === '1,9');
}
{
  const out = computeOrderedFilteredOrders({ ...base, searchedOrders: [], preSkuSortSnapshot: null }, stubDeps);
  check('empty searchedOrders -> empty result', Array.isArray(out) && out.length === 0);
}

// ── default branch: sort by the active column (getSortValue) + direction ──
{
  const asc = computeOrderedFilteredOrders(
    { ...base, searchedOrders: [{ orderId: 3, v: 30 }, { orderId: 1, v: 10 }, { orderId: 2, v: 20 }], preSkuSortSnapshot: null, sortState: { key: 'v', dir: 'asc' } },
    stubDeps,
  );
  check('default branch sorts ascending by getSortValue', asc.map((o) => o.orderId).join(',') === '1,2,3');
  const desc = computeOrderedFilteredOrders(
    { ...base, searchedOrders: [{ orderId: 1, v: 10 }, { orderId: 3, v: 30 }, { orderId: 2, v: 20 }], preSkuSortSnapshot: null, sortState: { key: 'v', dir: 'desc' } },
    stubDeps,
  );
  check('default branch respects descending direction', desc.map((o) => o.orderId).join(',') === '3,2,1');
}

// ── sku-sort branch: smoke (uses the real buildSkuCompositionKey leaf, no crash) ──
{
  const out = computeOrderedFilteredOrders({ ...base, skuSortActive: true, searchedOrders: [{ orderId: 1 }, { orderId: 2 }], preSkuSortSnapshot: null }, stubDeps);
  check('sku-sort branch returns an array of the same length (real grouping leaf)', Array.isArray(out) && out.length === 2);
}

// ── structural: OrdersView delegates to the pure owner, no inline sort body ──
const ov = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
check('OrdersView imports computeOrderedFilteredOrders from the pure owner',
  /computeOrderedFilteredOrders/.test(ov) && /orders-filtered-sort/.test(ov));
check('the orderedFilteredOrders useMemo delegates to computeOrderedFilteredOrders',
  /orderedFilteredOrders = useMemo\(\s*\(\) => computeOrderedFilteredOrders\(/.test(ov));
const memo = /const orderedFilteredOrders = useMemo\([\s\S]{0,500}?\)\s*\n/.exec(ov)?.[0] ?? '';
check('no inline .sort() remains in the orderedFilteredOrders useMemo (delegated, not inlined)',
  memo.length > 0 && !/\.sort\(/.test(memo));

check('package.json wires test:ps-258-orders-filtered-sort',
  /test:ps-258-orders-filtered-sort/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-258 orders-filtered-sort guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-258 orders-filtered-sort guard');
