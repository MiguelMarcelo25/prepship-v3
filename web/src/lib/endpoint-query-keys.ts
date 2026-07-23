/**
 * PS-458: canonical TanStack identities for shared GET endpoints.
 *
 * Backend routes remain the source of truth for every returned value. This
 * module owns only frontend request identity so hooks, views, and imperative
 * readers cannot create parallel caches for the same request.
 */

type DateFilter = { dateStart?: string; dateEnd?: string }
type DailyStatsFilter = { status?: string; dateFrom?: string; dateTo?: string }

function clientFilterKey(clientFilter?: number | number[]): number | readonly number[] | null {
  if (!Array.isArray(clientFilter)) return clientFilter ?? null
  return [...clientFilter]
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right)
}

export const endpointQueryKeys = {
  countsRoot: ['endpoint', 'init', 'counts'] as const,
  counts: (filter?: DateFilter) =>
    ['endpoint', 'init', 'counts', filter?.dateStart ?? null, filter?.dateEnd ?? null] as const,
  storesRoot: ['endpoint', 'init', 'stores'] as const,
  stores: ['endpoint', 'init', 'stores'] as const,
  carrierAccounts: ['endpoint', 'init', 'carrier-accounts'] as const,
  columnPrefs: ['endpoint', 'settings', 'orders.columnPrefs'] as const,
  legacySyncStatus: ['endpoint', 'sync', 'status'] as const,
  syncWorkerStatus: ['endpoint', 'worker', 'status'] as const,
  distinctSkusRoot: ['endpoint', 'orders', 'distinct-skus'] as const,
  distinctSkus: (filters: Record<string, unknown> = {}) =>
    ['endpoint', 'orders', 'distinct-skus', filters] as const,
  dailyStatsRoot: ['endpoint', 'orders', 'daily-stats'] as const,
  dailyStats: (filter?: DailyStatsFilter) =>
    ['endpoint', 'orders', 'daily-stats', filter ?? {}] as const,
  inventoryRoot: ['endpoint', 'inventory'] as const,
  inventory: (query?: Record<string, unknown>) => ['endpoint', 'inventory', query ?? {}] as const,
  locations: ['endpoint', 'locations'] as const,
  packagesRoot: ['endpoint', 'packages', 'list'] as const,
  packages: (source?: string) => ['endpoint', 'packages', 'list', source ?? null] as const,
  packagesUsageRoot: ['endpoint', 'packages', 'usage-summary'] as const,
  packagesUsage: (days = 30) => ['endpoint', 'packages', 'usage-summary', days] as const,
  billingConfigs: ['billing', 'configs'] as const,
  billingSummaryRoot: ['billing', 'summary'] as const,
  billingSummary: (from: string, to: string, clientFilter?: number | number[]) =>
    ['billing', 'summary', from, to, clientFilterKey(clientFilter)] as const,
  shippingMarginRoot: ['billing', 'shipping-margin'] as const,
  shippingMargin: (from: string, to: string, clientFilter?: number | number[]) =>
    ['billing', 'shipping-margin', from, to, clientFilterKey(clientFilter)] as const,
  billingPackagePricesRoot: ['billing', 'package-prices'] as const,
  billingPackagePrices: (clientId: number | null) =>
    ['billing', 'package-prices', clientId] as const,
}
