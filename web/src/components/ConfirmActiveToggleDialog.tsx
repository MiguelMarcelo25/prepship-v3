// Confirmation modal shown when an operator toggles a client's
// active flag. Used by both the Clients-page variants (via
// useClientsData) and the Inventory page's Clients tab (via
// InventoryView's handleToggleClientActive).
//
// Portal-rendered to document.body so it floats above any sibling
// stacking context — important because some variants set their own
// transform / will-change which create new stacking contexts that
// would otherwise pin the modal behind their content.
//
// 2026-05-12: built in response to operator request to "have a
// confirmation modal" when clicking the active/inactive toggle —
// previously the toggle fired instantly, which made accidental
// click-throughs cascade across the dashboard, sidebar, analysis,
// billing, etc. (since 60344e2 + 0fc5e14 made the visibility filter
// propagate everywhere). One extra click of friction is cheap
// insurance against the wrong client getting disabled.

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

export interface ConfirmActiveTogglePending {
  clientId: number
  clientName: string
  nextActive: boolean
}

interface Props {
  pending: ConfirmActiveTogglePending | null
  onConfirm: () => void
  onCancel: () => void
  isPending?: boolean
}

export function ConfirmActiveToggleDialog({ pending, onConfirm, onCancel, isPending }: Props) {
  // ESC key dismisses the dialog. Bound only while the dialog is
  // open so we don't add a global listener for the lifetime of the
  // page. Stops propagation so other ESC handlers (e.g. drawers)
  // don't also close themselves on the same keystroke.
  useEffect(() => {
    if (!pending) return
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [pending, onCancel])

  if (typeof document === 'undefined') return null

  // The two action verbs are swapped intentionally — when the
  // operator clicks an ACTIVE client's toggle, they're DEACTIVATING.
  // The pendingToggle's `nextActive` is what the state will become
  // if confirmed, so flip the language around it.
  const verb = pending?.nextActive ? 'enable' : 'disable'
  const heroIcon = pending?.nextActive ? '⚡' : '⏸'
  const accent = pending?.nextActive ? 'var(--ok, #16a34a)' : 'var(--red, #dc2626)'
  const accentSoft = pending?.nextActive ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)'

  return createPortal(
    <AnimatePresence>
      {pending ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={`Confirm ${verb} client`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9500,
            background: 'rgba(15,23,42,0.55)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
          onMouseDown={(event) => {
            // Click on the backdrop (not the dialog body) cancels.
            if (event.target === event.currentTarget) onCancel()
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            style={{
              width: 'min(440px, 100%)',
              background: 'var(--surface, #fff)',
              border: '1px solid var(--border, #e5e7eb)',
              borderRadius: 14,
              boxShadow:
                '0 18px 50px -12px rgba(15,23,42,0.28), 0 6px 16px -6px rgba(15,23,42,0.12)',
              padding: '22px 24px 20px',
              fontFamily: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: accentSoft,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 22,
                  color: accent,
                  flex: '0 0 auto',
                }}
              >
                {heroIcon}
              </span>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: accent, marginBottom: 2 }}>
                  {pending?.nextActive ? 'Enable client' : 'Disable client'}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text, #0a0a0a)', letterSpacing: '-0.005em', lineHeight: 1.2 }}>
                  {pending?.clientName ?? '—'}
                </div>
              </div>
            </div>

            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text2, #4b5563)', margin: '0 0 18px' }}>
              {pending?.nextActive ? (
                <>
                  This client and their orders will appear again on the dashboard, sidebar,
                  analysis, billing, and every dropdown. Their historical numbers flow back
                  into all aggregations.
                </>
              ) : (
                <>
                  This client will disappear from the dashboard, sidebar, analysis, billing,
                  and every dropdown. Their orders stay in the database — they just stop
                  contributing to reports until you re-enable.
                </>
              )}
            </p>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={isPending}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '9px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--border, #e5e7eb)',
                  background: 'var(--surface2, #f3f4f6)',
                  color: 'var(--text, #0a0a0a)',
                  cursor: isPending ? 'wait' : 'pointer',
                  opacity: isPending ? 0.6 : 1,
                  transition: 'background 120ms',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={onConfirm}
                disabled={isPending}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 700,
                  padding: '9px 18px',
                  borderRadius: 8,
                  border: `1px solid ${accent}`,
                  background: accent,
                  color: '#fff',
                  cursor: isPending ? 'wait' : 'pointer',
                  opacity: isPending ? 0.7 : 1,
                  boxShadow: '0 2px 6px -2px rgba(15,23,42,0.18)',
                }}
              >
                {isPending ? 'Working…' : pending?.nextActive ? 'Yes, enable' : 'Yes, disable'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}
