// @ts-nocheck
// Combined Sidebar Variant + Theme picker. One floating widget with two tabs.
// Mounts at the app root via main.tsx. Persists both selections via:
//   - useSidebarVariant (writes localStorage + dispatches a custom event)
//   - ThemeProvider     (writes CSS vars on :root + localStorage)
import { useEffect, useRef, useState } from 'react'
import { Check, Palette, LayoutPanelLeft, X as XIcon } from 'lucide-react'
import { useTheme } from '../lib/ThemeProvider'
import { SIDEBAR_VARIANTS, useSidebarVariant, type SidebarVariantKey } from '../lib/useSidebarVariant'

type Tab = 'sidebar' | 'theme'

export default function DesignPicker() {
  const { theme, themes, setThemeId } = useTheme()
  const { variant, setVariant } = useSidebarVariant()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('theme')
  const popRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const variantKeys = Object.keys(SIDEBAR_VARIANTS) as SidebarVariantKey[]
  const activeVariant = SIDEBAR_VARIANTS[variant]

  return (
    <div className="fixed bottom-4 right-4 z-[2000] font-sans select-none">
      {/* Pop-up panel */}
      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label="Choose a design"
          className="
            mb-2 w-[340px] rounded-2xl bg-white text-slate-900
            shadow-[0_20px_60px_-12px_rgba(15,23,42,0.35),0_0_0_1px_rgba(15,23,42,0.06)]
            ring-1 ring-slate-900/5
            overflow-hidden animate-fadeInUp
          "
          style={{ animationDuration: '180ms' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                Design Studio
              </div>
              <div className="text-[14px] font-extrabold tracking-tight text-slate-900">
                Pick your look
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <XIcon size={14} strokeWidth={2.5} />
            </button>
          </div>

          {/* Tabs */}
          <div className="px-3 pb-2">
            <div role="tablist" aria-label="Design picker tabs" className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'theme'}
                onClick={() => setTab('theme')}
                className={`flex items-center justify-center gap-1.5 h-7 rounded-md text-[11.5px] font-semibold tracking-tight transition-all duration-150 ${tab === 'theme' ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <Palette size={12} strokeWidth={2.25} />
                Theme
                <span className="text-[9px] font-mono tabular-nums opacity-60">{themes.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'sidebar'}
                onClick={() => setTab('sidebar')}
                className={`flex items-center justify-center gap-1.5 h-7 rounded-md text-[11.5px] font-semibold tracking-tight transition-all duration-150 ${tab === 'sidebar' ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-900/5' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <LayoutPanelLeft size={12} strokeWidth={2.25} />
                Sidebar
                <span className="text-[9px] font-mono tabular-nums opacity-60">{variantKeys.length}</span>
              </button>
            </div>
          </div>

          {/* Tab content */}
          {tab === 'theme' ? (
            <div>
              <div className="px-4 pt-1 pb-2">
                <div className="text-[10px] uppercase tracking-[0.12em] text-slate-400 font-semibold">
                  Active theme
                </div>
                <div className="text-[13px] font-bold tracking-tight text-slate-900 leading-tight">
                  {theme.name}
                </div>
                <div className="text-[10px] text-slate-500 leading-tight mt-0.5">{theme.tagline}</div>
              </div>
              <div className="px-3 pb-3 grid grid-cols-2 gap-2 max-h-[320px] overflow-y-auto">
                {themes.map((t) => {
                  const isActive = t.id === theme.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setThemeId(t.id)}
                      aria-pressed={isActive}
                      title={`${t.name} — ${t.tagline}`}
                      className={`
                        group relative flex items-center gap-2.5 p-2 rounded-xl text-left
                        transition-all duration-150
                        ${isActive
                          ? 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900/20'
                          : 'bg-slate-50 hover:bg-slate-100 text-slate-700 ring-1 ring-slate-200/60'}
                      `}
                    >
                      <div
                        className={`flex-shrink-0 w-12 h-9 rounded-md overflow-hidden flex ring-1 ${isActive ? 'ring-white/20' : 'ring-slate-300/60'}`}
                        aria-hidden
                      >
                        <span className="flex-1" style={{ background: t.swatches[0] }} />
                        <span className="flex-1" style={{ background: t.swatches[1] }} />
                        <span className="flex-1" style={{ background: t.swatches[2] }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[12px] font-semibold leading-tight tracking-tight truncate ${isActive ? 'text-white' : 'text-slate-900'}`}>
                          {t.name}
                        </div>
                        <div className={`text-[9.5px] leading-tight mt-0.5 truncate ${isActive ? 'text-slate-300' : 'text-slate-500'}`}>
                          {t.mode === 'dark' ? 'Dark' : 'Light'}
                        </div>
                      </div>
                      {isActive ? (
                        <Check size={14} strokeWidth={3} className="text-emerald-300 flex-shrink-0" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div>
              <div className="px-4 pt-1 pb-2">
                <div className="text-[10px] uppercase tracking-[0.12em] text-slate-400 font-semibold">
                  Active sidebar
                </div>
                <div className="text-[13px] font-bold tracking-tight text-slate-900 leading-tight">
                  {activeVariant.name}
                </div>
                <div className="text-[10px] text-slate-500 leading-tight mt-0.5">{activeVariant.tagline}</div>
              </div>
              <div className="px-3 pb-3 space-y-1.5 max-h-[320px] overflow-y-auto">
                {variantKeys.map((key) => {
                  const v = SIDEBAR_VARIANTS[key]
                  const isActive = key === variant
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setVariant(key)}
                      aria-pressed={isActive}
                      title={`Sidebar ${key} — ${v.name}`}
                      className={`
                        group relative flex items-center gap-3 w-full p-2.5 rounded-xl text-left
                        transition-all duration-150
                        ${isActive
                          ? 'bg-slate-900 text-white shadow-md ring-1 ring-slate-900/20'
                          : 'bg-slate-50 hover:bg-slate-100 text-slate-700 ring-1 ring-slate-200/60'}
                      `}
                    >
                      {/* Letter chip */}
                      <div
                        className={`
                          w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0
                          font-mono text-[14px] font-bold
                          ${isActive
                            ? 'bg-white/15 text-white ring-1 ring-white/25'
                            : 'bg-white text-slate-900 ring-1 ring-slate-300/60'}
                        `}
                        aria-hidden
                      >
                        {key}
                      </div>
                      {/* Swatch preview */}
                      <div
                        className={`flex-shrink-0 w-12 h-8 rounded-md overflow-hidden flex ring-1 ${isActive ? 'ring-white/20' : 'ring-slate-300/60'}`}
                        aria-hidden
                      >
                        <span className="flex-1" style={{ background: v.swatches[0] }} />
                        <span className="flex-1" style={{ background: v.swatches[1] }} />
                        <span className="flex-1" style={{ background: v.swatches[2] }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[12px] font-semibold leading-tight tracking-tight truncate ${isActive ? 'text-white' : 'text-slate-900'}`}>
                          {v.name}
                        </div>
                        <div className={`text-[9.5px] leading-tight mt-0.5 truncate ${isActive ? 'text-slate-300' : 'text-slate-500'}`}>
                          {v.tagline}
                        </div>
                      </div>
                      {isActive ? (
                        <Check size={14} strokeWidth={3} className="text-emerald-300 flex-shrink-0" />
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 text-[10px] text-slate-500 flex items-center justify-between">
            <span>Choices persist across sessions.</span>
            <span className="font-mono tabular-nums text-[9.5px] text-slate-400">{theme.id} · {variant}</span>
          </div>
        </div>
      ) : null}

      {/* Trigger pill — shows both current selections */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open design picker"
        aria-expanded={open}
        className="
          inline-flex items-center gap-2 pl-2.5 pr-3.5 py-2
          rounded-full bg-white text-slate-900
          shadow-[0_12px_32px_-8px_rgba(15,23,42,0.2),0_0_0_1px_rgba(15,23,42,0.06)]
          ring-1 ring-slate-900/5
          hover:shadow-[0_16px_40px_-8px_rgba(15,23,42,0.25),0_0_0_1px_rgba(15,23,42,0.08)]
          active:scale-95 transition-all duration-150
        "
      >
        {/* Theme swatch */}
        <span
          className="inline-flex w-6 h-6 rounded-md overflow-hidden ring-1 ring-slate-300/60"
          aria-hidden
        >
          <span className="flex-1" style={{ background: theme.swatches[0] }} />
          <span className="flex-1" style={{ background: theme.swatches[1] }} />
          <span className="flex-1" style={{ background: theme.swatches[2] }} />
        </span>
        {/* Variant letter chip */}
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-slate-900 text-white font-mono text-[10.5px] font-bold leading-none"
          aria-hidden
        >
          {variant}
        </span>
        <span className="text-[12px] font-semibold tracking-tight">Design</span>
      </button>
    </div>
  )
}
