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
  const page = selectBatchRecalculateOrderIds({
    currentStatus: 'awaiting_shipment',
    scope: 'page',
    orders: mixedOrders,
    selectedOrderIds: [],
    visibleOrderIds: [10, 11, 12, 13, 14],
  });
  check('page batch scope keeps only visible awaiting orders', page.orderIds.join(',') === '10,12,14');
  check('page batch scope reports immutable skips', page.skippedImmutable === 2);
}

{
  const blocked = selectBatchRecalculateOrderIds({
    currentStatus: 'shipped',
    scope: 'page',
    orders: mixedOrders,
    selectedOrderIds: [],
    visibleOrderIds: [10, 12, 14],
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

const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
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
check('batch Recalculate skips missing-dims rows before pending state', /queueableOrders/.test(batchBlock) && /getAutoBestRateRequest\(order\)[\s\S]*status:\s*'skipped'[\s\S]*queueableOrders\.push\(order\)/.test(batchBlock));
check('batch Recalculate has page button', /Recalculate Page/.test(ordersView));
check('batch Recalculate has selected button', /Recalculate Selected/.test(ordersView));
check('batch Recalculate shows percentage progress', /batchRecalculateProgress\.percent/.test(ordersView));
check('batch Recalculate has per-order retry action', /retryBatchRecalculateOrder/.test(ordersView) && /data-batch-recalculate-retry/.test(ordersView));
check('batch Recalculate has timeout guard', /BATCH_RECALCULATE_TIMEOUT_MS/.test(ordersView));
check('batch Recalculate keeps strict live flags', /forceLive:\s*true/.test(ordersView) && /forceRefresh:\s*true/.test(ordersView));

const bestRateProviderStart = ordersView.indexOf('function getBestRateShippingProviderId(');
const bestRateProviderEnd = ordersView.indexOf('\nfunction getBestRateServiceCode', bestRateProviderStart);
const bestRateProviderBlock = bestRateProviderStart >= 0 && bestRateProviderEnd > bestRateProviderStart
  ? ordersView.slice(bestRateProviderStart, bestRateProviderEnd)
  : '';
check('awaiting best-rate provider id wins over stale shipping metadata',
  /order\.orderStatus\s*===\s*'awaiting_shipment'/.test(bestRateProviderBlock) &&
  /return\s+rateProviderId\s*\?\?\s*getShippingProviderAccountId\(order\)/.test(bestRateProviderBlock));

const shippingDisplayStart = ordersView.indexOf('function getShipAccountDisplay(');
const shippingDisplayEnd = ordersView.indexOf('\nfunction getShipAccountLabelById', shippingDisplayStart);
const shippingDisplayBlock = shippingDisplayStart >= 0 && shippingDisplayEnd > shippingDisplayStart
  ? ordersView.slice(shippingDisplayStart, shippingDisplayEnd)
  : '';
check('awaiting account display resolves best-rate provider id through loaded accounts',
  /const bestRateProviderId = getBestRateShippingProviderId\(order\)/.test(shippingDisplayBlock) &&
  /getCarrierAccountLabelByProviderId\(accounts,\s*bestRateProviderId\)/.test(shippingDisplayBlock));

const overlayStart = ordersView.indexOf('function withBestRateOverride(');
const overlayEnd = ordersView.indexOf('\n  function withoutStaleBestRate', overlayStart);
const overlayBlock = overlayStart >= 0 && overlayEnd > overlayStart
  ? ordersView.slice(overlayStart, overlayEnd)
  : '';
check('auto-rate overlay resolves account label by provider id',
  /getCarrierAccountLabelByProviderId\(shippingAccounts,\s*shippingProviderId\)/.test(overlayBlock) &&
  /accountNickname:\s*rateAccountNickname/.test(overlayBlock));

const panelStart = ordersView.indexOf('const renderSinglePanel = () => {');
const panelEnd = ordersView.length;
const panelBlock = panelStart >= 0 && panelEnd > panelStart
  ? ordersView.slice(panelStart, panelEnd)
  : '';
check('side panel rate display consumes auto best-rate overlay',
  /const panelDisplayOrder = getOrderWithAutoBestRate\(panelOrder\)/.test(panelBlock) &&
  /getShipAccountDisplay\(panelDisplayOrder,\s*shippingAccounts\)/.test(panelBlock) &&
  /panelDisplayOrder\.bestRate/.test(panelBlock));

const fallbackStart = ordersView.indexOf('function renderRateCellFallback(');
const fallbackEnd = ordersView.indexOf('\n  // PS-071', fallbackStart + 1);
const fallbackBlock = fallbackStart >= 0 && fallbackEnd > fallbackStart
  ? ordersView.slice(fallbackStart, fallbackEnd)
  : '';
check('add-dims fallback wins over batch pending state',
  fallbackBlock.indexOf("state === 'add-dims'") >= 0 &&
  fallbackBlock.indexOf("state === 'add-dims'") < fallbackBlock.indexOf('const batchRow = batchRecalculateRows'));

if (failures > 0) {
  console.error(`\nFAIL batch recalculate best-rate guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS batch recalculate best-rate guard');
