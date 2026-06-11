/**
 * PS-197 guard — Rate Browser must show the backend-EFFECTIVE HUGRAB insurance and classify
 * the raw-manual vs label-safe rate difference.
 *
 * THE CONFUSION THIS PINS CLOSED (order #1461, ROCEL C81F70 UPS Ground): the Rate Browser
 * dropdown read "Insurance: None" while the backend quoted under the HUGRAB policy
 * (ParcelGuard $100 — ip=parcelguard|iv=10000 in the cache key), so PrepShip's label-safe
 * $8.95 looked "wrong" next to ShipStation's manual no-insurance $7.93. The backend already
 * owned the effective policy (GetRatesResult.effectiveInsurance*); the UI never showed it.
 *
 * Pins:
 *   1. BEHAVIOR (#1461 fixture, pure): HUGRAB + operator 'none' resolves to ParcelGuard $100
 *      (hugrab-default); ZIP+4 92801-5567 is preserved exactly; the rate cache key carries
 *      ip=parcelguard + iv=10000 + r=1 + w=350; Ground Saver stays blocked for HUGRAB.
 *   2. The pure display classifier: backend policy ≠ operator selection => 'effective_policy_diff'
 *      (the explainable mismatch), matching selection => 'matches_selection', none => null.
 *   3. Source pins: GetRatesResult declares the effective fields; resolveRateInput wires
 *      resolveHugrabRequestInsurance; the apiClient browse passthrough spreads the backend
 *      result; the modal captures effectiveInsuranceProvider and renders the
 *      data-rate-browser="effectiveInsurance" line from the classifier (backend DTO, not
 *      frontend guesswork).
 *
 *   npx tsx scripts/ps-197-effective-insurance-display-guard.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyEffectiveInsuranceDisplay } from '../web/src/components/Views/orders-parity';
import {
  resolveHugrabRequestInsurance,
  evaluateShippingServiceEligibility,
} from '../src/lib/shipping-service-eligibility';
import { normalizeShippingPostalCode } from '../src/services/shipping-workflow/postal-code';
import { rateCacheKey } from '../src/services/rates';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { failures += 1; console.error(`FAIL ${name}: got ${g}, want ${w}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. The #1461 fixture (HUGRAB · ROCEL C81F70 · UPS Ground) ─────────────────
const HUGRAB = { clientId: 4, storeId: 378060 };
{
  const eff = resolveHugrabRequestInsurance(HUGRAB, { insuranceProvider: 'none', insuredValue: null });
  check('#1461: HUGRAB + operator none -> effective ParcelGuard', eff.insuranceProvider, 'parcelguard');
  check('#1461: HUGRAB effective insured value is $100', eff.insuredValue, 100);
  check('#1461: the effective source is the HUGRAB default policy', eff.source, 'hugrab-default');
}
check('#1461: ZIP+4 92801-5567 is preserved exactly',
  normalizeShippingPostalCode('92801-5567', 'US').exact, '92801-5567');
{
  const key = rateCacheKey({
    weightOz: 35,
    toZip: '92801-5567',
    toCountry: 'US',
    residential: true,
    dimsL: 12,
    dimsW: 10,
    dimsH: 3,
    clientId: 4,
    insuranceProvider: 'parcelguard',
    insuredValue: 100,
  } as Parameters<typeof rateCacheKey>[0]);
  check('#1461: cache key carries the effective insurance provider', key.includes('ip=parcelguard'), true);
  check('#1461: cache key carries the effective insured value', key.includes('iv=10000'), true);
  check('#1461: cache key carries residential=1', key.includes('r=1'), true);
  check('#1461: cache key carries the exact 35oz weight', key.includes('w=350'), true);
}
{
  const groundSaver = evaluateShippingServiceEligibility(
    { clientId: 4, storeId: 378060, clientName: 'HUGRAB' },
    { carrierCode: 'ups', serviceCode: 'ups_ground_saver', serviceName: 'UPS Ground Saver' },
  );
  check('#1461: Ground Saver remains blocked for HUGRAB (policy NOT weakened)', groundSaver.allowed, false);
}

// ── 2. The pure display classifier ────────────────────────────────────────────
{
  const diff = classifyEffectiveInsuranceDisplay({
    backendProvider: 'parcelguard',
    backendValue: 100,
    backendSource: 'hugrab-default',
    operatorProvider: 'none',
    operatorValue: null,
  });
  check('backend policy over operator-none classifies effective_policy_diff (the $8.95-vs-$7.93 explanation)',
    diff?.kind, 'effective_policy_diff');
  check('the operator-facing label names the policy', diff?.label, 'ParcelGuard $100 — HUGRAB default');
}
{
  const match = classifyEffectiveInsuranceDisplay({
    backendProvider: 'parcelguard',
    backendValue: 250,
    backendSource: 'operator',
    operatorProvider: 'parcelguard',
    operatorValue: 250,
  });
  check('matching operator selection classifies matches_selection', match?.kind, 'matches_selection');
}
check('backend none -> no effective-insurance line',
  classifyEffectiveInsuranceDisplay({ backendProvider: 'none', operatorProvider: 'none' }), null);
check('absent backend provider -> no line (never frontend guesswork)',
  classifyEffectiveInsuranceDisplay({ operatorProvider: 'none' }), null);

// ── 3. Source pins (backend DTO -> apiClient -> modal render) ─────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('GetRatesResult declares the effective insurance fields',
  /effectiveInsuranceProvider: string \| null;[\s\S]*effectiveInsuredValue: number \| null;[\s\S]*effectiveInsuranceSource: string \| null;/.test(ratesService),
  true);
check('resolveRateInput wires the single HUGRAB owner (resolveHugrabRequestInsurance)',
  /resolveHugrabRequestInsurance\(/.test(ratesService), true);

const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
check('apiClient browse passthrough spreads the backend result (effective fields ride through)',
  /\.\.\.backendResult,/.test(apiClient), true);

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('modal captures the backend effectiveInsuranceProvider per browse',
  /browseResult\?\.effectiveInsuranceProvider/.test(modal), true);
check('modal renders the effective-insurance line with a stable selector',
  /data-rate-browser="effectiveInsurance"/.test(modal), true);
check('modal display comes from the pure classifier (backend DTO, not inline FE policy)',
  /classifyEffectiveInsuranceDisplay\(\{/.test(modal), true);
check('the diagnostics tooltip carries the redacted quote facts',
  /Quoted with: ZIP \$\{zip\}/.test(modal), true);

if (failures > 0) {
  console.error(`\nFAIL PS-197 effective-insurance display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-197 effective-insurance display guard');
