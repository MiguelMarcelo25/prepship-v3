/**
 * PS-329 - Orders wrapper source-of-truth cleanup guard.
 *
 * Protects the post-PS-313/333/334 contract: Awaiting Shipment rate display
 * consumes the backend-stamped bestRateWorkflow money/display tuple, while the
 * frontend may only pass through cached rate objects for display. The frontend
 * must not rebuild shipping.bestRate or overwrite canonical shipping/account
 * facts from a locally-normalized "Best Rate" wrapper.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function read(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${String(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = start >= 0 ? source.indexOf(endNeedle, start + startNeedle.length) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

const useOrders = read('web/src/hooks/useOrders.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const rateHelpers = read('web/src/components/Views/orders/best-rate/rate-helpers.ts');

const transformBlock = sliceBetween(
  useOrders,
  'function transformOrderRowV4toV2(',
  '\nfunction toIsoStart',
);
const shippingBlock = sliceBetween(transformBlock, 'const shipping = shippingModel', '\n\n  return {');

check('guard located useOrders transform block', transformBlock.length > 1000);
check('guard located useOrders shipping rewrite block', shippingBlock.length > 100);

check(
  'useOrders no longer creates a displayBestRate alternate rate authority',
  !/\bdisplayBestRate\b/.test(transformBlock) && !/\bhasPositiveRateAmount\b/.test(useOrders),
);

check(
  'useOrders does not normalize backend Best Rate into a rewritten row wrapper',
  !/normalizeRateForV2\(shippingModel\?\.bestRate\s*\?\?\s*row\.bestRate\)/.test(transformBlock),
);

check(
  'useOrders does not backfill canonical shipping carrier/service/account from Best Rate',
  !/bestRate\?\.carrierCode|bestRate\?\.serviceCode|bestRate\?\.carrierNickname|displayBestRate\?\./.test(shippingBlock),
  shippingBlock,
);

check(
  'useOrders shipping object does not rewrite shipping.bestRate',
  !/\bbestRate\s*:/.test(shippingBlock),
  shippingBlock,
);

const bestRateBaseCostBlock = sliceBetween(
  rowDisplay,
  'export function getBestRateBaseCost(',
  '\nexport function getBestRateFinalBaseCost',
);
check(
  'Awaiting Best Rate amount renders backend money only, with no shipping.bestRateAmount fallback',
  /order\.orderStatus === 'awaiting_shipment'/.test(bestRateBaseCostBlock) &&
    /money\?\.customerRateAmount \?\? money\?\.markedAmount \?\? null/.test(bestRateBaseCostBlock) &&
    bestRateBaseCostBlock.indexOf("order.orderStatus === 'awaiting_shipment'") <
      bestRateBaseCostBlock.indexOf("getShippingNumber(order, 'bestRateAmount')"),
  bestRateBaseCostBlock,
);

const bestRateAccountBlock = sliceBetween(
  rowDisplay,
  'export function getBestRateCarrierNickname(',
  '\nexport function getSelectedRateBaseCost',
);
check(
  'Awaiting Best Rate account display prefers backend bestRateWorkflow.display.accountNickname',
  /backendDisplayAccountNickname/.test(bestRateAccountBlock) &&
    bestRateAccountBlock.indexOf('backendDisplayAccountNickname') < bestRateAccountBlock.indexOf('rateNickname') &&
    /if \(order\.orderStatus === 'awaiting_shipment'\) return backendDisplayAccountNickname \?\? rateNickname/.test(bestRateAccountBlock),
  bestRateAccountBlock,
);

check(
  'Best Rate helpers do not rewrite order/shipping objects as alternate truth',
  !/function withBestRateOverride/.test(rateHelpers) &&
    !/function withoutStaleBestRate/.test(rateHelpers) &&
    /function getOrderWithAutoBestRate\(order: OrderSummaryDto\) \{[\s\S]*?return order[\s\S]*?\}/.test(rateHelpers),
);

if (failures > 0) {
  console.error(`\nPS-329 Orders wrapper SOT cleanup guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-329 Orders wrapper SOT cleanup guard passed.');
