import { useContext, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ClipboardList, X as XIcon, Calendar, Truck, Loader2, Download } from 'lucide-react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import {
  buildManifestFilename,
  buildManifestPayload,
  getManifestDefaultForm,
  validateManifestForm,
  type ManifestFormState,
} from './manifests-parity'

interface ManifestsViewProps {
  open: boolean
  onClose: () => void
}

export default function ManifestsView({ open, onClose }: ManifestsViewProps) {
  const toastContext = useContext(ToastContext)
  const [form, setForm] = useState<ManifestFormState>(() => getManifestDefaultForm())
  const [isLoading, setIsLoading] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setForm(getManifestDefaultForm())
    setIsLoading(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  async function handleGenerate() {
    const validationError = validateManifestForm(form)
    if (validationError) {
      toastContext?.addToast(validationError, 'error')
      return
    }

    setIsLoading(true)

    try {
      const result = await apiClient.downloadManifest(buildManifestPayload(form))
      const url = window.URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename || buildManifestFilename(form.startDate, form.endDate)
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(url)

      toastContext?.addToast('✅ Manifest downloaded', 'success')
      onClose()
    } catch (error) {
      if (mountedRef.current) setIsLoading(false)
      toastContext?.addToast(`❌ ${error instanceof Error ? error.message : 'Failed to generate manifest'}`, 'error')
    }
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-line bg-surface text-[13px] text-ink placeholder:text-ink-3 ' +
    'focus:bg-surface focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none ' +
    'font-mono tabular-nums'

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="manifest-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          className="fixed inset-0 z-[1500] flex items-center justify-center bg-ink/40 backdrop-blur-sm font-sans"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Manifest Export"
            onClick={(event) => event.stopPropagation()}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            className="w-full max-w-md mx-4 bg-surface rounded-2xl shadow-2xl border border-line overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-line bg-gradient-to-br from-page to-surface-2/40">
              <motion.div
                initial={{ rotate: -10, scale: 0.85 }}
                animate={{ rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-indigo-600 flex items-center justify-center shadow-md ring-1 ring-brand/20"
              >
                <ClipboardList size={18} strokeWidth={2.25} className="text-white" />
              </motion.div>
              <div className="flex-1">
                <div className="text-[15px] font-extrabold text-ink font-display tracking-tight">Manifest Export</div>
                <div className="text-tiny text-ink-3 mt-0.5">End-of-day handoff sheet for carriers</div>
              </div>
              <motion.button
                type="button"
                whileHover={{ rotate: 90 }}
                whileTap={{ scale: 0.85 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                onClick={onClose}
                aria-label="Close"
                className="w-8 h-8 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 transition-colors"
              >
                <XIcon size={16} strokeWidth={2.25} />
              </motion.button>
            </div>

            {/* Body */}
            <div className="px-5 py-5 space-y-5">
              {/* Date Range */}
              <div>
                <label className="flex items-center gap-1.5 text-tiny font-bold uppercase tracking-[0.08em] text-ink-3 mb-2">
                  <Calendar size={12} strokeWidth={2.5} />
                  Date Range
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="manifest-from"
                    type="date"
                    aria-label="Start date"
                    title="Start date (inclusive)"
                    value={form.startDate}
                    onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
                    className={inputCls}
                  />
                  <span className="text-tiny text-ink-3 font-medium">to</span>
                  <input
                    id="manifest-to"
                    type="date"
                    aria-label="End date"
                    title="End date (inclusive)"
                    value={form.endDate}
                    onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div className="text-2xs text-ink-3 mt-1.5 leading-relaxed">
                  Includes all shipments created within this window.
                </div>
              </div>

              {/* Carrier Filter */}
              <div>
                <label htmlFor="manifest-carrier" className="flex items-center gap-1.5 text-tiny font-bold uppercase tracking-[0.08em] text-ink-3 mb-2">
                  <Truck size={12} strokeWidth={2.5} />
                  Carrier <span className="text-ink-4 font-normal normal-case tracking-normal">(optional)</span>
                </label>
                <select
                  id="manifest-carrier"
                  value={form.carrierId}
                  onChange={(event) => setForm((current) => ({ ...current, carrierId: event.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-line bg-surface text-[13px] text-ink focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-all duration-150 outline-none cursor-pointer"
                >
                  <option value="">All Carriers</option>
                  <option value="stamps_com">USPS</option>
                  <option value="ups">UPS</option>
                  <option value="fedex">FedEx</option>
                </select>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-line bg-page/30">
              <motion.button
                type="button"
                whileTap={{ scale: 0.96 }}
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-ink-2 hover:text-ink hover:bg-line/40 transition-colors duration-150"
              >
                Cancel
              </motion.button>
              <div className="flex-1" />
              <AnimatePresence>
                {isLoading ? (
                  <motion.span
                    key="status"
                    initial={{ opacity: 0, x: 4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-tiny text-ink-3 font-medium mr-2"
                  >
                    Generating…
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <motion.button
                type="button"
                whileHover={{ y: -1 }}
                whileTap={{ scale: 0.96 }}
                disabled={isLoading}
                onClick={() => void handleGenerate()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-br from-brand to-indigo-600 shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 outline-none"
              >
                {isLoading ? (
                  <Loader2 size={14} strokeWidth={2.5} className="animate-spinSlow" />
                ) : (
                  <Download size={14} strokeWidth={2.5} />
                )}
                {isLoading ? 'Generating…' : 'Generate Manifest'}
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
