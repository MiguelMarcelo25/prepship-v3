/**
 * PS-357 guard - operator-facing rate language after PS-356.
 *
 * Canonical terms:
 * - Best Rate = DJR/DRP purchase cost.
 * - C. Shipping Rate = customer-facing billing shipping rate.
 * - DJR Purchase Cost = internal/admin cost basis when shown in Rate Browser details.
 *
 * This guard is static/offline only. It does not call providers, mutate orders,
 * buy labels, touch shipments, or perform marketplace/inventory side effects.
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
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const visibleUiFiles = [
  'web/src/components/RateBrowserModal.tsx',
  'web/src/components/RateRowItem.tsx',
  'web/src/components/Views/orders-rate-cells.tsx',
  'web/src/components/Views/orders-table-columns.ts',
  'web/src/components/Views/orders/cells/order-cells.tsx',
  'web/src/components/Views/orders-row-display.tsx',
  'web/src/components/Views/OrdersDetailSidePanel.tsx',
  'web/src/components/Views/OrdersView.tsx',
];

for (const file of visibleUiFiles) {
  const source = read(file);
  check(`${file} has no operator-facing "Rate Cost" breadcrumb`, !/Rate Cost/.test(source));
  check(`${file} has no operator-facing "House Rate" breadcrumb`, !/House Rate/.test(source));
}

const rateBrowserModal = read('web/src/components/RateBrowserModal.tsx');
check(
  'Rate Browser tooltip uses canonical C. Shipping / DJR purchase / Margin terms',
  rateBrowserModal.includes('C. Shipping Rate $') &&
    rateBrowserModal.includes('DJR Purchase Cost $') &&
    rateBrowserModal.includes('Margin $') &&
    !rateBrowserModal.includes('Customer Rate $') &&
    !rateBrowserModal.includes('Rate Cost $') &&
    !rateBrowserModal.includes('Spread $'),
);

const rateRowItem = read('web/src/components/RateRowItem.tsx');
check(
  'Rate Browser row admin annotation says DJR Purchase Cost, not Rate Cost',
  rateRowItem.includes('DJR Purchase Cost $') && !rateRowItem.includes('Rate Cost $'),
);

const rateCells = read('web/src/components/Views/orders-rate-cells.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
check(
  'C. Shipping Rate cell helper is named by customer-billing display, not old Rate Cost wording',
  rateCells.includes('export function renderCShippingRateCell') &&
    !rateCells.includes('renderRateCostCell') &&
    ordersView.includes('renderCShippingRateCell') &&
    !ordersView.includes('renderRateCostCell'),
);

const columns = read('web/src/components/Views/orders-table-columns.ts');
check(
  'ratecost remains only as a documented legacy column key for saved preferences',
  columns.includes("key: 'ratecost', label: 'C. Shipping Rate'") &&
    /legacy compatibility key/i.test(columns) &&
    !/label:\s*'Rate Cost'/.test(columns),
);

const orderRateDto = read('src/services/order-rate-dto.ts');
const rateMoney = read('src/services/shipping-workflow/rate-money.ts');
check(
  'backend DTO comments no longer say Best/Selected Rate uses customerRateAmount',
  !/Best\/Selected Rate uses customerRateAmount/.test(orderRateDto) &&
    !/Best\/Selected Rate\s*=\s*customerRateAmount/.test(rateMoney),
);

const ps308FeGuard = read('scripts/ps-308-fe-rate-cost-column-guard.ts');
const ps308BrowserGuard = read('scripts/ps-308-rate-browser-no-tuple-guard.ts');
check(
  'old PS-308 guards now enforce PS-356/PS-357 canonical copy',
  ps308FeGuard.includes('renderCShippingRateCell') &&
    ps308BrowserGuard.includes('DJR Purchase Cost') &&
    !ps308BrowserGuard.includes('/Rate Cost/'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-357 rate-language breadcrumb guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-357 rate-language breadcrumb guard');
