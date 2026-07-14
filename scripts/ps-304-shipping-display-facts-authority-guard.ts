/**
 * PS-304 guard - package/carrier/account/display facts authority.
 *
 * Offline only: no DB, no network, no providers, no labels, no postage, no
 * marketplace notifications, and no production data mutation. This pins the
 * backend-owned package facts and row display tuple, including account display
 * tuple preference before older frontend compatibility fallbacks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolvePackageFactsFromInputs } from '../src/services/package-facts-policy';
import {
  buildBestRateWorkflowDto,
  withOrderRowWorkflow,
  type OrderRowWorkflowFacts,
} from '../src/services/shipping-workflow/best-rate-workflow-dto';
import {
  resolveDisplayCarrierCode,
  resolveDisplayServiceCode,
  resolveDisplayShipAccount,
} from '../web/src/components/Views/order-shipping-display';

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

const statusDoc = read('docs/ps-tickets/ps-304-shipping-display-facts-authority-status.md');

const comboFacts = { weightOz: 31, length: 12, width: 10, height: 3, selectedPackageId: '121' };
const importedFacts = { weightOz: 35, length: 14, width: 11, height: 9, selectedPackageId: null };

const resolvedCombo = resolvePackageFactsFromInputs({
  override: null,
  comboDefault: comboFacts,
  singleSkuDefault: null,
  imported: importedFacts,
  comboKey: 'booster-gel-001:2|hu-10:1',
});
check('backend package facts owner keeps saved combo defaults ahead of imported facts',
  resolvedCombo.source === 'combo_default' &&
  resolvedCombo.weightOz === 31 &&
  resolvedCombo.dims?.length === 12 &&
  resolvedCombo.dims.width === 10 &&
  resolvedCombo.dims.height === 3 &&
  resolvedCombo.selectedPackageId === '121',
  resolvedCombo);

const halfOverride = resolvePackageFactsFromInputs({
  override: { weightOz: 33, length: null, width: null, height: null, selectedPackageId: null },
  comboDefault: comboFacts,
  singleSkuDefault: null,
  imported: importedFacts,
});
check('backend package facts owner never mixes fields across rungs',
  halfOverride.source === 'override' &&
  halfOverride.weightOz === 33 &&
  halfOverride.dims === null &&
  halfOverride.selectedPackageId === null,
  halfOverride);

const materializedDefault = resolvePackageFactsFromInputs({
  override: comboFacts,
  comboDefault: comboFacts,
  singleSkuDefault: null,
  imported: importedFacts,
});
check('materialized package defaults report source honestly',
  materializedDefault.source === 'combo_default',
  materializedDefault);

const NOW = new Date('2026-06-22T12:00:00.000Z');
const FINGERPRINT = 'ps304|zip=19422|dims=12x10x3|provider=607855';
const freshRate = {
  amount: 10.79,
  shipmentCost: 10.79,
  otherCost: 0,
  serviceCode: 'ups_ground',
  carrierCode: 'ups',
  shippingProviderId: 607855,
  requestFingerprint: FINGERPRINT,
  cacheKey: FINGERPRINT,
  proofSource: 'backend_rate_response',
  isComplete: true,
  cacheExpiresAt: '2026-06-22T18:00:00.000Z',
};

const baseFacts: OrderRowWorkflowFacts = {
  orderStatus: 'awaiting_shipment',
  externallyShipped: false,
  canonicalStatus: null,
  isTest: false,
  hasCompleteDims: true,
  hasWeight: true,
  hasShipment: false,
  hasQueueableLabel: false,
  isDirectCarrierSelection: false,
  bestRateCarrierCode: 'ups',
  bestRateServiceCode: 'ups_ground',
  canonicalCarrierCode: 'fedex',
  canonicalServiceCode: 'fedex_home',
  canonicalAccountNickname: 'Backend Account',
  selectedRateCarrierCode: 'usps',
  providerAccountId: 607855,
};

const workflow = buildBestRateWorkflowDto({
  currentRequestFingerprint: FINGERPRINT,
  backendRequestKey: FINGERPRINT,
  savedBestRate: freshRate,
  source: 'cache',
  carrierStatuses: [{ carrierId: 'se-607855', carrierName: 'UPS', status: 'cached', rateCount: 1 }],
  now: NOW,
});

const awaitingDisplay = withOrderRowWorkflow(workflow, baseFacts).display;
check('backend display tuple owns awaiting carrier/service/account facts',
  awaitingDisplay?.carrierCode === 'ups' &&
  awaitingDisplay.serviceCode === 'ups_ground' &&
  awaitingDisplay.accountNickname === 'Backend Account' &&
  awaitingDisplay.providerAccountId === 607855,
  awaitingDisplay);

const shippedDisplay = withOrderRowWorkflow(
  buildBestRateWorkflowDto({ savedBestRate: null, source: 'none', now: NOW }),
  { ...baseFacts, orderStatus: 'shipped', hasShipment: true },
).display;
check('backend display tuple owns shipped canonical-first carrier/service facts',
  shippedDisplay?.carrierCode === 'fedex' &&
  shippedDisplay.serviceCode === 'fedex_home' &&
  shippedDisplay.accountNickname === 'Backend Account',
  shippedDisplay);

check('frontend carrier resolver prefers backend display tuple when present',
  resolveDisplayCarrierCode({
    isTest: false,
    isAwaiting: true,
    backendDisplayCarrierCode: 'backend_carrier',
    bestRateCarrierCode: 'ups',
    canonicalCarrierCode: 'fedex',
    selectedRateCarrierCode: 'usps',
    bestRateNickname: null,
    bestRateNicknameIsKnownCarrier: false,
  }) === 'backend_carrier');
check('frontend service resolver prefers backend display tuple when present',
  resolveDisplayServiceCode({
    isAwaiting: true,
    backendDisplayServiceCode: 'backend_service',
    hasBestRate: true,
    bestRateServiceCode: 'ups_ground',
    canonicalServiceCode: 'fedex_home',
  }) === 'backend_service');
check('frontend account resolver still keeps live-cache candidate precedence explicit',
  resolveDisplayShipAccount({
    isTest: false,
    backendDisplayAccountNickname: null,
    awaitingBestRateNickname: null,
    canonicalNickname: 'Backend Account',
    selectedNickname: 'Selected Account',
    v2AccountNickname: 'Static Account',
    hasSelectedRate: true,
    labelAccountLabel: null,
    bestRateNickname: 'Best Account',
    carrierCodeFallback: 'UPS',
  }) === 'Backend Account');
check('frontend account resolver prefers backend display tuple when present',
  resolveDisplayShipAccount({
    isTest: false,
    backendDisplayAccountNickname: 'Backend Tuple Account',
    awaitingBestRateNickname: 'Awaiting Rate Account',
    canonicalNickname: 'Canonical Account',
    selectedNickname: 'Selected Account',
    v2AccountNickname: 'Static Account',
    hasSelectedRate: true,
    labelAccountLabel: 'Live Label Account',
    bestRateNickname: 'Best Account',
    carrierCodeFallback: 'UPS',
  }) === 'Backend Tuple Account');

const packagePolicy = read('src/services/package-facts-policy.ts');
check('package facts policy is a pure backend owner',
  packagePolicy.includes('export function resolvePackageFactsFromInputs') &&
  !packagePolicy.includes('fetch(') &&
  !/\bfrom\s+['"][^'"]*\/db/.test(packagePolicy));

const workflowOwner = read('src/services/shipping-workflow/best-rate-workflow-dto.ts');
check('backend workflow DTO declares display tuple with account and provider identity',
  workflowOwner.includes('export type OrderRowWorkflowDisplay = {') &&
  workflowOwner.includes('carrierCode: string | null') &&
  workflowOwner.includes('serviceCode: string | null') &&
  workflowOwner.includes('accountNickname: string | null') &&
  workflowOwner.includes('providerAccountId: number | null'));
check('backend workflow DTO computes display tuple in withOrderRowWorkflow',
  /function displayTupleFor\(facts: OrderRowWorkflowFacts\): OrderRowWorkflowDisplay/.test(workflowOwner) &&
  /display: displayTupleFor\(facts\)/.test(workflowOwner));

const ordersRoute = read('src/routes/orders.ts');
const ordersReadModel = read('src/services/orders-read-model.ts');
check('orders route imports and emits backend package facts on detail payloads',
  ordersRoute.includes('resolveOrderPackageFacts') &&
  (ordersRoute.match(/packageFacts: await resolveOrderPackageFacts\(id\)/g)?.length ?? 0) >= 2);
check('orders canonical model owns weight and dimension source maps',
  ordersReadModel.includes('export function buildCanonicalOrderModel(') &&
  ordersReadModel.includes("weight: overrideWeightOz != null") &&
  ordersReadModel.includes("dimensions: dimensionSource") &&
  ordersReadModel.includes("'dimensions.length': dimensionSource") &&
  ordersReadModel.includes("'dimensions.height': dimensionSource") &&
  ordersRoute.includes("from '../services/orders-read-model'"));
check('orders route builds canonical shipping display facts before returning rows',
  ordersRoute.includes('const shipping = {') &&
  ordersRoute.includes('carrierCode: canonicalCarrierCode') &&
  ordersRoute.includes('serviceCode: canonicalServiceCode') &&
  ordersRoute.includes('providerAccountId: canonicalProviderAccountId') &&
  ordersRoute.includes('accountNickname: canonicalAccountNickname') &&
  ordersRoute.includes('bestRateWorkflow: bestRateWorkflowRow'));
check('orders route emits the enriched backend workflow and canonical order model',
  (ordersRoute.match(/bestRateWorkflow: bestRateWorkflowRow/g)?.length ?? 0) >= 2 &&
  ordersRoute.includes('shipping,') &&
  ordersRoute.includes('canonicalOrder,'));
check('orders route feeds package/carrier/account facts into withOrderRowWorkflow',
  ordersRoute.includes('hasCompleteDims: rowDimsL != null') &&
  ordersRoute.includes('bestRateCarrierCode: stringOrNull(bestRateRecord?.carrierCode)') &&
  ordersRoute.includes('bestRateServiceCode: stringOrNull(bestRateRecord?.serviceCode)') &&
  ordersRoute.includes('canonicalCarrierCode,') &&
  ordersRoute.includes('canonicalServiceCode,') &&
  ordersRoute.includes('canonicalAccountNickname,') &&
  ordersRoute.includes('providerAccountId: canonicalProviderAccountId ?? null'));

const useOrders = read('web/src/hooks/useOrders.ts');
check('frontend row adapter prefers backend canonical shipping model before legacy fields',
  useOrders.includes('const shippingModel = toRecordValue(canonicalOrder?.shipping) ?? toRecordValue(row.shipping)') &&
  useOrders.includes('shippingModel.carrierCode ?? selectedRate?.carrierCode') &&
  useOrders.includes('shippingModel.accountNickname ??'));
check('frontend row adapter still has compatibility fallback for weight/dims',
  useOrders.includes('toFiniteNumber(overrides?.rateWeightOz)') &&
  useOrders.includes('toFiniteNumber(canonicalDimensions?.length)') &&
  useOrders.includes('typeof rawDims.length ==='));

const displayState = read('web/src/components/Views/orders-display-state.ts');
const rowDisplay = read('web/src/components/Views/orders-row-display.tsx');
const shippingDisplay = read('web/src/components/Views/order-shipping-display.ts');
check('frontend carrier/service readers pass backend display tuple first',
  displayState.includes('backendDisplayCarrierCode: toStringValue(toRecord(order.bestRateWorkflow?.display)?.carrierCode)') &&
  rowDisplay.includes('backendDisplayServiceCode: toStringValue(toRecord(order.bestRateWorkflow?.display)?.serviceCode)'));
check('frontend account display now consumes backend tuple before compatibility fallbacks',
  shippingDisplay.includes('backendDisplayAccountNickname') &&
  displayState.includes('backendDisplayAccountNickname: normalizeShippingAccountName') &&
  displayState.includes('bestRateWorkflow?.display'));

const packageJson = read('package.json');
check('package wires PS-304 shipping display facts authority guard',
  /"test:ps-304-shipping-display-facts-authority"\s*:\s*"tsx scripts\/ps-304-shipping-display-facts-authority-guard\.ts"/.test(packageJson));
check('package wires PS-304 account fallback debt guard',
  /"test:ps-304-account-fallback-debt"\s*:\s*"tsx scripts\/ps-304-account-fallback-debt-guard\.ts"/.test(packageJson));
check('package still wires predecessor package/display guards',
  packageJson.includes('"test:ps-205-package-facts-precedence"') &&
  packageJson.includes('"test:ps-165-order-shipping-display"') &&
  packageJson.includes('"test:ps-301-row-workflow-authority"'));

const workflowDoc = read('docs/ps-tickets/ps-300-active-lawrence-execution-workflow.md');
check('workflow doc records PS-304 shipping display facts authority guard',
  workflowDoc.includes('test:ps-304-shipping-display-facts-authority'));

check('PS-304 status doc marks the card scoped Final Review-ready',
  /Current completion estimate: PS-304 89%/.test(statusDoc) &&
    /Final Review-ready/.test(statusDoc) &&
    /PS-306 cutover debt/.test(statusDoc));
check('PS-304 status doc separates this card from PS-166 and PS-258',
  /does not complete PS-166 or PS-258/.test(statusDoc) &&
    /DOM\/byte-equality certification/.test(statusDoc));
check('PS-304 status doc lists backend display tuple and remaining compatibility fallback debt',
  /bestRateWorkflow\.display\.accountNickname/.test(statusDoc) &&
    /compatibility[\s\S]*fallbacks/.test(statusDoc) &&
    /accepted as PS-306 cutover debt/.test(statusDoc));
check('PS-304 status doc documents offline-only safety',
  /offline-only/.test(statusDoc) &&
    /does not run labels/.test(statusDoc) &&
    /mutate shipped\/cancelled data/.test(statusDoc));

if (failures > 0) {
  console.error(`\nFAIL PS-304 shipping display facts authority guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-304 shipping display facts authority guard');
