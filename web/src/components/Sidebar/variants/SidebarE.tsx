// @ts-nocheck
// Variant E — Polished Dark with Motion
// Refined dark navy canvas (slate-900 → slate-950 gradient) with smooth
// animations on every surface. Display font for the wordmark, professional
// sans for body, premium icon family. Stagger-fade on mount, animated
// progress shimmer on active item, hover scale + glow. Motion makes the
// difference between "dark sidebar" and "alive product."
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
  Users,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

const STATUS_LABELS = { awaiting_shipment: 'Awaiting Shipment', shipped: 'Shipped', cancelled: 'Cancelled' } as const
const STATUS_ICON = { awaiting_shipment: Hourglass, shipped: CheckCircle2, cancelled: XOctagon }
const STATUS_DOT = { awaiting_shipment: 'bg-amber-400', shipped: 'bg-emerald-400', cancelled: 'bg-rose-400' }

const TOOL_ITEMS: Array<{ view: SidebarViewType; Icon: any; label: string }> = [
  { view: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'inventory', Icon: Boxes, label: 'Inventory' },
  { view: 'clients', Icon: Users, label: 'Clients' },
  { view: 'locations', Icon: Building2, label: 'Locations' },
  { view: 'packages', Icon: Package, label: 'Packages' },
  { view: 'rates', Icon: Wallet, label: 'Rate Shop' },
  { view: 'analysis', Icon: TrendingUp, label: 'Analysis' },
  { view: 'settings', Icon: SettingsIcon, label: 'Settings' },
  { view: 'billing', Icon: ReceiptText, label: 'Billing' },
  { view: 'manifests', Icon: ClipboardList, label: 'Manifests' },
]

export default function SidebarE(props: SidebarVariantProps) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()
  const userLocal = (c.user?.email ?? '').split('@')[0] ?? ''

  return (
    <aside
      className={`flex flex-col overflow-hidden flex-shrink-0 w-[260px] h-full font-sans antialiased text-slate-200 fixed md:relative inset-y-0 left-0 z-40 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950`}
      aria-label="Primary navigation"
    >
      {/* Subtle ambient glow */}
      <div className="pointer-events-none absolute -top-32 -right-12 w-72 h-72 rounded-full bg-indigo-500/10 blur-3xl animate-pulse [animation-duration:8s]" aria-hidden />
      <div className="pointer-events-none absolute -bottom-32 -left-8 w-72 h-72 rounded-full bg-blue-500/8 blur-3xl animate-pulse [animation-duration:10s] [animation-delay:2s]" aria-hidden />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-slate-700/50 to-transparent" aria-hidden />

      {/* Logo — animates in on mount */}
      <div className="relative px-4 pt-5 pb-4 animate-fadeInUp" style={{ animationDelay: '0ms' }}>
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10 group">
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 opacity-90 transition-all duration-300 group-hover:opacity-100 group-hover:scale-105" aria-hidden />
            <div className="absolute inset-[1.5px] rounded-[10.5px] bg-slate-900" aria-hidden />
            <div className="relative w-full h-full flex items-center justify-center overflow-hidden rounded-[10.5px]">
              <BrandLogo size={28} className="transition-transform duration-300 group-hover:rotate-12" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] font-extrabold tracking-[-0.025em] leading-none text-white">
              PrepShip
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] tracking-[0.12em] uppercase font-medium text-slate-400">
              <span className="relative inline-flex w-1.5 h-1.5">
                <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" aria-hidden />
                <span className="relative inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden />
              </span>
              <span>Live · DR Prepper</span>
            </div>
          </div>
        </div>
      </div>

      {/* Search — animates in */}
      <div className="relative px-3 pb-3 animate-fadeInUp" style={{ animationDelay: '60ms' }}>
        <div className="relative group">
          <SearchIcon size={13} strokeWidth={2.25} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none transition-colors duration-200 group-focus-within:text-indigo-300" aria-hidden />
          <input
            type="text"
            placeholder="Search orders, SKUs…"
            value={c.effectiveSearchValue}
            onChange={(e) => c.setSearch(e.target.value)}
            aria-label="Search orders"
            className="w-full h-9 pl-9 pr-8 rounded-lg bg-slate-800/50 backdrop-blur text-[12.5px] text-slate-100 placeholder:text-slate-500 ring-1 ring-slate-700/50 focus:bg-slate-800/80 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none transition-all duration-200"
          />
          {c.effectiveSearchValue ? (
            <button type="button" onClick={c.clearSearch} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-slate-700 active:scale-90 transition-all duration-150">
              <XIcon size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Nav */}
      <nav className="relative flex-1 overflow-y-auto px-2.5 pb-3">
        <div className="px-2 pt-2 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 animate-fadeInUp" style={{ animationDelay: '120ms' }}>
          Orders
        </div>

        {c.SIDEBAR_STATUSES.map((status, index) => {
          const StatusIcon = STATUS_ICON[status]
          const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
          const isExpanded = c.expandedSections.has(status)
          const total = c.counts ? c.sidebarSections[status].total : null
          return (
            <div key={status} className="mb-0.5 animate-fadeInUp" style={{ animationDelay: `${160 + index * 40}ms` }}>
              <div
                onClick={() => c.handleSelectStatus(status)}
                className={`group relative flex items-center h-10 px-2.5 rounded-lg cursor-pointer text-[12.5px] font-medium select-none transition-all duration-300 ease-out ${isActive ? 'bg-gradient-to-r from-indigo-500/15 via-indigo-500/8 to-transparent ring-1 ring-indigo-400/25 text-white shadow-[0_0_20px_-4px_rgba(99,102,241,0.4)]' : 'text-slate-300 hover:bg-slate-800/50 hover:translate-x-0.5'}`}
              >
                {/* Animated accent bar */}
                {isActive ? (
                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-gradient-to-b from-indigo-300 via-indigo-400 to-indigo-500 shadow-[0_0_8px_rgba(129,140,248,0.6)]" aria-hidden />
                ) : null}
                <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mr-2.5 transition-all duration-300 ${isActive ? 'bg-indigo-400/15 ring-1 ring-indigo-400/30' : 'bg-slate-800/60 ring-1 ring-slate-700/40 group-hover:bg-slate-700/60 group-hover:ring-slate-600/60'}`}>
                  <StatusIcon size={13} strokeWidth={2} className={`transition-colors duration-300 ${isActive ? 'text-indigo-300' : 'text-slate-400 group-hover:text-slate-200'}`} />
                </div>
                <span className={`flex-1 truncate transition-colors duration-300 ${isActive ? 'text-white font-semibold' : 'text-slate-200 group-hover:text-white'}`}>
                  {STATUS_LABELS[status]}
                </span>
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 transition-all duration-300 ${STATUS_DOT[status]} ${isActive ? 'opacity-100 shadow-[0_0_6px_currentColor]' : 'opacity-50'}`} aria-hidden />
                <span className={`text-[10.5px] font-mono tabular-nums font-bold mr-1 transition-colors duration-300 ${isActive ? 'text-indigo-200' : 'text-slate-400'}`}>
                  {total != null ? total.toLocaleString() : '—'}
                </span>
                <button type="button" onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }} aria-label={isExpanded ? 'Collapse' : 'Expand'} className={`w-5 h-5 flex items-center justify-center rounded transition-all duration-300 ${isExpanded ? 'rotate-0' : '-rotate-90'} ${isActive ? 'text-indigo-300' : 'text-slate-500 hover:text-slate-200'}`}>
                  <ChevronDown size={11} strokeWidth={2.5} />
                </button>
              </div>
              {isExpanded ? (
                <div className="mt-0.5 ml-3.5 pl-3 border-l border-slate-700/50 space-y-px py-0.5 animate-fadeInUp" style={{ animationDuration: '300ms' }}>
                  {c.sidebarSections[status].stores.map((store, sIdx) => {
                    const isTestStore = c.isTestOrdersStore(store)
                    const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                    const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                    return (
                      <div
                        key={`${status}-${store.storeId}`}
                        onClick={() => c.handleSelectStore(store.storeId, status)}
                        className={`flex items-center h-7 px-2.5 rounded-md cursor-pointer text-[11.5px] transition-all duration-200 ${storeActive ? 'bg-indigo-500/12 ring-1 ring-indigo-400/25 text-indigo-100 font-semibold' : isMuted ? 'text-slate-600 hover:text-slate-400 hover:bg-slate-800/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/50 hover:translate-x-0.5'}`}
                        style={{ animationDelay: `${sIdx * 30}ms` }}
                      >
                        <span className="flex-1 truncate">{store.name}</span>
                        {isTestStore ? (
                          <button type="button" onClick={c.toggleTestOrders} aria-pressed={c.showTestOrders} aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'} className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-all duration-300 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`}>
                            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-md transition-transform duration-300 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                          </button>
                        ) : null}
                        <span className={`ml-1.5 text-[10px] font-mono tabular-nums font-bold ${storeActive ? 'text-indigo-200' : 'text-slate-500'}`}>
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

        <div className="px-2 pt-4 pb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 animate-fadeInUp" style={{ animationDelay: '320ms' }}>
          Tools
        </div>

        <div className="space-y-0.5">
          {TOOL_ITEMS.map((tool, index) => {
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
                className={`group relative flex items-center h-10 px-2.5 rounded-lg cursor-pointer text-[12.5px] font-medium select-none transition-all duration-300 ease-out animate-fadeInUp ${active ? 'bg-gradient-to-r from-indigo-500/15 via-indigo-500/8 to-transparent ring-1 ring-indigo-400/25 text-white shadow-[0_0_20px_-4px_rgba(99,102,241,0.4)]' : 'text-slate-300 hover:bg-slate-800/50 hover:translate-x-0.5'}`}
                style={{ animationDelay: `${360 + index * 35}ms` }}
              >
                {active ? (
                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-gradient-to-b from-indigo-300 via-indigo-400 to-indigo-500 shadow-[0_0_8px_rgba(129,140,248,0.6)]" aria-hidden />
                ) : null}
                <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mr-2.5 transition-all duration-300 ${active ? 'bg-indigo-400/15 ring-1 ring-indigo-400/30' : 'bg-slate-800/60 ring-1 ring-slate-700/40 group-hover:bg-slate-700/60'}`}>
                  <ToolIcon size={13} strokeWidth={2} className={`transition-colors duration-300 ${active ? 'text-indigo-300' : 'text-slate-400 group-hover:text-slate-200'}`} />
                </div>
                <span className={`flex-1 truncate transition-colors duration-300 ${active ? 'text-white font-semibold' : 'text-slate-200 group-hover:text-white'}`}>
                  {tool.label}
                </span>
                {active ? (
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.9)] animate-pulse" aria-hidden />
                ) : null}
              </div>
            )
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className="relative border-t border-slate-800/60 px-3 pt-3 pb-3.5 flex-shrink-0 bg-slate-950/40 backdrop-blur animate-fadeInUp" style={{ animationDelay: '700ms' }}>
        {c.session ? (
          <div className="flex items-center gap-2.5 group">
            <div className="relative flex-shrink-0">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 blur-[2px] opacity-60 transition-opacity duration-300 group-hover:opacity-100" aria-hidden />
              <div className="relative w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center text-white text-[12px] font-bold ring-1 ring-white/20 transition-transform duration-300 group-hover:scale-105">{userInitial}</div>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-slate-950 shadow-[0_0_6px_rgba(16,185,129,0.8)]" aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-slate-100 truncate leading-tight transition-colors duration-200 group-hover:text-white" title={c.user?.email ?? ''}>{userLocal || 'Signed in'}</div>
              <div className="text-[9.5px] text-slate-500 truncate leading-tight mt-0.5 font-medium">Admin · Gardena, CA</div>
            </div>
            <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 hover:ring-1 hover:ring-rose-500/30 active:scale-90 disabled:opacity-50 transition-all duration-200">
              <LogOut size={14} strokeWidth={2.25} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
