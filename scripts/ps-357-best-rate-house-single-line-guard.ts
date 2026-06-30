/**
 * PS-357 guard - Best Rate hides the internal/customer tuple for HOUSE rows.
 *
 * Backend still owns the money tuple. This guard pins the display-only rule:
 * HOUSE Best Rate shows the DJR purchase cost once with HOUSE underneath; only
 * true marked carrier accounts may show customer-over-base in the Best Rate cell.
 *
 * Offline only: no DB, no providers, no labels, no postage, no marketplace
 * notifications, no inventory, and no production order/shipment edits.
 */
import { readFileSync } from 'node:fs';
import { resolveAwaitingBestRatePriceDisplay } from '../web/src/components/Views/orders/best-rate-price-display';

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

const houseDisplay = resolveAwaitingBestRatePriceDisplay({
  markupSource: 'house_account',
  rateCostAmount: 6.82,
  baseAmount: 6.82,
  customerRateAmount: 9.25,
  markedAmount: 9.25,
  insuranceAddOn: 1.09,
  fallbackAmount: 6.82,
});

check(
  'HOUSE Best Rate displays only the DJR purchase cost with HOUSE underneath',
  houseDisplay.mode === 'house_purchase_only' &&
    houseDisplay.primaryAmount === 6.82 &&
    houseDisplay.baseAmount === null &&
    houseDisplay.insuranceAddOn === null &&
    houseDisplay.showHouseBadge === true,
  houseDisplay,
);

const markedCarrierDisplay = resolveAwaitingBestRatePriceDisplay({
  markupSource: 'carrier_markup',
  rateCostAmount: 12.82,
  baseAmount: 12.82,
  customerRateAmount: 14.74,
  markedAmount: 14.74,
  insuranceAddOn: null,
  fallbackAmount: 12.82,
});

check(
  'marked carrier Best Rate may show customer amount over base cost',
  markedCarrierDisplay.mode === 'carrier_marked_breakdown' &&
    markedCarrierDisplay.primaryAmount === 14.74 &&
    markedCarrierDisplay.baseAmount === 12.82 &&
    markedCarrierDisplay.showHouseBadge === false,
  markedCarrierDisplay,
);

const flatCarrierDisplay = resolveAwaitingBestRatePriceDisplay({
  markupSource: 'carrier_markup',
  rateCostAmount: 6.82,
  baseAmount: 6.82,
  customerRateAmount: 6.82,
  markedAmount: 6.82,
  insuranceAddOn: null,
  fallbackAmount: 6.82,
});

check(
  'unmarked carrier Best Rate displays a single amount',
  flatCarrierDisplay.mode === 'single_amount' &&
    flatCarrierDisplay.primaryAmount === 6.82 &&
    flatCarrierDisplay.baseAmount === null &&
    flatCarrierDisplay.showHouseBadge === false,
  flatCarrierDisplay,
);

const orderCellsSrc = read('web/src/components/Views/orders/cells/order-cells.tsx');
const sidePanelSrc = read('web/src/components/Views/OrdersDetailSidePanel.tsx');

check(
  'Best Rate cell delegates the display tuple decision to the focused display policy',
  orderCellsSrc.includes('resolveAwaitingBestRatePriceDisplay') &&
    /renderRateAmountWithMarkup\(\s*bestRatePriceDisplay\.baseAmount,\s*bestRatePriceDisplay\.primaryAmount/.test(orderCellsSrc) &&
    !/renderRateAmountWithMarkup\(backendBestRateCost,\s*backendBestRateCustomer/.test(orderCellsSrc),
);

check(
  'Best Rate cell renders HOUSE under the price instead of beside a two-rate tuple',
  /bestRatePriceDisplay\??\.showHouseBadge \? renderHouseBadge\(\) : null/.test(orderCellsSrc),
);

check(
  'detail panel rate display delegates to the same focused display policy as the Best Rate cell',
  sidePanelSrc.includes('resolveAwaitingBestRatePriceDisplay') &&
    /sidePanelBestRatePriceDisplay\??\.primaryAmount/.test(sidePanelSrc) &&
    !/getBackendRowMoney\(panelDisplayOrder\)\?\.markedAmount\s*\?\?\s*getBestRateBaseCost/.test(sidePanelSrc),
);

if (failures > 0) {
  console.error(`\nFAIL PS-357 Best Rate HOUSE single-line guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-357 Best Rate HOUSE single-line guard');
