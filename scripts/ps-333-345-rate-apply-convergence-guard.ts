/**
 * PS-333 / PS-345 - Rate Browser apply convergence guard.
 *
 * DJ live re-audit found order #1979 could show one Awaiting amount, a different
 * Rate Browser amount, then persist a third amount after Apply. This guard pins
 * the backend source-of-truth fix: Apply Best Rate must resolve the clicked
 * backend quote snapshot row by (rateQuoteId, selectedRateKey) and persist that
 * finalized backend DTO. The frontend-carried row object is never persistence
 * authority when backend quote identity is absent.
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
  return readFileSync(path, 'utf8');
}

function money(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

const ordersRoute = read('src/routes/orders.ts');
const ordersCommand = read('src/services/orders-overrides-command.ts');
const applyBestRateService = read('src/services/shipping-workflow/apply-best-rate.ts');
const packageJson = read('package.json');

const applyRouteStart = ordersRoute.indexOf("'/:id{[0-9]+}/apply-best-rate'");
const applyRouteEnd = applyRouteStart >= 0 ? ordersRoute.indexOf("'/:id{[0-9]+}/selected-package-id'", applyRouteStart) : -1;
const applyRoute = applyRouteStart >= 0 && applyRouteEnd > applyRouteStart
  ? ordersRoute.slice(applyRouteStart, applyRouteEnd)
  : '';

check('guard found the backend Apply Best Rate route', applyRoute.length > 0);
check(
  'Apply Best Rate command resolves backend quote snapshots before persisting',
  /loadRateQuoteSnapshot/.test(ordersCommand) &&
    /finalizeAppliedBestRateFromSnapshot/.test(ordersCommand) &&
    /bestRateJsonForApply/.test(ordersCommand) &&
    /applyBestRateForOrder/.test(applyRoute),
);
check(
  'Apply Best Rate command stamps the same house tuple verdict as saved best-rate persistence',
  /stampHouseTuple\(/.test(ordersCommand) &&
    /houseTupleStatus/.test(ordersCommand) &&
    /HOUSE_TUPLE_REQUIRED/.test(ordersCommand),
);
check(
  'apply-best-rate service exposes the backend snapshot finalizer',
  /export function finalizeAppliedBestRateFromSnapshot/.test(applyBestRateService),
);
check(
  'package wires PS-333/345 apply convergence guard',
  packageJson.includes('"test:ps-333-345-rate-apply-convergence"'),
);

const selectedRateKey = 'srk_ps333_345_order_1979';
const backendSelectedRate = {
  carrier_id: 'se-596001',
  carrier_code: 'ups',
  service_code: 'ups_ground',
  service_type: 'UPS Ground',
  shipping_amount: { amount: 9.65, currency: 'USD' },
  other_amount: { amount: 3.93, currency: 'USD' },
  amount: 9.65,
  shipmentCost: 9.65,
  otherCost: 3.93,
  customerRateAmount: 13.58,
  customer_rate_amount: 13.58,
  rateCostAmount: 13.58,
  rate_cost_amount: 13.58,
  selectedRateKey,
};
const rateQuoteId = 'rq_ps333_345_order_1979';
const snapshot = {
  cacheKey: 'ps333|order=1979|pkg=596001|w=8lb6oz|dims=15x11x10',
  rates: [backendSelectedRate],
  fetchedAt: '2026-06-26T08:00:00.000Z',
  bestRateKey: selectedRateKey,
  bestRateComplete: true,
};
const frontendDoubleMarkedPayload = {
  ...backendSelectedRate,
  amount: 15.62,
  shipmentCost: 13.58,
  otherCost: 0,
  customerRateAmount: 15.62,
  customer_rate_amount: 15.62,
  rateCostAmount: 13.58,
  rate_cost_amount: 13.58,
  rateQuoteId,
  selectedRateKey,
};

const applyModule = await import('../src/services/shipping-workflow/apply-best-rate') as Record<string, unknown>;
const finalize = applyModule.finalizeAppliedBestRateFromSnapshot as undefined | ((input: {
  fallbackRate: unknown;
  rateQuoteId: string | null;
  selectedRateKey: string | null;
  snapshot: typeof snapshot | null;
  now?: number;
}) => { ok: boolean; bestRateJson?: Record<string, unknown>; code?: string; error?: string });

if (typeof finalize === 'function') {
  const finalized = finalize({
    fallbackRate: frontendDoubleMarkedPayload,
    rateQuoteId,
    selectedRateKey,
    snapshot,
    now: Date.parse('2026-06-26T09:00:00.000Z'),
  });
  const rate = finalized.bestRateJson ?? {};
  check('snapshot finalizer succeeds for a backend-selected rate key', finalized.ok === true, finalized);
  check(
    'snapshot finalizer uses backend snapshot customer amount instead of frontend double-marked amount',
    money(rate.customerRateAmount) === 13.58 &&
      money(rate.customer_rate_amount) === 13.58 &&
      money(rate.amount) === 13.58,
    rate,
  );
  check(
    'snapshot finalizer stamps backend proof and freshness fields for Awaiting reload convergence',
    rate.requestFingerprint === snapshot.cacheKey &&
      rate.cacheKey === snapshot.cacheKey &&
      rate.rateQuoteId === rateQuoteId &&
      rate.selectedRateKey === selectedRateKey &&
      rate.proofSource === 'backend_rate_response' &&
      rate.isComplete === true &&
      typeof rate.cacheCreatedAt === 'string' &&
      typeof rate.cacheExpiresAt === 'string',
    rate,
  );
} else {
  check('snapshot finalizer behavior is implemented', false);
}

if (failures > 0) {
  console.error(`\nFAIL PS-333/345 rate apply convergence guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-333/345 rate apply convergence guard');
