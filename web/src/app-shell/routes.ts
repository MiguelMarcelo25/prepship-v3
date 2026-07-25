import { getOrdersDateRange } from '../components/Views/orders-view-filters'

export type ViewType =
  | 'orders'
  | 'dashboard'
  | 'inventory'
  | 'clients'
  | 'locations'
  | 'packages'
  | 'rates'
  | 'analysis'
  | 'settings'
  | 'automations'
  | 'billing'
  | 'manifests'

export type ContentView = Exclude<ViewType, 'manifests'>
export type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'
export type InventoryRouteTab = 'stock' | 'receive' | 'alerts' | 'parents' | 'history'
export type OrdersDateFilter = '' | 'this-month' | 'last-month' | 'last-30' | 'last-90' | 'custom'

export type AppRoute = {
  view: ViewType
  status: OrderStatus | null
  orderId: number | null
  inventoryTab: InventoryRouteTab | null
}

// 2026-05-13: 'locations' was removed from this map when Ship-From
// Locations moved into Settings. pathToRoute maps old /locations URLs to
// Settings before navigation uses this map, so no locations path is needed.
export const VIEW_PATHS: Record<Exclude<ViewType, 'orders' | 'locations'>, string> = {
  dashboard: '/dashboard',
  inventory: '/inventory/stock-levels',
  clients: '/clients',
  packages: '/packages',
  rates: '/rates',
  analysis: '/analysis',
  settings: '/settings',
  automations: '/automations',
  billing: '/billing',
  manifests: '/manifest',
}

export const VALID_STATUSES: OrderStatus[] = ['awaiting_shipment', 'shipped', 'cancelled']

export const INVENTORY_TAB_PATHS: Record<InventoryRouteTab, string> = {
  stock: '/inventory/stock-levels',
  receive: '/inventory/received',
  alerts: '/inventory/alerts',
  parents: '/inventory/parent-skus',
  history: '/inventory/history',
}

export const INVENTORY_SEGMENT_TO_TAB: Record<string, InventoryRouteTab> = {
  '': 'stock',
  stock: 'stock',
  'stock-levels': 'stock',
  levels: 'stock',
  receive: 'receive',
  received: 'receive',
  alerts: 'alerts',
  parents: 'parents',
  'parent-skus': 'parents',
  history: 'history',
}

export function getResolvedDateRange(filter: OrdersDateFilter) {
  const range = getOrdersDateRange(filter)
  if (!range) return { start: undefined, end: undefined }
  return {
    start: range.start.toISOString().split('T')[0],
    end: range.end.toISOString().split('T')[0],
  }
}

// Parses URLs of the form:
//   /orders                         -> awaiting_shipment, no order
//   /orders/awaiting_shipment       -> awaiting_shipment, no order
//   /orders/awaiting_shipment/12345 -> awaiting_shipment, drawer open on order 12345
//   /orders/shipped/87765           -> shipped, drawer open on order 87765
//   /inventory                      -> inventory tool, stock tab
export function pathToRoute(pathname: string): AppRoute {
  if (pathname === '/' || pathname === '/orders' || pathname === '/orders/') {
    return { view: 'orders', status: 'awaiting_shipment', orderId: null, inventoryTab: null }
  }

  if (pathname === '/locations' || pathname.startsWith('/locations/')) {
    return { view: 'settings', status: null, orderId: null, inventoryTab: null }
  }

  const inventoryMatch = pathname.match(/^\/inventory(?:\/([^/]+))?\/?$/)
  if (inventoryMatch) {
    const segment = (inventoryMatch[1] ?? '').toLowerCase()
    return {
      view: 'inventory',
      status: null,
      orderId: null,
      inventoryTab: INVENTORY_SEGMENT_TO_TAB[segment] ?? 'stock',
    }
  }

  const ordersMatch = pathname.match(/^\/orders\/([^/]+)(?:\/(\d+))?\/?$/)
  if (ordersMatch) {
    const candidate = ordersMatch[1] as OrderStatus
    const status: OrderStatus = VALID_STATUSES.includes(candidate)
      ? candidate
      : 'awaiting_shipment'
    const idStr = ordersMatch[2]
    const orderId = idStr ? Number.parseInt(idStr, 10) : null
    return {
      view: 'orders',
      status,
      orderId: Number.isFinite(orderId) && (orderId ?? 0) > 0 ? orderId : null,
      inventoryTab: null,
    }
  }

  for (const [view, path] of Object.entries(VIEW_PATHS) as [
    Exclude<ViewType, 'orders' | 'locations'>,
    string,
  ][]) {
    if (pathname === path || pathname.startsWith(path + '/')) {
      return { view, status: null, orderId: null, inventoryTab: null }
    }
  }

  return { view: 'orders', status: 'awaiting_shipment', orderId: null, inventoryTab: null }
}
