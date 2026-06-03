import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ordersView = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersView.tsx'), 'utf8');
const v2ApiClient = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const renderBestRatePriceStart = ordersView.indexOf('const renderBestRatePrice = (order: OrderSummaryDto) => {');
const renderMarginStart = ordersView.indexOf('const renderMargin = (order: OrderSummaryDto) => {');
const renderBestRatePriceBlock =
  renderBestRatePriceStart >= 0 && renderMarginStart > renderBestRatePriceStart
    ? ordersView.slice(renderBestRatePriceStart, renderMarginStart)
    : '';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${message}`);
  }
}

assert(
  ordersView.includes('hasAnySavedBestRateForDisplay'),
  'OrdersView keeps a permissive saved-rate display check for first paint'
);

assert(
  !ordersView.includes('getOrderWithDisplayBestRate'),
  'OrdersView does not display stale saved carrier/account as final while exact passive recalculation is pending'
);

assert(
  ordersView.includes('const isCalculatingBestRate = !hasDisplayableBestRate && hasAnySavedBestRateForDisplay(displayOrder)'),
  'awaiting rows detect stale saved rates as calculating until exact best rate is ready'
);

// PS-071: the awaiting Carrier / Shipping Account / Ship Margin cells now route
// their no-displayable-rate branch through classifyAwaitingRateCellState /
// renderAwaitingRateFallback (instead of three open-coded spinner divs), so a
// stale/recalculating rate shows a BOUNDED loading spinner (the 'calculating' /
// 'pending' states) while still never presenting the stale rate as final, and a
// genuinely-empty/no-carrier case becomes a terminal actionable state rather
// than an indefinite spinner. The intent (stale rate -> loading, never final)
// is unchanged; the assertion tracks the new bounded implementation.
assert(
  (ordersView.match(/renderAwaitingRateFallback\(order, displayOrder/g) ?? []).length >= 3 &&
    ordersView.includes('classifyAwaitingRateCellState') &&
    ordersView.includes('const isCalculatingBestRate = !hasDisplayableBestRate && hasAnySavedBestRateForDisplay(displayOrder)') &&
    ordersView.includes('className="spin-center"') &&
    ordersView.includes('spin-sm'),
  'stale saved rates show a bounded loading spinner (calculating/pending) via classifyAwaitingRateCellState until recalculation returns the exact current best rate'
);

assert(
  renderBestRatePriceBlock.includes("renderAwaitingRateFallback(order, displayOrder, 'full')") &&
    !/if\s*\(\s*isCalculatingBestRate\s*\)\s*\{\s*return\s*<div className="spin-center"><span className="spin-sm" \/><\/div>/.test(renderBestRatePriceBlock),
  // PS-078 wording: renderAwaitingRateFallback is the bounded/actionable DISPLAY
  // renderer (pending/calculating/error/unavailable) — it is NOT a rate
  // substitution. It never promotes a stale/cached rate to a final/selected
  // rate; it only shows a safe non-final state until the exact current rate
  // resolves. Rate SELECTION for labels happens elsewhere and is asserted below.
  'Best Rate cell renders the bounded/actionable non-final state (no open-coded spinner); it never displays a stale rate as final'
);

// PS-078 req 10: stale/cached saved best-rate data must NOT be selectable into
// the label payload. The non-test label name/type are derived from the CURRENT
// panel rate preview or the operator's selected serviceCode — never from the
// saved order.bestRate (which can be stale relative to current dims/options).
const createLabelPayloadBlock = ordersView.slice(
  ordersView.indexOf('const payload: CreateLabelRequestDto = {'),
  ordersView.indexOf('const labelPopup = mode ='),
);
assert(
  createLabelPayloadBlock.length > 0 &&
    !createLabelPayloadBlock.includes('order.bestRate?.serviceName') &&
    !createLabelPayloadBlock.includes('order.bestRate?.serviceType'),
  'stale saved order.bestRate cannot be selected into the label payload (no fallback to saved best-rate strings)'
);

assert(
  ordersView.includes('AUTO_BEST_RATE_WATCHDOG_MS') &&
    ordersView.includes('autoBestRateTimeoutsRef') &&
    ordersView.includes('startAutoBestRateWatchdog') &&
    ordersView.includes('Passive rate lookup timed out') &&
    ordersView.includes('clearAutoBestRateWatchdog(request.key)'),
  'passive best-rate requests have a watchdog that resolves stuck pending rows to a retryable error'
);

assert(
  packageJson.scripts?.['test:ps-099-orders-rate-cache-first'] ===
    'node scripts/ps-099-orders-rate-cache-first-guard.mjs',
  'package exposes PS-099 cache-first Orders rate guard'
);

assert(
  v2ApiClient.includes('const combinedBestRate = combined[0] ?? responseBestRate') &&
    v2ApiClient.includes("Object.defineProperty(combined, 'bestRate',") &&
    v2ApiClient.includes('value: combinedBestRate'),
  'Orders passive rating exposes the cheapest combined ShipStation/direct-carrier rate as bestRate'
);

if (process.exitCode) {
  console.error('\nPS-099 guard failed.');
  process.exit(process.exitCode);
}

console.log('\nPASS PS-099 Orders carrier/account cache-first display guard');
