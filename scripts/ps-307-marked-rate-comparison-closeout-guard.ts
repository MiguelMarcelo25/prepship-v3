/**
 * PS-307/PS-356 closeout guard - customer charge preservation plus marked/customer ranking packet.
 *
 * Offline only: no DB, network, providers, labels, postage, marketplace
 * notifications, queue mutation, or shipped/cancelled data mutation.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  combineCarrierUniverses,
  rateCostTotal,
  rateTotal,
  type CombinableRate,
} from '../src/services/rates-combined';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const statusPath = 'docs/ps-tickets/ps-307-marked-rate-comparison-status.md';
const statusDoc = existsSync(statusPath) ? readFileSync(statusPath, 'utf8') : '';
const packageJson = readFileSync('package.json', 'utf8');
const workflowDoc = readFileSync('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md', 'utf8');
const ps307Guard = readFileSync('scripts/ps-307-marked-rate-comparison-guard.ts', 'utf8');
const ratesCombined = readFileSync('src/services/rates-combined.ts', 'utf8');
const ratesService = readFileSync('src/services/rates.ts', 'utf8');

const lowRawHighCustomer: CombinableRate = {
  carrier_id: 'shipp-house',
  carrier_code: 'ups',
  provider: 'shipp',
  service_code: 'shipp_ups_ground',
  shipping_amount: { amount: 7 },
  customerRateAmount: 13,
  rateCostAmount: 7,
  other_amount: { amount: 0 },
};
const higherRawLowerCustomer: CombinableRate = {
  carrier_id: 'direct-ups',
  carrier_code: 'ups',
  provider: 'ups',
  service_code: 'ups_ground',
  shipping_amount: { amount: 10 },
  customerRateAmount: 11,
  rateCostAmount: 10,
  other_amount: { amount: 0 },
};

const combined = combineCarrierUniverses({
  ssRates: [higherRawLowerCustomer],
  ssCacheKey: 'ps-307-closeout',
  ssCached: false,
  ssDiagnostics: [{ carrierId: 'direct-ups', status: 'ok', rateCount: 1 }],
  directRates: [lowRawHighCustomer],
  directDiagnostics: [{ carrierId: 'shipp-house', status: 'ok', rateCount: 1 }],
  requestedCarrierIds: null,
  accountNamesByCarrierId: new Map([
    ['direct-ups', 'UPS'],
    ['shipp-house', 'SHIPP House'],
  ]),
  accountCarrierIds: ['direct-ups', 'shipp-house'],
  isCachedOnlyLookup: false,
});

check('PS-307 status doc exists', existsSync(statusPath));
check('status doc marks PS-307 Final Review-ready at 89%',
  /PS-307 89%/.test(statusDoc) && /Final Review-ready/.test(statusDoc));
check('status doc lists feature and closeout guards',
  statusDoc.includes('`test:ps-307-marked-rate-comparison`') &&
    statusDoc.includes('`test:ps-307-marked-rate-comparison-closeout`'));
check('status doc keeps production spot-check as not-100% evidence',
  /Missing Before 100%/.test(statusDoc) && /Read-only production spot-check/.test(statusDoc));
check('status doc documents offline-only safety',
  /offline-only/.test(statusDoc) &&
    /does not run live carrier calls/.test(statusDoc) &&
    /mutate shipped\/cancelled data/.test(statusDoc));

check('package wires PS-307 feature guard',
  /"test:ps-307-marked-rate-comparison"\s*:\s*"tsx scripts\/ps-307-marked-rate-comparison-guard\.ts"/.test(packageJson));
check('package wires PS-307 closeout guard',
  /"test:ps-307-marked-rate-comparison-closeout"\s*:\s*"tsx scripts\/ps-307-marked-rate-comparison-closeout-guard\.ts"/.test(packageJson));
check('PS-300 workflow requires PS-307 closeout guard',
  workflowDoc.includes('test:ps-307-marked-rate-comparison-closeout'));
check('PS-305 authority docs still include PS-307 feature guard',
  readFileSync('docs/ps-tickets/ps-305-authority-drift-guardrails.md', 'utf8')
    .includes('test:ps-307-marked-rate-comparison'));
check('PS-307 feature guard proves customer amount preservation plus marked/customer owner',
  /rateTotal prefers explicit customer shipping charge/.test(ps307Guard) &&
    /combined best-rate owner ranks by marked\/customer charge/.test(ps307Guard));

check('runtime fixture ranks lower customer charge as Best Rate while preserving internal cost',
  combined.cheapest?.service_code === 'ups_ground' &&
    combined.secondCheapest?.service_code === 'shipp_ups_ground' &&
    rateCostTotal(combined.cheapest) === 10 &&
    rateTotal(combined.cheapest) === 11 &&
    rateCostTotal(combined.secondCheapest!) === 7 &&
    rateTotal(combined.secondCheapest!) === 13,
  {
    cheapest: combined.cheapest?.service_code,
    cheapestCost: combined.cheapest ? rateCostTotal(combined.cheapest) : null,
    cheapestCustomer: combined.cheapest ? rateTotal(combined.cheapest) : null,
    secondCustomer: combined.secondCheapest ? rateTotal(combined.secondCheapest) : null,
  });
check('combined owner customer total prefers PS-307/PS-308 customer fields before raw cost',
  /rate\.customerRateAmount/.test(ratesCombined) &&
    /rate\.customer_rate_amount/.test(ratesCombined) &&
    /rate\.markedShippingAmount/.test(ratesCombined) &&
    /rate\.shipping_amount\?\.amount/.test(ratesCombined));
check('combined owner exposes internal rateCostTotal separately for PS-308 cost display',
  /export function rateCostTotal/.test(ratesCombined) &&
    /not the primary Best Rate pick basis/.test(ratesCombined));
check('rates service delegates local pick to combinedRateCostTotal and keeps customer total owner',
  /function rateCostTotal\(rate: Rate\): number \{\s*return combinedRateCostTotal\(rate as any\);\s*\}/s.test(ratesService) &&
    /function rateTotal\(rate: Rate\): number \{\s*return combinedRateTotal\(rate as any\);\s*\}/s.test(ratesService));
check('rates service keeps raw/internal cost separate from customer amount',
  /const amount = directCustomerShippingAmount\(rate\);/.test(ratesService) &&
    /const rawShippingCost = directRawShippingCost\(rate, amount\);/.test(ratesService) &&
    /customerRateAmount: amount/.test(ratesService) &&
    /rateCostAmount: rawShippingCost/.test(ratesService));

if (failures > 0) {
  console.error(`\nFAIL PS-307 marked-rate comparison closeout guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-307 marked-rate comparison closeout guard');
