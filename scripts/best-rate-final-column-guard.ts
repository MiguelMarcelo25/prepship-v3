/**
 * Best Rate Final column guard.
 *
 * Offline/static only: no DB, providers, labels, postage, marketplace
 * notifications, shipped/cancelled mutations, or production data edits.
 *
 * The column is display-only. The second-best/final rate remains backend-owned:
 * rates-backfill and /rates/browse delegate to combineCarrierUniverses(),
 * then persist the backend-selected all-carrier second-best rate into the saved
 * best-rate cache. The frontend may only render that cached DTO; it must not
 * rank, choose, or mutate rate truth.
 */
import { readFileSync } from 'node:fs';
import { getBestRateFinalBaseCost } from '../web/src/components/Views/orders-row-display';

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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const columns = read('web/src/components/Views/orders-table-columns.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const rateCells = read('web/src/components/Views/orders-rate-cells.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const cells = read('web/src/components/Views/orders/cells/order-cells.tsx');
const ratesCombined = read('src/services/rates-combined.ts');

check(
  "'bestRateFinal' is a registered table column with label 'Best Rate Final'",
  /'bestRateFinal'/.test(columns) &&
    /\{ key: 'bestRateFinal', label: 'Best Rate Final'/.test(columns),
);

check(
  "'bestRateFinal' participates in the typed column/sort unions",
  /TableColumnKey =[^\n]*'bestRateFinal'/.test(columns) &&
    /SortKey =[^\n]*'bestRateFinal'/.test(columns),
);

check(
  "'bestRateFinal' is awaiting-only display, not a shipped/cancelled selected-rate duplicate",
  /if \(currentStatus !== 'awaiting_shipment'\) \{[\s\S]*hidden\.add\('bestRateFinal'\)/.test(columns),
);

check(
  "'bestRateFinal' sorts by backend cached second-best/final amount",
  /case 'bestRateFinal':[\s\S]*getBestRateFinalBaseCost\(order\)/.test(columns),
);

check(
  'row display helper exposes backend cached second-best amount without live overlay state',
  /export function getBestRateFinalBaseCost/.test(rowDisplay) &&
    /secondBestRate/.test(rowDisplay) &&
    /second_best_rate/.test(rowDisplay) &&
    /readRateTotalAmount/.test(rowDisplay) &&
    !/getBestRateFinalBaseCost[\s\S]*getBackendRowMoney\(order\)/.test(rowDisplay),
);

check(
  'Best Rate Final renderer reads the backend DTO/cache and does not use getOrderWithAutoBestRate',
  /export function renderBestRateFinalCell/.test(rateCells) &&
    /getBestRateFinalBaseCost\(order\)/.test(rateCells) &&
    !/renderBestRateFinalCell[\s\S]*getOrderWithAutoBestRate/.test(rateCells),
);

check(
  'OrdersView delegates the Best Rate Final column to the pure renderer',
  /case 'bestRateFinal':\s*\n\s*return renderBestRateFinalCell\(order\)/.test(ordersView),
);

check(
  'Best Rate cell may use live overlay, but Best Rate Final stays outside the overlay leaf',
  /renderBestRatePrice[\s\S]*getOrderWithAutoBestRate/.test(cells) &&
    !/renderBestRateFinalCell/.test(cells),
);

check(
  'backend all-carrier second-best owner still lives in rates-combined',
  /const rankedEligibleRates = \[\.\.\.combinedRates\]/.test(ratesCombined) &&
    /rateTotal\(a\) - rateTotal\(b\)/.test(ratesCombined) &&
    /\|\| \(rateCostTotal\(a\) - rateCostTotal\(b\)\)/.test(ratesCombined) &&
    /const secondCheapest = rankedEligibleRates\[1\] \?\? null/.test(ratesCombined),
);

check(
  'Best Rate Final amount prefers backend cached secondBestRate and does not fall back to cheapest',
  getBestRateFinalBaseCost({
    orderId: 1,
    orderNumber: 'A',
    clientId: 1,
    orderStatus: 'awaiting_shipment',
    bestRate: { shipmentCost: 6, otherCost: 0, secondBestRate: { shipmentCost: 9, otherCost: 1 } },
    bestRateWorkflow: { money: { markedAmount: 12, rateCostAmount: 7.25, houseRateAmount: 6.9 } },
  } as any) === 10 &&
    getBestRateFinalBaseCost({
      orderId: 2,
      orderNumber: 'B',
      clientId: 1,
      orderStatus: 'awaiting_shipment',
      bestRate: { shipmentCost: 6, otherCost: 0, raw: { second_best_rate: { totalCost: 11.25 } } },
      bestRateWorkflow: { money: { markedAmount: 12, rateCostAmount: 7.25, houseRateAmount: null } },
    } as any) === 11.25 &&
    getBestRateFinalBaseCost({
      orderId: 3,
      orderNumber: 'C',
      clientId: 1,
      orderStatus: 'awaiting_shipment',
      bestRate: { shipmentCost: 9, otherCost: 1 },
      bestRateWorkflow: null,
    } as any) == null,
);

check(
  'frontend does not resurrect a rate ranking owner',
  !/\bpickBestRate\s*\(|rankedEligibleRates|rateTotal\(a\) - rateTotal\(b\)/.test(rateCells + ordersView + columns),
);

if (failures > 0) {
  console.error(`\nBest Rate Final column guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nBest Rate Final column guard passed.');
