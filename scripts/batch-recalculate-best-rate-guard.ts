/**
 * Guard: Awaiting Shipment batch Recalculate must be strict, progress-aware,
 * retryable per order, and must never fall back to stale/cached best rates.
 *
 * Read-only: no DB, no network, no provider calls.
 */
import { readFileSync } from 'node:fs';
import {
  buildBatchRecalculateProgress,
  canRetryBatchRecalculateRow,
  classifyAwaitingRateCellState,
  selectBatchRecalculateOrderIds,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const mixedOrders = [
  { orderId: 10, orderStatus: 'awaiting_shipment' },
  { orderId: 11, orderStatus: 'shipped' },
  { orderId: 12, orderStatus: 'awaiting_shipment' },
  { orderId: 13, orderStatus: 'cancelled' },
  { orderId: 14, orderStatus: 'awaiting_shipment' },
];

{
  const selected = selectBatchRecalculateOrderIds({
    currentStatus: 'awaiting_shipment',
    scope: 'selected',
    orders: mixedOrders,
    selectedOrderIds: [11, 12, 13, 14],
    visibleOrderIds: [10, 11, 12, 13, 14],
  });
  check('selected batch scope keeps only awaiting orders', selected.orderIds.join(',') === '12,14');
  check('selected batch scope reports skipped immutable orders', selected.skippedImmutable === 2);
}

{
  const filtered = selectBatchRecalculateOrderIds({
    currentStatus: 'awaiting_shipment',
    scope: 'filtered',
    orders: mixedOrders,
    selectedOrderIds: [],
    visibleOrderIds: [10],
    matchingOrderIds: [10, 11, 12, 13, 14],
  });
  check('filtered batch scope keeps matching awaiting orders across pages', filtered.orderIds.join(',') === '10,12,14');
  check('filtered batch scope is not limited to visible order ids', filtered.orderIds.includes(12) && filtered.orderIds.includes(14));
  check('filtered batch scope reports immutable skips', filtered.skippedImmutable === 2);
}

{
  const blocked = selectBatchRecalculateOrderIds({
    currentStatus: 'shipped',
    scope: 'filtered',
    orders: mixedOrders,
    selectedOrderIds: [],
    visibleOrderIds: [10, 12, 14],
    matchingOrderIds: [10, 12, 14],
  });
  check('batch recalculation is unavailable outside awaiting shipment', blocked.orderIds.length === 0 && Boolean(blocked.blockedReason));
}

{
  const progress = buildBatchRecalculateProgress({
    10: { status: 'updated' },
    12: { status: 'cleared' },
    14: { status: 'blocked', message: 'carrier error' },
    15: { status: 'timed-out', message: 'timeout' },
    16: { status: 'running' },
  });
  check('progress counts all rows', progress.total === 5);
  check('progress counts terminal rows as completed', progress.completed === 4);
  check('progress percent is integer completion percent', progress.percent === 80);
  check('progress counts updated rows', progress.updated === 1);
  check('progress counts cleared rows', progress.cleared === 1);
  check('progress counts blocked rows', progress.blocked === 1);
  check('progress counts timed out rows', progress.timedOut === 1);
  check('progress exposes running count', progress.running === 1);
}

check('timed-out batch rows are retryable', canRetryBatchRecalculateRow({ status: 'timed-out' }));
check('blocked batch rows are retryable', canRetryBatchRecalculateRow({ status: 'blocked' }));
check('cleared no-rate batch rows are retryable', canRetryBatchRecalculateRow({ status: 'cleared' }));
check('updated batch rows are not retryable', !canRetryBatchRecalculateRow({ status: 'updated' }));
check('running batch rows are not retryable', !canRetryBatchRecalculateRow({ status: 'running' }));

const displayableRateCellInput = {
  hasDims: true,
  hasWeight: true,
  hasDisplayableBestRate: true,
  isCalculatingBestRate: false,
  resolvedNoRate: false,
  resolvedError: false,
  hasCarrierContext: true,
  accountsLoading: false,
  isAutoRatingActive: true,
};

check('batch pending hides stale saved awaiting best-rate values',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    batchRecalculateStatus: 'pending',
  }) === 'pending');
check('batch running hides stale saved awaiting best-rate values',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    batchRecalculateStatus: 'running',
  }) === 'pending');
check('add-dims wins over batch pending for non-rateable rows',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    hasDisplayableBestRate: false,
    hasDims: false,
    batchRecalculateStatus: 'pending',
  }) === 'add-dims');
check('finalized batch rows can render their current displayable rate',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    batchRecalculateStatus: 'updated',
  }) === 'ready');

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// PS-178 (Phase 6, part 2): the row-display readers (getBestRateBaseCost /
// getBestRateShippingProviderId / getBestRateServiceCode and friends) were
// extracted VERBATIM to orders-row-display.tsx — the definition slices below
// re-anchor there; the OrdersView call-site pins are unchanged.
const rowDisplay = readFileSync('web/src/components/Views/orders-row-display.tsx', 'utf8');
// PS-166 (Wave 4): the filter-bar Recalculate Selected / Recalculate All buttons
// + the strict-live progress bar moved VERBATIM into OrdersFilterToolbar.tsx
// (OrdersFilterToolbarBatchControls). The batch RUNNER + state still live in
// OrdersView; only the toolbar BUTTON markup re-points to the extracted file.
const filterToolbar = readFileSync('web/src/components/Views/OrdersFilterToolbar.tsx', 'utf8');
const batchStart = ordersView.indexOf('async function runBatchRecalculateOrder(');
const batchEnd = ordersView.indexOf('\n  // PS-071', batchStart);
const batchBlock = batchStart >= 0 && batchEnd > batchStart
  ? ordersView.slice(batchStart, batchEnd)
  : '';

check('OrdersView has batch Recalculate entrypoint', /async function startBatchRecalculateBestRates\(/.test(batchBlock));
check('batch Recalculate reuses strict order runner', /runStrictBestRateRecalculation/.test(batchBlock));
check('batch Recalculate avoids fetchRates fallback', !/apiClient\.fetchRates/.test(batchBlock));
check('batch Recalculate avoids pickBestPanelRate fallback', !/pickBestPanelRate/.test(batchBlock));
check('batch Recalculate tracks progress rows', /setBatchRecalculateRows/.test(batchBlock));
check('batch Recalculate skips missing-dims rows before pending state',
  /prepareBatchRecalculateRows/.test(batchBlock) &&
  /getAutoBestRateRequest\(order\)[\s\S]*status:\s*'skipped'[\s\S]*Missing weight, dimensions, or ship-to postal code/.test(batchBlock));
check('batch Recalculate removed page-only button', !/Recalculate Page/.test(ordersView) && !/Recalculate Page/.test(filterToolbar));
check('batch Recalculate has filtered all button', /Recalculate All/.test(filterToolbar));
check('batch Recalculate has selected button', /Recalculate Selected/.test(filterToolbar));
check('batch Recalculate shows percentage progress', /batchRecalculateProgress\.percent/.test(filterToolbar));
check('batch Recalculate has per-order retry action', /retryBatchRecalculateOrder/.test(ordersView) && /data-batch-recalculate-retry/.test(ordersView));
check('batch Recalculate has timeout guard', /BATCH_RECALCULATE_TIMEOUT_MS/.test(ordersView));
check('batch Recalculate keeps strict live flags', /forceLive:\s*true/.test(ordersView) && /forceRefresh:\s*true/.test(ordersView));

const rateBrowserStart = ordersView.indexOf('async function openRateBrowser()');
const rateBrowserEnd = ordersView.indexOf('\n  async function recalculateBestRate()', rateBrowserStart);
const rateBrowserBlock = rateBrowserStart >= 0 && rateBrowserEnd > rateBrowserStart
  ? ordersView.slice(rateBrowserStart, rateBrowserEnd)
  : '';
const rateBrowserModalStart = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
check('Browse Rates open avoids duplicate parent live browse source', !/apiClient\.browseRates/.test(rateBrowserBlock));
check('Browse Rates no longer uses fetchRates fallback source', !/apiClient\.fetchRates/.test(rateBrowserBlock));
check('Browse Rates modal owns strict live browse trigger',
  /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(rateBrowserModalStart));
check('Browse Rates modal applies backend best-rate callback',
  /onBestRateResolved/.test(ordersView) &&
  /decision\.kind === 'emit' && rateIsBackendComplete\(decision\.rate\)/.test(rateBrowserModalStart) &&
  /const applied = toAppliedRate\(decision\.rate\)/.test(rateBrowserModalStart));

const bestRateProviderStart = rowDisplay.indexOf('export function getBestRateShippingProviderId(');
const bestRateProviderEnd = rowDisplay.indexOf('\nexport function getBestRateServiceCode', bestRateProviderStart);
const bestRateProviderBlock = bestRateProviderStart >= 0 && bestRateProviderEnd > bestRateProviderStart
  ? rowDisplay.slice(bestRateProviderStart, bestRateProviderEnd)
  : '';
check('awaiting best-rate provider id wins over stale shipping metadata',
  /order\.orderStatus\s*===\s*'awaiting_shipment'/.test(bestRateProviderBlock) &&
  /return\s+rateProviderId\s*\?\?\s*getShippingProviderAccountId\(order\)/.test(bestRateProviderBlock));

// PS-166 Wave 2a re-anchor: getShipAccountDisplay moved VERBATIM to the
// orders-display-state module (it still receives the live `accounts` array as
// an argument — the dependency rides the parameter, behavior identical). The
// call-shape pin below (panel passes shippingAccounts) still reads OrdersView.
const displayState = readFileSync('web/src/components/Views/orders-display-state.ts', 'utf8');
const shippingDisplayStart = displayState.indexOf('export function getShipAccountDisplay(');
const shippingDisplayEnd = displayState.indexOf('\nexport function hasAuthoritativeProviderId', shippingDisplayStart);
const shippingDisplayBlock = shippingDisplayStart >= 0 && shippingDisplayEnd > shippingDisplayStart
  ? displayState.slice(shippingDisplayStart, shippingDisplayEnd)
  : '';
// PS-165 part 2 (67d0d77f) inlined the provider-id local into the call; the protection (the
// awaiting nickname fallback resolves the best-rate provider id through the loaded accounts)
// is unchanged — re-anchored to the inlined form.
check('awaiting account display resolves best-rate provider id through loaded accounts',
  /getCarrierAccountLabelByProviderId\(accounts,\s*getBestRateShippingProviderId\(order\)\)/.test(shippingDisplayBlock));

// PS-317: withBestRateOverride + withoutStaleBestRate moved to ./orders/best-rate/rate-helpers.ts
// as indented inner functions in the createBestRateHelpers factory. The slice (start anchor →
// the next inner function withoutStaleBestRate) re-points there.
const rateHelpers = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
const overlayStart = rateHelpers.indexOf('function withBestRateOverride(');
const overlayEnd = rateHelpers.indexOf('\n  function withoutStaleBestRate', overlayStart);
const overlayBlock = overlayStart >= 0 && overlayEnd > overlayStart
  ? rateHelpers.slice(overlayStart, overlayEnd)
  : '';
// TEETH (PS-317): an empty/absent slice must FAIL LOUD, never pass vacuously on this money path.
check('auto-rate overlay slice is present (non-vacuous)', overlayStart >= 0 && overlayBlock.length > 0);
check('auto-rate overlay resolves account label by provider id',
  /getCarrierAccountLabelByProviderId\(shippingAccounts,\s*shippingProviderId\)/.test(overlayBlock) &&
  /accountNickname:\s*rateAccountNickname/.test(overlayBlock));

// PS-166/PS-306/PS-258 (Wave 5): the order-detail side panel was extracted
// VERBATIM from OrdersView into OrdersDetailSidePanel.tsx. The OrdersView shell's
// thin renderSinglePanel wrapper still derives the auto-best-rate overlay
// (panelDisplayOrder = getOrderWithAutoBestRate(panelOrder)) and threads it down;
// the DISPLAY consumption (account label + bestRate read) moved to the leaf.
const panelStart = ordersView.indexOf('const renderSinglePanel = () => {');
const panelEnd = ordersView.length;
const panelBlock = panelStart >= 0 && panelEnd > panelStart
  ? ordersView.slice(panelStart, panelEnd)
  : '';
const detailSidePanel = readFileSync('web/src/components/Views/OrdersDetailSidePanel.tsx', 'utf8');
check('side panel rate display consumes auto best-rate overlay',
  /const panelDisplayOrder = getOrderWithAutoBestRate\(panelOrder\)/.test(panelBlock) &&
  /getShipAccountDisplay\(panelDisplayOrder,\s*shippingAccounts\)/.test(detailSidePanel) &&
  /panelDisplayOrder\.bestRate/.test(detailSidePanel));

const fallbackStart = ordersView.indexOf('function renderRateCellFallback(');
const fallbackEnd = ordersView.indexOf('\n  // PS-071', fallbackStart + 1);
const fallbackBlock = fallbackStart >= 0 && fallbackEnd > fallbackStart
  ? ordersView.slice(fallbackStart, fallbackEnd)
  : '';
check('add-dims fallback wins over batch pending state',
  fallbackBlock.indexOf("state === 'add-dims'") >= 0 &&
  fallbackBlock.indexOf("state === 'add-dims'") < fallbackBlock.indexOf('const batchRow = batchRecalculateRows'));

const passiveStart = ordersView.indexOf('async function refreshVisibleBestRate(');
const passiveEnd = ordersView.indexOf('\n    async function runPassiveAutoRating()', passiveStart);
const passiveBlock = passiveStart >= 0 && passiveEnd > passiveStart
  ? ordersView.slice(passiveStart, passiveEnd)
  : '';
const passiveRunnerStart = ordersView.indexOf('async function runPassiveAutoRating()');
const passiveRunnerEnd = ordersView.indexOf('\n    void runPassiveAutoRating()', passiveRunnerStart);
const passiveRunnerBlock = passiveRunnerStart >= 0 && passiveRunnerEnd > passiveRunnerStart
  ? ordersView.slice(passiveRunnerStart, passiveRunnerEnd)
  : '';
check('passive auto-rating cannot persist from legacy fetchRates fallback',
  passiveStart >= 0 &&
  !/apiClient\.fetchRates/.test(passiveBlock) &&
  !/pickBestPanelRate/.test(passiveBlock) &&
  /apiClient\.browseRates/.test(passiveBlock) &&
  /response\?\.bestRate/.test(passiveBlock));
check('passive auto-rating caps browser live work and hands overflow to backend backfill',
  /PASSIVE_LIVE_BEST_RATE_CONCURRENCY/.test(ordersView) &&
  /PASSIVE_LIVE_BEST_RATE_MAX_ROWS/.test(ordersView) &&
  /const liveBudget = Math\.max\(0, PASSIVE_LIVE_BEST_RATE_MAX_ROWS - passiveLiveBestRateCountRef\.current\)/.test(passiveRunnerBlock) &&
  /const liveQueue = queue\.splice\(0, liveBudget\)/.test(passiveRunnerBlock) &&
  /const workerCount = Math\.min\(PASSIVE_LIVE_BEST_RATE_CONCURRENCY, liveQueue\.length\)/.test(passiveRunnerBlock) &&
  /while \(!cancelled && liveQueue\.length > 0\)/.test(passiveRunnerBlock) &&
  /const overflow = queue\.splice\(0\)/.test(passiveRunnerBlock) &&
  /startRecalculateAllBestRates\(PASSIVE_BACKFILL_MAX_AGE_HOURS\)/.test(passiveRunnerBlock));

const bestRateBaseStart = rowDisplay.indexOf('export function getBestRateBaseCost(');
const bestRateBaseEnd = rowDisplay.indexOf('\nexport function getBestRateShippingProviderId', bestRateBaseStart);
const bestRateBaseBlock = bestRateBaseStart >= 0 && bestRateBaseEnd > bestRateBaseStart
  ? rowDisplay.slice(bestRateBaseStart, bestRateBaseEnd)
  : '';
check('awaiting best-rate amount reads saved bestRate before stale canonical amount',
  /order\.orderStatus\s*===\s*'awaiting_shipment'/.test(bestRateBaseBlock) &&
  bestRateBaseBlock.indexOf("order.orderStatus === 'awaiting_shipment'") < bestRateBaseBlock.indexOf("getShippingNumber(order, 'bestRateAmount')"));

const bestRateServiceStart = rowDisplay.indexOf('export function getBestRateServiceCode(');
const bestRateServiceEnd = rowDisplay.indexOf('\nexport function getBestRateCarrierNickname', bestRateServiceStart);
const bestRateServiceBlock = bestRateServiceStart >= 0 && bestRateServiceEnd > bestRateServiceStart
  ? rowDisplay.slice(bestRateServiceStart, bestRateServiceEnd)
  : '';
check('awaiting best-rate service reads saved bestRate before stale canonical service',
  /order\.orderStatus\s*===\s*'awaiting_shipment'/.test(bestRateServiceBlock) &&
  bestRateServiceBlock.indexOf("order.orderStatus === 'awaiting_shipment'") < bestRateServiceBlock.indexOf("getShippingString(order, 'serviceCode')"));

if (failures > 0) {
  console.error(`\nFAIL batch recalculate best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS batch recalculate best-rate guard');
