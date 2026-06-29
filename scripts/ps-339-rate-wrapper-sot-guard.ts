/**
 * PS-339 - Rate wrapper source-of-truth guard.
 *
 * Offline/static only: no DB, no network, no providers, no labels, no postage,
 * no marketplace notification, no production data mutation, and no
 * shipped/cancelled mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

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
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sliceBetween(source: string, startToken: string, endToken: string): string {
  const start = source.indexOf(startToken);
  if (start < 0) return '';
  const end = source.indexOf(endToken, start + startToken.length);
  return end > start ? source.slice(start, end) : '';
}

function checkIncludesAll(name: string, text: string, values: string[]): void {
  const missing = values.filter((value) => !text.includes(value));
  check(name, missing.length === 0, missing);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
}

type PatternClass = {
  id: string;
  description: string;
  pattern: RegExp;
};

type ScannedFile = {
  path: string;
  content: string;
};

type Violation = {
  class: string;
  file: string;
  description: string;
};

const FORBIDDEN_RATE_WRAPPER_PATTERNS: PatternClass[] = [
  {
    id: 'ratebrowser_local_rank_emit',
    description: 'Rate Browser locally ranks by a display total and emits/persists that row as best.',
    pattern: /(?:rateDisplayTotal|readRateTotalAmount|rateBrowserCustomerAmount)[\s\S]{0,260}\.sort[\s\S]{0,360}(?:emitBestRateResolved|onBestRateResolved|bestRate\s*:)|\.sort[\s\S]{0,260}(?:rateDisplayTotal|readRateTotalAmount|rateBrowserCustomerAmount)[\s\S]{0,360}(?:emitBestRateResolved|onBestRateResolved|bestRate\s*:)/,
  },
  {
    id: 'local_index_best_rate',
    description: 'A wrapper chooses official bestRate/secondBestRate from a local sorted array index.',
    pattern: /\b(?:bestRate|secondBestRate|canonicalBest|recommendedRate)\s*[:=]\s*(?:sorted|ranked|available|rates|combined|rows)\s*\[\s*[01]\s*\]/,
  },
  {
    id: 'frontend_proof_minting',
    description: 'Frontend mints selected-rate proof/freshness instead of passing backend proof through.',
    pattern: /(?:proofSource\s*:\s*['"`](?!backend_rate_response)|requestFingerprint\s*:\s*(?:crypto\.randomUUID|Date\.now|new Date|Math\.random|createHash|hash\()|rateQuoteId\s*:\s*(?:crypto\.randomUUID|Date\.now|Math\.random)|selectedRateKey\s*:\s*(?:crypto\.randomUUID|Date\.now|Math\.random))/,
  },
  {
    id: 'best_rate_fallback_chain',
    description: 'Frontend searches multiple legacy shapes to resolve authoritative Best Rate.',
    pattern: /\b(?:apiBestRate|bestRateLegacy|shipping\.bestRate|canonicalOrder\.shipping|raw\.bestRate)\b[^\n;]{0,220}\?\?[^\n;]{0,220}\?\?/,
  },
  {
    id: 'best_rate_override_helper',
    description: 'A frontend helper rewrites order/shipping Best Rate truth.',
    pattern: /\b(?:withBestRateOverride|withoutStaleBestRate|displayBestRate|hasPositiveRateAmount)\b/,
  },
  {
    id: 'frontend_rate_proof_hashing',
    description: 'Frontend imports or calls backend fingerprint/proof minters.',
    pattern: /\b(?:buildShippingRateRequestFingerprint|selectedRateAuthorityKey|createHash)\b/,
  },
];

function scanForbiddenRateWrapperPatterns(
  files: ScannedFile[],
  patterns: PatternClass[] = FORBIDDEN_RATE_WRAPPER_PATTERNS,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    for (const entry of patterns) {
      if (entry.pattern.test(code)) {
        violations.push({ class: entry.id, file: file.path, description: entry.description });
      }
    }
  }
  return violations;
}

const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-339-rate-wrapper-sot.md';
const doc = read(docPath);

const modalPath = 'web/src/components/RateBrowserModal.tsx';
const v2ClientPath = 'web/src/lib/v2-apiClient.ts';
const v2SharedPath = 'web/src/lib/v2-apiClient/shared.ts';
const useOrdersPath = 'web/src/hooks/useOrders.ts';
const rowDisplayPath = 'web/src/components/Views/orders-row-display.tsx';
const rateProofPath = 'web/src/components/Views/orders/best-rate/rate-proof.ts';
const rateHelpersPath = 'web/src/components/Views/orders/best-rate/rate-helpers.ts';
const rateBrowserMoneyPath = 'web/src/lib/rate-browser-money.ts';

const modal = read(modalPath);
const v2Client = read(v2ClientPath);
const v2Shared = read(v2SharedPath);
const useOrders = read(useOrdersPath);
const rowDisplay = read(rowDisplayPath);
const rateProof = read(rateProofPath);
const rateHelpers = read(rateHelpersPath);
const rateBrowserMoney = read(rateBrowserMoneyPath);

type AllowedDebt = {
  id: string;
  file: string;
  symbol: string;
  owner: string;
  removalCondition: string;
  why: string;
};

const ALLOWED_DEBT: AllowedDebt[] = [
  {
    id: 'PS339-DEBT-v2-legacy-display-translator',
    file: v2SharedPath,
    symbol: 'translateRateToLegacyDisplayShape',
    owner: 'PS-320/PS-342',
    removalCondition: 'Delete when legacy Rate Browser and calculator callers consume backend DTO rows directly.',
    why: 'Legacy display adapter passes backend-issued aliases through and must not rank/select/prove rates.',
  },
  {
    id: 'PS339-DEBT-useorders-selected-rate-normalizer',
    file: useOrdersPath,
    symbol: 'normalizeRateForV2',
    owner: 'PS-341/PS-344',
    removalCondition: 'Delete when order rows no longer need v2 selected-rate compatibility shape.',
    why: 'Selected/purchased-rate display compatibility only; not allowed to normalize Best Rate.',
  },
  {
    id: 'PS339-DEBT-row-second-best-shape-reader',
    file: rowDisplayPath,
    symbol: 'getCachedSecondBestRate',
    owner: 'PS-334/Best Rate Final',
    removalCondition: 'Delete when backend row DTO emits one canonical bestRateFinal/secondBest display field.',
    why: 'Reads cached backend secondBestRate from legacy DTO shapes for display only.',
  },
  {
    id: 'PS339-DEBT-row-second-best-money-reader',
    file: rowDisplayPath,
    symbol: 'readRateTotalAmount',
    owner: 'PS-334/Best Rate Final',
    removalCondition: 'Delete when backend row DTO emits the numeric bestRateFinal amount directly.',
    why: 'Computes display amount for cached backend secondBestRate; cannot choose or persist best rate.',
  },
  {
    id: 'PS339-DEBT-rate-proof-metadata-wrapper',
    file: rateProofPath,
    symbol: 'withRateRequestMetadata',
    owner: 'PS-317/PS-341',
    removalCondition: 'Delete when Apply/label/queue payloads can pass backend proof DTOs verbatim.',
    why: 'Wraps backend-issued proof metadata; it must not hash or mint local fingerprints.',
  },
  {
    id: 'PS339-DEBT-ratebrowser-proof-lifter',
    file: modalPath,
    symbol: 'rateBackendProof',
    owner: 'PS-198/PS-321',
    removalCondition: 'Delete when Rate Browser row DTO and applied-rate DTO share one backend proof shape.',
    why: 'Lifts backend proof fields from row/raw/canonical best for Apply pass-through only.',
  },
  {
    id: 'PS339-DEBT-ratebrowser-display-rank-sorter',
    file: rateBrowserMoneyPath,
    symbol: 'sortRateRowsByBackendDisplayRank',
    owner: 'PS-321/PS-343',
    removalCondition: 'Delete amount fallback when backend displayRank is present on every Rate Browser row.',
    why: 'Display ordering helper only; Rate Browser must not emit/persist its sorted first row as Best Rate.',
  },
];

check('package wires test:ps-339-rate-wrapper-sot',
  /"test:ps-339-rate-wrapper-sot"\s*:\s*"tsx scripts\/ps-339-rate-wrapper-sot-guard\.ts"/.test(packageJson));
for (const command of [
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:rate-source-of-truth',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-333-hugrab-current-rate-sot',
  'test:ps-334-house-rate-column',
]) {
  check(`package keeps predecessor guard ${command}`, packageJson.includes(`"${command}"`));
}

check('PS-339 rate-wrapper SOT doc exists', existsSync(docPath));
checkIncludesAll('PS-339 doc records scope, collision, allowlist, and required proof', doc, [
  'PS-339 - Rate Wrapper SOT Guard',
  'PS-339 Number Collision',
  'Forbidden Wrapper Patterns',
  'Allowed Thin Helpers',
  'Existing Debt Allowlist',
  'Required Proof',
  'test:ps-339-rate-wrapper-sot',
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:rate-source-of-truth',
  'test:ps-320-v2-api-client-transport',
  'test:ps-321-ratebrowsermodal-thin-ui',
  'test:ps-333-hugrab-current-rate-sot',
  'test:ps-334-house-rate-column',
]);

for (const debt of ALLOWED_DEBT) {
  check(`allowlist ${debt.id} has owner and removal condition`, Boolean(debt.owner && debt.removalCondition && debt.why));
  check(`allowlist ${debt.id} file exists`, existsSync(debt.file));
  check(`allowlist ${debt.id} symbol exists in file`, read(debt.file).includes(debt.symbol));
  checkIncludesAll(`doc records allowlist ${debt.id}`, doc, [
    debt.id,
    debt.file,
    debt.symbol,
    debt.owner,
    debt.removalCondition,
  ]);
}

const negativeControl = scanForbiddenRateWrapperPatterns([
  {
    path: 'web/src/components/__ps339_local_rank_emit__.tsx',
    content: `
      const sorted = rates.sort((a, b) => rateDisplayTotal(a) - rateDisplayTotal(b));
      emitBestRateResolved(sorted[0]);
    `,
  },
  {
    path: 'web/src/lib/v2-apiClient/__ps339_minted_money_proof__.ts',
    content: `
      return {
        amount: readRateTotalAmount(rate),
        shipmentCost: rate.shipping_amount.amount,
        bestRate: sorted[0],
        proofSource: 'frontend',
        requestFingerprint: crypto.randomUUID(),
        rateQuoteId: crypto.randomUUID(),
      };
    `,
  },
  {
    path: 'web/src/hooks/__ps339_fallback_chain__.ts',
    content: `
      const best = apiBestRate ?? bestRateLegacy ?? selectedRate ?? shipping.bestRate ?? canonicalOrder.shipping.bestRate;
      return { bestRate: best };
    `,
  },
], FORBIDDEN_RATE_WRAPPER_PATTERNS);
check('PS-339 scanner negative control flags local rank, proof minting, and fallback-chain wrappers',
  new Set(negativeControl.map((hit) => hit.class)).size >= 3,
  negativeControl);

const positiveControl = scanForbiddenRateWrapperPatterns([
  {
    path: 'web/src/components/__ps339_format_money__.ts',
    content: `
      export function formatMoney(amount: number | null | undefined) {
        return typeof amount === 'number' ? '$' + amount.toFixed(2) : '-';
      }
    `,
  },
  {
    path: 'web/src/components/__ps339_backend_dto_render__.tsx',
    content: `
      const money = order.bestRateWorkflow?.money;
      return <span>{money?.customerRateAmount ?? null}</span>;
    `,
  },
], FORBIDDEN_RATE_WRAPPER_PATTERNS);
check('PS-339 scanner positive control allows formatMoney and pure backend DTO rendering',
  positiveControl.length === 0,
  positiveControl);

const realViolations = scanForbiddenRateWrapperPatterns([
  { path: modalPath, content: modal },
  { path: v2ClientPath, content: v2Client },
  { path: v2SharedPath, content: v2Shared },
  { path: useOrdersPath, content: useOrders },
  { path: rowDisplayPath, content: rowDisplay },
  { path: rateProofPath, content: rateProof },
  { path: rateHelpersPath, content: rateHelpers },
  { path: rateBrowserMoneyPath, content: rateBrowserMoney },
]);
check('PS-339 target files contain no forbidden rate-wrapper SOT bypass patterns',
  realViolations.length === 0,
  realViolations);

const browseRatesBlock = sliceBetween(v2Client, 'browseRates(data: Record<string, unknown>)', '\n  // ');
const fetchRatesBlock = sliceBetween(v2Client, 'fetchRates(data: Record<string, unknown>)', '\n  fetchCachedRatesBulk');
const fetchCachedRatesBulkBlock = sliceBetween(v2Client, 'fetchCachedRatesBulk(items: Record<string, unknown>[])', '\n\n  // Thin wrapper around POST /rates/browse');
const translatorBlock = sliceBetween(v2Shared, 'export function translateRateToLegacyDisplayShape', '\nexport async function fetchBlob');
const normalizeRateForV2Block = sliceBetween(useOrders, 'function normalizeRateForV2(', '\nfunction normalizeLabelForV2');
const transformBlock = sliceBetween(useOrders, 'function transformOrderRowV4toV2(', '\nfunction toIsoStart');
const shippingBlock = sliceBetween(transformBlock, 'const shipping = shippingModel', '\n\n  return {');
const rateBackendProofBlock = sliceBetween(modal, 'function rateBackendProof(', '\n\n  function rateIsBackendComplete');
const autoEmissionBlock = sliceBetween(modal, 'if (!cachedProbeHasIncompleteCoverage && onBestRateResolved', '\n\n    finishBrowseRequest');
const combinedAllBlock = sliceBetween(modal, 'const combinedAll: RateRow[] = useMemo(', '\n\n  const totalCarriersAvailable');
const savedBestRateBlock = sliceBetween(rateProof, 'export function getSavedBestRateRecord(', '\n\n// PS-204');
const metadataBlock = sliceBetween(rateProof, 'export function withRateRequestMetadata(', '\n\nexport function getSavedBestRateRecord');
const secondBestReaderBlock = sliceBetween(rowDisplay, 'function getCachedSecondBestRate(', '\n\nexport function getBestRateBaseCost');
const secondBestAmountBlock = sliceBetween(rowDisplay, 'function readRateTotalAmount(', '\n\nfunction getCachedSecondBestRate');

check('v2 browseRates is backend DTO pass-through only',
  /return postRateBrowseTransport\(data\)/.test(browseRatesBlock) &&
    !/bestRate\s*:|secondBestRate\s*:|amount\s*:|shipmentCost\s*:|requestFingerprint|proofSource|rateQuoteId|selectedRateKey/.test(browseRatesBlock),
  browseRatesBlock);
check('v2 fetchRates uses legacy array adapter and does not expose a local Best Rate DTO',
  /postRateBrowseTransport\(data\)\.then\(\(backendResult\) => toLegacyRateArray\(backendResult\)\)/.test(fetchRatesBlock) &&
    !/bestRate\s*:|secondBestRate\s*:|requestFingerprint|proofSource|rateQuoteId|selectedRateKey|\.sort\s*\(/.test(fetchRatesBlock),
  fetchRatesBlock);
check('cached bulk can pass through backend hit.bestRate but cannot rebuild a bestRate object',
  /bestRate:\s*item\.hit\.bestRate \?\? null/.test(fetchCachedRatesBulkBlock) &&
    countMatches(fetchCachedRatesBulkBlock, /\bbestRate\s*:/g) === 1 &&
    !/bestRate:\s*\{|\bsecondBestRate\s*:|proofSource\s*:|requestFingerprint\s*:/.test(fetchCachedRatesBulkBlock),
  fetchCachedRatesBulkBlock);

check('v2 legacy rate translator only passes through backend money/proof aliases',
  /amount:\s*obj\.amount \?\? null/.test(translatorBlock) &&
    /shipmentCost:\s*obj\.shipmentCost \?\? null/.test(translatorBlock) &&
    /otherCost:\s*obj\.otherCost \?\? null/.test(translatorBlock) &&
    /requestFingerprint:\s*obj\.requestFingerprint \?\? null/.test(translatorBlock) &&
    /proofSource:\s*obj\.proofSource \?\? null/.test(translatorBlock) &&
    /rateQuoteId:\s*obj\.rateQuoteId \?\? null/.test(translatorBlock) &&
    /selectedRateKey:\s*obj\.selectedRateKey \?\? null/.test(translatorBlock) &&
    /secondBestRate:\s*obj\.secondBestRate \? translateRateToLegacyDisplayShape\(obj\.secondBestRate\) : null/.test(translatorBlock) &&
    !/rateTotal\(|pickBestRate|rankRates|\.sort\s*\(|Math\.min|createHash|buildShippingRateRequestFingerprint|selectedRateAuthorityKey/.test(translatorBlock),
  translatorBlock);

check('useOrders selected-rate compatibility normalizer is not used for Best Rate',
  normalizeRateForV2Block.length > 200 &&
    /const selectedRate = normalizeRateForV2\(shippingModel\?\.selectedRate \?\? row\.selectedRate\)/.test(transformBlock) &&
    !/normalizeRateForV2\(shippingModel\?\.bestRate|normalizeRateForV2\(row\.bestRate|normalizeRateForV2\(.*bestRate/.test(transformBlock),
  transformBlock);
check('useOrders shipping rewrite does not create or overwrite shipping.bestRate',
  shippingBlock.length > 100 &&
    !/\bbestRate\s*:/.test(shippingBlock) &&
    !/bestRate\?\.carrierCode|bestRate\?\.serviceCode|displayBestRate|bestRateLegacy/.test(shippingBlock),
  shippingBlock);
check('useOrders selected-rate normalizer does not mint proof or official best fields',
  !/bestRate|secondBestRate|requestFingerprint|proofSource|rateQuoteId|selectedRateKey|cacheExpiresAt|\.sort\s*\(|rankRates|pickBestRate/.test(stripComments(normalizeRateForV2Block)),
  normalizeRateForV2Block);

check('RateBrowserModal emits only backend canonical best through decideBestRateEmission',
  /findCanonicalBestRate\(canonicalBackendBest, available\)/.test(autoEmissionBlock) &&
    /decideBestRateEmission\(canonicalBest\)/.test(autoEmissionBlock) &&
    /emitBestRateResolved\(applied\)/.test(autoEmissionBlock) &&
    !/(?:ratesToRank|available|combinedAll)\s*\[\s*0\s*\]|rateDisplayTotal|\.sort\s*\(/.test(stripComments(autoEmissionBlock)),
  autoEmissionBlock);
check('RateBrowserModal display sorting stays inside combinedAll and cannot emit/persist best',
  /sortRateRowsByBackendDisplayRank\(dedupeRateRows\(filterBySvcClass\(out\)\)\)/.test(combinedAllBlock) &&
    !/emitBestRateResolved|onBestRateResolved|bestRate\s*:/.test(combinedAllBlock),
  combinedAllBlock);
check('RateBrowserModal rateBackendProof lifts backend fields only and does not mint proof',
  rateBackendProofBlock.length > 500 &&
    /const value = \(r as Record<string, unknown>\)\[key\] \?\? raw\?\.\[key\] \?\? canonical\?\.\[key\]/.test(rateBackendProofBlock) &&
    /if \(typeof value === 'string' && value\) out\[key\] = value as any/.test(rateBackendProofBlock) &&
    /const secondBestRate = \(r as Record<string, unknown>\)\.secondBestRate \?\? raw\?\.secondBestRate \?\? canonical\?\.secondBestRate/.test(rateBackendProofBlock) &&
    !/crypto\.randomUUID|Date\.now|Math\.random|new Date|createHash|buildShippingRateRequestFingerprint|selectedRateAuthorityKey/.test(rateBackendProofBlock),
  rateBackendProofBlock);

check('orders-row-display Best Rate Final reads cached backend secondBestRate only',
  secondBestReaderBlock.length > 200 &&
    /toRecord\(bestRate\?\.secondBestRate\)/.test(secondBestReaderBlock) &&
    /toRecord\(shippingBestRateRaw\?\.second_best_rate\)/.test(secondBestReaderBlock) &&
    /return readRateTotalAmount\(getCachedSecondBestRate\(order\)\)/.test(rowDisplay) &&
    countMatches(rowDisplay, /readRateTotalAmount\(/g) === 2 &&
    !/rates\.sort|combined\[0\]|pickBestRate|rankRates|bestRateLegacy|withBestRateOverride|withoutStaleBestRate/.test(stripComments(secondBestReaderBlock + secondBestAmountBlock)),
  secondBestReaderBlock);

check('best-rate proof helper consumes normalized order.bestRate and never re-searches shipping.bestRate',
  /return toRecord\(order\.bestRate\)/.test(savedBestRateBlock) &&
    !/getShippingModel|shipping\.bestRate|overrides|bestRateJson|bestRateLegacy/.test(stripComments(savedBestRateBlock)),
  savedBestRateBlock);
check('withRateRequestMetadata may wrap backend metadata but cannot hash or locally mint proof',
  /const backendRequestFingerprint = getBackendRateResponseFingerprint\(metadata, rate\)/.test(metadataBlock) &&
    /backendRequestFingerprint[\s\S]{0,220}requestFingerprint: backendRequestFingerprint/.test(metadataBlock) &&
    /proofSource: BACKEND_RATE_PROOF_SOURCE/.test(metadataBlock) &&
    !/createHash|buildShippingRateRequestFingerprint|selectedRateAuthorityKey|crypto\.randomUUID|Math\.random/.test(metadataBlock),
  metadataBlock);
check('rate helper path has no best-rate override wrappers',
  !/withBestRateOverride|withoutStaleBestRate|bestRateLegacy|displayBestRate|hasPositiveRateAmount/.test(rateHelpers));

check('rate-browser money helper is display-only and not an authoritative best selector',
  /export function sortRateRowsByBackendDisplayRank/.test(rateBrowserMoney) &&
    /backendDisplayRank/.test(rateBrowserMoney) &&
    /rateBrowserCustomerAmount/.test(rateBrowserMoney) &&
    !/emitBestRateResolved|onBestRateResolved|bestRate\s*:|proofSource|requestFingerprint|rateQuoteId|selectedRateKey/.test(rateBrowserMoney),
  rateBrowserMoney);

if (failures > 0) {
  console.error(`\nFAIL PS-339 rate wrapper source-of-truth guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-339 rate wrapper source-of-truth guard');
