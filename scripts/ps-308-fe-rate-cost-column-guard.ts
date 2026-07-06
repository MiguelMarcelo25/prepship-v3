/**
 * PS-308/PS-356 (FE) guard — the separated C. Shipping Rate column exists and reads the backend field.
 *
 * The PS-308 audit found the existing guard "stays green while the headline deliverable
 * (the Awaiting/Shipped customer billing columns) is absent." This guard closes that: it asserts
 * the 'ratecost' legacy compatibility key is registered, hidden on Cancelled, sortable by the backend
 * customer billing amount, rendered from getBackendRowMoney().cShippingRateAmount (NOT recomputed), and that the FE money
 * getter exposes the separated backend fields. (On Shipped, the Best Rate column relabels to
 * Selected Rate, so the same compatibility key now gives "Selected Rate + C. Shipping Rate".)
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

const columns = read('web/src/components/Views/orders-table-columns.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
// PS-166/PS-306: the rate cells were extracted out of OrdersView into this module.
const rateCells = read('web/src/components/Views/orders-rate-cells.tsx');

check("'ratecost' is a registered table column (key + label 'C. Shipping Rate')",
  /'ratecost'/.test(columns) &&
  /\{ key: 'ratecost', label: 'C\. Shipping Rate'/.test(columns));
check("'ratecost' is in the TableColumnKey union", /TableColumnKey =[^\n]*'ratecost'/.test(columns));
check("'ratecost' is hidden on Cancelled (rate/financial column)", /hidden\.add\('ratecost'\)/.test(columns));
check("'ratecost' sorts by the backend customer billing amount (no FE recompute)",
  /case 'ratecost':[\s\S]*?getBackendRowMoney\(order\)\?\.cShippingRateAmount/.test(columns));

check('FE money getter exposes the separated backend fields',
  /cShippingRateAmount: toNumberValue\(money\.cShippingRateAmount\)/.test(rowDisplay) &&
  /selectedRateCost: toNumberValue\(money\.selectedRateCost\)/.test(rowDisplay) &&
  /shippingMarginAmount: toNumberValue\(money\.shippingMarginAmount\)/.test(rowDisplay));

// PS-166/PS-306: OrdersView now DELEGATES the rate cells to the extracted module; the backend
// money read lives in orders-rate-cells.tsx (renderCShippingRateCell), so assert it there.
check("OrdersView delegates the C. Shipping cell to renderCShippingRateCell (PS-166 extraction)",
  /case 'ratecost':\s*\n\s*return renderCShippingRateCell\(order\)/.test(ordersView));
check("renderCShippingRateCell renders from the backend money tuple",
  /export function renderCShippingRateCell/.test(rateCells) &&
  /getBackendRowMoney\(order\)\?\.cShippingRateAmount/.test(rateCells));
check("C. Shipping cell does NOT recompute (no client-side cost math)",
  !/cShippingRateAmount\s*[-+*/]\s/.test(rateCells) &&
  !/Math\.(max|min|round|abs)\s*\(/.test(rateCells));

if (failures > 0) {
  console.error(`\nPS-308 FE rate-cost column guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-308 FE rate-cost column guard passed.');
