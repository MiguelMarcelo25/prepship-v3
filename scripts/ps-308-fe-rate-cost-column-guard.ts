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

check("OrdersView renders the Rate Cost cell from the backend money tuple",
  /case 'ratecost':[\s\S]*?getBackendRowMoney\(order\)\?\.rateCostAmount/.test(ordersView));
check("Rate Cost cell does NOT recompute (no client-side cost math)",
  !/rateCostAmount\s*=\s*[^;]*[-*/]\s/.test(ordersView.slice(ordersView.indexOf("case 'ratecost'"), ordersView.indexOf("case 'ratecost'") + 500)));

if (failures > 0) {
  console.error(`\nPS-308 FE rate-cost column guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-308 FE rate-cost column guard passed.');
