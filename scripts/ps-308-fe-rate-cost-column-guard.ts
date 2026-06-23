/**
 * PS-308 (FE) guard — the separated Rate Cost column exists and reads the backend field.
 *
 * The PS-308 audit found the existing guard "stays green while the headline deliverable
 * (the Awaiting/Shipped Rate Cost columns) is absent." This guard closes that: it asserts
 * the 'ratecost' column is registered, hidden on Cancelled, sortable by the backend cost,
 * rendered from getBackendRowMoney().rateCostAmount (NOT recomputed), and that the FE money
 * getter exposes the separated backend fields. (On Shipped, the Best Rate column relabels to
 * Selected Rate, so the same column gives "Selected Rate + Rate Cost".)
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

check("'ratecost' is a registered table column (key + label 'Rate Cost')",
  /'ratecost'/.test(columns) &&
  /\{ key: 'ratecost', label: 'Rate Cost'/.test(columns));
check("'ratecost' is in the TableColumnKey union", /TableColumnKey =[^\n]*'ratecost'/.test(columns));
check("'ratecost' is hidden on Cancelled (rate/financial column)", /hidden\.add\('ratecost'\)/.test(columns));
check("'ratecost' sorts by the backend rate cost (no FE recompute)",
  /case 'ratecost':[\s\S]*?getBackendRowMoney\(order\)\?\.rateCostAmount/.test(columns));

check('FE money getter exposes the separated backend fields',
  /rateCostAmount: toNumberValue\(money\.rateCostAmount\)/.test(rowDisplay) &&
  /customerRateAmount: toNumberValue\(money\.customerRateAmount\)/.test(rowDisplay));

// PS-166/PS-306: OrdersView now DELEGATES the rate cells to the extracted module; the backend
// money read lives in orders-rate-cells.tsx (renderRateCostCell), so assert it there.
check("OrdersView delegates the Rate Cost cell to renderRateCostCell (PS-166 extraction)",
  /case 'ratecost':\s*\n\s*return renderRateCostCell\(order\)/.test(ordersView));
check("renderRateCostCell renders from the backend money tuple",
  /export function renderRateCostCell/.test(rateCells) &&
  /getBackendRowMoney\(order\)\?\.rateCostAmount/.test(rateCells));
check("Rate Cost cell does NOT recompute (no client-side cost math)",
  !/rateCostAmount\s*[-+*/]\s/.test(rateCells) &&
  !/Math\.(max|min|round|abs)\s*\(/.test(rateCells));

if (failures > 0) {
  console.error(`\nPS-308 FE rate-cost column guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-308 FE rate-cost column guard passed.');
