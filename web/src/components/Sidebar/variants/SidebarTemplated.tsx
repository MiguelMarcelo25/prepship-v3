// @ts-nocheck
// Spec-driven sidebar — one component, dozens of looks.
// Used for variants F→Y. The first 5 hand-crafted variants (A-E) keep their
// own files because they have radically different layouts.
//
// Each spec controls the *visual* knobs only — all behavior comes from
// useSidebarController (search, expand, sign-out, etc.).
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
  Box,
  Diamond,
  Sparkles,
  Zap,
  Triangle,
  Hexagon,
  Leaf,
  Flame,
  Square,
  Users,
} from 'lucide-react'
import { useSidebarController, type SidebarVariantProps, type SidebarViewType } from './useSidebarController'

type Mode = 'light' | 'dark'
type Density = 'compact' | 'cozy' | 'wide'
type Radius = 'sharp' | 'soft' | 'pill'
type ActiveStyle = 'bar' | 'pill' | 'underline' | 'glow' | 'fill' | 'border'
type Surface = 'solid' | 'gradient' | 'glass' | 'mesh'
type IconStyle = 'minimal' | 'tile' | 'circle' | 'square'
type Typography = 'clean' | 'display' | 'mono' | 'italic'
type LogoIconKey = 'box' | 'diamond' | 'sparkles' | 'zap' | 'triangle' | 'hexagon' | 'leaf' | 'flame' | 'square'

export interface SidebarSpec {
  id: string
  name: string
  tagline: string
  swatches: [string, string, string]
  mode: Mode
  density: Density
  radius: Radius
  activeStyle: ActiveStyle
  surface: Surface
  iconStyle: IconStyle
  typography: Typography
  /** Tailwind color name root, e.g. 'indigo', 'emerald', 'rose'... */
  accent: string
  /** Optional gradient via space-separated stops, e.g. 'from-indigo-500 via-violet-500 to-fuchsia-500' */
  brandGradient?: string
  logoIcon: LogoIconKey
  /** Optional decorative ambient glow */
  ambient?: 'none' | 'subtle' | 'aurora'
}

const STATUS_LABELS = { awaiting_shipment: 'Awaiting', shipped: 'Shipped', cancelled: 'Cancelled' } as const
const STATUS_ICON = { awaiting_shipment: Clock, shipped: CheckCircle2, cancelled: XOctagon }

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

const LOGO_ICONS: Record<LogoIconKey, any> = {
  box: Box,
  diamond: Diamond,
  sparkles: Sparkles,
  zap: Zap,
  triangle: Triangle,
  hexagon: Hexagon,
  leaf: Leaf,
  flame: Flame,
  square: Square,
}

// ─── Class composition helpers ─────────────────────────────────────
function rootSurfaceClasses(spec: SidebarSpec): string {
  if (spec.mode === 'dark') {
    if (spec.surface === 'gradient') {
      return `bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-slate-200 border-slate-800`
    }
    if (spec.surface === 'glass') {
      return `bg-slate-900/90 backdrop-blur-xl text-slate-200 border-slate-800`
    }
    if (spec.surface === 'mesh') {
      return `bg-slate-950 text-slate-200 border-slate-800` // mesh handled via ambient
    }
    return `bg-slate-900 text-slate-200 border-slate-800`
  }
  // light
  if (spec.surface === 'gradient') {
    return `bg-gradient-to-b from-slate-50 via-white to-slate-50 text-slate-700 border-slate-200`
  }
  if (spec.surface === 'glass') {
    return `bg-white/85 backdrop-blur-xl text-slate-700 border-slate-200`
  }
  if (spec.surface === 'mesh') {
    return `bg-slate-50 text-slate-700 border-slate-200` // mesh handled via ambient
  }
  return `bg-white text-slate-700 border-slate-200`
}

function rowHeight(d: Density): string {
  return d === 'compact' ? 'h-8' : d === 'wide' ? 'h-11' : 'h-10'
}
function rowPadding(d: Density): string {
  return d === 'compact' ? 'px-2' : d === 'wide' ? 'px-3.5' : 'px-2.5'
}
function radiusClass(r: Radius): string {
  return r === 'sharp' ? 'rounded-none' : r === 'pill' ? 'rounded-full' : 'rounded-lg'
}
function iconRadiusClass(r: Radius): string {
  return r === 'sharp' ? 'rounded-none' : r === 'pill' ? 'rounded-full' : 'rounded-md'
}
function fontFamilyClass(t: Typography): string {
  if (t === 'display') return 'font-display'
  if (t === 'mono') return 'font-mono'
  if (t === 'italic') return 'font-sans italic'
  return 'font-sans'
}
function activeBgClass(spec: SidebarSpec): string {
  const a = spec.accent
  if (spec.mode === 'dark') {
    switch (spec.activeStyle) {
      case 'fill':       return `bg-${a}-500 text-white`
      case 'pill':       return `bg-${a}-500/20 text-${a}-200 ring-1 ring-${a}-400/30`
      case 'glow':       return `bg-${a}-500/15 text-${a}-200 ring-1 ring-${a}-400/30 shadow-[0_0_20px_-4px] shadow-${a}-500/40`
      case 'border':     return `bg-transparent ring-1 ring-${a}-400/40 text-${a}-200`
      case 'underline':  return `bg-transparent text-${a}-200 border-b-2 border-${a}-400 rounded-b-none`
      case 'bar':
      default:           return `bg-${a}-500/15 text-${a}-200`
    }
  }
  switch (spec.activeStyle) {
    case 'fill':       return `bg-${a}-600 text-white`
    case 'pill':       return `bg-${a}-100 text-${a}-700 ring-1 ring-${a}-200`
    case 'glow':       return `bg-${a}-50 text-${a}-700 ring-1 ring-${a}-200 shadow-[0_0_16px_-4px] shadow-${a}-500/35`
    case 'border':     return `bg-transparent ring-1 ring-${a}-300 text-${a}-700`
    case 'underline':  return `bg-transparent text-${a}-700 border-b-2 border-${a}-500 rounded-b-none`
    case 'bar':
    default:           return `bg-${a}-50 text-${a}-700`
  }
}
function hoverBgClass(spec: SidebarSpec): string {
  return spec.mode === 'dark' ? 'hover:bg-slate-800/60' : 'hover:bg-slate-100/70'
}
function inactiveTextClass(spec: SidebarSpec): string {
  // Boss directive 2026-05-07: sidebar text must be near-black, no
  // gray gradations across active/inactive. We force the darkest
  // available color in each mode (slate-900 for light, slate-100 for
  // dark). The previous slate-700/300 + slate-400/500 split produced
  // a 3-tier gray hierarchy in the sidebar (active / inactive /
  // muted) which made low-count clients look "off". Now all text
  // reads as primary-dark.
  return spec.mode === 'dark' ? 'text-slate-100' : 'text-slate-900'
}
function mutedTextClass(spec: SidebarSpec): string {
  // Same directive — was slate-400/500 (true gray); now matches
  // inactiveTextClass to eliminate gray entirely. Used for store
  // counts, store labels at zero count, search icon, section
  // chevrons. All collapse to the same near-black for uniformity.
  return spec.mode === 'dark' ? 'text-slate-100' : 'text-slate-900'
}
function borderClass(spec: SidebarSpec): string {
  return spec.mode === 'dark' ? 'border-slate-800' : 'border-slate-200'
}
function softBorderClass(spec: SidebarSpec): string {
  return spec.mode === 'dark' ? 'border-slate-800/60' : 'border-slate-100'
}
function iconWrapClass(spec: SidebarSpec, isActive: boolean): string {
  if (spec.iconStyle === 'minimal') return 'mr-2.5 flex-shrink-0'
  const base = `w-7 h-7 flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors duration-150`
  const r = spec.iconStyle === 'circle' ? 'rounded-full' : spec.iconStyle === 'square' ? 'rounded-none' : iconRadiusClass(spec.radius)
  const a = spec.accent
  if (spec.mode === 'dark') {
    return `${base} ${r} ${isActive ? `bg-${a}-500/20 ring-1 ring-${a}-400/30` : 'bg-slate-800/60 ring-1 ring-slate-700/50'}`
  }
  return `${base} ${r} ${isActive ? `bg-${a}-100 ring-1 ring-${a}-200` : 'bg-slate-100 ring-1 ring-slate-200/60'}`
}
function iconColorClass(spec: SidebarSpec, isActive: boolean): string {
  // Boss directive 2026-05-07: no gray in sidebar. Inactive icons
  // were slate-400/500 (true gray) which made section icons fade
  // out next to inactive text. Now matches the slate-900/100 used
  // for inactive text — uniform near-black for all non-active
  // icons.
  const a = spec.accent
  if (spec.mode === 'dark') {
    return isActive ? `text-${a}-300` : 'text-slate-100'
  }
  return isActive ? `text-${a}-600` : 'text-slate-900'
}
function activeBarClass(spec: SidebarSpec): string {
  if (spec.activeStyle !== 'bar') return ''
  const a = spec.accent
  return spec.mode === 'dark' ? `absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-${a}-400` : `absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-${a}-600`
}
function sectionLabelClass(spec: SidebarSpec): string {
  const base = `px-2 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.14em]`
  return `${base} ${mutedTextClass(spec)}`
}
function logoTitleClass(spec: SidebarSpec): string {
  const family = fontFamilyClass(spec.typography)
  const color = spec.mode === 'dark' ? 'text-white' : 'text-slate-900'
  return `${family} text-[15px] font-extrabold tracking-tight leading-none ${color}`
}

// Render an ambient backdrop layer based on spec.ambient
function AmbientBackdrop({ spec }: { spec: SidebarSpec }) {
  if (!spec.ambient || spec.ambient === 'none') return null
  if (spec.ambient === 'aurora') {
    return (
      <>
        <div className={`pointer-events-none absolute -top-24 -right-12 w-72 h-72 rounded-full blur-3xl ${spec.mode === 'dark' ? `bg-${spec.accent}-500/15` : `bg-${spec.accent}-300/30`}`} aria-hidden />
        <div className={`pointer-events-none absolute -bottom-20 -left-8 w-64 h-64 rounded-full blur-3xl ${spec.mode === 'dark' ? `bg-${spec.accent}-500/10` : `bg-${spec.accent}-200/40`}`} aria-hidden />
      </>
    )
  }
  return (
    <div className={`pointer-events-none absolute -top-24 -right-10 w-64 h-64 rounded-full blur-3xl ${spec.mode === 'dark' ? `bg-${spec.accent}-500/10` : `bg-${spec.accent}-300/15`}`} aria-hidden />
  )
}

interface Props extends SidebarVariantProps {
  spec: SidebarSpec
}

export default function SidebarTemplated({ spec, ...props }: Props) {
  const c = useSidebarController(props)
  const userInitial = (c.user?.email ?? '?').charAt(0).toUpperCase()
  const userLocal = (c.user?.email ?? '').split('@')[0] ?? ''
  const LogoIcon = LOGO_ICONS[spec.logoIcon] ?? Box
  const a = spec.accent

  const rootSurface = rootSurfaceClasses(spec)
  const r = radiusClass(spec.radius)
  const rIcon = iconRadiusClass(spec.radius)
  const fam = fontFamilyClass(spec.typography)
  const rh = rowHeight(spec.density)
  const rp = rowPadding(spec.density)
  const hover = hoverBgClass(spec)
  const inactiveText = inactiveTextClass(spec)
  const muted = mutedTextClass(spec)
  const border = borderClass(spec)
  const softBorder = softBorderClass(spec)
  const sectionLabel = sectionLabelClass(spec)
  const logoTitle = logoTitleClass(spec)

  return (
    <aside
      className={`flex flex-col overflow-hidden flex-shrink-0 w-[252px] h-full antialiased fixed md:relative inset-y-0 left-0 z-40 transition-transform duration-200 ease-out ${c.mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'} border-r ${rootSurface} ${fam}`}
      aria-label="Primary navigation"
    >
      <AmbientBackdrop spec={spec} />

      {/* Logo — clickable, navigates to /orders/awaiting_shipment.
          Same handler as a status-row click on "Awaiting Shipment", so
          the URL updates and the orders view re-loads. Visual cues that
          it's clickable: hover-scale on the logo tile + subtle bg tint
          on the wrapper. Uses <button> for keyboard + screen-reader
          accessibility (Tab navigates here, Enter activates). */}
      <button
        type="button"
        onClick={() => c.handleSelectStatus('awaiting_shipment')}
        aria-label="Go to Awaiting Shipment"
        title="Go to Awaiting Shipment"
        className={`group relative w-full text-left px-4 pt-4 pb-3.5 border-b ${softBorder} transition-colors duration-150 ${spec.mode === 'dark' ? 'hover:bg-slate-800/40' : 'hover:bg-slate-100/60'} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${spec.mode === 'dark' ? `focus-visible:ring-${a}-400/40` : `focus-visible:ring-${a}-500/40`}`}
      >
        <div className="flex items-center gap-2.5">
          <div className={`relative w-10 h-10 ${rIcon} flex items-center justify-center flex-shrink-0 overflow-hidden transition-transform duration-150 group-hover:scale-105 group-active:scale-95 ${spec.brandGradient ? `bg-gradient-to-br ${spec.brandGradient}` : `bg-${a}-${spec.mode === 'dark' ? '500/20' : '100'}`} ${spec.mode === 'dark' ? `ring-1 ring-${a}-400/30` : `ring-1 ring-${a}-200`}`}>
            <BrandLogo size={50} />
          </div>
          <div className="flex-1 min-w-0">
            <div className={logoTitle}>PrepShip</div>
            <div className={`text-[10px] mt-1 tracking-wide leading-none truncate font-medium ${muted}`}>
              DR PREPPER · Fulfillment
            </div>
          </div>
        </div>
      </button>

      {/* Search */}
      <div className="relative px-3 pt-2.5 pb-2">
        <div className="relative">
          <SearchIcon size={13} strokeWidth={2} className={`absolute left-3 top-1/2 -translate-y-1/2 ${muted} pointer-events-none`} aria-hidden />
          <input
            type="text"
            placeholder="Search…"
            value={c.effectiveSearchValue}
            onChange={(e) => c.setSearch(e.target.value)}
            aria-label="Search orders"
            className={`w-full h-9 pl-9 pr-7 ${rIcon} text-[12.5px] outline-none transition-all duration-150 ${spec.mode === 'dark' ? `bg-slate-800/60 text-slate-100 placeholder:text-slate-500 ring-1 ring-slate-700/50 focus:bg-slate-800 focus:ring-2 focus:ring-${a}-500/50` : `bg-slate-100 text-slate-800 placeholder:text-slate-400 ring-1 ring-transparent focus:bg-white focus:ring-2 focus:ring-${a}-500/30`}`}
          />
          {c.effectiveSearchValue ? (
            <button type="button" onClick={c.clearSearch} aria-label="Clear search" className={`absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 ${rIcon} flex items-center justify-center ${muted} ${spec.mode === 'dark' ? 'hover:text-slate-100 hover:bg-slate-700' : 'hover:text-slate-700 hover:bg-slate-200'} transition-colors`}>
              <XIcon size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Nav */}
      <nav className="relative flex-1 overflow-y-auto px-2 pb-3">
        <div className={sectionLabel}>Orders</div>

        {c.SIDEBAR_STATUSES.map((status) => {
          const StatusIcon = STATUS_ICON[status]
          const isActive = c.currentView === 'orders' && c.currentStatus === status && c.activeStore == null
          const isExpanded = c.expandedSections.has(status)
          const total = c.counts ? c.sidebarSections[status].total : null
          const activeCls = isActive ? activeBgClass(spec) : `${inactiveText} ${hover}`
          return (
            <div key={status} className="mb-0.5">
              <div
                onClick={() => c.handleSelectStatus(status)}
                className={`group relative flex items-center ${rh} ${rp} ${r} cursor-pointer text-[12.5px] font-semibold select-none transition-all duration-150 ${activeCls}`}
              >
                {isActive && spec.activeStyle === 'bar' ? <span className={activeBarClass(spec)} aria-hidden /> : null}
                <div className={iconWrapClass(spec, isActive)}>
                  <StatusIcon size={13} strokeWidth={2.25} className={iconColorClass(spec, isActive)} />
                </div>
                <span className="flex-1 truncate">{STATUS_LABELS[status]}</span>
                <span className={`text-[10.5px] font-mono tabular-nums font-bold mr-1 ${isActive ? '' : muted}`}>
                  {total != null ? total.toLocaleString() : '—'}
                </span>
                <button type="button" onClick={(e) => { e.stopPropagation(); c.toggleSection(status) }} aria-label={isExpanded ? 'Collapse' : 'Expand'} className={`w-5 h-5 flex items-center justify-center ${rIcon} transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'} ${isActive ? '' : muted}`}>
                  <ChevronDown size={11} strokeWidth={2.25} />
                </button>
              </div>
              {isExpanded ? (
                <div className={`mt-0.5 ml-3.5 pl-3 border-l ${border} space-y-px py-0.5`}>
                  {c.sidebarSections[status].stores.map((store) => {
                    const isTestStore = c.isTestOrdersStore(store)
                    const storeActive = c.currentView === 'orders' && c.activeStore === store.storeId && c.currentStatus === status
                    const isMuted = (isTestStore && !c.showTestOrders) || (store.cnt === 0 && !storeActive)
                    return (
                      <div
                        key={`${status}-${store.storeId}`}
                        onClick={() => c.handleSelectStore(store.storeId, status)}
                        className={`flex items-center h-7 px-2.5 ${rIcon} cursor-pointer text-[11.5px] transition-colors duration-100 ${storeActive ? activeBgClass(spec) + ' font-semibold' : isMuted ? `${muted} ${hover}` : `${inactiveText} ${hover}`}`}
                      >
                        <span className="flex-1 truncate">{store.name}</span>
                        {isTestStore ? (
                          <button type="button" onClick={c.toggleTestOrders} aria-pressed={c.showTestOrders} aria-label={c.showTestOrders ? 'Hide Test Orders' : 'Show Test Orders'} className={`relative inline-flex items-center w-7 h-3.5 rounded-full transition-colors duration-150 ml-1.5 mr-1 ${c.showTestOrders ? 'bg-emerald-500' : spec.mode === 'dark' ? 'bg-slate-700' : 'bg-slate-300'}`}>
                            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform duration-150 ${c.showTestOrders ? 'translate-x-[14px]' : 'translate-x-0.5'}`} aria-hidden />
                          </button>
                        ) : null}
                        <span className={`ml-1.5 text-[10px] font-mono tabular-nums font-bold ${storeActive ? '' : muted}`}>
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

        <div className={sectionLabel}>Tools</div>

        <div className="space-y-0.5">
          {TOOL_ITEMS.map((tool) => {
            const active = c.currentView === tool.view
            const ToolIcon = tool.Icon
            const activeCls = active ? activeBgClass(spec) : `${inactiveText} ${hover}`
            return (
              <div
                key={tool.view}
                role="button"
                tabIndex={0}
                aria-current={active ? 'page' : undefined}
                onClick={() => c.handleShowView(tool.view)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.handleShowView(tool.view) } }}
                className={`group relative flex items-center ${rh} ${rp} ${r} cursor-pointer text-[12.5px] font-semibold select-none transition-all duration-150 ${activeCls}`}
              >
                {active && spec.activeStyle === 'bar' ? <span className={activeBarClass(spec)} aria-hidden /> : null}
                <div className={iconWrapClass(spec, active)}>
                  <ToolIcon size={13} strokeWidth={2.25} className={iconColorClass(spec, active)} />
                </div>
                <span className="flex-1 truncate">{tool.label}</span>
              </div>
            )
          })}
        </div>
      </nav>

      {/* Footer */}
      <div className={`relative border-t ${softBorder} px-3 pt-3 pb-3.5 flex-shrink-0 ${spec.mode === 'dark' ? 'bg-slate-950/40 backdrop-blur' : ''}`}>
        {c.session ? (
          <div className="flex items-center gap-2.5">
            <div className="relative flex-shrink-0">
              <div className={`w-9 h-9 ${rIcon === 'rounded-none' ? '' : 'rounded-full'} ${spec.brandGradient ? `bg-gradient-to-br ${spec.brandGradient}` : `bg-${a}-${spec.mode === 'dark' ? '500' : '600'}`} flex items-center justify-center text-white text-[12px] font-bold ring-1 ${spec.mode === 'dark' ? 'ring-white/10' : 'ring-white/40'}`}>{userInitial}</div>
              <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ${spec.mode === 'dark' ? 'ring-slate-950' : 'ring-white'}`} aria-hidden />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[12px] font-semibold truncate leading-tight ${spec.mode === 'dark' ? 'text-slate-100' : 'text-slate-900'}`} title={c.user?.email ?? ''}>{userLocal || 'Signed in'}</div>
              <div className={`text-[9.5px] truncate leading-tight mt-0.5 font-medium ${muted}`}>Admin · Gardena, CA</div>
            </div>
            <button type="button" onClick={c.handleSignOut} disabled={c.signingOut} aria-label="Sign out" className={`w-8 h-8 ${rIcon} flex items-center justify-center ${muted} hover:text-rose-400 hover:bg-rose-500/10 active:scale-90 disabled:opacity-50 transition-all duration-150`}>
              <LogOut size={13} strokeWidth={2} />
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
