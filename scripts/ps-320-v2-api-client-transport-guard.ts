/**
 * PS-320 guard - v2-apiClient must stay transport-only after the backend SOT
 * owners exist.
 *
 * Offline/static only: no DB, no network, no providers, no labels, no postage,
 * no marketplace notification, no production data mutation, and no
 * shipped/cancelled mutation. This guard extends the PS-314/316 law and the
 * PS-313/317 authority guards with a focused scanner for v2-apiClient.
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

const packageJson = read('package.json');
const apiClientPath = 'web/src/lib/v2-apiClient.ts';
const sharedPath = 'web/src/lib/v2-apiClient/shared.ts';
const apiClient = read(apiClientPath);
const shared = read(sharedPath);
const apiClientCode = stripComments(apiClient);
const sharedCode = stripComments(shared);

const ps320DocPath = 'docs/ps-tickets/ps-320-v2-api-client-transport-boundary.md';
const ps320Doc = read(ps320DocPath);

check('PS-320 responsibility map doc exists', existsSync(ps320DocPath));
checkIncludesAll('PS-320 doc records transport-only responsibility map and backend owners', ps320Doc, [
  'v2-apiClient responsibility map',
  'Transport-only API methods',
  'Compatibility shims / DTO translators',
  'Forbidden in v2-apiClient',
  'src/services/rates-combined.ts',
  'src/routes/rates.ts#/browse',
  'src/services/labels.ts#createLabelV2',
  'src/services/print-queue.ts',
  'src/services/shipping-workflow/rate-quote-snapshot-store.ts',
  'src/services/shipping-workflow/rate-money.ts',
  'src/services/package-facts-policy.ts',
  'src/lib/direct-carrier-scope.ts',
  'src/lib/inventory-stock-status.ts',
]);
checkIncludesAll('PS-320 doc inventories the allowed legacy shims and why they are not SOT', ps320Doc, [
  'apiClient.fetchRates',
  'apiClient.browseRates',
  'postRateBrowseTransport',
  'apiClient.createLabel',
  'apiClient.addToQueue',
  'apiClient.applyBestRate',
  'apiClient.fetchCarriersForStore',
  'translateRatePayloadToV4',
  'translateRateToLegacyDisplayShape',
  'normalizeInventoryDto',
]);
checkIncludesAll('PS-320 doc records the rate-transport matrix from the Trello addendum', ps320Doc, [
  'Rate Transport Matrix',
  'Verbatim backend DTO pass-through',
  'Fields no longer synthesized in v2-apiClient',
  'amount',
  'shipmentCost',
  'otherCost',
  'proofSource',
]);
checkIncludesAll('PS-320 doc records offline safety limits', ps320Doc, [
  'No real label purchases',
  'No postage',
  'No marketplace notifications',
  'No production order mutations',
  'No shipped/cancelled mutations',
]);

check('package wires PS-320 v2-apiClient transport guard',
  /"test:ps-320-v2-api-client-transport"\s*:\s*"tsx scripts\/ps-320-v2-api-client-transport-guard\.ts"/.test(packageJson));

for (const command of [
  'test:ps-314-no-sot-bypass-wrappers',
  'test:ps-316-backend-truth-law',
  'test:rate-source-of-truth',
  'test:ps-317-fe-buy-anti-regression',
  'test:ps-302-thin-client-apply-delegation',
  'test:ps-303-fe-route-binding',
  'test:ps-305-authority-drift',
  'test:ps-202-direct-label-owner',
  'test:ps-124-backend-combined-best-rate',
  'test:ps-159-apiclient-deadmethods',
]) {
  check(`package keeps predecessor authority guard ${command}`, packageJson.includes(`"${command}"`));
}

const fetchRatesBlock = sliceBetween(apiClient, 'fetchRates(data: Record<string, unknown>)', '\n  fetchCachedRatesBulk');
const browseRatesBlock = sliceBetween(apiClient, 'browseRates(data: Record<string, unknown>)', '\n  browseShopifyRates');
const rateBrowseTransportBlock = sliceBetween(apiClient, 'async function postRateBrowseTransport(', '\nexport const apiClient');
const createLabelBlock = sliceBetween(apiClient, 'createLabel(payload: unknown)', '\n  // PS-139: removed dead FE method createLabelBatch');
const addToQueueBlock = sliceBetween(apiClient, 'addToQueue(payload: Record<string, unknown>)', '\n  startQueueSendJob');
const applyBestRateBlock = sliceBetween(apiClient, 'applyBestRate(', '\n  // PS-179: updateOrderBestRateSelectionStrict removed');
const fetchCarriersForStoreBlock = sliceBetween(apiClient, 'fetchCarriersForStore(', '\n  // ');

check('v2-apiClient has a single /rates/browse transport owner',
  rateBrowseTransportBlock.length > 0 &&
  (apiClient.match(/api\.post<any>\('\/rates\/browse'/g) ?? []).length === 1,
  { postCount: (apiClient.match(/api\.post<any>\('\/rates\/browse'/g) ?? []).length });

checkPatterns('rate browse transport posts normalized intent to backend /rates/browse', rateBrowseTransportBlock, [
  /api\.post<any>\('\/rates\/browse'/,
  /translateRatePayloadToV4\(data\)/,
  /stableRateBrowseKey\(/,
  /rateBrowseInflight/,
]);
check('browseRates is backend DTO pass-through and does not translate or rebuild rate fields',
  browseRatesBlock.length > 0 &&
  /return postRateBrowseTransport\(data\)/.test(browseRatesBlock) &&
  !/translateRate|bestRate\s*:|secondBestRate\s*:|rates\s*:|requestFingerprint|cacheExpiresAt|proofSource/.test(browseRatesBlock),
  browseRatesBlock);

check('fetchRates delegates to the same browse transport and only uses the legacy display adapter',
  fetchRatesBlock.length > 0 &&
  /postRateBrowseTransport\(data\)/.test(fetchRatesBlock) &&
  /toLegacyRateArray\(backendResult\)/.test(fetchRatesBlock) &&
  !/api\.post<any>\('\/rates\/browse'|Object\.defineProperty|requestFingerprint|cacheExpiresAt|proofSource/.test(fetchRatesBlock),
  fetchRatesBlock);

check('legacy rate mapper is explicitly display-only and not the official browse DTO path',
  /function translateRateToLegacyDisplayShape\(/.test(shared) &&
  !/translateRateToV2Shape/.test(apiClient + shared) &&
  !/translateRateToLegacyDisplayShape/.test(browseRatesBlock),
  browseRatesBlock);

check('backend /rates/browse stamps legacy display aliases before the client receives rates',
  /export function stampRateBrowserDisplayAliases(?:<[^>]+>)?\(/.test(read('src/services/rate-browser-display-fields.ts')) &&
  /responseRates = stampRateBrowserDisplayAliases\(responseRates\)/.test(read('src/services/rate-browse-response-producer.ts')) &&
  /bestRateOut = stampRateBrowserDisplayAliases\(bestRateOut\)/.test(read('src/services/rate-browse-response-producer.ts')),
);

check('fetchRates/browseRates do not fetch direct carrier rates or locally pick combined[0]',
  fetchRatesBlock.length > 0 &&
  browseRatesBlock.length > 0 &&
  !/fetchDirectCarrierRates\s*\(|combinedBestRate|combined\s*\[\s*0\s*\]|\.sort\s*\(/.test(fetchRatesBlock + browseRatesBlock));

check('createLabel is a thin backend /labels POST to createLabelV2',
  /api\.post<any>\('\/labels', payload\)\.then\(normalizeLabelResponse\)/.test(createLabelBlock) &&
  !/carriers\/labels|callVercelFunction|directLabelAccountRefFromProviderId|classifyLabelEndpoint|createDirectCarrierLabel/i.test(createLabelBlock));

check('addToQueue is a thin backend Print Queue POST and does not buy/select labels',
  /api\.post<any>\('\/print-queue\/add', payload\)/.test(addToQueueBlock) &&
  !/\/labels|\/rates|createLabel|bestRate|selectedRate|shippingProviderId|carrierId/i.test(addToQueueBlock));

check('applyBestRate delegates the atomic persist command to the backend owner',
  /api\.post<any>\(`\/orders\/\$\{orderId\}\/apply-best-rate`/.test(applyBestRateBlock) &&
  !/currentRequestFingerprint|setOrderSelectedPid|saveOrderDims|saveOrderBestRate/.test(applyBestRateBlock));

check('fetchCarriersForStore is a backend-only compatibility read shim with exact order context',
  /api\.get<any>\(\s*`\/rates\/carriers-for-store/.test(fetchCarriersForStoreBlock) &&
  /orderId: orderId \?\? undefined/.test(fetchCarriersForStoreBlock) &&
  !/\/carrier-accounts|\/store-accounts|directCarrierAccountVisibleForOrder|fetchDirectCarrierAccountRows/.test(fetchCarriersForStoreBlock));

check('v2-apiClient contains no frontend direct-carrier account authorization shim',
  !/directCarrierVisibleForScope|directCarrierAccountVisibleForOrder|fetchDirectCarrierAccountRows/.test(apiClientCode + sharedCode));

check('shared inventory shim requires backend canonical stockStatus without recomputing thresholds',
  /if \(!\['in', 'low', 'out'\]\.includes\(row\.stockStatus\)\)/.test(shared) &&
  /status: row\.stockStatus === 'in' \? 'ok' : row\.stockStatus/.test(shared) &&
  !/classifyStockStatus\(|function inventoryStatus\(/.test(shared));

check('legacy classifyLabelEndpoint is absent from v2-apiClient',
  !/\bclassifyLabelEndpoint\b/.test(apiClientCode));

type ForbiddenPattern = {
  id: string;
  description: string;
  pattern: RegExp;
};

const FORBIDDEN_V2_AUTHORITY: ForbiddenPattern[] = [
  {
    id: 'local_best_rate_selection',
    description: 'v2-apiClient locally selects final/best rates instead of consuming backend bestRate.',
    pattern: /\bcombinedBestRate\b|\bcombined\s*\[\s*0\s*\]|\brateTotal\s*\(|\.sort\s*\(\s*\([^)]*(?:rate|amount|cost)/,
  },
  {
    id: 'legacy_direct_carrier_rate_quote',
    description: 'v2-apiClient calls the retired FE/direct-carrier rate endpoint.',
    pattern: /fetchDirectCarrierRates\s*\(|callVercelFunction[\s\S]{0,160}\/carriers\/rates|['"`]\/(?:api\/)?carriers\/rates['"`]/,
  },
  {
    id: 'legacy_direct_carrier_label_buy',
    description: 'v2-apiClient calls the retired FE/direct-carrier label endpoint.',
    pattern: /callVercelFunction[\s\S]{0,160}\/carriers\/labels|['"`]\/(?:api\/)?carriers\/labels['"`]/,
  },
  {
    id: 'frontend_proof_minting',
    description: 'v2-apiClient mints fingerprints/proofs instead of passing backend proof fields.',
    pattern: /buildShippingRateRequestFingerprint\s*\(|selectedRateAuthorityKey\s*\(|createHash\s*\(|assertLabelPurchaseRateSelection\s*\(/,
  },
  {
    id: 'frontend_direct_purchase_orchestration',
    description: 'v2-apiClient reintroduces direct-carrier buy/purchase orchestration.',
    pattern: /createDirectCarrierLabelThenQueue|\b(?:buyDirect\w*|purchaseDirect\w*|directCarrier(?:Buy|Purchase)\w*)\s*\(/,
  },
];

type ScannedFile = { path: string; content: string };
type Violation = { class: string; file: string; description: string };

function scanForbiddenAuthority(files: ScannedFile[], classes: ForbiddenPattern[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const code = stripComments(file.content);
    for (const cls of classes) {
      if (cls.pattern.test(code)) {
        violations.push({ class: cls.id, file: file.path, description: cls.description });
      }
    }
  }
  return violations;
}

const negativeControl = scanForbiddenAuthority([
  {
    path: 'web/src/lib/v2-apiClient/__ps320_negative_control__.ts',
    content: `
      const combinedBestRate = combined[0];
      await api.post('/carriers/labels', payload);
      selectedRateAuthorityKey(rate);
      createDirectCarrierLabelThenQueue(order);
    `,
  },
], FORBIDDEN_V2_AUTHORITY);
check('PS-320 scanner negative control flags synthetic client-authority violations',
  negativeControl.length >= 4,
  negativeControl);

const realViolations = scanForbiddenAuthority([
  { path: apiClientPath, content: apiClientCode },
  { path: sharedPath, content: sharedCode },
], FORBIDDEN_V2_AUTHORITY);
check('v2-apiClient files contain no forbidden business-authority patterns',
  realViolations.length === 0,
  realViolations);

if (failures > 0) {
  console.error(`\nFAIL PS-320 v2-apiClient transport guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-320 v2-apiClient transport guard');
