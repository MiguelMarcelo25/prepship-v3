// @ts-nocheck
// Variant D — Calm Aurora
// Soft layered aurora background (slate base + multi-blob gradient mesh) with
// uniform calm content on top. No display-font typography, no bar accents,
// no aggressive states — just whisper-quiet hierarchy with a beautiful
// atmospheric backdrop that carries the visual weight.
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
  Clock,
  CheckCircle2,
  XOctagon,
  Feather,
  Users,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

const STATUS_LABELS = { awaiting_shipment: 'Awaiting', shipped: 'Shipped', cancelled: 'Cancelled' } as const
const STATUS_ICON = { awaiting_shipment: Clock, shipped: CheckCircle2, cancelled: XOctagon }
const STATUS_DOT = { awaiting_shipment: 'bg-amber-400', shipped: 'bg-emerald-400', cancelled: 'bg-rose-400' }

const TOOL_ITEMS: Array<{ view: SidebarViewType; Icon: any; label: string }> = [
  { view: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard' },
  { view: 'inventory', Icon: Boxes, label: 'Inventory' },
  { view: 'clients', Icon: Users, label: 'Clients' },
  // 2026-05-13: Locations moved into Settings → Ship-From Locations tab.
  { view: 'packages', Icon: Package, label: 'Packages' },
  { view: 'rates', Icon: Wallet, label: 'Rate Shop' },
  { view: 'analysis', Icon: TrendingUp, label: 'Analysis' },
  { view: 'settings', Icon: SettingsIcon, label: 'Settings' },
  { view: 'billing', Icon: ReceiptText, label: 'Billing' },
  { view: 'manifests', Icon: ClipboardList, label: 'Manifests' },
]

export default function SidebarD(props: SidebarVariantProps) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()
  const userLocal = (c.user?.email ?? '').split('@')[0] ?? ''

  return (
    <aside
      className={`flex flex-col overflow-hidden flex-shrink-0 w-[256px] h-full font-sans antialiased text-slate-700 fixed md:relative inset-y-0 left-0 z-40 transition-transform duration-200 ease-out ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      aria-label="Primary navigation"
    >
      {/* ─── Aurora background ─────────────────────────────────────────
          Layered: a calm slate base, then 4 soft blurred color blobs that
          drift very slowly, plus a SVG noise texture so the gradient
          doesn't band on retina screens. */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-50 via-slate-50/95 to-slate-100" aria-hidden />

      {/* Aurora blobs */}
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-80 h-72 rounded-full bg-sky-300/30 blur-3xl animate-pulse [animation-duration:6s]" aria-hidden />
      <div className="pointer-events-none absolute top-1/4 -right-20 w-64 h-72 rounded-full bg-indigo-300/25 blur-3xl animate-pulse [animation-duration:8s] [animation-delay:1s]" aria-hidden />
      <div className="pointer-events-none absolute top-2/3 -left-16 w-72 h-64 rounded-full bg-emerald-300/20 blur-3xl animate-pulse [animation-duration:10s] [animation-delay:2s]" aria-hidden />
      <div className="pointer-events-none absolute -bottom-20 right-0 w-72 h-64 rounded-full bg-violet-300/20 blur-3xl animate-pulse [animation-duration:9s] [animation-delay:3s]" aria-hidden />

      {/* Subtle noise to break up gradient banding */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
        }}
        aria-hidden
      />

      {/* Right-edge hairline */}
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-slate-300/60 to-transparent" aria-hidden />

      {/* ─── Content (relative-positioned over the backdrop) ───────── */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Logo */}
        <div className="px-4 pt-4 pb-3.5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/70 backdrop-blur-md ring-1 ring-white/80 flex items-center justify-center shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden">
              <BrandLogo size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold tracking-tight leading-none text-slate-800">
                PrepShip
              </div>
              <div className="text-[10px] text-slate-500 mt-1 tracking-wide leading-none truncate font-normal">
                Quietly handling fulfillment
              </div>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="relative">
            <SearchIcon size={13} strokeWidth={2} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" aria-hidden />
            <input
              type="text"
              placeholder="Search…"
              value={c.effectiveSearchValue}
              onChange={(e) => c.setSearch(e.target.value)}
              aria-label="Search orders"
              className="w-full h-9 pl-9 pr-7 rounded-lg bg-white/50 backdrop-blur-md text-[12.5px] text-slate-800 placeholder:text-slate-400 ring-1 ring-white/60 focus:bg-white/80 focus:ring-1 focus:ring-indigo-300/60 focus:outline-none transition-all duration-200"
            />
            {c.effectiveSearchValue ? (
              <button type="button" onClick={c.clearSearch} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-white/60 transition-colors">
                <XIcon size={12} strokeWidth={2.5} />
              </button>
            ) : null}
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
          <div className="px-2 pt-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400/90">
            Orders
          </div>

          {c.SIDEBAR_STATUSES.map((status) => {
            const StatusIcon = STATUS_ICON[status]
            const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
            const isExpanded = c.expandedSections.has(status)
            const total = c.counts ? c.sidebarSections[status].total : null
            return (
              <div key={status} className="mb-px">
                <div
                  onClick={() => c.handleSelectStatus(status)}
                  className={`flex items-center h-9 px-2.5 rounded-lg cursor-pointer text-[12.5px] select-none transition-all duration-200 ${isActive ? 'bg-white/65 backdrop-blur-md ring-1 ring-white/70 text-slate-900 font-medium shadow-[0_1px_2px_rgba(15,23,42,0.04)]' : 'text-slate-600 hover:bg-white/40 hover:text-slate-800'}`}
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2.5 flex-shrink-0 ${STATUS_DOT[status]} ${isActive ? 'opacity-100' : 'opacity-60'}`} aria-hidden />
                  <StatusIcon size={13} strokeWidth={1.75} className={`mr-2 flex-shrink-0 ${isActive ? 'text-slate-700' : 'text-slate-400'}`} />
                  <span className="flex-1 truncate">{STATUS_LABELS[status]}</span>
                  <span className={`text-[10.5px] font-mono tabular-nums mr-1 ${isActive ? 'text-slate-700 font-semibold' : 'text-slate-400'}`}>
                    {total != null ? total.toLocaleString() : '—'}
                  </span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }} aria-label={isExpanded ? 'Collapse' : 'Expand'} className={`w-5 h-5 flex items-center justify-center rounded transition-transform duration-300 ${isExpanded ? 'rotate-0' : '-rotate-90'} text-slate-400 hover:text-slate-700`}>
                    <ChevronDown size={11} strokeWidth={2} />
                  </button>
                </div>
                {isExpanded ? (
                  <div className="mt-px ml-3 pl-3 border-l border-white/70 space-y-px py-0.5">
                    {c.sidebarSections[status].stores.map((store) => {
                      const isTestStore = c.isTestOrdersStore(store)
                      const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                      const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                      return (
                        <div
                          key={`${status}-${store.storeId}`}
                          onClick={() => c.handleSelectStore(store.storeId, status)}
                          className={`flex items-center h-7 px-2.5 rounded-md cursor-pointer text-[11.5px] transition-all duration-150 ${storeActive ? 'bg-white/60 backdrop-blur ring-1 ring-white/70 text-slate-800 font-medium' : isMuted ? 'text-slate-400 hover:text-slate-600 hover:bg-white/30' : 'text-slate-500 hover:text-slate-800 hover:bg-white/40'}`}
                        >
                          <span className="flex-1 truncate">{store.name}</span>
                          {isTestStore ? (
                            <button type="button" onClick={c.toggleTestOrders} aria-pressed={c.showTestOrders} aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'} className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-200 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-400/80' : 'bg-slate-300/70'}`}>
                              <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                            </button>
                          ) : null}
                          <span className={`ml-1.5 text-[10px] font-mono tabular-nums ${storeActive ? 'text-slate-700 font-semibold' : 'text-slate-400'}`}>
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

          <div className="px-2 pt-4 pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400/90">
            Tools
          </div>

          <div className="space-y-px">
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
                  className={`flex items-center h-9 px-2.5 rounded-lg cursor-pointer text-[12.5px] select-none transition-all duration-200 ${active ? 'bg-white/65 backdrop-blur-md ring-1 ring-white/70 text-slate-900 font-medium shadow-[0_1px_2px_rgba(15,23,42,0.04)]' : 'text-slate-600 hover:bg-white/40 hover:text-slate-800'}`}
                >
                  <ToolIcon size={13} strokeWidth={1.75} className={`mr-2.5 flex-shrink-0 ${active ? 'text-slate-700' : 'text-slate-400'}`} />
                  <span className="flex-1 truncate">{tool.label}</span>
                </div>
              )
            })}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-3 pb-3 pt-2 flex-shrink-0">
          {c.session ? (
            <div className="rounded-xl bg-white/55 backdrop-blur-xl ring-1 ring-white/70 p-2.5 flex items-center gap-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="relative flex-shrink-0">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-600 to-slate-800 flex items-center justify-center text-white text-[12px] font-semibold ring-1 ring-white/30">{userInitial}</div>
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white" aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-slate-800 truncate" title={c.user?.email ?? ''}>{userLocal || 'Signed in'}</div>
                <div className="text-[10px] text-slate-500 truncate">Admin</div>
              </div>
              <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50/60 active:scale-90 disabled:opacity-50 transition-all duration-150">
                <LogOut size={13} strokeWidth={2} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}
