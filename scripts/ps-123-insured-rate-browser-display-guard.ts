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

// PS-157: useOrders (and its rate/label transform helpers normalizeRateForV2
// and normalizeLabelForV2) split out of v2Hooks.ts into web/src/hooks/useOrders.ts.
// PS-333 addendum: the old bestRateLegacy override remapper is intentionally gone.
const hooks = readFileSync('web/src/hooks/useOrders.ts', 'utf8');
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// Repointed (guard rot): /rates/browse was extracted from src/routes/rates.ts into
// src/services/rate-browse-response-producer.ts (route delegates to produceRateBrowsePayload),
// and money canonicalization e9762409 moved the insurance-in-otherCost fold into
// purchase-customer-rate-aliases.ts. The response/fold pins read those owners now.
// (CRLF-normalized so the \n slice anchors match on Windows checkouts too.)
const browseProducer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8').replace(/\r\n/g, '\n');
const purchaseAliases = readFileSync('src/services/shipping-workflow/purchase-customer-rate-aliases.ts', 'utf8').replace(/\r\n/g, '\n');
const openWorkflow = readFileSync('web/src/components/rate-browser-open-workflow.ts', 'utf8').replace(/\r\n/g, '\n');
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

const clickStart = modal.indexOf('function handleRateClick(');
const clickEnd = modal.indexOf('\n  if (!open) return null;', clickStart);
const clickBlock = clickStart >= 0 && clickEnd > clickStart
  ? modal.slice(clickStart, clickEnd)
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

// Repointed (guard rot): the browse response literal is now the producer's final
// `return { ...result, ... }` block (was `const payload = {` in routes/rates.ts).
const browsePayloadStart = browseProducer.indexOf('return {\n    ...result,');
const browsePayloadEnd = browseProducer.indexOf('\n  };', browsePayloadStart);
const browsePayloadBlock = browsePayloadStart >= 0 && browsePayloadEnd > browsePayloadStart
  ? browseProducer.slice(browsePayloadStart, browsePayloadEnd)
  : '';

check(
  'normalizeRateForV2 folds raw insurance_amount into otherCost',
  /insuranceAmount/.test(normalizeBlock) &&
    /insurance_amount/.test(normalizeBlock) &&
    /componentOtherCost\s*=\s*otherAmountCost\s*\+\s*confirmationAmountCost\s*\+\s*insuranceAmountCost/.test(normalizeBlock) &&
    /Math\.max\(storedOtherCost,\s*componentOtherCost\)/.test(normalizeBlock),
);

check(
  'useOrders does not remap override bestRateJson as a second insured saved-rate money path',
  legacyBlock.length === 0 &&
    !/const bestRateLegacy/.test(hooks) &&
    !/bestRateJson\.insurance_amount/.test(hooks),
);

check(
  // Repointed (guard rot): money canonicalization e9762409 moved the insurance-in-otherCost
  // fold backend-side into purchase-customer-rate-aliases.ts (money builder folds
  // rate.insurance_amount, stamps otherCost); the modal seed now consumes the
  // backend-stamped otherCost alias verbatim instead of re-deriving component math.
  'Rate Browser saved-rate seed consumes the backend-stamped otherCost (insurance folded backend-side)',
  // Repointed again (PS-500 — second guard-rot fix on this same line). It pinned
  // the literal `... ?? toFiniteNumber(raw.otherCost) ?? 0;`. That trailing
  // `?? 0` is precisely what PS-500 removes — an absent add-on is unknown, not
  // zero — so the value pin blocked the fix, while the intent it exists to
  // protect (consume the backend-stamped alias; never re-derive component math)
  // is unchanged. Asserted as a property now, including that the default is gone.
  (() => {
    // Scoped to the seed body: rateRowDedupeKey legitimately keeps its own
    // `?? 0` because it builds a grouping key, not a money claim.
    const seedStart = modal.indexOf('function buildOrderBestRateSeed');
    const seed = modal.slice(seedStart, modal.indexOf('\n}', seedStart));
    return /const otherCost = toFiniteNumber\(bestRate\.otherCost\) \?\? toFiniteNumber\(raw\.otherCost\)/.test(seed)
      && !/const otherCost[^\n]*\?\?\s*0\s*;/.test(seed);
  })() &&
    purchaseAliases.includes('otherCost: money.otherCost,') &&
    purchaseAliases.includes('moneyObjectMaxAmount(rate.insurance_amount, raw.insurance_amount)'),
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
  // Repointed (guard rot): PS-345/346 replaced the cached-probe escalation with load-all-on-open
  // — modal open now goes straight live via the shared open-workflow options (forceLive: true);
  // the cachedOnly probe + uncoveredPids coverage gate no longer exist on the open path.
  'modal open loads all rates live via the shared open-workflow options (PS-345/346 load-all-on-open)',
  modal.includes('browseRates(undefined, rateBrowserOpenBrowseOptions())') &&
    openWorkflow.includes('forceLive: true'),
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
    /bestRateMetadata[\s\S]{0,500}effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(browseProducer) &&
    // Window 300→450 (PS-183 added cacheCreatedAt/cacheExpiresAt lines inside the
    // bestRateOut literal before the insurance stamp; assertion unchanged).
    /bestRateOut[\s\S]{0,450}effectiveInsuranceProvider:\s*result\.effectiveInsuranceProvider/.test(browseProducer),
);

if (failures > 0) {
  console.error(`\nFAIL PS-123 insured rate browser display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-123 insured rate browser display guard');
