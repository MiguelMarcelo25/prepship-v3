/**
 * PS-166 / PS-306 guard — OrdersRateCells extraction.
 *
 * Pins the decomposition slice that moved the PURE money/rate cell renderers out of the
 * OrdersView shell into ./orders-rate-cells: the module renders ONLY backend DTO data
 * (getBackendRowMoney / getBackendRowMarketplace / formatMoney) with no component-state
 * closure and no recompute, and the shell DELEGATES to it (no inline cell JSX). Fails if a
 * cell renderer is re-inlined into OrdersView or starts owning/recomputing money truth.
 *
 * Offline/static only.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}
function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

const cells = read('web/src/components/Views/orders-rate-cells.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');

check('OrdersRateCells exports the pure cell renderers',
  /export function renderOrderTotalCell/.test(cells) &&
  // Repointed (guard rot): PS-356/PS-357 renamed renderRateCostCell → renderCShippingRateCell
  // (the 'ratecost' column is now labeled "C. Shipping Rate" and reads backend customer money).
  /export function renderCShippingRateCell/.test(cells) &&
  /export function renderMarketplaceFeeCell/.test(cells) &&
  /export function renderProfitCell/.test(cells));
check('OrdersRateCells reads ONLY the backend money DTO helpers (no recompute)',
  /from '\.\/orders-row-display'/.test(cells) &&
  /getBackendRowMoney/.test(cells) &&
  /getBackendRowMarketplace/.test(cells) &&
  // no client-side cost/margin arithmetic — the cells read DTO fields + formatMoney only.
  !/Math\.(max|min|round|abs)\s*\(/.test(cells) &&
  !/\.rateCostAmount\s*[-+*/]/.test(cells) &&
  !/\.customerRateAmount\s*[-+*/]/.test(cells));

check('OrdersView imports the extracted cell module',
  /from '\.\/orders-rate-cells'/.test(ordersView));
check('OrdersView DELEGATES the pure cells (no inline cell JSX re-introduced)',
  /case 'total':\s*\n\s*return renderOrderTotalCell\(order\)/.test(ordersView) &&
  /case 'ratecost':\s*\r?\n\s*return renderCShippingRateCell\(order\)/.test(ordersView) &&
  /case 'marketplacefee':\s*\n\s*return renderMarketplaceFeeCell\(order\)/.test(ordersView) &&
  /case 'profit':\s*\n\s*return renderProfitCell\(order\)/.test(ordersView));

if (failures > 0) {
  console.error(`\nPS-166 OrdersRateCells guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-166 OrdersRateCells guard passed.');
