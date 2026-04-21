// @ts-nocheck
import { useContext, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import {
  buildManifestFilename,
  buildManifestPayload,
  getManifestDefaultForm,
  getManifestGenerateButtonLabel,
  getManifestStatusText,
  validateManifestForm,
  type ManifestFormState,
} from './manifests-parity'
import './ManifestsView.css'

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

  if (!open) return null

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
      if (mountedRef.current) {
        setIsLoading(false)
      }
      toastContext?.addToast(`❌ ${error instanceof Error ? error.message : 'Failed to generate manifest'}`, 'error')
    }
  }

  return (
    <div className="manifest-overlay" onClick={onClose}>
      <div className="manifest-modal" role="dialog" aria-modal="true" aria-label="Manifest Export" onClick={(event) => event.stopPropagation()}>
        <div className="manifest-header">
          <span className="manifest-header-title">📋 Manifest Export</span>
          <button type="button" className="manifest-close" onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>

        <div className="manifest-body">
          <div className="manifest-fields">
            <div>
              <label htmlFor="manifest-from" className="manifest-label">Date Range</label>
              <div className="manifest-date-row">
                <input
                  id="manifest-from"
                  type="date"
                  className="ship-select"
                  title="Start date (inclusive)"
                  value={form.startDate}
                  onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
                />
                <span className="manifest-inline-copy">to</span>
                <input
                  id="manifest-to"
                  type="date"
                  className="ship-select"
                  title="End date (inclusive)"
                  value={form.endDate}
                  onChange={(event) => setForm((current) => ({ ...current, endDate: event.target.value }))}
                />
              </div>
              <div className="manifest-help">Include all shipments created within this date range</div>
            </div>

            <div>
              <label htmlFor="manifest-carrier" className="manifest-label">Filter by Carrier (Optional)</label>
              <select
                id="manifest-carrier"
                className="ship-select manifest-select"
                value={form.carrierId}
                onChange={(event) => setForm((current) => ({ ...current, carrierId: event.target.value }))}
              >
                <option value="">All Carriers</option>
                <option value="stamps_com">USPS</option>
                <option value="ups">UPS</option>
                <option value="fedex">FedEx</option>
              </select>
            </div>

            <div className="manifest-summary" aria-hidden="true">
              <div />
            </div>
          </div>
        </div>

        <div className="manifest-footer">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleGenerate()} disabled={isLoading}>
            {getManifestGenerateButtonLabel(isLoading)}
          </button>
          <span className="manifest-status" style={{ display: isLoading ? 'inline' : 'none' }}>
            {getManifestStatusText(isLoading)}
          </span>
        </div>
      </div>
    </div>
  )
}
