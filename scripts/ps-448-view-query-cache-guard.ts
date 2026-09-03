import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  queryClient,
  VIEW_QUERY_CACHE_MS,
  VIEW_QUERY_STALE_MS,
} from '../web/src/lib/query-client'

const read = (path: string) => readFileSync(path, 'utf8')

const queryClientSource = read('web/src/lib/query-client.ts')
const home = read('web/src/Home.tsx')
const dashboard = read('web/src/components/Views/DashboardView.tsx')
const billing = read('web/src/components/Views/BillingView.tsx')
const analysis = read('web/src/components/Views/AnalysisView.tsx')
const settings = [
  read('web/src/components/Views/SettingsView.tsx'),
  read('web/src/components/Views/MarketplaceFeesSection.tsx'),
  read('web/src/components/Views/LocationsView.tsx'),
  read('web/src/components/Settings/CarrierEligibilityPolicyCard.tsx'),
  read('web/src/components/Settings/CarrierIntegrationsCard.tsx'),
  read('web/src/components/Settings/PendingClientIntegrationsCard.tsx'),
  read('web/src/components/Settings/HugrabInsurancePolicyCard.tsx'),
].join('\n')
const browserProof = read('web/e2e/dashboard-ps325-proof.spec.js')

assert.match(queryClientSource, /VIEW_QUERY_STALE_MS\s*=\s*5 \* 60_000/)
assert.match(queryClientSource, /VIEW_QUERY_CACHE_MS\s*=\s*30 \* 60_000/)
assert.match(queryClientSource, /refetchOnWindowFocus:\s*false/)
assert.match(queryClientSource, /refetchOnMount:\s*false/)
assert.match(queryClientSource, /\['dashboard', 'billing', 'analysis', 'settings'\]/)
assert.match(queryClientSource, /setQueryDefaults\(\[root\]/)
assert.match(queryClientSource, /refetchOnMount:\s*true/)
assert.doesNotMatch(home, /<AnimatePresence[^>]*mode=["']wait["']/)

const requiredKeys: Array<[string, string, string[]]> = [
  ['Dashboard', dashboard, [
    "['dashboard', 'reporting-window'",
    'endpointQueryKeys.legacySyncStatus',
    'activeClientRowsQueryOptions()',
    "['dashboard', 'metrics'",
    "['dashboard', 'shipping-margin'",
    "['dashboard', 'sku-trends'",
    "['dashboard', 'inventory-risk'",
    "['dashboard', 'top-skus'",
    "['dashboard', 'daily-revenue-by-client'",
    "['dashboard', 'top-combos'",
  ]],
  ['Billing', billing, [
    "['billing', 'preset-window'",
    'endpointQueryKeys.billingConfigs',
    'endpointQueryKeys.billingPackagePrices',
    'endpointQueryKeys.billingSummary',
    'endpointQueryKeys.shippingMargin',
    "['billing', 'details'",
    "['billing', 'finalizations'",
    "['billing', 'credit-notes'",
  ]],
  ['Analysis', analysis, [
    "['analysis', 'preset-window'",
    "['analysis', 'skus'",
    "['analysis', 'daily-sales'",
    "'sku-orders',",
  ]],
  ['Settings', settings, [
    "['settings', 'test-clients'",
    "['settings', 'observability-status'",
    "['settings', 'marketplace-fee-rules'",
    'endpointQueryKeys.stores',
    'endpointQueryKeys.locations',
    "['settings', 'carrier-eligibility-policy'",
    "['settings', 'carrier-accounts'",
    "['settings', 'store-accounts'",
    "['settings', 'pending-carrier-integrations'",
    "['settings', 'pending-store-integrations'",
    "['settings', 'shipstation-env-accounts'",
  ]],
]

for (const [view, source, keys] of requiredKeys) {
  assert.match(source, /useQuery(?:<[^>]+>)?\s*\(/, `${view} must use TanStack Query`)
  for (const key of keys) {
    assert(source.includes(key), `${view} must retain canonical query key ${key}`)
  }
}

assert.match(analysis, /queryKey:\s*clientQueryKeys\.active/)
assert.match(settings, /queryKey:\s*QUERY_KEY/)
assert.doesNotMatch(settings, /\['settings:/, 'Settings keys must use the canonical two-part prefix')

assert.doesNotMatch(dashboard, /(?:function|const)\s+loadDashboard\b/)
assert.doesNotMatch(billing, /(?:function|const)\s+(?:loadConfigs|loadSummary|loadDetails)\b/)
assert.doesNotMatch(analysis, /(?:function|const)\s+(?:loadAnalysis|loadSkus|loadDailySales)\b/)
assert.doesNotMatch(settings, /\b(?:setTestClients|setSystemStatus|setAutomationRows)\s*\(/)

assert.match(dashboard, /queryClient\.invalidateQueries\(\{ queryKey: \['dashboard'\] \}\)/)
assert.match(billing, /queryClient\.invalidateQueries\(\{ queryKey: endpointQueryKeys\.billingSummaryRoot/)
assert.match(browserProof, /PS-448 Dashboard remount cache proof/)
assert.match(browserProof, /Dashboard -> Orders -> Dashboard performs zero unchanged-data refetches/)
assert.match(browserProof, /backend\.captured\.filter\(isDashboardRead\)/)

async function proveFreshCacheReuse(root: string): Promise<void> {
  queryClient.clear()
  let requestCount = 0
  const options = {
    queryKey: [root, 'ps-448-fresh-cache-proof'] as const,
    queryFn: async () => {
      requestCount += 1
      return { root, requestCount }
    },
  }

  const first = await queryClient.fetchQuery(options)
  const revisit = await queryClient.fetchQuery(options)
  assert.deepEqual(revisit, first, `${root} fresh revisit must render cached data`)
  assert.equal(requestCount, 1, `${root} fresh revisit must not call its queryFn again`)

  await queryClient.invalidateQueries({ queryKey: [root], refetchType: 'none' })
  await queryClient.fetchQuery(options)
  assert.equal(requestCount, 2, `${root} explicit invalidation must permit one fresh request`)
}

for (const root of ['dashboard', 'billing', 'analysis', 'settings']) {
  const defaults = queryClient.getQueryDefaults([root, 'ps-448-defaults-proof'])
  assert.equal(defaults.staleTime, VIEW_QUERY_STALE_MS)
  assert.equal(defaults.gcTime, VIEW_QUERY_CACHE_MS)
  assert.equal(defaults.refetchOnWindowFocus, false)
  assert.equal(defaults.refetchOnMount, true, `${root} stale remount must refresh in background`)
  await proveFreshCacheReuse(root)
}
queryClient.clear()

console.log('PASS PS-448 view query-cache guard')
