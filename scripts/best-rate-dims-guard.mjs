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

const [ordersView, ordersRoute, ratesBackfill, cleanupScript, packageJson] = await Promise.all([
  read('web/src/components/Views/OrdersView.tsx'),
  read('src/routes/orders.ts'),
  read('src/services/rates-backfill.ts'),
  read('scripts/clear-invalid-best-rates.ts'),
  read('package.json'),
])

assert(
  ordersView.includes('function hasValidBestRateForCurrentDims') &&
    ordersView.includes('return Boolean(savedDims && currentDims && savedDims === currentDims)'),
  'Orders UI validates bestRateDims against current complete dimensions',
)

assert(
  ordersView.includes('if (!hasDisplayableBestRate)') &&
    ordersView.includes('return <span style={{ fontSize: 10.5, color:') &&
    ordersView.includes('add dims'),
  'Orders UI hides stale best rates and prompts for dimensions',
)

assert(
  ordersView.includes('if (!hasCompleteDims(dims)) {') &&
    ordersView.includes("throw new Error('Complete dimensions are required before saving a best rate')"),
  'Orders UI refuses to persist non-null best rates without complete dimensions',
)

assert(
  ordersRoute.includes('const bestRateDimsSchema') &&
    ordersRoute.includes('parseBestRateDimsLabel') &&
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
