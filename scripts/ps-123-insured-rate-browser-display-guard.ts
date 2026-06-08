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
  'modal open uses cache probe only, avoiding duplicate automatic live fanout',
  /cachedOnly:\s*true/.test(autoFetchBlock) && !/forceLive:\s*true/.test(autoFetchBlock),
);

check(
  'OrdersView openRateBrowser no longer starts its own live browse request',
  !/apiClient\.browseRates\(/.test(openBlock),
);

if (failures > 0) {
  console.error(`\nFAIL PS-123 insured rate browser display guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-123 insured rate browser display guard');
