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

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const MODULE_PATH = 'web/src/components/Views/orders-rate-proof.ts';
const ORDERS_VIEW_PATH = 'web/src/components/Views/OrdersView.tsx';

const moduleSrc = readFileSync(MODULE_PATH, 'utf8');
const ordersView = readFileSync(ORDERS_VIEW_PATH, 'utf8');

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
check('buildRateRequestDraftKey still lives in OrdersView (not moved)',
  /function buildRateRequestDraftKey\b/.test(ordersView));
check('PS-143: buildRateRequestDraftKey does not derive from the backend requestFingerprint',
  (() => {
    const start = ordersView.indexOf('function buildRateRequestDraftKey');
    if (start < 0) return false;
    // bound the scan to the function body (up to the next top-level `function `)
    const rest = ordersView.slice(start + 'function buildRateRequestDraftKey'.length);
    const nextFn = rest.indexOf('\n  function ');
    const body = nextFn >= 0 ? rest.slice(0, nextFn) : rest;
    return !/requestFingerprint/.test(body) &&
      !/getBackendRateResponseFingerprint/.test(body) &&
      !/deriveBackendBestRateComplete/.test(body);
  })());

if (failures > 0) {
  console.error(`\nFAIL PS-166 orders-rate-proof guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-166 orders-rate-proof guard');
