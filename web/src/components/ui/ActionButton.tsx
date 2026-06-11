import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Loader2 } from 'lucide-react'

// PS-156: extracted verbatim from CarrierIntegrationsCard (module-level, self-contained).
// Action button — icon + label combo with hover lift + active scale. Four
// variants share the same pill-shape language so they read as one family — the
// tint communicates the action's role, not the shape:
//   subtle:  brand-blue tinted bg + brand-blue text (diagnostic/utility)
//   primary: filled brand-blue gradient (main action)
//   danger:  rose-tinted bg + rose text (destructive / disabled-state)
//   success: emerald-tinted bg + emerald text (healthy / enabled-state)
//   default: neutral surface (reserved for future generic actions)
// All buttons are 30px tall, 11.5px font, rounded-full (pill), with a 1px ring
// instead of a border so the hover boxShadow doesn't fight the border thickness.
export type ActionVariant = 'subtle' | 'primary' | 'danger' | 'success' | 'default'

export function ActionButton({
  icon,
  label,
  loadingLabel,
  loading,
  disabled,
  onClick,
  variant = 'subtle',
  title,
}: {
  icon: ReactNode
  label: string
  loadingLabel?: string
  loading?: boolean
  disabled?: boolean
  onClick: () => void
  variant?: ActionVariant
  title?: string
}) {
  const styles: Record<ActionVariant, { background: string; color: string; ringColor: string; hoverRing: string }> = {
    subtle: {
      background: 'rgb(var(--brand-rgb, 3 169 244) / 0.08)',
      color: 'rgb(var(--brand-rgb, 3 169 244))',
      ringColor: 'rgb(var(--brand-rgb, 3 169 244) / 0.25)',
      hoverRing: 'rgb(var(--brand-rgb, 3 169 244) / 0.5)',
    },
    primary: {
      background:
        'linear-gradient(135deg, rgb(var(--brand-rgb, 3 169 244)), rgb(var(--brand-2-rgb, 2 136 209)))',
      color: '#fff',
      ringColor: 'rgb(var(--brand-rgb, 3 169 244) / 0.5)',
      hoverRing: 'rgb(var(--brand-rgb, 3 169 244) / 0.7)',
    },
    danger: {
      background: 'rgb(244 63 94 / 0.08)',
      color: 'rgb(190 18 60)',
      ringColor: 'rgb(244 63 94 / 0.25)',
      hoverRing: 'rgb(244 63 94 / 0.5)',
    },
    success: {
      background: 'rgb(16 185 129 / 0.10)',
      color: 'rgb(4 120 87)',
      ringColor: 'rgb(16 185 129 / 0.3)',
      hoverRing: 'rgb(16 185 129 / 0.55)',
    },
    default: {
      background: 'var(--surface)',
      color: 'var(--text)',
      ringColor: 'var(--border)',
      hoverRing: 'var(--border-2)',
    },
  }
  const v = styles[variant]
  return (
    <motion.button
      type="button"
      whileHover={!disabled && !loading ? { y: -1 } : undefined}
      whileTap={!disabled && !loading ? { scale: 0.95 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      onClick={onClick}
      disabled={!!(disabled || loading)}
      title={title}
      style={{
        background: v.background,
        color: v.color,
        boxShadow: `inset 0 0 0 1px ${v.ringColor}, 0 1px 2px rgba(15, 23, 42, 0.04)`,
        borderRadius: 999,
        padding: '6px 12px',
        height: 30,
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: '0.01em',
        cursor: loading ? 'wait' : disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        border: 'none',
        transition: 'box-shadow 150ms ease-out, background 150ms ease-out',
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) {
          e.currentTarget.style.boxShadow = `inset 0 0 0 1px ${v.hoverRing}, 0 4px 10px -2px rgba(15, 23, 42, 0.14), 0 2px 4px -1px rgba(15, 23, 42, 0.06)`
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = `inset 0 0 0 1px ${v.ringColor}, 0 1px 2px rgba(15, 23, 42, 0.04)`
      }}
    >
      {loading ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" /> : icon}
      <span>{loading && loadingLabel ? loadingLabel : label}</span>
    </motion.button>
  )
}
