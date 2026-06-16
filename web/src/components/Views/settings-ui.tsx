// PS-155: presentational helpers extracted verbatim from SettingsView.tsx (behavior-preserving).
// Self-contained, prop-driven UI primitives + the section accent tokens. SettingsView imports them
// back. Fully typed (unlike the parent) — pure presentation, no view state.
import { motion } from 'framer-motion'
import { CheckCircle2, Loader2, Lock, XCircle } from 'lucide-react'
import { type ReactNode } from 'react'

// ─── Section card ────────────────────────────────────────────────
// Reusable section wrapper. The accent strip is a 4px gradient bar
// on the left edge — gives each section type a glanceable color
// signature without being decorative-for-its-own-sake. Used by every
// top-level card on this page.
export type AccentTone = 'brand' | 'emerald' | 'amber' | 'rose' | 'violet'

export const ACCENT_GRADIENT: Record<AccentTone, string> = {
  brand: 'from-brand to-indigo-600',
  emerald: 'from-emerald-500 to-emerald-600',
  amber: 'from-amber-500 to-amber-600',
  rose: 'from-rose-500 to-rose-600',
  violet: 'from-violet-500 to-violet-600',
}

export const ACCENT_ICON_BG: Record<AccentTone, string> = {
  brand: 'from-brand/15 to-brand/5 ring-brand/30',
  emerald: 'from-emerald-500/15 to-emerald-500/5 ring-emerald-500/30',
  amber: 'from-amber-500/15 to-amber-500/5 ring-amber-500/30',
  rose: 'from-rose-500/15 to-rose-500/5 ring-rose-500/30',
  violet: 'from-violet-500/15 to-violet-500/5 ring-violet-500/30',
}

export const ACCENT_ICON_COLOR: Record<AccentTone, string> = {
  brand: 'text-brand',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
  violet: 'text-violet-600',
}

export function SectionCard({
  tone,
  icon,
  title,
  subtitle,
  actions,
  children,
  delay = 0,
}: {
  tone: AccentTone
  icon: ReactNode
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  delay?: number
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -1 }}
      className="relative overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm hover:shadow-md transition-shadow duration-200 mb-4 group"
    >
      {/* Left-edge accent strip — animated growth on mount + subtle
          pulse when section first appears. Gives the page a feeling
          of "controls coming online" rather than "static form". */}
      <motion.div
        aria-hidden
        initial={{ scaleY: 0, transformOrigin: 'top' }}
        animate={{ scaleY: 1 }}
        transition={{ duration: 0.5, delay: delay + 0.1, ease: [0.22, 1, 0.36, 1] }}
        className={`absolute left-0 top-0 bottom-0 w-[3px] bg-gradient-to-b ${ACCENT_GRADIENT[tone]}`}
      />
      <header className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20, delay: delay + 0.15 }}
          className={`w-9 h-9 rounded-lg bg-gradient-to-br ${ACCENT_ICON_BG[tone]} ring-1 flex items-center justify-center flex-shrink-0`}
        >
          <span className={ACCENT_ICON_COLOR[tone]}>{icon}</span>
        </motion.div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-extrabold text-ink tracking-tight font-display m-0">
            {title}
          </h3>
          {subtitle ? (
            <p className="text-tiny text-ink-3 mt-0.5 leading-snug">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2 flex-shrink-0">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </motion.section>
  )
}

// ─── Loading primitives ──────────────────────────────────────────
// Single shimmer rule shared across all skeleton variants; defined
// once below so the visual stays consistent. Avoids the previous
// "disabled+0.5 opacity" pattern as the only loading signal —
// skeletons read as "loading" much more clearly than greyed buttons.
export function SkeletonRow({ width = 'full' }: { width?: 'full' | 'sm' | 'md' }) {
  const w = width === 'full' ? 'w-full' : width === 'md' ? 'w-2/3' : 'w-1/3'
  return (
    <div className={`h-7 rounded-md bg-gradient-to-r from-surface-2 via-line/60 to-surface-2 bg-[length:200%_100%] animate-shimmer ${w}`} />
  )
}

export function SkeletonStack({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} width={i % 3 === 0 ? 'full' : i % 3 === 1 ? 'md' : 'sm'} />
      ))}
    </div>
  )
}

export function ButtonSpinner() {
  return <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />
}

// Reusable on/off switch for the Automation panel, modeled on the inventory
// active-view toggle idiom (InventoryView.tsx). Variants: enabled (emerald),
// disabled (slate), locked/protected (brand + lock, non-interactive), and a
// "mixed" amber state for the per-store master toggle when only some carriers
// are enabled.
type AutomationSwitchProps = {
  checked: boolean
  onChange?: (next: boolean) => void
  disabled?: boolean
  saving?: boolean
  locked?: boolean
  indeterminate?: boolean
  label?: string
  title?: string
  size?: 'sm' | 'md'
  ariaLabel?: string
}

export function AutomationSwitch({
  checked,
  onChange,
  disabled = false,
  saving = false,
  locked = false,
  indeterminate = false,
  label,
  title,
  size = 'md',
  ariaLabel,
}: AutomationSwitchProps) {
  const interactive = !disabled && !locked && !saving && typeof onChange === 'function'
  const dims =
    size === 'sm'
      ? { track: 'w-7 h-3.5', thumb: 'w-2.5 h-2.5', on: 'translate-x-[14px]', off: 'translate-x-0.5' }
      : { track: 'w-9 h-5', thumb: 'w-4 h-4', on: 'translate-x-[18px]', off: 'translate-x-0.5' }
  const trackColor = locked
    ? 'bg-brand'
    : indeterminate
      ? 'bg-amber-400'
      : checked
        ? 'bg-emerald-500'
        : 'bg-slate-300'
  const thumbShifted = checked || indeterminate || locked
  return (
    <button
      type="button"
      role="switch"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel ?? label}
      disabled={!interactive}
      title={title}
      onClick={interactive ? () => onChange?.(!checked) : undefined}
      className={`inline-flex items-center gap-1.5 ${interactive ? 'cursor-pointer' : 'cursor-not-allowed'} ${
        size === 'sm' ? 'text-[11px]' : 'text-[12px]'
      } font-semibold ${locked ? 'text-brand' : checked ? 'text-ink' : 'text-ink-3'} transition-colors`}
    >
      <span
        className={`relative inline-flex items-center ${dims.track} rounded-full transition-colors duration-150 ${trackColor} ${
          interactive ? '' : 'opacity-90'
        }`}
        aria-hidden="true"
      >
        <span
          className={`absolute top-0.5 ${dims.thumb} rounded-full bg-white shadow-sm transition-transform duration-150 ${
            thumbShifted ? dims.on : dims.off
          }`}
        />
      </span>
      {saving ? (
        <Loader2 size={size === 'sm' ? 11 : 13} className="animate-spin text-brand" />
      ) : locked ? (
        <Lock size={size === 'sm' ? 10 : 12} strokeWidth={2.5} className="text-brand" />
      ) : null}
      {label ? <span>{label}</span> : null}
    </button>
  )
}

// ─── Status line ──────────────────────────────────────────────────
// Thin colored row under destructive actions that shows the last op
// result. Matches OrdersView's success/error toast aesthetic so
// settings feels native to the rest of the app.
export function StatusLine({
  kind,
  message,
}: {
  kind: 'success' | 'error' | 'info'
  message: string
}) {
  const cfg = {
    success: { icon: <CheckCircle2 size={13} strokeWidth={2.5} />, text: 'text-emerald-700', ring: 'ring-emerald-200', bg: 'bg-emerald-50' },
    error: { icon: <XCircle size={13} strokeWidth={2.5} />, text: 'text-rose-700', ring: 'ring-rose-200', bg: 'bg-rose-50' },
    info: { icon: <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />, text: 'text-ink-2', ring: 'ring-line', bg: 'bg-surface-2' },
  }[kind]
  return (
    <div className={`mt-3 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium ring-1 ${cfg.text} ${cfg.ring} ${cfg.bg}`}>
      {cfg.icon}
      <span>{message}</span>
    </div>
  )
}
