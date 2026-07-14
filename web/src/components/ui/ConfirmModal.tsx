// ConfirmModal — reusable confirmation dialog with smooth transitions.
//
// Replaces the native browser `confirm()` and `alert()` calls that
// the Clients page (and eventually other surfaces) used to gate
// destructive or potentially-surprising actions. Native dialogs
// look out of place against the rest of the app's design language
// and don't support animations or rich content.
//
// Animation contract: backdrop fades 0→1 over 180ms, panel scales
// from 0.96→1 + slides up 8px with a spring (stiffness 380, damping
// 28). Exit reverses both. AnimatePresence handles mount/unmount
// timing so the consumer just toggles a boolean.
//
// Tones drive both the icon color + the primary action button color:
//   default → ink/brand   (generic confirm)
//   danger  → rose        (delete / destroy)
//   magic   → violet      (auto/AI actions like backfill assign)
//   info    → sky         (informational confirm — e.g. archive)
//
// Closes on: Cancel button click, backdrop click, Escape key.
// (Backdrop click + Escape are suppressed while loading=true so a
// destructive in-flight mutation can't be abandoned mid-request.)
//
// Usage:
//   <ConfirmModal
//     open={confirmDelete}
//     title="Delete client?"
//     description="This also deletes their billing config."
//     confirmLabel="Delete"
//     tone="danger"
//     loading={remove.isPending}
//     onConfirm={() => remove.mutate(row.id)}
//     onCancel={() => setConfirmDelete(false)}
//   />

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Sparkles,
  Info,
  CheckCircle2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type ConfirmTone = 'default' | 'danger' | 'magic' | 'info'

interface ConfirmModalProps {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
  loading?: boolean
  /** Optional: when set, replaces the cancel/confirm footer with a
   *  single "OK" button. Useful for result/info dialogs that don't
   *  need a yes/no decision. */
  acknowledgeOnly?: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Each tone gets a coordinated icon + accent + button color set so
// the dialog reads as a unified visual signal. Idle and hover both
// stay in the same hue family.
const TONE_STYLES: Record<
  ConfirmTone,
  {
    Icon: LucideIcon
    iconBg: string
    iconColor: string
    confirmBtn: string
  }
> = {
  default: {
    Icon: CheckCircle2,
    iconBg: 'bg-sky-50',
    iconColor: 'text-sky-600',
    confirmBtn: 'bg-ink text-white hover:bg-ink-2',
  },
  danger: {
    Icon: AlertTriangle,
    iconBg: 'bg-rose-50',
    iconColor: 'text-rose-600',
    confirmBtn: 'bg-rose-600 text-white hover:bg-rose-700',
  },
  magic: {
    Icon: Sparkles,
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-600',
    confirmBtn: 'bg-violet-600 text-white hover:bg-violet-700',
  },
  info: {
    Icon: Info,
    iconBg: 'bg-sky-50',
    iconColor: 'text-sky-600',
    confirmBtn: 'bg-sky-600 text-white hover:bg-sky-700',
  },
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  loading = false,
  acknowledgeOnly = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Escape key closes (unless an in-flight mutation says otherwise).
  // Listener attaches only when the modal is open so we don't sit on
  // the document forever, and detaches on close so other dialogs'
  // Escape handlers don't fight ours.
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading) {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, loading, onCancel])

  const styles = TONE_STYLES[tone]
  const Icon = styles.Icon

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="confirm-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          // Click-outside dismisses, but only when we're not in the
          // middle of a mutation — operators shouldn't be able to
          // abandon a delete that's already firing.
          onClick={(e) => {
            if (e.target === e.currentTarget && !loading) onCancel()
          }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-ink/55 backdrop-blur-sm"
        >
          <motion.div
            key="confirm-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 4 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            className="w-full max-w-[420px] bg-surface rounded-2xl shadow-[0_20px_60px_-12px_rgba(15,23,42,0.4),0_8px_24px_-8px_rgba(15,23,42,0.18)] overflow-hidden ring-1 ring-line"
          >
            <div className="p-5 flex items-start gap-4">
              {/* Tone icon — soft tinted circle, sized to match the
                  visual weight of the title text on its right. */}
              <div className={`w-11 h-11 flex-shrink-0 rounded-full inline-flex items-center justify-center ${styles.iconBg} ${styles.iconColor}`}>
                <Icon size={22} />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <h2
                  id="confirm-title"
                  className="text-[15px] font-extrabold text-ink leading-tight m-0"
                >
                  {title}
                </h2>
                {description ? (
                  <div className="mt-1.5 text-[12.5px] text-ink-2 leading-relaxed">
                    {description}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="px-5 pb-5 pt-1 flex items-center justify-end gap-2">
              {/* Two-button mode (default) shows Cancel + Confirm.
                  acknowledgeOnly mode is a single OK button — used
                  for result/info dialogs that don't need a no/yes
                  decision (e.g. "Backfill complete: 12 orders
                  assigned"). The "OK" path still fires onConfirm
                  so the consumer can close + reset state in one
                  handler. */}
              {!acknowledgeOnly ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={onCancel}
                  className="h-9 px-3.5 rounded-lg text-[12.5px] font-bold text-ink-2 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cancelLabel}
                </button>
              ) : null}
              <button
                type="button"
                disabled={loading}
                onClick={onConfirm}
                className={`h-9 px-4 rounded-lg text-[12.5px] font-extrabold transition disabled:opacity-60 disabled:cursor-wait ${styles.confirmBtn}`}
              >
                {loading ? 'Working…' : acknowledgeOnly ? 'OK' : confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
