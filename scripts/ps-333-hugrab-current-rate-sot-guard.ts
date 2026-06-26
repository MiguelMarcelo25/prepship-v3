/**
 * PS-333 - HUGRAB current-rate source-of-truth guard.
 *
 * Proves saved quote display and HUGRAB margin math are tied to the current
 * backend package/rating facts, not to stale saved snapshots or provider-name
 * shortcuts. Pure/offline: no DB, providers, labels, billing, or marketplace
 * mutations.
 */
import { readFileSync } from 'node:fs';
import { resolveNextBestNonHouseRate } from '../src/lib/next-best-non-house-rate';
import { buildBestRateWorkflowDto } from '../src/services/shipping-workflow/best-rate-workflow-dto';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';
import {
  awaitingRateCellIsSpinner,
  classifyAwaitingRateCellStateWithWorkflow,
} from '../web/src/components/Views/orders-parity';

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

const quote35OzFingerprint = buildShippingRateRequestFingerprint({
  version: 'ps-333',
  shipDateBucket: '2026-06-26',
  weightOz: 35,
  dimsL: 12,
  dimsW: 10,
  dimsH: 3,
  toZip: '11364',
  toCountry: 'US',
  residential: true,
});

const workflow = buildBestRateWorkflowDto({
  savedBestRate: {
    amount: 9.04,
    carrierCode: 'stamps_com',
    serviceCode: 'usps_ground_advantage',
    proofSource: 'backend_rate_response',
    isComplete: true,
    requestFingerprint: quote35OzFingerprint,
    cacheExpiresAt: '2026-06-27T00:00:00.000Z',
    cacheCreatedAt: '2026-06-26T08:00:00.000Z',
  },
  source: 'saved_override',
  now: new Date('2026-06-26T09:00:00.000Z'),
  currentShipmentFacts: {
    weightOz: 31,
    dimsL: 12,
    dimsW: 10,
    dimsH: 3,
    toZip: '11364',
    toCountry: 'US',
    residential: true,
  },
} as Parameters<typeof buildBestRateWorkflowDto>[0] & { currentShipmentFacts: Record<string, unknown> });

check(
  'saved 35 oz quote cannot display as current when backend package SOT is 31 oz',
  workflow.bestRateState === 'mismatched_request' &&
    workflow.canDisplayFinalRate === false &&
    workflow.allowedActions.canCreateLabel === false,
  workflow,
);

const mismatchedCellState = classifyAwaitingRateCellStateWithWorkflow(workflow, {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: false,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
  isAutoRatingActive: false,
});
check(
  'mismatched current-rate row is actionable stale, not a loading spinner',
  mismatchedCellState === 'stale' && !awaitingRateCellIsSpinner(mismatchedCellState),
  mismatchedCellState,
);

const ordersViewSource = read('web/src/components/Views/OrdersView.tsx');
check(
  'awaiting stale fallback renders a re-rate action before the spinner branch',
  /case 'stale':[\s\S]*data-rate-state="stale"[\s\S]*Re-rate needed[\s\S]*case 'deferred':/.test(ordersViewSource),
  false,
);

const HUGRAB_CONTEXT = { clientId: 4, clientName: 'HUGRAB', storeId: 378060 };

const ROCK_BOTTOM_USPS = {
  provider: 'shipstation',
  carrier_code: 'stamps_com',
  carrier_id: 'se-3003',
  service_code: 'usps_ground_advantage',
  service_name: 'USPS Ground Advantage',
  shipping_amount: { amount: 9.04 },
  other_amount: { amount: 0 },
};

const SHIPP_SECOND_ELIGIBLE = {
  provider: 'shipp',
  carrier_code: 'ups',
  carrier_id: 'se-1001',
  service_code: 'ups_ground',
  service_name: 'UPS Ground',
  shipping_amount: { amount: 10.54 },
  other_amount: { amount: 0 },
};

const ROCEL_THIRD_ELIGIBLE = {
  provider: 'ups',
  carrier_code: 'ups',
  carrier_id: 'se-2002',
  service_code: 'ups_ground',
  service_name: 'UPS Ground',
  shipping_amount: { amount: 13.00 },
  other_amount: { amount: 0 },
};

const customerRate = resolveNextBestNonHouseRate({
  eligibleRates: [ROCK_BOTTOM_USPS, SHIPP_SECOND_ELIGIBLE, ROCEL_THIRD_ELIGIBLE],
  context: HUGRAB_CONTEXT,
  shippingOptions: { insuranceProvider: 'none', insuredValue: 0 },
  client: { shippingMarginPolicy: { mode: 'next_best_customer_rate' } } as never,
});

check(
  'HUGRAB customer rate is the next eligible rate above rock-bottom, even when that rate is SHIPP',
  customerRate?.rate === SHIPP_SECOND_ELIGIBLE &&
    customerRate.total === 10.54 &&
    customerRate.competitorCount === 2,
  customerRate,
);

const backfillSrc = read('src/services/rates-backfill.ts');
check(
  'rates backfill selects order override rate weight as a current package fact',
  /rateWeightOz:\s*orderOverrides\.rateWeightOz/.test(backfillSrc),
);
check(
  'rates backfill filters on effective override/imported weight instead of imported-only weight',
  /coalesce\(\$\{orderOverrides\.rateWeightOz\},\s*\$\{orders\.weightOz\}\)/.test(backfillSrc),
);

const ordersRouteSrc = read('src/routes/orders.ts');
check(
  'orders list passes current shipment facts into the best-rate workflow owner',
  /currentShipmentFacts:/.test(ordersRouteSrc) && /rowWeightOz/.test(ordersRouteSrc),
);

const useOrdersSrc = read('web/src/hooks/useOrders.ts');
check(
  'useOrders does not rebuild Awaiting visible Best Rate from overrides/selected fallbacks',
  !/bestRateLegacy/.test(useOrdersSrc) &&
    !/selectedRateBestFallback/.test(useOrdersSrc) &&
    !/displayBestRate\s*=[\s\S]*?\?\?[\s\S]*?bestRateJson/.test(useOrdersSrc) &&
    !/bestRateAmount:\s*toFiniteNumber\(shippingModel\.bestRateAmount\)\s*\?\?\s*toFiniteNumber\(displayBestRate\?\.amount\)/.test(useOrdersSrc),
);

const rateHelpersSrc = read('web/src/components/Views/orders/best-rate/rate-helpers.ts');
check(
  'Best Rate helpers no longer rewrite order/shipping objects as alternate visible-rate truth',
  !/function withBestRateOverride/.test(rateHelpersSrc) &&
    !/function withoutStaleBestRate/.test(rateHelpersSrc) &&
    /function getOrderWithAutoBestRate\(order: OrderSummaryDto\) \{[\s\S]*?return order[\s\S]*?\}/.test(rateHelpersSrc),
);

const rowDisplaySrc = read('web/src/components/Views/orders-row-display.tsx');
const bestRateBaseCostBlock = rowDisplaySrc.slice(
  rowDisplaySrc.indexOf('export function getBestRateBaseCost('),
  rowDisplaySrc.indexOf('export function getBestRateFinalBaseCost('),
);
check(
  'Awaiting Best Rate amount reads backend money customerRateAmount, not order.bestRate fallback math',
    /order\.orderStatus === 'awaiting_shipment'/.test(bestRateBaseCostBlock) &&
    /customerRateAmount/.test(bestRateBaseCostBlock) &&
    /markedAmount/.test(bestRateBaseCostBlock) &&
    /\?\? null/.test(bestRateBaseCostBlock) &&
    !/order\.bestRate|shipmentCost|otherCost/.test(bestRateBaseCostBlock),
);

const v2SharedSrc = read('web/src/lib/v2-apiClient/shared.ts');
check(
  'rate transport translation preserves backend-named money fields instead of minting a second money truth',
  /customerRateAmount: obj\.customerRateAmount \?\? null/.test(v2SharedSrc) &&
    /rateCostAmount: obj\.rateCostAmount \?\? null/.test(v2SharedSrc) &&
    /houseRateAmount: obj\.houseRateAmount \?\? null/.test(v2SharedSrc) &&
    /shippingMarginAmount: obj\.shippingMarginAmount \?\? null/.test(v2SharedSrc),
);

if (failures > 0) {
  console.error(`\nPS-333 HUGRAB current-rate SOT guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}

console.log('\nPS-333 HUGRAB current-rate SOT guard passed.');
