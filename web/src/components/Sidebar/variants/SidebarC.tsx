// @ts-nocheck
// Variant C — Executive Glass (refined, professional)
// Frosted glass on a calm slate base. Single deep-indigo accent throughout —
// no rainbow. Refined typography, premium fintech / Stripe-style polish.
import { BrandLogo } from '../../BrandLogo'
import {
  Search as SearchIcon,
  X as XIcon,
  Boxes,
  Building2,
  Package,
  Wallet,
  TrendingUp,
  Settings as SettingsIcon,
  ReceiptText,
  ClipboardList,
  ChevronDown,
  LogOut,
  LayoutDashboard,
  Hourglass,
  CheckCircle2,
  XOctagon,
  Diamond,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

const STATUS_LABELS = { awaiting_shipment: 'Awaiting Shipment', shipped: 'Shipped', cancelled: 'Cancelled' } as const
const STATUS_ICON = { awaiting_shipment: Hourglass, shipped: CheckCircle2, cancelled: XOctagon }
const STATUS_DOT = { awaiting_shipment: 'bg-amber-500', shipped: 'bg-emerald-500', cancelled: 'bg-rose-500' }

const TOOL_ITEMS: Array<{ view: SidebarViewType; Icon: any; label: string }> = [
  { view: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'inventory', Icon: Boxes, label: 'Inventory' },
  { view: 'locations', Icon: Building2, label: 'Locations' },
  { view: 'packages', Icon: Package, label: 'Packages' },
  { view: 'rates', Icon: Wallet, label: 'Rate Shop' },
  { view: 'analysis', Icon: TrendingUp, label: 'Analysis' },
  { view: 'settings', Icon: SettingsIcon, label: 'Settings' },
  { view: 'billing', Icon: ReceiptText, label: 'Billing' },
  { view: 'manifests', Icon: ClipboardList, label: 'Manifests' },
]

export default function SidebarC(props: SidebarVariantProps) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()
  const userLocal = (c.user?.email ?? '').split('@')[0] ?? ''

  return (
    <aside
      className={`flex flex-col overflow-hidden flex-shrink-0 w-[260px] h-full font-sans antialiased text-slate-700 fixed md:relative inset-y-0 left-0 z-40 transition-transform duration-200 ease-out ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} bg-gradient-to-b from-slate-50 via-slate-50 to-white border-r border-slate-200/80`}
      aria-label="Primary navigation"
    >
      {/* Subtle, refined ambient glow — single indigo tone, very low opacity */}
      <div className="pointer-events-none absolute -top-32 -right-16 w-72 h-72 rounded-full bg-indigo-400/12 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-32 -left-12 w-60 h-60 rounded-full bg-slate-400/10 blur-3xl" aria-hidden />

      {/* Logo card — frosted, restrained */}
      <div className="relative px-3 pt-4">
        <div className="rounded-xl p-3.5 bg-white/80 backdrop-blur-xl ring-1 ring-slate-900/5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_-8px_rgba(15,23,42,0.08)]">
          <div className="flex items-center gap-3">
            <div className="relative w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-600 to-indigo-700 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] overflow-hidden">
              <BrandLogo size={26} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-extrabold tracking-[-0.02em] leading-none text-slate-900">
                PrepShip
              </div>
              <div className="text-[10px] text-slate-500 mt-1.5 tracking-wide truncate font-medium">
                DR PREPPER · Fulfillment
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative px-3 pt-2.5 pb-2">
        <div className="relative">
          <SearchIcon size={13} strokeWidth={2.25} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden />
          <input
            type="text"
            placeholder="Search orders, SKUs…"
            value={c.effectiveSearchValue}
            onChange={(e) => c.setSearch(e.target.value)}
            aria-label="Search orders"
            className="w-full h-9 pl-9 pr-7 rounded-lg bg-white/80 backdrop-blur-md text-[12.5px] text-slate-800 placeholder:text-slate-400 ring-1 ring-slate-900/5 focus:bg-white focus:ring-2 focus:ring-indigo-500/40 focus:outline-none transition-all duration-150 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"
          />
          {c.effectiveSearchValue ? (
            <button type="button" onClick={c.clearSearch} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors">
              <XIcon size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Nav */}
      <nav className="relative flex-1 overflow-y-auto px-2.5 pb-3">
        <div className="px-2 pt-2.5 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
          Orders
        </div>

        {c.SIDEBAR_STATUSES.map((status) => {
          const StatusIcon = STATUS_ICON[status]
          const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
          const isExpanded = c.expandedSections.has(status)
          const total = c.counts ? c.sidebarSections[status].total : null
          return (
            <div key={status} className="mb-0.5">
              <div
                onClick={() => c.handleSelectStatus(status)}
                className={`group relative flex items-center h-10 px-2.5 rounded-lg cursor-pointer text-[12.5px] font-semibold select-none transition-all duration-150 ${isActive ? 'bg-white/90 backdrop-blur-md ring-1 ring-indigo-500/15 text-indigo-700 shadow-[0_1px_3px_rgba(15,23,42,0.04),0_0_0_1px_rgba(99,102,241,0.04)]' : 'text-slate-700 hover:bg-white/60 hover:backdrop-blur-md hover:ring-1 hover:ring-slate-900/5'}`}
              >
                {isActive ? (
                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-sm bg-indigo-600" aria-hidden />
                ) : null}
                <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors duration-150 ${isActive ? 'bg-indigo-50 ring-1 ring-indigo-500/15' : 'bg-slate-100/70'}`}>
                  <StatusIcon size={13} strokeWidth={2.25} className={isActive ? 'text-indigo-600' : 'text-slate-500'} />
                </div>
                <span className="flex-1 truncate">{STATUS_LABELS[status]}</span>
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${STATUS_DOT[status]} ${isActive ? 'opacity-100' : 'opacity-50'}`} aria-hidden />
                <span className={`text-[10.5px] font-mono tabular-nums font-bold mr-1 ${isActive ? 'text-indigo-700' : 'text-slate-500'}`}>
                  {total != null ? total.toLocaleString() : '—'}
                </span>
                <button type="button" onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }} aria-label={isExpanded ? 'Collapse' : 'Expand'} className={`w-5 h-5 flex items-center justify-center rounded transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'} ${isActive ? 'text-indigo-500' : 'text-slate-400 hover:text-slate-700'}`}>
                  <ChevronDown size={11} strokeWidth={2.5} />
                </button>
              </div>
              {isExpanded ? (
                <div className="mt-0.5 ml-3.5 pl-3 border-l border-slate-200 space-y-px py-0.5">
                  {c.sidebarSections[status].stores.map((store) => {
                    const isTestStore = c.isTestOrdersStore(store)
                    const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                    const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                    return (
                      <div
                        key={`${status}-${store.storeId}`}
                        onClick={() => c.handleSelectStore(store.storeId, status)}
                        className={`flex items-center h-7 px-2.5 rounded-md cursor-pointer text-[11.5px] transition-all duration-100 ${storeActive ? 'bg-white/90 backdrop-blur ring-1 ring-indigo-500/15 text-indigo-700 font-semibold shadow-sm' : isMuted ? 'text-slate-400 hover:text-slate-600 hover:bg-white/40' : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'}`}
                      >
                        <span className="flex-1 truncate">{store.name}</span>
                        {isTestStore ? (
                          <button type="button" onClick={c.toggleTestOrders} aria-pressed={c.showTestOrders} aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'} className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform duration-150 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                          </button>
                        ) : null}
                        <span className={`ml-1.5 text-[10px] font-mono tabular-nums font-bold ${storeActive ? 'text-indigo-700' : 'text-slate-400'}`}>
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

        <div className="px-2 pt-4 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
          Tools
        </div>

        <div className="space-y-0.5">
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
                className={`relative flex items-center h-10 px-2.5 rounded-lg cursor-pointer text-[12.5px] font-semibold select-none transition-all duration-150 ${active ? 'bg-white/90 backdrop-blur-md ring-1 ring-indigo-500/15 text-indigo-700 shadow-[0_1px_3px_rgba(15,23,42,0.04)]' : 'text-slate-700 hover:bg-white/60 hover:backdrop-blur-md hover:ring-1 hover:ring-slate-900/5'}`}
              >
                {active ? <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-sm bg-indigo-600" aria-hidden /> : null}
                <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors duration-150 ${active ? 'bg-indigo-50 ring-1 ring-indigo-500/15' : 'bg-slate-100/70'}`}>
                  <ToolIcon size={13} strokeWidth={2.25} className={active ? 'text-indigo-600' : 'text-slate-500'} />
                </div>
                <span className="flex-1 truncate">{tool.label}</span>
              </div>
            )
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="relative px-3 pb-3 pt-2 flex-shrink-0">
        {c.session ? (
          <div className="rounded-xl bg-white/85 backdrop-blur-xl ring-1 ring-slate-900/5 p-2.5 flex items-center gap-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_-8px_rgba(15,23,42,0.06)]">
            <div className="relative flex-shrink-0">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-600 to-indigo-700 flex items-center justify-center text-white text-[12px] font-bold ring-1 ring-indigo-500/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">{userInitial}</div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-white" aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-slate-900 truncate" title={c.user?.email ?? ''}>{userLocal || 'Signed in'}</div>
              <div className="text-[10px] text-slate-500 truncate font-medium">Admin · Gardena, CA</div>
            </div>
            <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50 active:scale-90 disabled:opacity-50 transition-all duration-150">
              <LogOut size={13} strokeWidth={2.25} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
