import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

async function read(relPath) {
  return readFile(path.join(root, relPath), 'utf8')
}

function assert(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`)
  if (!condition) process.exitCode = 1
}

const [
  ordersView,
  orderCells,
  ordersRoute,
  applyBestRate,
  ratesBackfill,
  cleanupScript,
  packageJson,
  // PS-317: hasDisplayableBestRateForCurrentRequest moved to ./orders/best-rate/rate-helpers.ts;
  // hasValidSavedBestRateForRequest + the saved-rate freshness/completeness contract moved to
  // ./orders/best-rate/rate-display-predicates.ts.
  rateHelpers,
  rateDisplayPredicates,
] = await Promise.all([
  read('web/src/components/Views/OrdersView.tsx'),
  // PS-166/PS-306/PS-258 (Wave 2): the Best Rate leaf cell (which gates display on
  // hasDisplayableBestRate) moved VERBATIM from OrdersView into ./orders/cells/order-cells.
  read('web/src/components/Views/orders/cells/order-cells.tsx'),
  read('src/routes/orders.ts'),
  read('src/services/shipping-workflow/apply-best-rate.ts'),
  read('src/services/rates-backfill.ts'),
  read('scripts/clear-invalid-best-rates.ts'),
  read('package.json'),
  read('web/src/components/Views/orders/best-rate/rate-helpers.ts'),
  read('web/src/components/Views/orders/best-rate/rate-display-predicates.ts'),
])

assert(
  // PS-317: the displayable gate (validates the saved rate against the CURRENT request
  // fingerprint — the freshness check) now lives in rate-helpers.ts as an indented inner
  // function; hasValidSavedBestRateForRequest + the freshness (cacheExpiresAt) +
  // completeness (isComplete) inputs to the savedBestRateCanDisplayForCurrentRequest
  // contract now live in rate-display-predicates.ts. Teeth preserved: same three checks,
  // re-anchored to the real tokens at the new owners (savedRateIsFreshAndComplete was
  // folded into the isComplete + cacheExpiresAt request-contract inputs).
  /function hasDisplayableBestRateForCurrentRequest/.test(rateHelpers) &&
    rateDisplayPredicates.includes('hasValidSavedBestRateForRequest') &&
    /requestKey:\s*request\.key/.test(rateDisplayPredicates) &&
    /isComplete:\s*savedRate\.isComplete === true/.test(rateDisplayPredicates) &&
    /cacheExpiresAt:\s*toStringValue\(savedRate\.cacheExpiresAt\)/.test(rateDisplayPredicates),
  'Orders UI validates saved rates against current complete request fingerprint/freshness/completeness',
)

// PS-071/PS-079: the awaiting cell still GATES display on hasDisplayableBestRate
// and prompts "add dims" via the bounded classifyAwaitingRateCellState 'add-dims'
// fallback. The exact `if (!hasDisplayableBestRate && ...)` literal was refactored
// by c13748cf ("Fix awaiting best-rate auto display") to
// `if (!hasDisplayableBestRate || bestRateBaseCost == null)` and the
// `isCalculatingBestRate = !hasDisplayableBestRate && hasAnySavedBestRateForDisplay`
// stale-rate gate — same behavior, less brittle pin.
assert(
  // The `if (!hasDisplayableBestRate ...)` display gate now lives in the extracted
  // Best Rate leaf cell; the isCalculatingBestRate stale gate + the bounded
  // 'add-dims' fallback (classifyAwaitingRateCellState / renderRateCellFallback)
  // stay in the OrdersView shell.
  /\bif \(!hasDisplayableBestRate\b/.test(orderCells) &&
    ordersView.includes('!hasDisplayableBestRate && hasAnySavedBestRateForDisplay') &&
    (ordersView.includes('return <span style={{ fontSize: 10.5, color:') ||
      ordersView.includes("data-rate-state=\"add-dims\"")) &&
    ordersView.includes('add dims'),
  'Orders UI hides stale best rates and prompts for dimensions',
)

assert(
  ordersView.includes('if (!hasCompleteDims(dims)) {') &&
    ordersView.includes("throw new Error('Complete dimensions are required before saving a best rate')"),
  'Orders UI refuses to persist non-null best rates without complete dimensions',
)

assert(
  applyBestRate.includes('export function validateBestRateDimsForPersistedRate') &&
    applyBestRate.includes('function parseBestRateDimsLabel') &&
    ordersRoute.includes('validateBestRateDimsForPersistedRate') &&
    ordersRoute.includes('Complete dimensions are required before saving a best rate'),
  'Orders API rejects non-null best rates without complete LxWxH dimensions',
)

assert(
  !ratesBackfill.includes('fallbackDims') &&
    ratesBackfill.includes('getBackfillOrderDims') &&
    ratesBackfill.includes('bestRateDims: dimsLabel'),
  'Rate backfill skips missing real dimensions and persists bestRateDims',
)

assert(
  packageJson.includes('"test:best-rate-dims": "node scripts/best-rate-dims-guard.mjs"'),
  'package script exposes best-rate dimension guard',
)

assert(
  cleanupScript.includes("eq(orders.orderStatus, 'awaiting_shipment')") &&
    cleanupScript.includes('bestRateJson: null') &&
    cleanupScript.includes('bestRateDims: null') &&
    !cleanupScript.includes('shipments'),
  'cleanup tool only clears invalid awaiting best rates and does not touch shipments',
)

assert(
  packageJson.includes('"best-rate:dims:dry-run": "tsx scripts/clear-invalid-best-rates.ts"') &&
    packageJson.includes('"best-rate:dims:apply": "tsx scripts/clear-invalid-best-rates.ts --apply"'),
  'package scripts expose dry-run and apply cleanup commands',
)

if (process.exitCode) {
  console.error('\nBest-rate dimension guard failed.')
  process.exit(process.exitCode)
}
