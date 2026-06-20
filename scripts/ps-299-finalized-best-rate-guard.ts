/**
 * PS-299 guard - Awaiting best rate is finalized-only and ranked once.
 *
 * Read-only: pure backend owners only. No DB, no carrier APIs, no labels.
 */
import { combineCarrierUniverses, rateTotal } from '../src/services/rates-combined';
import { normalizeOrderBestRateDto } from '../src/services/order-rate-dto';
import { buildBestRateWorkflowDto } from '../src/services/shipping-workflow/best-rate-workflow-dto';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const baseCombine = {
  ssCacheKey: 'ss-key',
  ssCached: false,
  ssDiagnostics: [{ carrierId: 'se-ss', status: 'ok', rateCount: 2 }],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map([['se-ss', 'ShipStation']]),
  accountCarrierIds: ['se-ss'],
  isCachedOnlyLookup: false,
};

const combined = combineCarrierUniverses({
  ...baseCombine,
  ssRates: [
    {
      carrier_id: 'se-ss',
      service_code: 'ups_ground',
      shipping_amount: { amount: 11 },
      other_amount: { amount: 0 },
    },
    {
      carrier_id: 'se-ss',
      service_code: 'usps_ground_advantage',
      shipping_amount: { amount: 7 },
      other_amount: { amount: 0 },
    },
  ],
  directRates: [
    {
      carrier_id: 'se-direct',
      service_code: 'shipp_surepost',
      shipping_amount: { amount: 8 },
      other_amount: { amount: 0 },
    },
    {
      carrier_id: 'se-direct',
      service_code: 'unpriced',
      shipping_amount: { amount: 0 },
      other_amount: { amount: 0 },
    },
  ],
  directDiagnostics: [{ carrierId: 'se-direct', status: 'ok', rateCount: 2 }],
});

const rankedEligibleRates = (combined as any).rankedEligibleRates as unknown[] | undefined;
check('combined owner exposes ranked eligible rates', Array.isArray(rankedEligibleRates));
check(
  'best and second best come from one sorted finalized set',
  combined.cheapest?.service_code === 'usps_ground_advantage' &&
    (combined as any).secondCheapest?.service_code === 'shipp_surepost' &&
    Array.isArray(rankedEligibleRates) &&
    rankedEligibleRates.length === 3 &&
    rateTotal(rankedEligibleRates[0] as any) === 7 &&
    rateTotal(rankedEligibleRates[1] as any) === 8,
  {
    cheapest: combined.cheapest,
    secondCheapest: (combined as any).secondCheapest,
    rankedEligibleRates,
  },
);

const normalized = normalizeOrderBestRateDto({
  serviceCode: 'usps_ground_advantage',
  serviceName: 'USPS Ground Advantage',
  carrierCode: 'usps',
  shipmentCost: 7,
  otherCost: 0,
  requestFingerprint: 'fp-current',
  cacheKey: 'fp-current',
  cacheExpiresAt: '2026-06-20T15:30:00.000Z',
  eligibilityVersion: 'ground-saver-v2',
  isComplete: true,
  secondBestRate: {
    carrierCode: 'ups',
    serviceCode: 'ups_surepost',
    serviceName: 'UPS SurePost',
    shippingProviderId: 123,
    shipmentCost: 8,
    otherCost: 0,
    totalCost: 8,
  },
});

check(
  'best-rate normalizer preserves generic secondBestRate',
  (normalized as any)?.secondBestRate?.serviceCode === 'ups_surepost' &&
    (normalized as any)?.secondBestRate?.totalCost === 8,
  normalized,
);

const freshWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'fp-current',
  savedBestRate: {
    amount: 7,
    serviceCode: 'usps_ground_advantage',
    carrierCode: 'usps',
    requestFingerprint: 'fp-current',
    cacheExpiresAt: '2026-06-20T15:30:00.000Z',
    isComplete: true,
  },
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-ss', carrierName: 'ShipStation', status: 'cached', rateCount: 2 }],
  now: new Date('2026-06-20T15:00:00.000Z'),
});
check('fresh workflow explicitly allows final display', (freshWorkflow as any).canDisplayFinalRate === true, freshWorkflow);

const staleWorkflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: 'fp-current',
  savedBestRate: {
    amount: 7,
    serviceCode: 'usps_ground_advantage',
    carrierCode: 'usps',
    requestFingerprint: 'fp-current',
    cacheExpiresAt: '2026-06-20T14:59:59.000Z',
    isComplete: true,
  },
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-ss', carrierName: 'ShipStation', status: 'cached', rateCount: 2 }],
  now: new Date('2026-06-20T15:00:00.000Z'),
});
check('stale workflow does not allow final display', (staleWorkflow as any).canDisplayFinalRate === false, staleWorkflow);
check('stale workflow no longer marks saved rate displayable', staleWorkflow.savedRateDisplay === 'none', staleWorkflow);

if (failures > 0) {
  console.error(`\nFAIL PS-299 finalized best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-299 finalized best-rate guard');
