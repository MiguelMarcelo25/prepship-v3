/**
 * PS-308 closeout guard - separated Best/Selected Rate, Rate Cost, and Margin.
 *
 * Offline only: no DB, network, providers, labels, postage, marketplace
 * notifications, queue mutation, or shipped/cancelled data mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { redactOrderFinancials } from '../src/services/orders-financial-redaction';
import { redactRateBrowserMoney } from '../src/services/rate-browser-money-redaction';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { rateCostTotal, rateTotal } from '../src/services/rates-combined';
import { buildOrderRowMoneyDisplay } from '../src/services/shipping-workflow/rate-money';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

function closeTo(actual: unknown, expected: number, epsilon = 0.001): boolean {
  return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
}

const statusPath = 'docs/ps-tickets/ps-308-rate-cost-columns-status.md';
const statusDoc = existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : '';
const packageJson = readFileSync('package.json', 'utf8');
const workflowDoc = readFileSync('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md', 'utf8');
const ps308Guard = readFileSync('scripts/ps-308-rate-cost-columns-guard.ts', 'utf8');
const rateMoney = readFileSync('src/services/shipping-workflow/rate-money.ts', 'utf8');
const ratesCombined = readFileSync('src/services/rates-combined.ts', 'utf8');
const orderRateDto = readFileSync('src/services/order-rate-dto.ts', 'utf8');
const orderRedaction = readFileSync('src/services/orders-financial-redaction.ts', 'utf8');
const rateBrowserRedaction = readFileSync('src/services/rate-browser-money-redaction.ts', 'utf8');
const rateRowItem = readFileSync('web/src/components/RateRowItem.tsx', 'utf8');

check('PS-308 status doc exists', existsSync(statusPath));
check('status doc marks PS-308 Final Review-ready at 89%',
  /PS-308 89%/.test(statusDoc) && /Final Review-ready/.test(statusDoc));
check('status doc lists feature and closeout guards',
  statusDoc.includes('`test:ps-308-rate-cost-columns`') &&
    statusDoc.includes('`test:ps-308-rate-cost-columns-closeout`'));
check('status doc declares PS-308 supersedes PS-292 tuple direction',
  /PS-308 supersedes the old PS-292 stacked SHIPP tuple direction/.test(statusDoc));
check('status doc keeps production/admin spot-check as not-100% evidence',
  /Missing Before 100%/.test(statusDoc) && /Read-only production\/admin spot-check/.test(statusDoc));
check('status doc documents offline-only safety',
  /offline-only/.test(statusDoc) &&
    /does not run live carrier calls/.test(statusDoc) &&
    /mutate shipped\/cancelled data/.test(statusDoc));

check('package wires PS-308 feature guard',
  /"test:ps-308-rate-cost-columns"\s*:\s*"tsx scripts\/ps-308-rate-cost-columns-guard\.ts"/.test(packageJson));
check('package wires PS-308 closeout guard',
  /"test:ps-308-rate-cost-columns-closeout"\s*:\s*"tsx scripts\/ps-308-rate-cost-columns-closeout-guard\.ts"/.test(packageJson));
check('PS-300 workflow requires PS-308 closeout guard',
  workflowDoc.includes('test:ps-308-rate-cost-columns-closeout'));
check('PS-308 feature guard pins separated money behavior',
  /customer charge separate from internal rate cost/.test(ps308Guard) &&
    /order financial redaction hides separated internal rate-cost fields/.test(ps308Guard) &&
    /Rate Browser no longer renders SHIPP House as a stacked price tuple/.test(ps308Guard));

const houseAwaiting = buildOrderRowMoneyDisplay({
  isAwaiting: true,
  bestRateBaseAmount: 7.75,
  selectedRateBaseAmount: null,
  labelFinalCost: null,
  markupRule: { type: 'percent', value: 50 },
  insuranceAddOn: null,
  houseMarkedAmount: 8.05,
});
check('runtime fixture separates house customer rate from SHIPP internal rate cost',
  houseAwaiting?.customerRateAmount === 8.05 &&
    houseAwaiting.rateCostAmount === 7.75 &&
    closeTo(houseAwaiting.shippingMarginAmount, 0.3) &&
    houseAwaiting.customerRateSource === 'projected_house_customer_rate' &&
    houseAwaiting.rateCostSource === 'shipp_house_internal_cost',
  houseAwaiting);

const splitRate = {
  shipping_amount: { amount: 8.5 },
  other_amount: { amount: 0 },
  customerRateAmount: 12,
  rateCostAmount: 8.5,
};
check('runtime fixture keeps customer ranking separate from internal Rate Cost',
  rateTotal(splitRate) === 12 && rateCostTotal(splitRate) === 8.5);

const normalized = normalizeOrderBestRateDto({
  carrierCode: 'ups',
  serviceCode: 'shipp_ups_ground',
  shipmentCost: 8.5,
  otherCost: 0,
  nextBestNonHouseRate: { totalCost: 9.64, shipmentCost: 9.64, otherCost: 0 },
  houseMargin: 1.14,
});
check('runtime fixture derives separated fields for older house best-rate rows',
  normalized?.customerRateAmount === 9.64 &&
    normalized.rateCostAmount === 8.5 &&
    normalized.shippingMarginAmount === 1.14 &&
    normalized.houseApplied === true,
  normalized);

const redactedOrder = redactOrderFinancials({
  shipping: {
    customerRateAmount: 12,
    rateCostAmount: 8.5,
    shippingMarginAmount: 3.5,
    shippingMarginPct: 29.2,
  },
  bestRateWorkflow: {
    money: {
      customerRateAmount: 12,
      rateCostAmount: 8.5,
      shippingMarginAmount: 3.5,
    },
  },
}, false) as any;
check('runtime fixture redacts internal order money fields from non-financial viewers',
  redactedOrder.shipping.customerRateAmount === null &&
    redactedOrder.shipping.rateCostAmount === null &&
    redactedOrder.shipping.shippingMarginAmount === null &&
    redactedOrder.bestRateWorkflow.money === null,
  redactedOrder);

const redactedRateBrowser = redactRateBrowserMoney({
  bestRate: {
    service_code: 'shipp_ups_ground',
    customerRateAmount: 12,
    rateCostAmount: 8.5,
    shippingMarginAmount: 3.5,
    rateCostSource: 'shipp_house_internal_cost',
  },
}) as any;
check('runtime fixture redacts internal Rate Browser money fields from non-financial viewers',
  redactedRateBrowser.bestRate.service_code === 'shipp_ups_ground' &&
    redactedRateBrowser.bestRate.customerRateAmount === null &&
    redactedRateBrowser.bestRate.rateCostAmount === null &&
    redactedRateBrowser.bestRate.shippingMarginAmount === null &&
    redactedRateBrowser.bestRate.rateCostSource === null,
  redactedRateBrowser);

check('backend money owner declares separated PS-308 field names and sources',
  /customerRateAmount/.test(rateMoney) &&
    /rateCostAmount/.test(rateMoney) &&
    /shippingMarginAmount/.test(rateMoney) &&
    /customerRateSource/.test(rateMoney) &&
    /rateCostSource/.test(rateMoney));
check('combined-rate owner documents Rate Cost is not the ranking basis',
  /export function rateCostTotal/.test(ratesCombined) &&
    /Never use this for cheapest ranking/.test(ratesCombined));
check('OrderBestRateDto preserves separated fields',
  /customerRateAmount/.test(orderRateDto) &&
    /rateCostAmount/.test(orderRateDto) &&
    /shippingMarginAmount/.test(orderRateDto));
check('redaction owners scrub separated Rate Cost and margin fields',
  /rateCostAmount/.test(orderRedaction) &&
    /shippingMarginAmount/.test(orderRedaction) &&
    /rateCostAmount/.test(rateBrowserRedaction) &&
    /shippingMarginAmount/.test(rateBrowserRedaction));
// PS-308 (2026-06-23): the Rate Browser row was corrected to the SEPARATED form — the customer
// comparison rate is the primary price and the internal Rate Cost is a delineated admin block;
// Margin is NOT rendered in the row (it lives in the Awaiting/Shipped columns, per the card's Rate
// Browser spec). The prior assertion required a rendered "Margin" line, which pinned the very
// stacked tuple this card removes; it is replaced with positive separation + tuple-absence checks.
check('RateRowItem renders the customer rate as primary + a SEPARATED admin Rate Cost (no stacked tuple)',
  /houseTuple\.customerRate\.toFixed\(2\)/.test(rateRowItem) &&
    /data-ps308-internal-cost/.test(rateRowItem) &&
    /Rate Cost/.test(rateRowItem) &&
    /renderHouseBadge/.test(rateRowItem) &&
    !/houseTuple\.customerRate\s*-\s*houseTuple\.drpCost/.test(rateRowItem) &&
    !/Margin \$\{/.test(rateRowItem) &&
    !/priceDisplay\(houseTuple\.drpCost,\s*houseTuple\.customerRate/.test(rateRowItem));

if (failures > 0) {
  console.error(`\nFAIL PS-308 rate-cost columns closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-308 rate-cost columns closeout guard');
