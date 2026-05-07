// @ts-nocheck
// Variant A — Clean Linear / Notion-inspired
// White surface, subtle slate hover, 3px left accent bar for active items.
// Calm, professional, Software-product feel.
import { BrandLogo } from '../../BrandLogo'
import {
  Search as SearchIcon,
  X as XIcon,
  Boxes,
  Building2,
  Ruler,
  DollarSign,
  BarChart3,
  Settings as SettingsIcon,
  Receipt,
  ClipboardList,
  Box,
  ChevronDown,
  ChevronRight,
  LogOut,
  LayoutDashboard,
  Inbox,
  CheckCircle2,
  XCircle,
  Circle,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

const STATUS_LABELS = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
} as const

const STATUS_ICON = {
  awaiting_shipment: Inbox,
  shipped: CheckCircle2,
  cancelled: XCircle,
}

const TOOL_ITEMS: Array<{ view: SidebarViewType; Icon: any; label: string }> = [
  { view: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'inventory', Icon: Boxes, label: 'Inventory' },
  { view: 'locations', Icon: Building2, label: 'Locations' },
  { view: 'packages', Icon: Ruler, label: 'Packages' },
  { view: 'rates', Icon: DollarSign, label: 'Rate Shop' },
  { view: 'analysis', Icon: BarChart3, label: 'Analysis' },
  { view: 'settings', Icon: SettingsIcon, label: 'Settings' },
  { view: 'billing', Icon: Receipt, label: 'Billing' },
  { view: 'manifests', Icon: ClipboardList, label: 'Manifests' },
]

export default function SidebarA(props: SidebarVariantProps) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()

  return (
    <aside
      className={`
        flex flex-col overflow-hidden flex-shrink-0
        w-[240px] h-full bg-white border-r border-slate-200
        font-sans antialiased text-slate-900
        fixed md:relative inset-y-0 left-0 z-40
        transition-transform duration-200 ease-out
        ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}
      aria-label="Primary navigation"
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-slate-100">
        <div className="w-7 h-7 rounded-md bg-indigo-50 ring-1 ring-indigo-100 flex items-center justify-center overflow-hidden">
          <BrandLogo size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-slate-900 tracking-tight leading-none">PrepShip</div>
          <div className="text-[10px] text-slate-900 mt-0.5 tracking-wide leading-none truncate">
            DR PREPPER · Fulfillment
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <SearchIcon size={13} strokeWidth={2} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-900 pointer-events-none" aria-hidden />
          <input
            type="text"
            placeholder="Search…"
            value={c.effectiveSearchValue}
            onChange={(e) => c.setSearch(e.target.value)}
            aria-label="Search orders"
            className="w-full h-8 pl-8 pr-7 rounded-md border-0 bg-slate-50 text-[12.5px] text-slate-900 placeholder:text-slate-500 focus:bg-white focus:ring-2 focus:ring-indigo-500/30 focus:outline-none transition-colors"
          />
          {c.effectiveSearchValue ? (
            <button type="button" onClick={c.clearSearch} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-slate-900 hover:bg-slate-200 transition-colors">
              <XIcon size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-1.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-900">Orders</div>
        {c.SIDEBAR_STATUSES.map((status) => {
          const StatusIcon = STATUS_ICON[status]
          const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
          const isExpanded = c.expandedSections.has(status)
          const total = c.counts ? c.sidebarSections[status].total : null
          return (
            <div key={status} className="mb-px">
              <div
                className={`group relative flex items-center h-8 pl-3 pr-2 rounded-md cursor-pointer text-[12.5px] font-medium select-none transition-colors duration-100 text-slate-900 ${isActive ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                onClick={() => c.handleSelectStatus(status)}
              >
                {isActive ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-indigo-600" aria-hidden /> : null}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }}
                  aria-label={isExpanded ? `Collapse ${STATUS_LABELS[status]}` : `Expand ${STATUS_LABELS[status]}`}
                  className={`mr-1 -ml-1 w-4 h-4 flex items-center justify-center rounded transition-transform duration-150 ${isExpanded ? 'rotate-0' : '-rotate-90'} text-slate-900`}
                >
                  <ChevronDown size={11} strokeWidth={2.25} />
                </button>
                <StatusIcon size={13} strokeWidth={2} className="mr-2 text-slate-900" />
                <span className="flex-1 truncate">{STATUS_LABELS[status]}</span>
                <span className={`ml-2 text-[10.5px] font-mono tabular-nums text-slate-900 ${isActive ? 'font-semibold' : ''}`}>
                  {total != null ? total.toLocaleString() : '—'}
                </span>
              </div>
              {isExpanded ? (
                <div className="mt-px">
                  {c.sidebarSections[status].stores.map((store) => {
                    const isTestStore = c.isTestOrdersStore(store)
                    const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                    const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                    return (
                      <div
                        key={`${status}-${store.storeId}`}
                        onClick={() => c.handleSelectStore(store.storeId, status)}
                        className={`group relative flex items-center h-7 pl-9 pr-2 rounded-md cursor-pointer text-[11.5px] transition-colors duration-100 ${storeActive ? 'text-slate-900 font-semibold bg-indigo-50/60' : 'text-slate-900 hover:bg-slate-50'}`}
                      >
                        {storeActive ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-indigo-600" aria-hidden /> : null}
                        <span className="flex-1 truncate">{store.name}</span>
                        {isTestStore ? (
                          <button
                            type="button"
                            onClick={c.toggleTestOrders}
                            aria-pressed={c.showTestOrders}
                            aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'}
                            className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-500' : 'bg-slate-300'}`}
                          >
                            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                          </button>
                        ) : null}
                        <span className="ml-2 text-[10px] font-mono tabular-nums text-slate-900">
                          {store.cnt > 0 ? store.cnt.toLocaleString() : ''}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}

        <div className="h-px bg-slate-100 mx-1 my-3" aria-hidden />

        <div className="px-1.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-900">Tools</div>
        {TOOL_ITEMS.map((tool) => {
          const active = c.currentView === tool.view
          const ToolIcon = tool.Icon
          return (
            <div
              key={tool.view}
              role="button"
              tabIndex={0}
              aria-current={active ? 'page' : undefined}
              onClick={() => c.handleShowView(tool.view)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.handleShowView(tool.view) } }}
              className={`relative flex items-center h-8 px-3 rounded-md cursor-pointer text-[12.5px] font-medium select-none transition-colors duration-100 text-slate-900 ${active ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
            >
              {active ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-indigo-600" aria-hidden /> : null}
              <ToolIcon size={14} strokeWidth={2} className="mr-2.5 text-slate-900" />
              <span className="flex-1 truncate">{tool.label}</span>
              {active ? <ChevronRight size={11} strokeWidth={2.5} className="text-indigo-500 ml-1" /> : null}
            </div>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-100 px-3 py-2.5 flex-shrink-0">
        <div className="flex items-center gap-1.5 text-[10.5px] text-slate-900 mb-2">
          <Circle size={6} strokeWidth={0} className="fill-emerald-500 text-emerald-500 flex-shrink-0" aria-hidden />
          <span className="font-medium text-slate-900">ShipStation</span>
          <span className="text-slate-900">·</span>
          <span className="truncate">Gardena CA</span>
        </div>
        {c.session ? (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0 ring-1 ring-indigo-300/40" aria-hidden>{userInitial}</div>
            <div className="flex-1 min-w-0">
              <div className="text-[11.5px] font-semibold text-slate-900 truncate" title={c.user?.email ?? ''}>{c.user?.email ?? 'Signed in'}</div>
              <div className="text-[10px] text-slate-900 leading-tight">Admin</div>
            </div>
            <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className="w-7 h-7 rounded-md flex items-center justify-center text-slate-900 hover:text-rose-600 hover:bg-rose-50 active:scale-95 disabled:opacity-50 transition-colors duration-150">
              <LogOut size={13} strokeWidth={2} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
