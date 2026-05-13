// @ts-nocheck
// Variant B — Bold Dark Premium
// Slate-950 gradient canvas, indigo/violet glow blobs, color-tinted icon tiles
// per status (amber/emerald/rose), gradient ring brand mark, premium feel.
import { BrandLogo } from '../../BrandLogo'
import {
  Search as SearchIcon,
  X as XIcon,
  Boxes,
  Building2,
  PackageOpen,
  Wallet,
  LineChart,
  Cog,
  CreditCard,
  FileText,
  ChevronDown,
  LogOut,
  Sparkles,
  Clock,
  Truck,
  Ban,
  Zap,
  Users,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

const STATUS_LABELS = { awaiting_shipment: 'Awaiting', shipped: 'Shipped', cancelled: 'Cancelled' } as const

const STATUS_THEME = {
  awaiting_shipment: { Icon: Clock, accentBg: 'bg-amber-400/10', accentRing: 'ring-amber-400/25', accentText: 'text-amber-100', iconBgActive: 'bg-amber-400/20', iconColorActive: 'text-amber-300', glow: 'shadow-[0_0_24px_-6px_rgba(251,191,36,0.35)]' },
  shipped:           { Icon: Truck, accentBg: 'bg-emerald-400/10', accentRing: 'ring-emerald-400/25', accentText: 'text-emerald-100', iconBgActive: 'bg-emerald-400/20', iconColorActive: 'text-emerald-300', glow: 'shadow-[0_0_24px_-6px_rgba(52,211,153,0.35)]' },
  cancelled:         { Icon: Ban,   accentBg: 'bg-rose-400/10',    accentRing: 'ring-rose-400/25',    accentText: 'text-rose-100',    iconBgActive: 'bg-rose-400/20',    iconColorActive: 'text-rose-300',    glow: 'shadow-[0_0_24px_-6px_rgba(251,113,133,0.3)]' },
}

const TOOL_ITEMS: Array<{ view: SidebarViewType; Icon: any; label: string; hint: string }> = [
  { view: 'dashboard', Icon: Sparkles,    label: 'Dashboard',  hint: 'Live overview' },
  { view: 'inventory', Icon: Boxes,        label: 'Inventory',  hint: 'Stock & SKUs' },
  { view: 'clients',   Icon: Users,         label: 'Clients',    hint: 'Brands & stores' },
  // 2026-05-13: Locations moved into Settings → Ship-From Locations tab.
  { view: 'packages',  Icon: PackageOpen,  label: 'Packages',   hint: 'Box library' },
  { view: 'rates',     Icon: Wallet,       label: 'Rate Shop',  hint: 'Compare carriers' },
  { view: 'analysis',  Icon: LineChart,    label: 'Analysis',   hint: 'SKU performance' },
  { view: 'settings',  Icon: Cog,          label: 'Settings',   hint: 'Markups & config' },
  { view: 'billing',   Icon: CreditCard,   label: 'Billing',    hint: 'Invoices' },
  { view: 'manifests', Icon: FileText,     label: 'Manifests',  hint: 'EOD handoff' },
]

export default function SidebarB(props: SidebarVariantProps) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()
  const userLocal = (c.user?.email ?? '').split('@')[0] ?? ''

  return (
    <aside
      className={`flex flex-col overflow-hidden flex-shrink-0 w-[252px] h-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-300 font-sans antialiased fixed md:relative inset-y-0 left-0 z-40 transition-transform duration-200 ease-out ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
      aria-label="Primary navigation"
    >
      <div className="pointer-events-none absolute -top-32 -right-20 w-72 h-72 rounded-full bg-indigo-500/10 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-40 -left-16 w-72 h-72 rounded-full bg-violet-500/8 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-slate-700/60 to-transparent" aria-hidden />

      <div className="relative px-4 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <div className="relative w-10 h-10 flex items-center justify-center">
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 opacity-90" aria-hidden />
            <div className="absolute inset-[2px] rounded-[10px] bg-slate-950" aria-hidden />
            <BrandLogo size={26} className="relative" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] font-extrabold tracking-[-0.025em] leading-none text-white">
              Prep<span className="text-indigo-400">Ship</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] tracking-[0.12em] uppercase font-semibold text-slate-500">
              <span className="inline-block w-1 h-1 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" aria-hidden />
              <span>Live · DR Prepper</span>
            </div>
          </div>
        </div>
      </div>

      <div className="relative px-3 pb-3">
        <div className="relative group">
          <SearchIcon size={13} strokeWidth={2.25} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none transition-colors group-focus-within:text-indigo-300" aria-hidden />
          <input
            type="text"
            placeholder="Search orders, SKUs…"
            value={c.effectiveSearchValue}
            onChange={(e) => c.setSearch(e.target.value)}
            aria-label="Search orders"
            className="w-full h-9 pl-9 pr-8 rounded-lg bg-slate-800/60 backdrop-blur text-[12.5px] text-slate-100 placeholder:text-slate-500 ring-1 ring-slate-700/60 focus:bg-slate-800 focus:ring-2 focus:ring-indigo-500/60 focus:outline-none transition-all duration-150"
          />
          {c.effectiveSearchValue ? (
            <button type="button" onClick={c.clearSearch} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-slate-700 active:scale-90 transition-all duration-150">
              <XIcon size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      <nav className="relative flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2.5 pt-2 pb-2 flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Orders</span>
          <span className="flex-1 h-px bg-gradient-to-r from-slate-700/50 to-transparent" aria-hidden />
        </div>

        {c.SIDEBAR_STATUSES.map((status) => {
          const t = STATUS_THEME[status]
          const StatusIcon = t.Icon
          const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
          const isExpanded = c.expandedSections.has(status)
          const total = c.counts ? c.sidebarSections[status].total : null
          return (
            <div key={status} className="mb-0.5">
              <div
                className={`group relative flex items-center h-10 pl-3 pr-2.5 rounded-xl cursor-pointer text-[12.5px] font-semibold select-none transition-all duration-150 ${isActive ? `${t.accentBg} ring-1 ${t.accentRing} ${t.glow}` : 'hover:bg-slate-800/50'}`}
                onClick={() => c.handleSelectStatus(status)}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors duration-150 ${isActive ? `${t.iconBgActive} ring-1 ${t.accentRing}` : 'bg-slate-700/40 ring-1 ring-slate-700/40 group-hover:bg-slate-700/60'}`}>
                  <StatusIcon size={14} strokeWidth={2.25} className={isActive ? t.iconColorActive : 'text-slate-400'} />
                </div>
                <span className={`flex-1 truncate ${isActive ? t.accentText : 'text-slate-200 group-hover:text-white'}`}>{STATUS_LABELS[status]}</span>
                <span className={`text-[10.5px] font-mono tabular-nums font-bold mr-1.5 ${isActive ? t.accentText : 'text-slate-400'}`}>
                  {total != null ? total.toLocaleString() : '—'}
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }}
                  aria-label={isExpanded ? `Collapse ${STATUS_LABELS[status]}` : `Expand ${STATUS_LABELS[status]}`}
                  className={`w-5 h-5 flex items-center justify-center rounded transition-all duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'} ${isActive ? t.accentText : 'text-slate-500 hover:text-slate-200'}`}
                >
                  <ChevronDown size={12} strokeWidth={2.5} />
                </button>
              </div>
              {isExpanded ? (
                <div className="mt-0.5 ml-4 pl-3 border-l border-slate-700/40 space-y-px py-0.5">
                  {c.sidebarSections[status].stores.map((store) => {
                    const isTestStore = c.isTestOrdersStore(store)
                    const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                    const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                    return (
                      <div
                        key={`${status}-${store.storeId}`}
                        onClick={() => c.handleSelectStore(store.storeId, status)}
                        className={`group relative flex items-center h-7 pl-2.5 pr-2 rounded-lg cursor-pointer text-[11.5px] transition-all duration-150 ${storeActive ? `${t.accentBg} ring-1 ${t.accentRing} ${t.accentText} font-semibold` : isMuted ? 'text-slate-600 hover:text-slate-400 hover:bg-slate-800/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
                      >
                        <span className="flex-1 truncate">{store.name}</span>
                        {isTestStore ? (
                          <button type="button" onClick={c.toggleTestOrders} aria-pressed={c.showTestOrders} aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'} className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-all duration-200 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-500/80 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-700'}`}>
                            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-md transition-transform duration-200 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                          </button>
                        ) : null}
                        <span className={`ml-1.5 text-[10px] font-mono tabular-nums font-bold ${storeActive ? t.accentText : 'text-slate-500'}`}>
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

        <div className="px-2.5 pt-5 pb-2 flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Tools</span>
          <span className="flex-1 h-px bg-gradient-to-r from-slate-700/50 to-transparent" aria-hidden />
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
                className={`group relative flex items-center h-10 px-2.5 rounded-xl cursor-pointer text-[12.5px] font-medium select-none transition-all duration-150 ${active ? 'bg-indigo-500/15 ring-1 ring-indigo-400/30 shadow-[0_0_24px_-6px_rgba(99,102,241,0.45)]' : 'hover:bg-slate-800/50'}`}
              >
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors duration-150 ${active ? 'bg-indigo-400/20 ring-1 ring-indigo-400/30' : 'bg-slate-700/40 ring-1 ring-slate-700/40 group-hover:bg-slate-700/60'}`}>
                  <ToolIcon size={14} strokeWidth={2.25} className={active ? 'text-indigo-300' : 'text-slate-400 group-hover:text-slate-200'} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`truncate font-semibold ${active ? 'text-indigo-100' : 'text-slate-200 group-hover:text-white'}`}>{tool.label}</div>
                  <div className="text-[9.5px] text-slate-500 truncate leading-tight">{tool.hint}</div>
                </div>
                {active ? <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.9)]" aria-hidden /> : null}
              </div>
            )
          })}
        </div>
      </nav>

      <div className="relative border-t border-slate-800/80 px-3 pt-3 pb-3.5 flex-shrink-0 bg-slate-950/40 backdrop-blur">
        {c.session ? (
          <div className="flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-indigo-400 via-violet-400 to-fuchsia-400 blur-[1px] opacity-80" aria-hidden />
              <div className="relative w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white text-[12px] font-bold ring-1 ring-white/20">{userInitial}</div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-slate-950 shadow-[0_0_8px_rgba(16,185,129,0.9)]" aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-slate-100 truncate leading-tight" title={c.user?.email ?? ''}>{userLocal || 'Signed in'}</div>
              <div className="text-[9.5px] text-slate-500 truncate leading-tight mt-0.5">Admin · Gardena, CA</div>
            </div>
            <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 hover:ring-1 hover:ring-rose-500/30 active:scale-90 disabled:opacity-50 transition-all duration-150">
              <LogOut size={14} strokeWidth={2.25} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
