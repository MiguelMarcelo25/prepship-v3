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

const hooks = readFileSync('web/src/hooks/v2Hooks.ts', 'utf8');
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

const autoRequestStart = ordersView.indexOf('function getAutoBestRateRequest(');
const autoRequestEnd = ordersView.indexOf('\n  function normalizeDimsLabel', autoRequestStart);
const autoRequestBlock = autoRequestStart >= 0 && autoRequestEnd > autoRequestStart
  ? ordersView.slice(autoRequestStart, autoRequestEnd)
  : '';

const metadataStart = ordersView.indexOf('function withRateRequestMetadata(');
const metadataEnd = ordersView.indexOf('\n  function buildStrictBestRateRequest', metadataStart);
const metadataBlock = metadataStart >= 0 && metadataEnd > metadataStart
  ? ordersView.slice(metadataStart, metadataEnd)
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
  // PS-123 (reconciled with the "show all carriers on open" requirement): the modal
  // open must PROBE THE CACHE FIRST. A live fanout is permitted ONLY as a fallback
  // gated by a thin-cache check (cachedCarrierCount <= 1), so a warm/complete cache
  // (worker backfill or the passive auto-rater) is served without any duplicate
  // live fanout. An UNCONDITIONAL forceLive on open is still forbidden.
  'modal open probes cache first; any live fanout is gated by a thin-cache check (no unconditional/duplicate fanout)',
  /cachedOnly:\s*true/.test(autoFetchBlock) &&
    (!/forceLive:\s*true/.test(autoFetchBlock) ||
      (/cachedCarrierCount/.test(autoFetchBlock) && /<=\s*1/.test(autoFetchBlock))),
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
    /bestRateOut[\s\S]{0,300}effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(ratesRoute),
);

if (failures > 0) {
  console.error(`\nFAIL PS-123 insured rate browser display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-123 insured rate browser display guard');
