/**
 * PS-166 (#685) — deriveBackendBestRateComplete extraction guard (BEHAVIORAL + STATIC).
 *
 * Pins the behavior-preserving extraction of the nested pure function
 * `deriveBackendBestRateComplete` out of OrdersView.tsx into its own small module
 * web/src/components/Views/orders-rate-proof.ts (DJ preference: new functions live
 * in their own small file). The function is PURE — it READS the backend best-rate
 * DTO (its `bestRate.isComplete` stamp, else the backend `carrierStatuses`) and
 * never recomputes a money/insurance verdict. PS-111 owns completeness on the
 * backend; the FE only forwards it.
 *
 * Behavioral pins (import the extracted fn and exercise the real branches):
 *   1. Backend-stamped `isComplete` wins verbatim (true AND false), never recomputed.
 *   2. No stamp + every carrier settled (not loading/error) => complete.
 *   3. No stamp + any carrier loading/error => NOT complete.
 *   4. No stamp + no carrierStatuses => NOT complete (never assert true from a bare rate).
 *
 * Static pins:
 *   5. The module is its own small file, genuinely type-checked (no @ts-nocheck),
 *      and PURE (no fetch/db/api/network imports).
 *   6. OrdersView imports the fn from ./orders-rate-proof and no longer declares it inline.
 *   7. PS-143 rule preserved: buildRateRequestDraftKey stays in OrdersView and is NOT
 *      coupled to the backend response fingerprint (the FE draft key must not be
 *      derived from the backend requestFingerprint).
 *
 *   npx tsx scripts/ps-166-orders-rate-proof-guard.ts
 */
import { readFileSync } from 'node:fs';
import { deriveBackendBestRateComplete } from '../web/src/components/Views/orders-rate-proof';
// PS-166 (this slice): the pure test-mock rate-builder cluster moved into the new
// orders/ package directory. Import the extracted fns and exercise the real branches.
import {
  buildBestTestRateForShipment,
  buildTestRatesForShipment,
} from '../web/src/components/Views/orders/test-rate-mock';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-rate-proof.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';
const TEST_RATE_MOCK_PATH = 'web/src/components/Views/orders/test-rate-mock.ts';

const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');
const testRateMockSrc = readFileSync(TEST_RATE_MOCK_PATH, 'utf8');
// PS-317: buildRateRequestDraftKey moved to ./orders/best-rate/rate-request (still PS-143-independent).
const rateRequestSrc = readFileSync('web/src/components/Views/orders/best-rate/rate-request.ts', 'utf8');

// ── 1. backend-stamped isComplete wins verbatim (both polarities) ──
check('stamped isComplete:true is forwarded verbatim',
  deriveBackendBestRateComplete({ carrierStatuses: [{ status: 'loading' }] }, { isComplete: true }) === true);
check('stamped isComplete:false is forwarded verbatim (even when carriers settled)',
  deriveBackendBestRateComplete({ carrierStatuses: [{ status: 'ok' }] }, { isComplete: false }) === false);

// ── 2. no stamp + all carriers settled => complete ──
check('no stamp + all carriers settled => complete',
  deriveBackendBestRateComplete(
    { carrierStatuses: [{ status: 'ok' }, { status: 'done' }] },
    { shipmentCost: 5 },
  ) === true);

// ── 3. no stamp + a loading/error carrier => NOT complete ──
check('no stamp + a loading carrier => NOT complete',
  deriveBackendBestRateComplete(
    { carrierStatuses: [{ status: 'ok' }, { status: 'loading' }] },
    { shipmentCost: 5 },
  ) === false);
check('no stamp + an error carrier => NOT complete',
  deriveBackendBestRateComplete(
    { carrierStatuses: [{ status: 'error' }] },
    { shipmentCost: 5 },
  ) === false);

// ── 4. no stamp + no carrierStatuses => NOT complete (never assert true from a bare rate) ──
check('no stamp + no carrierStatuses => NOT complete',
  deriveBackendBestRateComplete({}, { shipmentCost: 5 }) === false);
check('null response + null rate => NOT complete',
  deriveBackendBestRateComplete(null, null) === false);

// ── 5. the module is its own small, pure, type-checked file ──
check('module exports deriveBackendBestRateComplete',
  /export function deriveBackendBestRateComplete\b/.test(moduleSrc));
check('module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(moduleSrc));
check('module reuses toRecord/toStringValue (does not re-implement primitives)',
  /toRecord/.test(moduleSrc) && /toStringValue/.test(moduleSrc));
check('module is PURE: no fetch/db/api/network imports',
  !/fetch\(/.test(moduleSrc) &&
  !/from ['"].*\/(db|lib\/api|v2-apiClient)['"]/.test(moduleSrc) &&
  !/from ['"]\.\.\/\.\.\/api\//.test(moduleSrc));
check('module is small (the slice keeps it tiny)',
  moduleSrc.split('\n').length < 60);

// ── 6. OrdersView delegates, no longer declares the fn inline ──
check('OrdersView imports deriveBackendBestRateComplete from ./orders-rate-proof',
  /import \{ deriveBackendBestRateComplete \} from '\.\/orders-rate-proof'/.test(ordersView));
check('OrdersView no longer declares deriveBackendBestRateComplete inline',
  !/function deriveBackendBestRateComplete\b/.test(ordersView));
check('OrdersView still consumes deriveBackendBestRateComplete (call sites preserved)',
  /deriveBackendBestRateComplete\(/.test(ordersView));

// ── 7. PS-143 rule preserved: the FE draft key is NOT coupled to the backend fingerprint ──
check('buildRateRequestDraftKey lives in ./orders/best-rate/rate-request (moved out of OrdersView)',
  /function buildRateRequestDraftKey\b/.test(rateRequestSrc));
check('PS-143: buildRateRequestDraftKey does not derive from the backend requestFingerprint',
  (() => {
    const start = rateRequestSrc.indexOf('function buildRateRequestDraftKey');
    if (start < 0) return false;
    // buildRateRequestDraftKey is the last fn in rate-request.ts; scan to EOF.
    const body = rateRequestSrc.slice(start + 'function buildRateRequestDraftKey'.length);
    return body.length > 0 &&
      !/requestFingerprint/.test(body) &&
      !/getBackendRateResponseFingerprint/.test(body) &&
      !/deriveBackendBestRateComplete/.test(body);
  })());

// ── 8. NEW SLICE: the pure test-mock rate-builder cluster lives in the orders/ package ──
// These are deterministic, side-effect-free mock generators for the local "PrepShip
// Test" carrier. They never touch a real money/insurance verdict — they fabricate a
// synthetic rate table for test orders only. Moving them out keeps OrdersView thinner.
const dims = { length: 8, width: 6, height: 4 };

check('test-rate-mock: buildTestRatesForShipment is deterministic (same seed => same table)',
  JSON.stringify(buildTestRatesForShipment(42, dims, 32)) ===
    JSON.stringify(buildTestRatesForShipment(42, dims, 32)));
check('test-rate-mock: buildBestTestRateForShipment picks the cheapest (shipmentCost+otherCost)',
  (() => {
    const all = buildTestRatesForShipment(42, dims, 32);
    const best = buildBestTestRateForShipment(42, dims, 32);
    if (!best || !all.length) return false;
    const cheapest = Math.min(...all.map((r) => r.shipmentCost + r.otherCost));
    return (best.shipmentCost + best.otherCost) === cheapest;
  })());
check('test-rate-mock: every generated rate is the local prepship_test carrier (no real provider)',
  buildTestRatesForShipment(42, dims, 32).every((r) => r.carrierCode === 'prepship_test'));

// ── 9. NEW SLICE: the module is its own small, pure, type-checked file in orders/ ──
check('test-rate-mock module exports buildBestTestRateForShipment',
  /export function buildBestTestRateForShipment\b/.test(testRateMockSrc));
check('test-rate-mock module exports buildTestRatesForShipment',
  /export function buildTestRatesForShipment\b/.test(testRateMockSrc));
check('test-rate-mock module is NOT @ts-nocheck (genuinely type-checked)',
  !/@ts-nocheck/.test(testRateMockSrc));
check('test-rate-mock module is PURE: no fetch/db/api/network imports',
  !/fetch\(/.test(testRateMockSrc) &&
  !/from ['"].*\/(db|lib\/api|v2-apiClient)['"]/.test(testRateMockSrc) &&
  !/from ['"]\.\.\//.test(testRateMockSrc));
check('test-rate-mock module is small (the slice keeps it tiny)',
  testRateMockSrc.split('\n').length < 120);

// ── 10. NEW SLICE: OrdersView delegates to orders/test-rate-mock, no longer inline ──
// Inverted 2026-08-04. These two previously required OrdersView to IMPORT and
// CALL buildBestTestRateForShipment. Both now fail, and correctly so: the import
// was narrowed to display constants only, under the comment
//   "Mock-label display constants only; the browser never fabricates rate money."
// That is PS-313/PS-316 being enforced -- the frontend may not mint rate money or
// selected-rate proof. The guard was demanding the frontend keep building it.
//
// This is the third guard today found asserting the defect rather than the rule,
// after the CP-045 company override and ps-217's `rowTotal > 0`. Repairing it by
// making the code match would have reintroduced frontend rate fabrication and
// gone green doing it. A guard written against an old architecture does not
// simply stop protecting -- it starts pulling the other way.
//
// Now pinned in the direction the law actually runs: the module may supply
// display constants; it may not supply money to this file.
check('OrdersView imports only display constants from ./orders/test-rate-mock',
  /from '\.\/orders\/test-rate-mock'/.test(ordersView) &&
  /TEST_CARRIER_CODE/.test(ordersView));
check('OrdersView no longer declares buildBestTestRateForShipment inline',
  !/function buildBestTestRateForShipment\b/.test(ordersView));
check('OrdersView no longer declares buildTestRatesForShipment inline',
  !/function buildTestRatesForShipment\b/.test(ordersView));
check('OrdersView never fabricates rate money (PS-313/PS-316: no test-rate builders)',
  !/buildBestTestRateForShipment\(/.test(ordersView) &&
  !/buildTestRatesForShipment\(/.test(ordersView));

if (failures > 0) {
  console.error(`\nFAIL PS-166 orders-rate-proof guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-166 orders-rate-proof guard');
