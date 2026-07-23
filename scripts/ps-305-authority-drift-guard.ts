/**
 * PS-305 guard - backend authority drift prevention.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, no production data mutation, and no
 * shipped/cancelled mutation. This guard pins the docs, package wiring, and
 * static source-of-truth boundaries that prevent rates/labels/billing/package
 * authority from drifting back into frontend-only logic.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

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
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function checkPatterns(name: string, text: string, patterns: RegExp[]): void {
  const missing = patterns.map((pattern) => pattern.source).filter((_, index) => !patterns[index].test(text));
  check(name, missing.length === 0, missing);
}

const docPath = 'docs/ps-tickets/ps-305-authority-drift-guardrails.md';
const doc = read(docPath);
const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
const architecture = read('ARCHITECTURE.md');
const packageJson = read('package.json');
const ciWorkflow = read('.github/workflows/ci.yml');
const sotGuardPack = read('scripts/sot-guard-pack.mjs');

check('PS-305 authority drift guardrails doc exists', existsSync(docPath));

checkIncludesAll('PS-305 doc names backend authority domains', doc, [
  'Rates and proof',
  'Labels and Print Queue',
  'Billing and money',
  'Package, carrier, account, and row display facts',
]);
checkIncludesAll('PS-305 doc names canonical backend owners', doc, [
  'src/services/rates-combined.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/labels.ts#createLabelV2',
  'src/services/print-queue.ts',
  'src/services/shipping-workflow/rate-money.ts',
  'src/services/shipping-margin-analytics.ts',
  'src/services/package-facts-policy.ts',
  'src/services/shipping-workflow/best-rate-workflow-dto.ts',
]);
checkIncludesAll('PS-305 doc records frontend fallback debt explicitly', doc, [
  'web/src/components/Views/OrdersView.tsx',
  'web/src/hooks/useOrders.ts',
  'web/src/components/Views/order-shipping-display.ts',
  'web/src/components/Views/orders-display-state.ts',
  'web/src/components/Views/orders-row-display.tsx',
  'web/src/components/RateBrowserModal.tsx',
  'web/src/lib/rate-proof.ts',
  'PS-306 debt',
]);
checkIncludesAll('PS-305 doc rejects frontend-owned business truth', doc, [
  'Frontend-computed final/best rate',
  'Frontend-minted selected-rate proof',
  'Frontend direct label purchase orchestration',
  'Frontend billing totals used as invoice truth',
  'Frontend package/dim/weight precedence',
]);
check('PS-305 doc keeps safety scope offline and non-mutating',
  doc.includes('offline and read-only') &&
  doc.includes('does not run live labels') &&
  doc.includes('production order mutations') &&
  doc.includes('shipped/cancelled data mutations'));

const requiredCommands = [
  'test:ps-111-backend-rate-authority',
  'test:ps-124-backend-combined-best-rate',
  'test:ps-244-rate-finalization-single-owner',
  'test:ps-302-apply-best-rate-authority',
  'test:ps-307-marked-rate-comparison',
  'test:selected-rate-proof-boundary',
  'test:ps-202-direct-label-owner',
  'test:print-to-queue-selected-rate-proof',
  'test:ps-303-print-queue-authority',
  'test:ps-177-row-money-display',
  'test:ps-220-house-margin',
  'test:ps-295-house-customer-rate-proof',
  'test:ps-296-shipping-margin',
  'test:ps-296-shipping-margin-closeout',
  'test:ps-205-package-facts-precedence',
  'test:ps-301-row-workflow-authority',
  'test:ps-304-shipping-display-facts-authority',
  'test:ps-305-authority-drift',
];

for (const command of requiredCommands) {
  check(`PS-305 doc lists ${command}`, doc.includes(command));
  check(`package wires ${command}`, packageJson.includes(`"${command}"`));
}

check('package wires PS-305 authority drift guard to this script',
  /"test:ps-305-authority-drift"\s*:\s*"tsx scripts\/ps-305-authority-drift-guard\.ts"/.test(packageJson));
check('GitHub CI runs PS-305 authority drift guard before typecheck/build, directly or through PS-335 guard pack',
  (() => {
    const directGuardIndex = ciWorkflow.indexOf('npm run test:ps-305-authority-drift');
    const packIndex = ciWorkflow.indexOf('npm run test:sot-guard-pack');
    const guardIndex = directGuardIndex >= 0 ? directGuardIndex : packIndex;
    const typecheckIndex = ciWorkflow.indexOf('npm run typecheck');
    const buildIndex = ciWorkflow.indexOf('npm run build:web');
    return guardIndex >= 0 &&
      typecheckIndex > guardIndex &&
      buildIndex > typecheckIndex &&
      (directGuardIndex >= 0 || sotGuardPack.includes('test:ps-305-authority-drift'));
  })());
check('PS-300 workflow records PS-305 guard command',
  workflowDoc.includes('test:ps-305-authority-drift'));
check('PS-300 workflow first authority gate includes PS-305 after PS-304',
  /test:ps-304-shipping-display-facts-authority[\s\S]*test:ps-304-account-fallback-debt[\s\S]*test:ps-305-authority-drift/.test(workflowDoc));

check('architecture rejects frontend backend-critical authority',
  architecture.includes('Frontend must not own backend-critical decisions') &&
  architecture.includes('Frontend / UI') &&
  architecture.includes('Money/label/inventory/fulfillment/auth/rate/marketplace'));
check('architecture keeps current frontend hotspots visible',
  [
    'web/src/components/Views/OrdersView.tsx',
    'web/src/lib/v2-apiClient.ts',
    'web/src/components/RateBrowserModal.tsx',
    'web/src/components/Views/BillingView.tsx',
    'web/src/components/Views/DashboardView.tsx',
    'web/src/components/Views/InventoryView.tsx',
  ].every((path) => architecture.includes(path)));
check('architecture says read models can be fast without moving authority to frontend',
  /read models \/ DTOs[\s*]*provide fast UI display state/.test(architecture) &&
  architecture.includes('final mutation boundaries re-validate'));

const ratesCombined = read('src/services/rates-combined.ts');
checkPatterns('backend rates owner exports final carrier-universe combiner', ratesCombined, [
  /export function combineCarrierUniverses/,
  /DIRECT_CARRIER_QUOTE_TIMEOUT_MS/,
  /dedupeBrowseRates/,
  // Canonicalized money fields (e9762409): the ranking basis itself must read customer
  // money through the canonical normalizer — not just anywhere in the file.
  /export function rateTotal[\s\S]{0,120}?normalizeShippingRateMoney\(rate\)\.cShippingRateAmount/,
  /export function rateTotal/,
]);
check('rates route delegates final combination to backend combiner',
  read('src/routes/rates.ts').includes('produceRateBrowsePayload') &&
    read('src/services/rate-browse-response-producer.ts').includes('combineCarrierUniverses({'));
check('rates backfill also delegates final combination to backend combiner',
  read('src/services/rates-backfill.ts').includes('combineCarrierUniverses({'));

const quoteStore = read('src/services/shipping-workflow/rate-quote-snapshot-store.ts');
checkPatterns('backend rate proof owner validates selected-rate purchase refs', quoteStore, [
  /export async function finalizeBestRateWithQuote/,
  /export async function assertLabelPurchaseRateSelection/,
  /resolveRateQuoteForPurchase/,
  /BACKEND_RATE_PROOF_SOURCE/,
]);

const labels = read('src/services/labels.ts');
checkPatterns('backend label owner enforces proof before provider purchase', labels, [
  /export async function createLabelV2/,
  /await assertLabelPurchaseRateSelection\(/,
  /createDirectCarrierLabelForOrder\(/,
]);
check('label route delegates create requests to createLabelV2',
  read('src/routes/labels.ts').includes('createLabelV2(body, labelsScopeFromContext(c))'));
const printQueue = read('src/services/print-queue.ts');
checkPatterns('print queue delegates purchase and receipt recovery only to backend label owners', printQueue, [
  /createLabelV2\(input, labelPurchaseScope\)/,
  /resumeLabelV2FromDurableReceipt\(input, labelPurchaseScope\)/,
  /resumeShopifyShippingLabelFromDurableReceipt\(input, labelPurchaseScope\)/,
]);
checkPatterns('receipt-only label owners cannot dispatch a provider purchase', labels, [
  /resumeLabelV2FromDurableReceipt[\s\S]*?allowProviderDispatch: false/,
  /resumeShopifyShippingLabelFromDurableReceipt[\s\S]*?allowProviderDispatch: false/,
]);

const moneyOwner = read('src/services/shipping-workflow/rate-money.ts');
checkPatterns('backend money owner exports row money and marketplace display helpers', moneyOwner, [
  /export function buildOrderRowMoneyDisplay/,
  /export function computeMarketplaceFee/,
  /export function buildOrderRowMarketplace/,
  /export function applyMarkupToAmount/,
]);
const shippingMargin = read('src/services/shipping-margin-analytics.ts');
checkPatterns('backend shipping margin owner exports analytics read model', shippingMargin, [
  /export function buildShippingMarginRow/,
  /export function buildShippingMarginAnalytics/,
  /export async function shippingMarginAnalytics/,
]);

const packageFacts = read('src/services/package-facts-policy.ts');
checkPatterns('backend package facts owner exports effective package precedence', packageFacts, [
  /export function resolvePackageFactsFromInputs/,
  /combo_default/,
  /single_sku_default/,
  /imported/,
]);
const workflowDto = read('src/services/shipping-workflow/best-rate-workflow-dto.ts');
checkPatterns('backend workflow DTO owns row workflow, eligibility, and display tuple', workflowDto, [
  /export type BestRateWorkflowAllowedActions/,
  /export type OrderRowWorkflowDisplay/,
  /export function withOrderRowWorkflow/,
  /buildOrderRowMoneyDisplay/,
  /display: displayTupleFor\(facts\)/,
]);
check('orders route enriches rows through backend workflow DTO',
  read('src/routes/orders.ts').includes('withOrderRowWorkflow(bestRateWorkflow, {'));

const rateProof = read('web/src/lib/rate-proof.ts');
check('frontend rate-proof helper reads backend proof and does not recompute fingerprint',
  rateProof.includes('NEVER recompute a fingerprint') &&
  rateProof.includes('selectionRef') &&
  !rateProof.includes('createHash(') &&
  !rateProof.includes('buildShippingRateRequestFingerprint(') &&
  !rateProof.includes('selectedRateAuthorityKey('));
const rateBrowser = read('web/src/components/RateBrowserModal.tsx');
check('Rate Browser passes backend proof fields through instead of minting purchase truth',
  rateBrowser.includes('function rateBackendProof') &&
  rateBrowser.includes("'rateQuoteId'") &&
  rateBrowser.includes("'selectedRateKey'") &&
  rateBrowser.includes("'selectionRef'") &&
  rateBrowser.includes("'proofSource'"));
const useOrders = read('web/src/hooks/useOrders.ts');
check('frontend row adapter prefers backend canonical shipping model before legacy fields',
  useOrders.includes('const shippingModel = toRecordValue(canonicalOrder?.shipping) ?? toRecordValue(row.shipping)') &&
  useOrders.includes('shippingModel.carrierCode ?? selectedRate?.carrierCode') &&
  useOrders.includes('shippingModel.accountNickname ??'));
const displayState = read('web/src/components/Views/orders-display-state.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const shippingDisplay = read('web/src/components/Views/order-shipping-display.ts');
check('frontend display helpers keep remaining fallback debt explicit',
  shippingDisplay.includes('NOT moved here (intentionally): the shipping-ACCOUNT / provider-nickname display') &&
  displayState.includes('candidate RESOLUTION stays here') &&
  rowDisplay.includes('backend-owned row money tuple'));

// ── PS-305 ENFORCEMENT: real frontend-authority drift SCANNER ──────────────────
// The checks above pin docs + backend owners but never scan the frontend. This is the
// enforcement the card's "Done when" requires: recursively read web/src and FAIL when a
// backend-critical authority pattern appears in a NON-allowlisted frontend file. The
// allowlist captures TODAY's known PS-302/303/306 debt (so the guard passes now) and
// RATCHETS — a forbidden pattern may not spread to a new file. Empty-allowlist classes
// (hard-coded HUGRAB insurance, FE fingerprint/proof minting) fail on ANY occurrence.
type ForbiddenClass = { id: string; description: string; pattern: RegExp; allowlist: string[] };

const FORBIDDEN_FRONTEND_AUTHORITY: ForbiddenClass[] = [
  {
    id: 'fe_direct_label_buy',
    description: 'FE orchestrates a direct-carrier label PURCHASE then queue (postage buy belongs to the backend Print Queue owner — PS-303).',
    pattern: /createDirectCarrierLabelThenQueue/,
    allowlist: ['web/src/components/Views/OrdersView.tsx'],
  },
  {
    id: 'fe_queue_route_authority',
    description: "FE classifies the queue/label money-path route ('direct-create' vs backend) — backend owns routing (PS-303).",
    pattern: /classifyQueueOrderRoute\s*\(/,
    allowlist: [],
  },
  {
    id: 'hugrab_hardcoded_insurance',
    description: 'FE hard-codes the HUGRAB $100 insured value/default — effective insurance is backend-owned (PS-290/PS-261).',
    pattern: /HUGRAB_DEFAULT_INSURED_VALUE/,
    allowlist: [],
  },
  {
    id: 'fe_fingerprint_or_proof_minting',
    description: 'FE mints a rate-request fingerprint / selected-rate proof authority — proof is backend-issued (PS-244).',
    pattern: /buildShippingRateRequestFingerprint\s*\(|selectedRateAuthorityKey\s*\(|createHash\s*\(/,
    allowlist: [],
  },
];

function listFrontendSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.vite') continue;
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
    }
  };
  walk(root);
  return out;
}

type FrontendAuthorityViolation = { class: string; file: string };
function scanForbiddenFrontendAuthority(
  files: { path: string; content: string }[],
  classes: ForbiddenClass[],
): FrontendAuthorityViolation[] {
  const violations: FrontendAuthorityViolation[] = [];
  for (const file of files) {
    const norm = file.path.split(sep).join('/');
    for (const cls of classes) {
      if (cls.pattern.test(file.content) && !cls.allowlist.includes(norm)) {
        violations.push({ class: cls.id, file: norm });
      }
    }
  }
  return violations;
}

// Negative control — the scanner MUST flag a synthetic violation in a non-allowlisted
// file (proves the guard can actually fail; a guard that can never fail is not enforcement).
const negControl = scanForbiddenFrontendAuthority(
  [{ path: 'web/src/__ps305_neg_control__.ts', content: 'const v = HUGRAB_DEFAULT_INSURED_VALUE; await createDirectCarrierLabelThenQueue();' }],
  FORBIDDEN_FRONTEND_AUTHORITY,
);
check('PS-305 scanner negative control flags synthetic frontend-authority violations', negControl.length >= 2, negControl);

// Real scan of the frontend tree — FAIL on any non-allowlisted drift.
const feFiles = listFrontendSourceFiles('web/src').map((p) => ({ path: p, content: read(p) }));
check('PS-305 scanner read the frontend tree', feFiles.length > 50, feFiles.length);
const driftViolations = scanForbiddenFrontendAuthority(feFiles, FORBIDDEN_FRONTEND_AUTHORITY);
check('PS-305 no NEW frontend backend-critical authority drift (allowlisted PS-302/303/306 debt excepted)',
  driftViolations.length === 0, driftViolations);

if (failures > 0) {
  console.error(`\nFAIL PS-305 authority drift guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-305 authority drift guard');
