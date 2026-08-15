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
    14: { status: 'failed_retryable', message: 'carrier error', retryable: true },
    15: { status: 'failed_terminal', message: 'cancelled', retryable: false },
    16: { status: 'running' },
  });
  check('progress counts all rows', progress.total === 5);
  check('progress counts terminal rows as completed', progress.completed === 4);
  check('progress percent is integer completion percent', progress.percent === 80);
  check('progress counts updated rows', progress.updated === 1);
  check('progress counts cleared rows', progress.cleared === 1);
  check('progress counts typed failed rows', progress.blocked === 2);
  check('progress keeps legacy timed-out count separate', progress.timedOut === 0);
  check('progress exposes running count', progress.running === 1);
}

check('backend retryable failures are retryable', canRetryBatchRecalculateRow({ status: 'failed_retryable', retryable: true }));
check('backend terminal failures are not retryable', !canRetryBatchRecalculateRow({ status: 'failed_terminal', retryable: false }));
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

check('batch pending preserves last-known saved awaiting best-rate values',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    batchRecalculateStatus: 'pending',
  }) === 'ready');
check('batch running preserves last-known saved awaiting best-rate values',
  classifyAwaitingRateCellState({
    ...displayableRateCellInput,
    batchRecalculateStatus: 'running',
  }) === 'ready');
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
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
const batchOwner = readFileSync('src/services/rate-recalculate-batch.ts', 'utf8');
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
const orderCells = readFileSync('web/src/components/Views/orders/cells/order-cells.tsx', 'utf8');
const batchItemTypeStart = batchOwner.indexOf('export type RateRecalculateBatchItem = {');
const batchItemTypeEnd = batchOwner.indexOf('\nexport type RateRecalculateBatchCounters', batchItemTypeStart);
const batchItemTypeBlock = batchItemTypeStart >= 0 && batchItemTypeEnd > batchItemTypeStart
  ? batchOwner.slice(batchItemTypeStart, batchItemTypeEnd)
  : '';
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
const batchStart = ordersView.indexOf('async function startBatchRecalculateBestRates(');
const batchEnd = ordersView.indexOf('\n  function renderRateRecalculateHealth', batchStart);
const batchBlock = batchStart >= 0 && batchEnd > batchStart
  ? ordersView.slice(batchStart, batchEnd)
  : '';

check('OrdersView has batch Recalculate entrypoint', /async function startBatchRecalculateBestRates\(/.test(batchBlock));
check('batch Recalculate delegates admission to the durable backend owner',
  /apiClient\.startRateRecalculateBatch/.test(batchBlock) && /apiClient\.fetchRateRecalculateBatch/.test(ordersView));
check('batch Recalculate retries only through the durable backend owner',
  /apiClient\.retryRateRecalculateBatch/.test(batchBlock));
check('batch Recalculate removed the browser worker queue',
  !/const queue =/.test(batchBlock) &&
  !/BATCH_RECALCULATE_CONCURRENCY/.test(ordersView) &&
  !/runBatchRecalculateOrder/.test(ordersView));
check('batch Recalculate retains an opaque batch id for refresh reattachment',
  /SELECTED_RATE_BATCH_STORAGE_KEY/.test(ordersView) &&
  /window\.localStorage\.setItem\(SELECTED_RATE_BATCH_STORAGE_KEY, batch\.batch_id\)/.test(ordersView) &&
  /pollRateRecalculateBatch\(savedBatchId/.test(ordersView));
check('batch Recalculate does not replace saved-rate truth on a failed row',
  !/setAutoBestRateEntry/.test(batchBlock) &&
  /renderRateRecalculateHealth/.test(ordersView));
check('batch Recalculate removed page-only button', !/Recalculate Page/.test(ordersView) && !/Recalculate Page/.test(filterToolbar));
check('batch Recalculate has filtered all button', /Recalculate All/.test(filterToolbar));
check('batch Recalculate has selected button', /Recalculate Selected/.test(filterToolbar));
check('batch Recalculate shows percentage progress', /batchRecalculateProgress\.percent/.test(filterToolbar));
check('batch Recalculate has per-order retry action', /retryBatchRecalculateOrder/.test(ordersView) && /data-batch-recalculate-retry/.test(ordersView));
check('batch Recalculate displays exact backend progress counters',
  /remaining:\s*batch\.counters\.remaining/.test(ordersView) &&
  /retryableFailed:\s*batch\.counters\.retryable_failed/.test(ordersView));
check('batch Recalculate keeps strict live flags',
  /forceLive:\s*true/.test(ordersView) &&
  /forceRefresh:\s*true/.test(ordersView) &&
  /strictRecalculate:\s*true/.test(ordersView));
check('durable batch routes enforce auth and scoped order ownership',
  /'\/browse\/workflow\/batch'/.test(ratesRoute) &&
  /'\/browse\/workflow\/batch\/:batchId'/.test(ratesRoute) &&
  /'\/browse\/workflow\/batch\/:batchId\/retry'/.test(ratesRoute) &&
  /ensureRateRecalculateBatchScope/.test(ratesRoute) &&
  /requireBusinessRoutePolicy\('rates\.browse\.workflow\.start'\)/.test(ratesRoute));
check('durable batch owner delegates every rate job to the fenced workflow owner',
  /startRateBrowseWorkflow/.test(batchOwner) &&
  /deps\.startWorkflow/.test(batchOwner) &&
  !/getRates\(|fetch\(|axios/.test(batchOwner));
check('durable batch manifests are retention-bounded and omit request payload fields',
  /RATE_RECALCULATE_BATCH_RETENTION_MS/.test(batchOwner) &&
  /rateRecalculateBatchKeysToPrune/.test(batchOwner) &&
  batchItemTypeBlock.length > 0 &&
  !/\bbody\??:|address|payload/i.test(batchItemTypeBlock));
check('typed durable batch DTO is passed through the API client',
  /startRateRecalculateBatch/.test(apiClient) &&
  /fetchRateRecalculateBatch/.test(apiClient) &&
  /retryRateRecalculateBatch/.test(apiClient));
check('best-rate cell renders saved rate and separate recalculation health',
  /renderRateRecalculateHealth\?\.\(order\)/.test(orderCells));

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
check('awaiting backend display provider id wins over best-rate and stale shipping metadata',
  // Repointed (guard rot): status reads migrated to the getOrderEffectiveStatus(order) owner
  // (orders-row-display.tsx:80); same awaiting-branch protection, canonical status form.
  /getOrderEffectiveStatus\(order\)\s*===\s*'awaiting_shipment'/.test(bestRateProviderBlock) &&
  /backendDisplayProviderAccountId/.test(bestRateProviderBlock) &&
  /return\s+backendDisplayProviderAccountId\s*\?\?\s*rateProviderId\s*\?\?\s*getShippingProviderAccountId\(order\)/.test(bestRateProviderBlock));

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

const rateHelpers = readFileSync('web/src/components/Views/orders/best-rate/rate-helpers.ts', 'utf8');
check('auto-rate no longer rewrites row/shipping best-rate truth',
  !/function withBestRateOverride/.test(rateHelpers) &&
  !/function withoutStaleBestRate/.test(rateHelpers) &&
  /function getOrderWithAutoBestRate\(order: OrderSummaryDto\) \{[\s\S]*?return order[\s\S]*?\}/.test(rateHelpers));

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
check('side panel rate display consumes backend row display order',
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

// RETIRED (was: passive auto-rating cannot persist from legacy fetchRates fallback): PS-345
// (164b8667) deleted refreshVisibleBestRate (and the whole OrdersView passive-rating path)
// outright — there is no FE passive persist path left to mis-source. Rate loading is
// backend-owned and pinned by scripts/ps-345-rate-loading-sot-guard.ts.
// RETIRED (was: passive auto-rating caps browser live work and hands overflow to backend
// backfill): PS-345 deleted runPassiveAutoRating and the PASSIVE_LIVE_BEST_RATE_* budget —
// backend ownership of the bounded sweep is pinned by the ps-345 guard (OrdersView keeps only
// the startRecalculateAllBestRates job trigger).

// Repointed (guard rot): e9762409 canonicalized the money DTO (customerRateAmount is GONE;
// getBackendRowMoney exposes selectedRateCost/baseAmount/cShippingRateAmount/markedAmount) and
// the stale-canonical getShippingNumber(order, 'bestRateAmount') fallback was DELETED from
// getBestRateBaseCost — pin backend money + the fallback's ABSENCE over the tightened block
// (end anchor is now the next function, getBestRateFinalBaseCost).
const bestRateBaseStart = rowDisplay.indexOf('export function getBestRateBaseCost(');
const bestRateBaseEnd = rowDisplay.indexOf('\nexport function getBestRateFinalBaseCost', bestRateBaseStart);
const bestRateBaseBlock = bestRateBaseStart >= 0 && bestRateBaseEnd > bestRateBaseStart
  ? rowDisplay.slice(bestRateBaseStart, bestRateBaseEnd)
  : '';
// PS-499 re-anchored this check. It required two tokens that pinned the MECHANISM rather
// than the rule, and one of them had become a requirement to keep a defect:
//
//   /cShippingRateAmount/ — getBestRateBaseCost is a COST getter, and that field is the
//     CUSTOMER amount. Its presence was the tail of `selectedRateCost ?? baseAmount ??
//     cShippingRateAmount ?? markedAmount`, which returned customer money under a cost
//     meaning. PS-499 removed it, so the old assertion would now fail a correct getter.
//   /getOrderEffectiveStatus(order) === 'awaiting_shipment'/ — the awaiting and shipped
//     arms were BYTE-IDENTICAL, so the branch decided nothing. Asserting that dead code
//     exists protects nothing and invites someone to "fix" one arm.
//
// The rule being protected is the one in the name: this getter reads the BACKEND money
// tuple and never falls back to the stale canonical bestRateAmount. Both are asserted
// directly now, which is what the tokens were standing in for.
check('awaiting best-rate amount reads backend money before stale canonical amount',
  /getBackendRowMoney\(order\)/.test(bestRateBaseBlock) &&
  !/getShippingNumber\(order, 'bestRateAmount'\)/.test(bestRateBaseBlock));

const bestRateServiceStart = rowDisplay.indexOf('export function getBestRateServiceCode(');
const bestRateServiceEnd = rowDisplay.indexOf('\nexport function getBestRateCarrierNickname', bestRateServiceStart);
const bestRateServiceBlock = bestRateServiceStart >= 0 && bestRateServiceEnd > bestRateServiceStart
  ? rowDisplay.slice(bestRateServiceStart, bestRateServiceEnd)
  : '';
check('awaiting best-rate service reads saved bestRate before stale canonical service',
  // Repointed (guard rot): status form migrated to the getOrderEffectiveStatus(order) owner —
  // getBestRateServiceCode now feeds `isAwaiting: getOrderEffectiveStatus(order) === ...` into
  // resolveDisplayServiceCode; the awaiting flag still precedes the canonical serviceCode read.
  /getOrderEffectiveStatus\(order\)\s*===\s*'awaiting_shipment'/.test(bestRateServiceBlock) &&
  bestRateServiceBlock.indexOf("getOrderEffectiveStatus(order) === 'awaiting_shipment'") < bestRateServiceBlock.indexOf("getShippingString(order, 'serviceCode')"));

if (failures > 0) {
  console.error(`\nFAIL batch recalculate best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS batch recalculate best-rate guard');
