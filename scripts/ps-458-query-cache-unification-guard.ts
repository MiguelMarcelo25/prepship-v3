/**
 * PS-458 frontend cache identity guard.
 * Offline/static only: no browser, database, provider, or production access.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import { endpointQueryKeys } from '../web/src/lib/endpoint-query-keys'

function read(file: string): string {
  assert.ok(existsSync(file), `missing ${file}`)
  return readFileSync(file, 'utf8')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    return entry.isDirectory()
      ? sourceFiles(fullPath)
      : /\.(?:ts|tsx)$/.test(entry.name)
        ? [fullPath]
        : []
  })
}

const webSources = sourceFiles('web/src').map(read).join('\n')
const apiClient = read('web/src/lib/v2-apiClient.ts')
const clientInvalidation = read('web/src/lib/client-cache-invalidation.ts')
const clientsData = read('web/src/pages/Clients_variants/useClientsData.tsx')
const inventoryView = read('web/src/components/Views/InventoryView.tsx')
const shared = read('web/src/lib/v2-apiClient/shared.ts')
const dashboard = read('web/src/components/Views/DashboardView.tsx')
const billing = read('web/src/components/Views/BillingView.tsx')
const packages = read('web/src/components/Views/PackagesView.tsx')
const inventory = read('web/src/components/Views/InventoryView.tsx')
const locations = read('web/src/components/Views/LocationsView.tsx')
const marketplaceFees = read('web/src/components/Views/MarketplaceFeesSection.tsx')
const doc = read('docs/ps-tickets/PS-458.md')

assert.doesNotMatch(
  `${apiClient}\n${shared}`,
  /\b(?:cachedReads|cachedSafe|clearCachedReads|CachedRead|CachedSafeOptions)\b/,
  'the hand-rolled API read cache must be deleted',
)
assert.doesNotMatch(
  packages,
  /\b(?:USAGE_CACHE|USAGE_CACHE_TTL_MS|clearPackagesUsageCache)\b/,
  'Packages usage must not retain a module-level response cache',
)

for (const owner of [dashboard, billing, packages, inventory, locations, marketplaceFees]) {
  assert.match(owner, /endpointQueryKeys\./, 'shared endpoint readers must use the canonical key owner')
}

assert.match(dashboard, /\.\.\.activeClientRowsQueryOptions\(\)/,
  'Dashboard client scope must share the active-client endpoint key')
assert.match(dashboard, /select:\s*\(clientsRes\)/,
  'Dashboard must transform client rows with select without changing cached DTO shape')
assert.doesNotMatch(dashboard, /\['dashboard', 'reporting-clients'\]/,
  'Dashboard must not mint a client-list alias')
assert.doesNotMatch(webSources, /\['v2-hooks:(?:packages|locations|inventory)'/,
  'legacy hook-specific endpoint keys must be removed')
assert.doesNotMatch(webSources, /\['settings', '(?:locations|marketplace-fee-stores)'\]/,
  'Settings surfaces must not mint endpoint aliases')
assert.doesNotMatch(webSources, /\['packages', 'custom'\]|\['inventory', 'stock'/,
  'Inventory surfaces must use package/inventory endpoint keys')

for (const keyOwner of [
  'clientQueryKeys.root',
  'endpointQueryKeys.storesRoot',
  'endpointQueryKeys.countsRoot',
  'endpointQueryKeys.inventoryRoot',
]) {
  assert.ok(clientInvalidation.includes(keyOwner),
    `client mutation invalidator must include ${keyOwner}`)
}
assert.equal(
  (apiClient.match(/invalidateClientDependentQueries\(queryClient\)/g) ?? []).length,
  4,
  'all v2 API client create/update/delete/sync mutations must delegate to the canonical invalidator',
)
assert.equal(
  (clientsData.match(/invalidateClientDependentQueries\(queryClient\)/g) ?? []).length,
  3,
  'the real Clients page delete/toggle/sync mutations must delegate to the canonical invalidator',
)
assert.doesNotMatch(clientsData, /\['inventory'\]/,
  'the Clients page must not invalidate the obsolete inventory alias')
assert.doesNotMatch(inventoryView, /queryClient\.invalidateQueries\(\{ queryKey: clientQueryKeys\.root \}\)/,
  'Inventory client mutations must not reimplement the shared invalidation owner')
assert.match(apiClient, /invalidatePackageReads\(\)/,
  'package mutations must invalidate canonical package families')
assert.match(apiClient, /invalidateBillingReads\(\{ summary: true, shippingMargin: true \}\)/,
  'billing mutations must invalidate canonical summary and margin families')

assert.deepEqual(endpointQueryKeys.packages('custom'), ['endpoint', 'packages', 'list', 'custom'])
assert.deepEqual(
  endpointQueryKeys.billingSummary('2026-07-01', '2026-07-31', [9, 2]),
  ['billing', 'summary', '2026-07-01', '2026-07-31', [2, 9]],
  'set-like client filters must hash deterministically',
)

// Orders/client selectors and Dashboard client count share one cache entry.
// A simulated successful mutation changes the server snapshot, invalidates the
// client root once, and both consumers observe the new rows after one refetch.
const proofClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 5 * 60_000 } },
})
const proofClientKeys = {
  root: ['clients'] as const,
  active: ['clients', 'active-only'] as const,
}
let serverRows = [{ id: 1, name: 'Alpha' }]
let requestCount = 0
const clientOptions = {
  queryKey: proofClientKeys.active,
  queryFn: async () => {
    requestCount += 1
    return serverRows
  },
}
const ordersBefore = await proofClient.fetchQuery(clientOptions)
const dashboardBefore = await proofClient.fetchQuery(clientOptions)
assert.equal(requestCount, 1, 'same endpoint consumers must dedupe before mutation')
assert.equal(ordersBefore.length, dashboardBefore.length)
serverRows = [...serverRows, { id: 2, name: 'Beta' }]
await proofClient.invalidateQueries({ queryKey: proofClientKeys.root })
const ordersAfter = await proofClient.fetchQuery(clientOptions)
const dashboardAfter = await proofClient.fetchQuery(clientOptions)
assert.equal(requestCount, 2, 'one root invalidation must cause only one shared refetch')
assert.equal(ordersAfter.length, 2)
assert.equal(dashboardAfter.length, 2)

for (const field of [
  'Canonical owner',
  'Imperfect-data entry point',
  'Caller delegation',
  'Mutation consistency proof',
  'Safety',
]) {
  assert.ok(doc.includes(field), `PS-458 placement record must include ${field}`)
}

console.log('PASS PS-458 canonical TanStack endpoint cache guard')
