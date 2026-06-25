/**
 * PS-317 — Best-Rate boundary guard (BEHAVIORAL + STATIC).
 *
 * The Best-Rate helpers were extracted out of OrdersView.tsx into the pure,
 * testable modules under web/src/components/Views/orders/best-rate/. This guard
 * is the first-ever UNIT test of that rate orchestration (the repo's sanctioned
 * unit mechanism is a tsx guard with node:assert — there is no vitest) AND it
 * pins the FE/backend rate boundary: the FE shapes requests + projects display
 * state, but never mints a fingerprint, never ranks a rate, and forwards the
 * backend residential/insurance verdicts.
 *
 *   npx tsx scripts/best-rate-boundary-guard.ts
 */
import { readFileSync } from 'node:fs';
import { buildRateRequestDraftKey, residentialForRate, orderShippingHold } from '../web/src/components/Views/orders/best-rate/rate-request';
import { getBackendRateResponseFingerprint, getRateBaseAmount, withRateRequestMetadata, getSavedBestRateRecord } from '../web/src/components/Views/orders/best-rate/rate-proof';
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION } from '../src/lib/shipping-service-eligibility';
// NOTE: rate-helpers.ts is the state-bound factory; it transitively imports a Vite-only module
// (import.meta.env via api-base) so it can't be imported in node — it is covered by STATIC pins below.

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const BASE = 'web/src/components/Views/orders/best-rate';
const rateRequestSrc = readFileSync(`${BASE}/rate-request.ts`, 'utf8');
const rateProofSrc = readFileSync(`${BASE}/rate-proof.ts`, 'utf8');
const rateHelpersSrc = readFileSync(`${BASE}/rate-helpers.ts`, 'utf8');

// ── buildRateRequestDraftKey: pure, deterministic, fingerprint-independent (PS-143) ──
const draftInput = {
  weightOz: 32,
  dims: { length: 8, width: 6, height: 4 },
  shipTo: { postalCode: '90001', country: 'US', state: 'CA', city: 'Los Angeles' } as any,
  residential: true,
  carrierIds: ['se-2', 'se-1'],
  storeId: null,
  clientId: 42,
  confirmation: 'none',
  insuranceProvider: 'none',
  insuredValue: null,
};
const key1 = buildRateRequestDraftKey(draftInput);
const key2 = buildRateRequestDraftKey(draftInput);
check('draft key is deterministic (same input -> same key)', key1 === key2);
check('draft key encodes residential as r=1', key1.includes('r=1'));
check('draft key encodes commercial as r=0',
  buildRateRequestDraftKey({ ...draftInput, residential: false }).includes('r=0'));
check('draft key sorts carrier ids (stable identity)', key1.includes('c=se-1,se-2'));
check('PS-143: draft key never contains a backend fingerprint token',
  !/requestFingerprint|fingerprint/i.test(key1));
check('draft key omits insurance when provider is none', !key1.includes('ip='));
check('draft key includes insurance when a provider + value are set',
  buildRateRequestDraftKey({ ...draftInput, insuranceProvider: 'parcelguard', insuredValue: 100 }).includes('ip=parcelguard'));

// ── residentialForRate: forwards the backend verdict, residential-safe default ──
check('residentialForRate: commercial verdict -> false', residentialForRate({ residentialClassification: 'commercial' }) === false);
check('residentialForRate: residential verdict -> true', residentialForRate({ residentialClassification: 'residential' }) === true);
check('residentialForRate: missing verdict -> residential-safe true', residentialForRate({}) === true);

// ── orderShippingHold: blocks shipped/cancelled, lets awaiting through ──
check('orderShippingHold blocks a cancelled order', orderShippingHold({ orderStatus: 'cancelled' })?.blocked === true);
check('orderShippingHold blocks a shipped order', orderShippingHold({ orderStatus: 'shipped' })?.blocked === true);
check('orderShippingHold lets an awaiting order through', orderShippingHold({ orderStatus: 'awaiting_shipment' }) === null);

// ── getBackendRateResponseFingerprint: READS the backend fingerprint, never mints ──
check('fingerprint reads response.requestFingerprint', getBackendRateResponseFingerprint({ requestFingerprint: 'abc123' }) === 'abc123');
check('fingerprint returns null when the backend issued none (no FE mint)', getBackendRateResponseFingerprint({}, {}) === null);
check('fingerprint tolerates null input', getBackendRateResponseFingerprint(null, null) === null);

// ── getRateBaseAmount: sums backend cost fields (display only, not a ranking) ──
check('base amount = shipmentCost + otherCost', getRateBaseAmount({ shipmentCost: 5, otherCost: 2 }) === 7);
check('base amount falls back to amount', getRateBaseAmount({ amount: 9 }) === 9);
check('base amount of zero stays zero', getRateBaseAmount({ shipmentCost: 0, otherCost: 0 }) === 0);

// ── withRateRequestMetadata: backend-owned expiry/insurance, eligibility stamp ──
const req: any = {
  detail: null, dims: { length: 1, width: 1, height: 1 }, dimsLabel: '1x1x1', weightOz: 16,
  shipTo: { postalCode: '90001' }, confirmation: 'none', carrierIds: [], insuranceProvider: 'none',
  insuredValue: null, draftKey: 'k', key: 'order-1|k',
};
const stamped = withRateRequestMetadata({ shipmentCost: 5 }, req, {}) as any;
check('withRateRequestMetadata stamps the eligibility version', stamped.eligibilityVersion === SHIPPING_SERVICE_ELIGIBILITY_VERSION);
check('PS-183: no backend expiry -> cacheExpiresAt null (FE mints no window)', stamped.cacheExpiresAt === null);
check('withRateRequestMetadata forwards the client request key', stamped.clientRequestKey === 'order-1|k');
const stampedBackend = withRateRequestMetadata({ shipmentCost: 5 }, req, { requestFingerprint: 'fp-9', effectiveInsuranceProvider: 'parcelguard', effectiveInsuredValue: 200 }) as any;
check('withRateRequestMetadata stamps the backend fingerprint when present', stampedBackend.requestFingerprint === 'fp-9');
check('PS-123: withRateRequestMetadata prefers the backend effective insurance', stampedBackend.insuranceProvider === 'parcelguard' && stampedBackend.insuredValue === 200);

// ── getSavedBestRateRecord: reads the saved rate off the order DTO ──
check('getSavedBestRateRecord reads order.bestRate', (getSavedBestRateRecord({ bestRate: { amount: 7 } } as any) as any)?.amount === 7);

// ── rate-helpers factory (state-bound; Vite chain blocks a node import) — STATIC behaviour pins ──
check('factory exports createBestRateHelpers', /export function createBestRateHelpers\(/.test(rateHelpersSrc));
check('getRateCarrierIdsForAccounts de-duplicates carrier ids (new Set)',
  /getRateCarrierIdsForAccounts\(\)[\s\S]{0,200}?new Set\(/.test(rateHelpersSrc));
check('getServiceOptionsForAccount reads the fetched catalog by account code',
  /carrierServiceCatalog\[account\.code\]/.test(rateHelpersSrc));
check('getServiceOptionsForAccount has no first-entry auto-default',
  !/getServiceOptionsForAccount\([^)]*\)\[0\]/.test(rateHelpersSrc));
check('buildStrictBestRateRequest gates on awaiting_shipment + orderShippingHold (never rates a held/shipped order)',
  /orderStatus !== 'awaiting_shipment'\) return null/.test(rateHelpersSrc) && /orderShippingHold\(order\)\?\.blocked\) return null/.test(rateHelpersSrc));

// ── STATIC boundary pins: the FE owns no rate truth ──
check('rate-helpers does not rank rates (no Math.min / sort-by-amount / cheapest pick)',
  !/Math\.min\(/.test(rateHelpersSrc) && !/\.sort\([^)]*amount/i.test(rateHelpersSrc) && !/cheapest|pickBest/i.test(rateHelpersSrc));
check('rate-helpers sends insurance intent only (insuranceProvider: \'none\'), no HUGRAB mint',
  /insuranceProvider:\s*'none'/.test(rateHelpersSrc) && !/HUGRAB_DEFAULT_INSURED_VALUE/.test(rateHelpersSrc));
check('PS-143: rate-request draft key builder is not coupled to the backend fingerprint',
  /function buildRateRequestDraftKey\b/.test(rateRequestSrc) && !/getBackendRateResponseFingerprint|requestFingerprint/.test(rateRequestSrc));
check('rate-proof never mints a fingerprint (no createHash / buildShippingRateRequestFingerprint)',
  !/createHash|buildShippingRateRequestFingerprint/.test(rateProofSrc));
check('rate-request residentialForRate delegates to the shared rule',
  /residentialForRate as residentialForRateRule/.test(rateRequestSrc) && /return residentialForRateRule\(order\)/.test(rateRequestSrc));

// ── self-wiring ──
check('package.json wires test:best-rate-boundary',
  /test:best-rate-boundary/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-317 best-rate boundary guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-317 best-rate boundary guard');
