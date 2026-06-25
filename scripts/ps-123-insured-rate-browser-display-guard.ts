/**
 * PS-123 guard — insured Browse Rates output must stay insurance-aware from
 * ShipStation/API response through saved best-rate display and manual selection.
 *
 * Read-only: no DB, no network, no carrier APIs, no labels.
 */
import { readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, ok: boolean) {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

// PS-157: useOrders (and its rate/label transform helpers normalizeRateForV2,
// normalizeLabelForV2, and the bestRateLegacy block) split out of v2Hooks.ts
// into web/src/hooks/useOrders.ts. The slice anchors below are unchanged.
const hooks = readFileSync('web/src/hooks/useOrders.ts', 'utf8');
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const ratesService = readFileSync('src/services/rates.ts', 'utf8');

const normalizeStart = hooks.indexOf('function normalizeRateForV2(');
const normalizeEnd = hooks.indexOf('\nfunction normalizeLabelForV2', normalizeStart);
const normalizeBlock = normalizeStart >= 0 && normalizeEnd > normalizeStart
  ? hooks.slice(normalizeStart, normalizeEnd)
  : '';

const legacyStart = hooks.indexOf('const bestRateLegacy = (() => {');
const legacyEnd = hooks.indexOf('\n  const weightOz', legacyStart);
const legacyBlock = legacyStart >= 0 && legacyEnd > legacyStart
  ? hooks.slice(legacyStart, legacyEnd)
  : '';

const seedStart = modal.indexOf('function buildOrderBestRateSeed(');
const seedEnd = modal.indexOf('\nconst TEST_MOCK_SERVICE_TEMPLATES', seedStart);
const seedBlock = seedStart >= 0 && seedEnd > seedStart
  ? modal.slice(seedStart, seedEnd)
  : '';

const clickStart = modal.indexOf('function handleRateClick(');
const clickEnd = modal.indexOf('\n  if (!open) return null;', clickStart);
const clickBlock = clickStart >= 0 && clickEnd > clickStart
  ? modal.slice(clickStart, clickEnd)
  : '';

const effectStart = modal.indexOf('const autoFetchedRef = useRef');
const effectEnd = modal.indexOf('\n  // Auto-select a package', effectStart);
const autoFetchBlock = effectStart >= 0 && effectEnd > effectStart
  ? modal.slice(effectStart, effectEnd)
  : '';

const insuranceControlsStart = modal.indexOf('<div style={{ fontSize: 11, color: \'var(--text3)\', marginBottom: 3 }}>\n                  Insurance');
const insuranceControlsEnd = modal.indexOf('\n\n                <div style={{ fontSize: 11, color: \'var(--text3)\', marginBottom: 3 }}>\n                  Service Class', insuranceControlsStart);
const insuranceControlsBlock = insuranceControlsStart >= 0 && insuranceControlsEnd > insuranceControlsStart
  ? modal.slice(insuranceControlsStart, insuranceControlsEnd)
  : '';

const openStart = ordersView.indexOf('async function openRateBrowser()');
const openEnd = ordersView.indexOf('\n  async function recalculateBestRate()', openStart);
const openBlock = openStart >= 0 && openEnd > openStart
  ? ordersView.slice(openStart, openEnd)
  : '';

// PS-317: getAutoBestRateRequest moved to ./orders/best-rate/rate-helpers.ts as an indented inner
// function in the createBestRateHelpers factory. It STILL passes insuranceProvider:'none' /
// insuredValue:null (no FE HUGRAB inference). Re-anchored to the new owner; the END anchor is the
// next indented inner function (getCurrentBestRateDimsLabel) since normalizeDimsLabel now precedes it.
// (openRateBrowser, referenced elsewhere in this guard, STAYED in OrdersView and is NOT repointed.)
const rateHelpers = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
const autoRequestStart = rateHelpers.indexOf('function getAutoBestRateRequest(');
const autoRequestEnd = rateHelpers.indexOf('\n  function getCurrentBestRateDimsLabel', autoRequestStart);
const autoRequestBlock = autoRequestStart >= 0 && autoRequestEnd > autoRequestStart
  ? rateHelpers.slice(autoRequestStart, autoRequestEnd)
  : '';

// PS-317: withRateRequestMetadata moved to ./orders/best-rate/rate-proof.ts (getAutoBestRateRequest
// and openRateBrowser referenced in this guard STAYED in OrdersView — they are NOT repointed). Its
// body runs to the next top-level function getSavedBestRateRecord in the new file.
const bestRateProof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const metadataStart = bestRateProof.indexOf('function withRateRequestMetadata(');
const metadataEnd = bestRateProof.indexOf('\nexport function getSavedBestRateRecord', metadataStart);
const metadataBlock = metadataStart >= 0 && metadataEnd > metadataStart
  ? bestRateProof.slice(metadataStart, metadataEnd)
  : '';

const getRatesResultStart = ratesService.indexOf('export type GetRatesResult = {');
const getRatesResultEnd = ratesService.indexOf('\n};', getRatesResultStart);
const getRatesResultBlock = getRatesResultStart >= 0 && getRatesResultEnd > getRatesResultStart
  ? ratesService.slice(getRatesResultStart, getRatesResultEnd)
  : '';

const browsePayloadStart = ratesRoute.indexOf('const payload = {');
const browsePayloadEnd = ratesRoute.indexOf('\n  return c.json(publicRatesResult(payload', browsePayloadStart);
const browsePayloadBlock = browsePayloadStart >= 0 && browsePayloadEnd > browsePayloadStart
  ? ratesRoute.slice(browsePayloadStart, browsePayloadEnd)
  : '';

check(
  'normalizeRateForV2 folds raw insurance_amount into otherCost',
  /insuranceAmount/.test(normalizeBlock) &&
    /insurance_amount/.test(normalizeBlock) &&
    /componentOtherCost\s*=\s*otherAmountCost\s*\+\s*confirmationAmountCost\s*\+\s*insuranceAmountCost/.test(normalizeBlock) &&
    /Math\.max\(storedOtherCost,\s*componentOtherCost\)/.test(normalizeBlock),
);

check(
  'legacy saved bestRateJson folds raw insurance_amount into otherCost',
  /insuranceAmount/.test(legacyBlock) &&
    /insurance_amount/.test(legacyBlock) &&
    /componentOtherCost\s*=\s*otherAmountCost\s*\+\s*confirmationAmountCost\s*\+\s*insuranceAmountCost/.test(legacyBlock) &&
    /Math\.max\(storedOtherCost,\s*componentOtherCost\)/.test(legacyBlock),
);

check(
  'Rate Browser saved-rate seed folds raw insurance_amount into otherCost',
  /insuranceAmount/.test(seedBlock) &&
    /insurance_amount/.test(seedBlock) &&
    /componentOtherCost\s*=\s*otherAmountCost\s*\+\s*confirmationAmountCost\s*\+\s*insuranceAmountCost/.test(seedBlock) &&
    /Math\.max\(storedOtherCost,\s*componentOtherCost\)/.test(seedBlock),
);

check(
  'applied Browse Rates preserve raw and backend insurance metadata',
  /function rateInsuranceProof\(r: RateRow\)/.test(modal) &&
    /raw:\s*r\.raw\s*\?\?\s*r/.test(modal) &&
    /insuranceCost:\s*r\.insuranceCost/.test(modal) &&
    /insurance_amount:\s*r\.insurance_amount\s*\?\?\s*r\.raw\?\.insurance_amount/.test(modal) &&
    /insuranceCostUnresolved:\s*r\.insuranceCostUnresolved/.test(modal) &&
    /handleRateClick[\s\S]*\.\.\.rateInsuranceProof\(r\)/.test(clickBlock) &&
    /toAppliedRate[\s\S]*\.\.\.rateInsuranceProof\(r\)/.test(clickBlock),
);

check(
  'insurance control re-rate passes next provider/value explicitly',
  /browseRates\(confirmation,\s*\{[^}]*forceLive:\s*true,[^}]*insuranceProviderOverride:\s*next[^}]*\}/s.test(modal) &&
    /browseRates\(confirmation,\s*\{[^}]*forceLive:\s*true,[^}]*insuredValueOverride:\s*next[^}]*\}/s.test(modal),
);

check(
  // PS-206 + PS-241 + PS-260 (coverage-driven fan-out): the modal open must
  // PROBE THE CACHE FIRST (cachedOnly:true) for an instant paint, then complete
  // coverage LIVE only when the cached probe left scoped accounts uncovered. The
  // follow-up fan-out is gated by the backend's per-carrier COVERAGE identity
  // (probe.uncoveredPids.length > 0) — NOT a carrier-COUNT heuristic. The old
  // `cachedCarrierCount <= 1` thin-cache check this assertion used to pin was
  // deliberately removed by PS-206; a cached probe with full coverage
  // (uncoveredPids empty) is served with no live fan-out at all. This mirrors the
  // PS-241 fan-out guard's coverage-identity / no-`<=1`-heuristic invariants.
  'modal open probes cache first, then gates the live fanout on coverage identity (uncoveredPids), not a carrier-count heuristic',
  /cachedOnly:\s*true/.test(autoFetchBlock) &&
    /probe\.uncoveredPids\.length\s*>\s*0/.test(autoFetchBlock) &&
    !/(carriers?WithRates|ratedCount|withRates|cachedCarrierCount)\s*<=\s*1/.test(autoFetchBlock),
);

check(
  'OrdersView openRateBrowser no longer starts its own live browse request',
  !/apiClient\.browseRates\(/.test(openBlock),
);

check(
  'auto/table Best Rate no longer infers HUGRAB insurance on the frontend',
  autoRequestBlock.length > 0 &&
    !/isHugrabShippingContext/.test(autoRequestBlock) &&
    !/HUGRAB_DEFAULT_INSURED_VALUE/.test(autoRequestBlock) &&
    !/insuranceProvider:\s*hugrab\s*\?\s*['"]carrier['"]/.test(autoRequestBlock) &&
    /insuranceProvider:\s*['"]none['"]/.test(autoRequestBlock) &&
    /insuredValue:\s*null/.test(autoRequestBlock),
);

check(
  'saved best-rate metadata prefers backend effective insurance over frontend request defaults',
  // TEETH: require the moved withRateRequestMetadata body (best-rate/rate-proof.ts) to be
  // non-empty so a missing/renamed definition fails LOUD instead of passing vacuously.
  metadataStart >= 0 && metadataBlock.length > 0 &&
    /effectiveInsuranceProvider/.test(metadataBlock) &&
    /effectiveInsuredValue/.test(metadataBlock) &&
    /toStringValue\(metadata\.effectiveInsuranceProvider\)[\s\S]{0,220}toStringValue\(metadata\.insuranceProvider\)/.test(metadataBlock) &&
    /toNumberValue\(metadata\.effectiveInsuredValue\)[\s\S]{0,220}toNumberValue\(metadata\.insuredValue\)/.test(metadataBlock),
);

check(
  'getRates result exposes backend-resolved effective insurance context',
  /effectiveInsuranceProvider/.test(getRatesResultBlock) &&
    /effectiveInsuredValue/.test(getRatesResultBlock) &&
    /effectiveInsuranceSource/.test(getRatesResultBlock),
);

check(
  'Browse Rates response stamps effective insurance onto payload, bestRate, and saved workflow metadata',
  /effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(browsePayloadBlock) &&
    /effectiveInsuredValue:\s*result\.effectiveInsuredValue/.test(browsePayloadBlock) &&
    /bestRateMetadata[\s\S]{0,500}effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(ratesRoute) &&
    // Window 300→450 (PS-183 added cacheCreatedAt/cacheExpiresAt lines inside the
    // bestRateOut literal before the insurance stamp; assertion unchanged).
    /bestRateOut[\s\S]{0,450}effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(ratesRoute),
);

if (failures > 0) {
  console.error(`\nFAIL PS-123 insured rate browser display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-123 insured rate browser display guard');
