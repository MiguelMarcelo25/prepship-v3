// Clients page — dispatcher.
//
// Routes to one of 10 design variants via a localStorage-backed
// selection (see useClientsVariant). A small floating picker button
// in the bottom-right corner opens a modal where the operator can
// preview + switch between variants.
//
// Why 10 variants?
//   Operator asked 2026-05-12 for the same "design picker" pattern
//   the Sidebar has (A–Y variants) — wanted to choose between
//   distinct aesthetic directions rather than commit to one. Each
//   variant lives in pages/Clients_variants/V{NN}_<name>.tsx and
//   renders the same data through a wildly different visual lens.
//
// Variant 01 is the restored original card grid (so operators have
// an undo path back to the familiar layout). Variants 02–10 are
// freshly-designed: editorial, data-table, dark-glass, minimal,
// brutalist, mosaic, spreadsheet, kanban, and showcase.

import { lazy, Suspense, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LayoutGrid, X as XIcon } from 'lucide-react'
import {
  CLIENTS_VARIANTS,
  CLIENTS_VARIANT_KEYS,
  useClientsVariant,
  type ClientsVariantKey,
} from './Clients_variants/useClientsVariant'

// Lazy-load each variant so the bundle only includes the active
// one. Switching variants triggers a small chunk fetch; the picker
// shows a fallback while the new variant arrives.
const VARIANTS: Record<ClientsVariantKey, React.LazyExoticComponent<React.ComponentType>> = {
  '01': lazy(() => import('./Clients_variants/V01_Original')),
  '02': lazy(() => import('./Clients_variants/V02_Editorial')),
  '03': lazy(() => import('./Clients_variants/V03_DataTable')),
  '04': lazy(() => import('./Clients_variants/V04_DarkGlass')),
  '05': lazy(() => import('./Clients_variants/V05_Minimal')),
  '06': lazy(() => import('./Clients_variants/V06_Brutalist')),
  '07': lazy(() => import('./Clients_variants/V07_Mosaic')),
  '08': lazy(() => import('./Clients_variants/V08_Spreadsheet')),
  '09': lazy(() => import('./Clients_variants/V09_Kanban')),
  '10': lazy(() => import('./Clients_variants/V10_Showcase')),
}

export default function Clients() {
  const { variant, setVariant } = useClientsVariant()
  const [pickerOpen, setPickerOpen] = useState(false)
  const VariantComponent = VARIANTS[variant]
  const meta = CLIENTS_VARIANTS[variant]

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <Suspense fallback={<VariantLoader name={meta.name} />}>
        <VariantComponent />
      </Suspense>

      {/* Floating picker button — bottom-right of the viewport.
          `fixed` positioning keeps it visible no matter which
          variant is active or where the operator has scrolled. */}
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        title={`Variant ${variant}: ${meta.name} — click to switch design`}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 h-10 px-4 rounded-full bg-ink text-white text-[12px] font-bold shadow-[0_8px_24px_-4px_rgba(15,23,42,0.35)] hover:shadow-[0_12px_32px_-4px_rgba(15,23,42,0.45)] hover:-translate-y-px active:scale-95 transition-all"
      >
        <LayoutGrid size={13} strokeWidth={2.5} />
        <span className="font-mono tabular-nums opacity-70">V{variant}</span>
        <span className="font-semibold">{meta.name}</span>
      </button>

      <AnimatePresence>
        {pickerOpen ? (
          <motion.div
            key="picker-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => { if (e.target === e.currentTarget) setPickerOpen(false) }}
            className="fixed inset-0 z-50 bg-ink/60 backdrop-blur-md flex items-center justify-center p-6"
          >
            <motion.div
              key="picker-panel"
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: 'spring', stiffness: 360, damping: 28 }}
              className="bg-surface rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
            >
              <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-line">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.22em] font-extrabold text-ink-3 mb-1">Design Picker</div>
                  <h2 className="text-[18px] font-extrabold tracking-tight text-ink m-0 font-display">Choose your Clients design</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setPickerOpen(false)}
                  aria-label="Close picker"
                  className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2 transition"
                >
                  <XIcon size={16} strokeWidth={2.25} />
                </button>
              </header>

              <div className="flex-1 min-h-0 overflow-y-auto p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {CLIENTS_VARIANT_KEYS.map((key) => {
                    const m = CLIENTS_VARIANTS[key]
                    const isActive = key === variant
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setVariant(key)
                          setPickerOpen(false)
                        }}
                        className={`group relative text-left rounded-xl overflow-hidden ring-1 transition-all ${
                          isActive
                            ? 'ring-2 ring-brand shadow-[0_4px_16px_-4px_rgba(3,169,244,0.35)]'
                            : 'ring-line hover:ring-ink/30 hover:shadow-md'
                        }`}
                      >
                        <div className="h-20 flex">
                          {m.swatches.map((color, i) => (
                            <div key={i} className="flex-1" style={{ background: color }} />
                          ))}
                        </div>
                        <div className="p-3 bg-surface">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono text-[10px] tabular-nums text-ink-3">V{key}</span>
                              <span className="text-[13px] font-extrabold text-ink tracking-tight truncate">{m.name}</span>
                            </div>
                            {isActive ? (
                              <span className="flex-shrink-0 text-[9px] uppercase tracking-[0.18em] font-bold text-brand">Active</span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-ink-3 truncate">{m.tagline}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <footer className="px-6 py-3 border-t border-line bg-surface-2/40 text-[11px] text-ink-3 italic flex items-center justify-between">
                <span>Your choice persists in this browser via localStorage.</span>
                <span className="font-mono">10 variants</span>
              </footer>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function VariantLoader({ name }: { name: string }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-page">
      <div className="flex flex-col items-center gap-3 text-ink-3">
        <div className="w-7 h-7 rounded-full border-2 border-line border-t-brand animate-spin" />
        <div className="text-[11px] uppercase tracking-[0.18em] font-bold">Loading {name}</div>
      </div>
    </div>
  )
}
