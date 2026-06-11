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
import { effectiveInsuranceProviderForAccount } from '../src/lib/carrier-account-registry';
import { normalizeShippingPostalCode } from '../src/services/shipping-workflow/postal-code';
import { classifyShippingAddress } from '../src/services/shipping-workflow/address-classification';
import { rateCacheKey } from '../src/services/rates';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) { failures += 1; console.error(`FAIL ${name}: got ${g}, want ${w}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. The #1461 fixture (HUGRAB · ROCEL C81F70 · UPS Ground) ─────────────────
// DJ correction (2026-06-10): #1461 ROCEL is a DIRECT UPS account — its EFFECTIVE insurance is
// CARRIER DECLARED VALUE $100 ($0 add-on, PS-170 capability rule), NOT ParcelGuard. ParcelGuard
// remains only the REQUEST-LEVEL fingerprint policy (it spans all carriers before the
// per-candidate refinement) and the effective provider for brokered accounts (stamps_com,
// ups_walleted / UPS by SS).
const HUGRAB = { clientId: 4, storeId: 378060 };
{
  const eff = resolveHugrabRequestInsurance(HUGRAB, { insuranceProvider: 'none', insuredValue: null });
  check('REQUEST-LEVEL fingerprint policy is ParcelGuard (spans all carriers pre-refinement)', eff.insuranceProvider, 'parcelguard');
  check('REQUEST-LEVEL insured value is $100', eff.insuredValue, 100);
  check('REQUEST-LEVEL source is the HUGRAB default policy', eff.source, 'hugrab-default');
}
{
  // The PS-170 capability rule decides what each ACCOUNT actually purchases with:
  check('#1461 ROCEL C81F70 (607855, direct UPS) effective insurance is CARRIER declared value',
    effectiveInsuranceProviderForAccount({ shippingProviderId: 607855, serviceCode: 'ups_ground', insuredValue: 100 }),
    'carrier');
  check('ROCEL (604209, direct UPS) effective insurance is CARRIER declared value',
    effectiveInsuranceProviderForAccount({ shippingProviderId: 604209, serviceCode: 'ups_ground', insuredValue: 100 }),
    'carrier');
  check('UPS by SS / walleted stays ParcelGuard',
    effectiveInsuranceProviderForAccount({ carrierCode: 'ups_walleted', insuredValue: 100 }),
    'parcelguard');
  check('USPS/Stamps stays ParcelGuard',
    effectiveInsuranceProviderForAccount({ carrierCode: 'stamps_com', insuredValue: 100 }),
    'parcelguard');
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

// ── 4. PS-197b — per-account verdict + uninsured manual baseline (reference-only) ──
import { classifyAccountEffectiveInsurance } from '../web/src/components/Views/orders-parity';
{
  const carrier = classifyAccountEffectiveInsurance(
    [{ insuranceCost: { provenance: 'carrier_declared_value', amount: 0 }, insurance_amount: { amount: 0 } }],
    100,
  );
  check('direct-UPS account rates classify as carrier declared value (free first $100)',
    carrier?.provider, 'carrier');
  const pg = classifyAccountEffectiveInsurance(
    [{ insuranceCost: { provenance: 'parcelguard_schedule', amount: 1.09 }, insurance_amount: { amount: 1.09 } }],
    100,
  );
  check('brokered (USPS) account rates classify as ParcelGuard with the premium shown',
    pg?.label, 'ParcelGuard $100 (+$1.09)');
  check('no enriched rates -> no per-account verdict (never FE guesswork)',
    classifyAccountEffectiveInsurance([], 100), null);
}
// The manual baseline must be structurally NON-PURCHASABLE end to end:
check('backend: resolveRateInput supports the rawManualEstimate uninsured baseline',
  /rawManualEstimate/.test(ratesService) && /'manual-estimate'/.test(ratesService), true);
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
{
  // The manual-baseline block sits between its gate and the payload literal (so the payload
  // anchor other guards slice on stays byte-stable).
  const manualBlockStart = ratesRoute.indexOf('body.manualEstimate === true');
  const manualBlockEnd = ratesRoute.indexOf('const payload = {', manualBlockStart);
  const manualBlock = manualBlockStart >= 0 && manualBlockEnd > manualBlockStart
    ? ratesRoute.slice(manualBlockStart, manualBlockEnd)
    : '';
  check('route: manual baseline is on-demand only (gated on body.manualEstimate)', manualBlockStart >= 0, true);
  check('route: manual baseline never gets selection keys / a snapshot / a rateQuoteId',
    manualBlock.length > 0 &&
      !/withSelectedRateKeys|storeRateQuoteSnapshot|rateQuoteId/.test(manualBlock),
    true);
}
{
  const manualMapStart = apiClient.indexOf('manualEstimate:');
  const manualMapEnd = apiClient.indexOf('};', manualMapStart);
  const manualMap = manualMapStart >= 0 ? apiClient.slice(manualMapStart, manualMapEnd) : '';
  check('apiClient: manual baseline rates are translated WITHOUT proof metadata',
    manualMap.length > 0 && /translateRateToV2Shape\(rate\)/.test(manualMap) && !/backendProofMetadata/.test(manualMap),
    true);
}
check('modal: per-account effective verdict has a stable selector',
  /data-rate-browser="accountEffectiveInsurance"/.test(modal), true);
check('modal: the compare action is explicit + on-demand',
  /data-rate-browser="manualEstimateCompare"/.test(modal) && /manualEstimateCompare: true/.test(modal), true);
check('modal: the baseline list is labeled not-label-safe',
  /uninsured — not label-safe/.test(modal), true);
// PS-197c: the dropdown auto-syncs to the selected account's effective insurance ONLY when the
// backend policy owns the order's insurance (hugrab-default). For non-policy orders the gate
// early-returns and the dropdown stays REAL operator intent (a flip there would change actual
// quoted insurance — a money behavior change).
{
  const syncStart = modal.indexOf("backendEffectiveInsurance?.source !== 'hugrab-default'");
  const syncEnd = modal.indexOf('}, [selectedPid, backendEffectiveInsurance, ratesByPid]);', syncStart);
  const syncBlock = syncStart >= 0 && syncEnd > syncStart ? modal.slice(syncStart, syncEnd) : '';
  check('modal: dropdown auto-sync is GATED on the backend hugrab-default policy',
    syncStart >= 0 && /setInsuranceProvider\(verdict\.provider\)/.test(syncBlock), true);
  check('modal: the gate early-returns BEFORE any dropdown mutation (non-policy intent preserved)',
    syncBlock.indexOf('return;') >= 0 &&
      syncBlock.indexOf('return;') < syncBlock.indexOf('setInsuranceProvider('),
    true);
}

// ── 5. PS-197 residential parity — the OTHER #1461 axis ($1.02 = residential surcharge) ──
// ShipStation's Rate Alert on #1461: "Ship To Address Classification is changed from
// Residential to Commercial." PrepShip quoted residential (raw flag), hence $8.95 vs $7.93.
// The fix: /browse loads the ORDER's classification evidence and feeds the canonical
// classifier's proper tiers — the FE's collapsed boolean no longer decides for real orders.
{
  // Commercial must be REACHABLE through every trusted tier (the ticket's acceptance):
  const manual = classifyShippingAddress({ manualOverrideResidential: false, sourceResidential: true });
  check('manual commercial override beats the raw residential flag', manual.classification, 'commercial');
  check('manual override is attributed to the manual tier', manual.source, 'manual_override');
  const provider = classifyShippingAddress({
    providerMarker: { classification: 'commercial', provider: 'shipstation' },
    sourceResidential: true,
  });
  check('a ShipStation classification-change marker beats the raw residential flag (the #1461 alert)',
    provider.classification, 'commercial');
  const validated = classifyShippingAddress({ addressValidation: { business: 'Y' } });
  check('validation business=Y classifies commercial (validated tier)', validated.classification, 'commercial');
  check('validated commercial is attributed to address_validation', validated.source, 'address_validation');
  // Both variants must hit the fingerprint so cached residential/commercial quotes never mix:
  const base = { weightOz: 35, toZip: '92801-5567', toCountry: 'US', dimsL: 12, dimsW: 10, dimsH: 3, clientId: 4, insuranceProvider: 'parcelguard', insuredValue: 100 };
  check('commercial fingerprint carries r=0',
    rateCacheKey({ ...base, residential: false } as Parameters<typeof rateCacheKey>[0]).includes('r=0'), true);
  check('residential fingerprint carries r=1',
    rateCacheKey({ ...base, residential: true } as Parameters<typeof rateCacheKey>[0]).includes('r=1'), true);
}
{
  // Source pins — the backend owns the evidence for real-order browses:
  check('browse loads the order residential EVIDENCE (manual override + raw source flag)',
    /manualOverrideResidential: residentialEvidence\.manualOverrideResidential/.test(ratesRoute) &&
      /sourceResidential: residentialEvidence\.sourceResidential/.test(ratesRoute),
    true);
  check('browse DROPS the FE-collapsed residential boolean when order evidence exists',
    /residential: undefined,/.test(ratesRoute), true);
  check('the manual-estimate baseline reuses the SAME evidence-resolved input (apples to apples)',
    /const manual = await getRates\(\s*\/\/[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*browseRateInput/.test(ratesRoute) ||
      /await getRates\(\s*(\/\/[^\n]*\n\s*)*browseRateInput/.test(ratesRoute),
    true);
  check('GetRatesResult declares the residential classification fields',
    /residential: boolean;[\s\S]{0,400}residentialClassification: string \| null;[\s\S]{0,100}residentialSource: string \| null;/.test(ratesService),
    true);
  check('the modal diagnostics show the backend classification + evidence tier',
    /browseResult\?\.residentialClassification/.test(modal), true);
  check('the per-account verdict is the PRIMARY effective-insurance line when an account is selected',
    /Effective insurance \(\$\{selectedAccountLabel\}\): \$\{accountVerdict\.label\}/.test(modal), true);
}

if (failures > 0) {
  console.error(`\nFAIL PS-197 effective-insurance display guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-197 effective-insurance display guard');
