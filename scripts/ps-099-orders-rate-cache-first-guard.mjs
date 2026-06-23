import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ordersView = fs.readFileSync(path.join(root, 'web/src/components/Views/OrdersView.tsx'), 'utf8');
const v2ApiClient = fs.readFileSync(path.join(root, 'web/src/lib/v2-apiClient.ts'), 'utf8');
const ratesRoute = fs.readFileSync(path.join(root, 'src/routes/rates.ts'), 'utf8');
// PS-203 (stage 3): the merge + SINGLE cheapest pick moved to the canonical
// combined-selection owner; the route delegates via combineCarrierUniverses.
const ratesCombined = fs.readFileSync(path.join(root, 'src/services/rates-combined.ts'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// PS-166/PS-306/PS-258 (Wave 2): the four leaf cell renderers (Best Rate / Ship
// Margin / Carrier / Shipping Account) moved VERBATIM out of OrdersView into
// ./orders/cells/order-cells. renderTableCell stays in the shell as a thin
// dispatcher. The bounded/actionable-fallback assertions below follow the code to
// its new home (intent unchanged: stale rate -> bounded non-final state, never a
// stale rate presented as final).
const orderCells = fs.readFileSync(path.join(root, 'web/src/components/Views/orders/cells/order-cells.tsx'), 'utf8');
const renderBestRatePriceStart = orderCells.indexOf('export function renderBestRatePrice(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {');
const renderMarginStart = orderCells.indexOf('export function renderMargin(order: OrderSummaryDto, deps: OrderCellsDeps): ReactNode {');
const renderBestRatePriceBlock =
  renderBestRatePriceStart >= 0 && renderMarginStart > renderBestRatePriceStart
    ? orderCells.slice(renderBestRatePriceStart, renderMarginStart)
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
  // PS-166 Wave 2: the >=3 awaiting-cell fallback call sites (Best Rate / Carrier /
  // Shipping Account) now live in the extracted order-cells leaf module; the
  // classifier + bounded-spinner machinery (classifyAwaitingRateCellState /
  // isCalculatingBestRate / spin-center / spin-sm) stays in renderAwaitingRateFallback
  // inside OrdersView.
  (orderCells.match(/renderAwaitingRateFallback\(order, displayOrder/g) ?? []).length >= 3 &&
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
  // PS-203: cheapest combined ShipStation/direct-carrier selection lives in the
  // canonical rates-combined owner; the route delegates via combineCarrierUniverses.
  ratesCombined.includes('const combinedRates = dedupeBrowseRates([...input.ssRates, ...input.directRates])') &&
    ratesCombined.includes('const cheapest = rankedEligibleRates[0]') &&
    ratesRoute.includes('combineCarrierUniverses({') &&
    ratesRoute.includes('combinedRates,') &&
    ratesRoute.includes('cheapest,') &&
    v2ApiClient.includes('res?.bestRate') &&
    !v2ApiClient.includes('const combinedBestRate = combined[0]'),
  'Orders passive rating preserves the backend-selected cheapest combined ShipStation/direct-carrier bestRate (canonical rates-combined owner)'
);

if (process.exitCode) {
  console.error('\nPS-099 guard failed.');
  process.exit(process.exitCode);
}

console.log('\nPASS PS-099 Orders carrier/account cache-first display guard');
