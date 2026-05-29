const UI_CACHE_VERSION = '2026-05-29-sidebar-drawer-v1'
const VERSION_KEY = 'prepship:ui-cache-version'

const EXACT_UI_KEYS = [
  'analysis_chart_type',
  'analysis_column_layout',
  'analysis_column_size',
  'analysis_column_widths',
  'analysis_from',
  'analysis_preset_days',
  'analysis_sku_drawer_widths',
  'analysis_to',
  'billing_summary_client_filter_v1',
  'dashboard:sku:column-order',
  'dashboard:sku:column-widths',
  'dashboard_hidden_panels_v1',
  'dashboard_panel_order_v1',
  'dashboard_section_heights_v1',
  'dashboard_section_sizes_v1',
  'inventory_column_layout',
  'inventory_column_widths',
  'packages_column_layout',
  'packages_column_widths',
  'prepship_analysis_sort',
  'prepship.orders.columnPrefs',
  'prepship_hide_empty_panel',
  'rates_page_size',
  'settings:carrier-groups:collapsed',
]

const UI_KEY_PREFIXES = [
  'billing-detail-table',
  'billing-summary-table',
  'clients-table',
  'inventory-history-table',
  'inventory-stock-levels',
  'packages-table',
  'rates-table',
]

function isUiLayoutKey(key: string): boolean {
  if (key === VERSION_KEY) return false
  if (EXACT_UI_KEYS.includes(key)) return true
  return UI_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))
}

export function runUiCacheVersionMigration(storage: Storage = window.localStorage): void {
  try {
    if (storage.getItem(VERSION_KEY) === UI_CACHE_VERSION) return

    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key && isUiLayoutKey(key)) storage.removeItem(key)
    }

    storage.setItem(VERSION_KEY, UI_CACHE_VERSION)
  } catch (error) {
    console.warn('[main] UI cache migration skipped', error)
  }
}
