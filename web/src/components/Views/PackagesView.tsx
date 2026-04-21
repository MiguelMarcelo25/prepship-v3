// @ts-nocheck
import { useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type {
  PackageDto,
  PackageLedgerEntryDto,
  PackageMutationResult,
} from '../../types/api'
import {
  buildLowStockBannerText,
  buildPackageAdjustInput,
  buildPackageReceiveInput,
  buildPackageSaveInput,
  buildSetDefaultPackagePriceToast,
  createPackageFormState,
  createPackageQuantityFormState,
  formatPackageDimensionsText,
  formatPackageLedgerDate,
  formatPackageUnitCost,
  getPackageStockColor,
  getPackagesContentState,
  splitPackagesBySource,
  type PackageFormState,
  type PackageQuantityFormState,
} from './packages-parity'
import './PackagesView.css'

interface PackagesViewProps {
  onOpenOrder?: (orderId: number) => void
}

interface LedgerState {
  open: boolean
  loading: boolean
  error: string | null
  rows: PackageLedgerEntryDto[]
}

interface ReceiveModalState {
  packageId: number
  packageName: string
  form: PackageQuantityFormState
}

interface AdjustModalState {
  packageId: number
  packageName: string
  form: PackageQuantityFormState
  sign: 1 | -1
}

interface BillingDefaultModalState {
  packageId: number
  packageName: string
  price: string
}

function PackageAdjustModal({
  title,
  packageName,
  children,
  onClose,
  narrow = false,
}: {
  title: string
  packageName: string
  children: ReactNode
  onClose: () => void
  narrow?: boolean
}) {
  return (
    <div className="packages-overlay" onClick={onClose}>
      <div className={`packages-modal${narrow ? ' packages-modal-narrow' : ''}`} onClick={(event) => event.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>{packageName}</div>
        {children}
      </div>
    </div>
  )
}

function PackageBillingDefaultModal({
  packageName,
  price,
  onPriceChange,
  onClose,
  onConfirm,
  saving,
}: {
  packageName: string
  price: string
  onPriceChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
  saving: boolean
}) {
  return (
    <div className="packages-overlay" onClick={onClose}>
      <div className="packages-modal packages-modal-default" onClick={(event) => event.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>📋 Set Billing Default</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>{packageName}</div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, lineHeight: 1.5 }}>
          This will set the billing charge for <strong>all clients</strong> that haven&apos;t manually overridden their price.
          Clients with custom prices will <strong>not</strong> be changed.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--text2)', whiteSpace: 'nowrap' }}>Billing charge $</span>
          <input
            id="pkgDefaultPrice"
            type="number"
            min="0"
            step="0.01"
            value={price}
            placeholder="0.00"
            autoFocus
            onChange={(event) => onPriceChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onConfirm()
              }
            }}
            style={{
              flex: 1,
              padding: '7px 10px',
              border: '1px solid var(--border2)',
              borderRadius: 6,
              background: 'var(--surface2)',
              color: 'var(--text)',
              fontSize: 14,
              fontWeight: 700,
              textAlign: 'right',
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>per box</span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: '1px solid var(--border2)',
              background: 'var(--surface2)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--ss-blue)',
              color: '#fff',
              cursor: saving ? 'default' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Set Default'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PackagesView({ onOpenOrder }: PackagesViewProps) {
  const toastContext = useContext(ToastContext)
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [lowStockPackages, setLowStockPackages] = useState<PackageDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<PackageFormState>(() => createPackageFormState())
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [ledgerByPackageId, setLedgerByPackageId] = useState<Record<number, LedgerState>>({})
  const [reorderInputs, setReorderInputs] = useState<Record<number, string>>({})
  const [receiveModal, setReceiveModal] = useState<ReceiveModalState | null>(null)
  const [adjustModal, setAdjustModal] = useState<AdjustModalState | null>(null)
  const [billingDefaultModal, setBillingDefaultModal] = useState<BillingDefaultModalState | null>(null)
  const [modalSaving, setModalSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadPackages = async () => {
      setLoading(true)
      setError(null)

      const [packagesResult, lowStockResult] = await Promise.allSettled([
        apiClient.fetchPackages(),
        apiClient.fetchLowStockPackages(),
      ])

      if (cancelled) return

      if (packagesResult.status === 'rejected') {
        setError(packagesResult.reason instanceof Error ? packagesResult.reason.message : 'Failed to load packages')
        setLoading(false)
        return
      }

      const nextPackages = packagesResult.value
      setPackages(nextPackages)
      setReorderInputs(Object.fromEntries(nextPackages.map((pkg) => [pkg.packageId, String(pkg.reorderLevel ?? 10)])))
      setError(null)

      if (lowStockResult.status === 'fulfilled') {
        setLowStockPackages(lowStockResult.value)
      } else {
        setLowStockPackages([])
      }

      setLoading(false)
    }

    void loadPackages()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!receiveModal && !adjustModal && !billingDefaultModal) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setReceiveModal(null)
      setAdjustModal(null)
      setBillingDefaultModal(null)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [receiveModal, adjustModal, billingDefaultModal])

  const showToast = (message: string, tone?: 'error' | 'success' | 'info') => {
    toastContext?.addToast(message, tone)
  }

  const refreshPackages = async () => {
    const [nextPackages, nextLowStock] = await Promise.allSettled([
      apiClient.fetchPackages(),
      apiClient.fetchLowStockPackages(),
    ])

    if (nextPackages.status === 'fulfilled') {
      setPackages(nextPackages.value)
      setReorderInputs(Object.fromEntries(nextPackages.value.map((pkg) => [pkg.packageId, String(pkg.reorderLevel ?? 10)])))
      setError(null)
    } else {
      throw nextPackages.reason
    }

    if (nextLowStock.status === 'fulfilled') {
      setLowStockPackages(nextLowStock.value)
    } else {
      setLowStockPackages([])
    }
  }

  const { custom: customPackages } = useMemo(() => splitPackagesBySource(packages), [packages])
  const contentState = getPackagesContentState({ loading, error, packages })

  const handleFormChange = <K extends keyof PackageFormState>(field: K, value: PackageFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const handleShowAdd = () => {
    setForm(createPackageFormState())
    setFormOpen(true)
  }

  const handleEdit = (packageId: number) => {
    const pkg = packages.find((entry) => entry.packageId === packageId)
    if (!pkg) return
    setForm(createPackageFormState(pkg))
    setFormOpen(true)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return

    const payload = buildPackageSaveInput(form)
    if (!payload.name) {
      showToast('⚠ Name is required')
      return
    }

    setSaving(true)

    try {
      let result: PackageMutationResult
      if (form.packageId) {
        result = await apiClient.updatePackageMutation(Number(form.packageId), payload)
      } else {
        result = await apiClient.createPackageMutation(payload)
      }

      if (!result.ok) {
        throw new Error('Package save failed')
      }

      showToast('✅ Package saved')
      setFormOpen(false)
      setForm(createPackageFormState())
      await refreshPackages()
    } catch (saveError) {
      showToast(`❌ ${saveError instanceof Error ? saveError.message : 'Failed to save package'}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (packageId: number) => {
    if (!window.confirm('Delete this package?')) return

    try {
      await apiClient.deletePackageMutation(packageId)
      await refreshPackages()
    } catch (deleteError) {
      showToast(`❌ ${deleteError instanceof Error ? deleteError.message : 'Failed to delete package'}`, 'error')
    }
  }

  const handleSyncCarrierPackages = async () => {
    if (syncing) return
    setSyncing(true)

    try {
      await apiClient.syncCarrierPackages()
      await new Promise((resolve) => window.setTimeout(resolve, 3000))
      await refreshPackages()
      showToast('✅ Carrier packages synced')
    } catch (syncError) {
      showToast(`❌ ${syncError instanceof Error ? syncError.message : 'Failed to sync packages'}`, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const handleToggleLedger = async (packageId: number) => {
    const current = ledgerByPackageId[packageId]
    if (current?.open) {
      setLedgerByPackageId((state) => ({
        ...state,
        [packageId]: { ...current, open: false },
      }))
      return
    }

    setLedgerByPackageId((state) => ({
      ...state,
      [packageId]: {
        open: true,
        loading: true,
        error: null,
        rows: state[packageId]?.rows ?? [],
      },
    }))

    try {
      const rows = await apiClient.fetchPackageLedger(packageId)
      setLedgerByPackageId((state) => ({
        ...state,
        [packageId]: {
          open: true,
          loading: false,
          error: null,
          rows,
        },
      }))
    } catch (ledgerError) {
      setLedgerByPackageId((state) => ({
        ...state,
        [packageId]: {
          open: true,
          loading: false,
          error: ledgerError instanceof Error ? ledgerError.message : 'Failed to load ledger',
          rows: [],
        },
      }))
    }
  }

  const handleReorderInputChange = (packageId: number, value: string) => {
    setReorderInputs((state) => ({ ...state, [packageId]: value }))
  }

  const handleSaveReorderLevel = async (pkg: PackageDto) => {
    const nextValue = reorderInputs[pkg.packageId] ?? String(pkg.reorderLevel ?? 10)
    const parsed = Number.parseInt(nextValue, 10) || 0
    if (parsed === (pkg.reorderLevel ?? 10)) return

    try {
      await apiClient.setPackageReorderLevel(pkg.packageId, parsed)
      setPackages((current) => current.map((entry) => (
        entry.packageId === pkg.packageId ? { ...entry, reorderLevel: parsed } : entry
      )))
      setLowStockPackages((current) => current.map((entry) => (
        entry.packageId === pkg.packageId ? { ...entry, reorderLevel: parsed } : entry
      )))
    } catch (reorderError) {
      setReorderInputs((state) => ({ ...state, [pkg.packageId]: String(pkg.reorderLevel ?? 10) }))
      showToast(`❌ ${reorderError instanceof Error ? reorderError.message : 'Failed to save reorder level'}`, 'error')
    }
  }

  const handleReceiveSubmit = async () => {
    if (!receiveModal || modalSaving) return

    const payload = buildPackageReceiveInput(receiveModal.form)
    if (!payload.qty || payload.qty <= 0) {
      showToast('⚠ Enter a positive quantity')
      return
    }

    setModalSaving(true)

    try {
      const result = await apiClient.receivePackage(receiveModal.packageId, payload)
      setReceiveModal(null)
      showToast(`✅ Received ${payload.qty} units. New total: ${result.package?.stockQty ?? '?'}`)
      await refreshPackages()
    } catch (receiveError) {
      showToast(`❌ ${receiveError instanceof Error ? receiveError.message : 'Receive failed'}`, 'error')
    } finally {
      setModalSaving(false)
    }
  }

  const handleAdjustSubmit = async () => {
    if (!adjustModal || modalSaving) return

    const rawQty = Number.parseInt(adjustModal.form.qty, 10) || 0
    if (!rawQty || rawQty <= 0) {
      showToast('⚠ Enter a positive quantity')
      return
    }

    setModalSaving(true)

    try {
      const payload = buildPackageAdjustInput(adjustModal.form, adjustModal.sign)
      const result = await apiClient.adjustPackage(adjustModal.packageId, payload)
      setAdjustModal(null)
      showToast(`✅ Adjusted. New total: ${result.package?.stockQty ?? '?'}`)
      await refreshPackages()
    } catch (adjustError) {
      showToast(`❌ ${adjustError instanceof Error ? adjustError.message : 'Adjust failed'}`, 'error')
    } finally {
      setModalSaving(false)
    }
  }

  const handleConfirmDefaultPrice = async () => {
    if (!billingDefaultModal || modalSaving) return

    const price = Number.parseFloat(billingDefaultModal.price)
    if (Number.isNaN(price) || price < 0) {
      showToast('⚠ Enter a valid price')
      return
    }

    setModalSaving(true)

    try {
      const result = await apiClient.setDefaultPackagePrice(billingDefaultModal.packageId, price)
      setBillingDefaultModal(null)
      showToast(buildSetDefaultPackagePriceToast(result))
    } catch (defaultError) {
      showToast(`❌ ${defaultError instanceof Error ? defaultError.message : 'Failed to set default price'}`, 'error')
    } finally {
      setModalSaving(false)
    }
  }

  return (
    <>
      <div id="view-packages" className="view-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 2 }}>📐 Package Library</h2>
            <p style={{ color: 'var(--text3)', fontSize: 12 }}>Define reusable package types. Select in the right panel when shipping.</p>
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => void handleSyncCarrierPackages()} id="pkgSyncBtn" disabled={syncing}>
              {syncing ? '⏳ Syncing…' : '↻ Sync from ShipStation'}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={handleShowAdd}>＋ Add Custom</button>
          </div>
        </div>

        {formOpen ? (
          <form className="pkg-form-card" id="pkgFormCard" onSubmit={handleSubmit}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }} id="pkgFormTitle">
              {form.packageId ? 'Edit Package' : 'Add Package'}
            </div>
            <input id="pkgFormId" type="hidden" value={form.packageId} readOnly />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div className="pkg-form-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="pkgFormName">Name</label>
                <input id="pkgFormName" type="text" placeholder="e.g. Small Poly Mailer" value={form.name} onChange={(event) => handleFormChange('name', event.target.value)} />
              </div>
              <div className="pkg-form-field">
                <label htmlFor="pkgFormType">Type</label>
                <select id="pkgFormType" value={form.type} onChange={(event) => handleFormChange('type', event.target.value)}>
                  <option value="box">Box</option>
                  <option value="poly_mailer">Poly Mailer</option>
                  <option value="envelope">Envelope</option>
                  <option value="flat_rate_box_sm">Flat Rate Box SM</option>
                  <option value="flat_rate_box_md">Flat Rate Box MD</option>
                  <option value="flat_rate_box_lg">Flat Rate Box LG</option>
                  <option value="flat_rate_env">Flat Rate Envelope</option>
                </select>
              </div>
              <div className="pkg-form-field">
                <label htmlFor="pkgFormTare">Tare Weight (oz)</label>
                <input id="pkgFormTare" type="number" min="0" step="0.5" value={form.tareWeightOz} onChange={(event) => handleFormChange('tareWeightOz', event.target.value)} />
              </div>
            </div>
            <div className="pkg-form-grid">
              <div className="pkg-form-field">
                <label htmlFor="pkgFormL">Length (in)</label>
                <input id="pkgFormL" type="number" min="0" step="0.25" value={form.length} onChange={(event) => handleFormChange('length', event.target.value)} />
              </div>
              <div className="pkg-form-field">
                <label htmlFor="pkgFormW">Width (in)</label>
                <input id="pkgFormW" type="number" min="0" step="0.25" value={form.width} onChange={(event) => handleFormChange('width', event.target.value)} />
              </div>
              <div className="pkg-form-field">
                <label htmlFor="pkgFormH">Height (in)</label>
                <input id="pkgFormH" type="number" min="0" step="0.25" value={form.height} onChange={(event) => handleFormChange('height', event.target.value)} />
              </div>
              <div className="pkg-form-field">
                <label htmlFor="pkgFormCost">
                  Unit Cost ($) <span style={{ fontSize: 10, color: 'var(--text3)' }}>what you pay</span>
                </label>
                <input id="pkgFormCost" type="number" min="0" step="0.001" placeholder="0.000" value={form.unitCost} onChange={(event) => handleFormChange('unitCost', event.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => {
                  setFormOpen(false)
                  setForm(createPackageFormState())
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
                {saving ? 'Saving…' : '💾 Save Package'}
              </button>
            </div>
          </form>
        ) : null}

        {lowStockPackages.length > 0 ? (
          <div
            id="pkgLowStockBanner"
            style={{
              background: '#fffbeb',
              border: '1px solid #fde68a',
              borderRadius: 7,
              padding: '9px 14px',
              marginBottom: 12,
              fontSize: 12.5,
              color: '#92400e',
            }}
          >
            ⚠️ <strong>Low stock:</strong> {buildLowStockBannerText(lowStockPackages).replace(/^Low stock:\s*/, '')}
          </div>
        ) : null}

        <div id="packagesContent">
          {contentState === 'loading' ? (
            <div className="loading"><div className="spinner" /><div style={{ fontSize: 12, marginTop: 4 }}>Loading packages…</div></div>
          ) : contentState === 'error' ? (
            <div className="empty-state"><div className="empty-icon">⚠️</div><div>{error}</div></div>
          ) : contentState === 'empty' ? (
            <div className="empty-state"><div className="empty-icon">📐</div><div>No packages yet. Add one or sync from ShipStation.</div></div>
          ) : customPackages.length > 0 ? (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: 'var(--surface2)', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                Custom Packages
              </div>
              <table className="pkg-table">
                <thead>
                  <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '5px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', maxWidth: 280 }}>Package</th>
                    <th style={{ padding: '5px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', width: 60 }}>Stock</th>
                    <th style={{ padding: '5px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', width: 75 }}>Reorder</th>
                    <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', width: 70 }}>Cost</th>
                    <th style={{ padding: '5px 6px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {customPackages.map((pkg) => {
                    const ledger = ledgerByPackageId[pkg.packageId]
                    return (
                      <tr key={pkg.packageId} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '7px 10px', maxWidth: 280, overflow: 'hidden' }}>
                          <button
                            type="button"
                            className="packages-inline-button"
                            style={{
                              fontWeight: 600,
                              fontSize: 12,
                              color: 'var(--text)',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                              textDecorationColor: 'var(--border)',
                              display: 'block',
                            }}
                            onClick={() => void handleToggleLedger(pkg.packageId)}
                          >
                            {pkg.name}
                          </button>
                          <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 1 }}>{formatPackageDimensionsText(pkg)}</div>
                          {ledger?.open ? (
                            <div id={`pkg-ledger-${pkg.packageId}`} style={{ marginTop: 6 }}>
                              {ledger.loading ? (
                                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Loading…</span>
                              ) : ledger.error ? (
                                <span style={{ fontSize: 11, color: 'var(--red)' }}>Failed to load</span>
                              ) : ledger.rows.length === 0 ? (
                                <span style={{ fontSize: 11, color: 'var(--text3)' }}>No history yet</span>
                              ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, color: 'var(--text2)' }}>
                                  <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                      <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Date</th>
                                      <th style={{ textAlign: 'center', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Change</th>
                                      <th style={{ textAlign: 'right', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Cost/unit</th>
                                      <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Reason</th>
                                      <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Order</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ledger.rows.map((row) => (
                                      <tr key={`${pkg.packageId}-${row.id ?? row.createdAt}`} style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{formatPackageLedgerDate(row.createdAt)}</td>
                                        <td style={{ textAlign: 'center', padding: '3px 6px', fontWeight: 700, color: row.delta > 0 ? 'var(--green)' : 'var(--red)' }}>
                                          {row.delta > 0 ? '+' : ''}
                                          {row.delta}
                                        </td>
                                        <td style={{ textAlign: 'right', padding: '3px 6px', color: 'var(--text3)' }}>{formatPackageUnitCost(row.unitCost)}</td>
                                        <td style={{ padding: '3px 6px' }}>{row.reason || '—'}</td>
                                        <td style={{ padding: '3px 6px' }}>
                                          {row.orderId ? (
                                            <button
                                              type="button"
                                              className="packages-inline-button"
                                              style={{ color: 'var(--ss-blue)' }}
                                              onClick={() => onOpenOrder?.(row.orderId as number)}
                                            >
                                              #{row.orderId}
                                            </button>
                                          ) : '—'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13, color: getPackageStockColor(pkg) }}>
                          {pkg.stockQty ?? 0}
                        </td>
                        <td style={{ padding: '7px 8px', textAlign: 'center' }}>
                          <input
                            type="number"
                            min="0"
                            step="1"
                            title="Reorder Level"
                            value={reorderInputs[pkg.packageId] ?? String(pkg.reorderLevel ?? 10)}
                            onChange={(event) => handleReorderInputChange(pkg.packageId, event.target.value)}
                            onBlur={() => void handleSaveReorderLevel(pkg)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void handleSaveReorderLevel(pkg)
                                event.currentTarget.blur()
                              }
                            }}
                            style={{
                              width: 50,
                              padding: '3px 4px',
                              border: '1px solid var(--border2)',
                              borderRadius: 3,
                              background: 'var(--surface2)',
                              color: 'var(--text)',
                              fontSize: 11,
                              textAlign: 'center',
                            }}
                          />
                        </td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: 11.5, color: 'var(--text2)', fontFamily: 'monospace' }}>
                          {formatPackageUnitCost(pkg.unitCost)}
                        </td>
                        <td style={{ padding: '7px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-xs" type="button" title="Receive" onClick={() => setReceiveModal({ packageId: pkg.packageId, packageName: pkg.name, form: createPackageQuantityFormState(pkg.unitCost != null ? String(pkg.unitCost) : '') })}>📥</button>
                          <button className="btn btn-ghost btn-xs" type="button" title="Adjust" onClick={() => setAdjustModal({ packageId: pkg.packageId, packageName: pkg.name, sign: 1, form: createPackageQuantityFormState() })}>±</button>
                          <button className="btn btn-ghost btn-xs" type="button" title="Edit" onClick={() => handleEdit(pkg.packageId)}>✏️</button>
                          <button className="btn btn-ghost btn-xs" type="button" title="Default" onClick={() => setBillingDefaultModal({ packageId: pkg.packageId, packageName: pkg.name, price: pkg.unitCost != null ? pkg.unitCost.toFixed(2) : '' })}>📋</button>
                          <button className="btn btn-ghost btn-xs" type="button" title="Delete" style={{ color: 'var(--red)' }} onClick={() => void handleDelete(pkg.packageId)}>🗑</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      {receiveModal ? (
        <PackageAdjustModal title="📥 Receive Stock" packageName={receiveModal.packageName} onClose={() => setReceiveModal(null)}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input
              id="pkgAdjQty"
              type="number"
              min="1"
              step="1"
              value={receiveModal.form.qty}
              placeholder="Qty"
              autoFocus
              onChange={(event) => setReceiveModal((current) => current ? { ...current, form: { ...current.form, qty: event.target.value } } : current)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleReceiveSubmit()
                }
              }}
              style={{
                flex: 1,
                padding: '7px 10px',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                background: 'var(--surface2)',
                color: 'var(--text)',
                fontSize: 14,
                fontWeight: 700,
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>units</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>Cost/unit $</span>
            <input
              id="pkgAdjCost"
              type="number"
              min="0"
              step="0.001"
              value={receiveModal.form.costPerUnit}
              placeholder="0.000 (optional)"
              onChange={(event) => setReceiveModal((current) => current ? { ...current, form: { ...current.form, costPerUnit: event.target.value } } : current)}
              style={{
                flex: 1,
                padding: '7px 10px',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                background: 'var(--surface2)',
                color: 'var(--text)',
                fontSize: 13,
              }}
            />
            <span style={{ fontSize: 10.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>updates unit cost</span>
          </div>
          <input
            id="pkgAdjNote"
            type="text"
            maxLength={120}
            value={receiveModal.form.note}
            placeholder="Note (optional)"
            onChange={(event) => setReceiveModal((current) => current ? { ...current, form: { ...current.form, note: event.target.value } } : current)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleReceiveSubmit()
              }
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '7px 10px',
              border: '1px solid var(--border2)',
              borderRadius: 6,
              background: 'var(--surface2)',
              color: 'var(--text)',
              fontSize: 12,
              marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setReceiveModal(null)} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button type="button" onClick={() => void handleReceiveSubmit()} disabled={modalSaving} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--green)', color: '#fff', cursor: modalSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: modalSaving ? 0.7 : 1 }}>{modalSaving ? 'Receiving…' : 'Receive'}</button>
          </div>
        </PackageAdjustModal>
      ) : null}

      {adjustModal ? (
        <PackageAdjustModal title="± Adjust Stock" packageName={adjustModal.packageName} onClose={() => setAdjustModal(null)} narrow>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              id="pkgAdjBtn-add"
              type="button"
              onClick={() => setAdjustModal((current) => current ? { ...current, sign: 1 } : current)}
              style={{
                flex: 1,
                padding: 7,
                borderRadius: 6,
                border: adjustModal.sign > 0 ? '2px solid var(--ss-blue)' : '2px solid var(--border2)',
                background: adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--surface2)',
                color: adjustModal.sign > 0 ? '#fff' : 'var(--text)',
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              + Add
            </button>
            <button
              id="pkgAdjBtn-rem"
              type="button"
              onClick={() => setAdjustModal((current) => current ? { ...current, sign: -1 } : current)}
              style={{
                flex: 1,
                padding: 7,
                borderRadius: 6,
                border: adjustModal.sign < 0 ? '2px solid var(--red)' : '2px solid var(--border2)',
                background: adjustModal.sign < 0 ? 'var(--red)' : 'var(--surface2)',
                color: adjustModal.sign < 0 ? '#fff' : 'var(--text)',
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              − Remove
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <span id="pkgAdjSignLabel" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', width: 16, textAlign: 'center' }}>{adjustModal.sign > 0 ? '+' : '−'}</span>
            <input
              type="number"
              min="1"
              step="1"
              value={adjustModal.form.qty}
              placeholder="Qty"
              autoFocus
              onChange={(event) => setAdjustModal((current) => current ? { ...current, form: { ...current.form, qty: event.target.value } } : current)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleAdjustSubmit()
                }
              }}
              style={{
                flex: 1,
                padding: '7px 10px',
                border: '1px solid var(--border2)',
                borderRadius: 6,
                background: 'var(--surface2)',
                color: 'var(--text)',
                fontSize: 14,
                fontWeight: 700,
              }}
            />
          </div>
          <input
            type="text"
            maxLength={120}
            value={adjustModal.form.note}
            placeholder="Note (optional)"
            onChange={(event) => setAdjustModal((current) => current ? { ...current, form: { ...current.form, note: event.target.value } } : current)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleAdjustSubmit()
              }
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '7px 10px',
              border: '1px solid var(--border2)',
              borderRadius: 6,
              background: 'var(--surface2)',
              color: 'var(--text)',
              fontSize: 12,
              marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setAdjustModal(null)} style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border2)', background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
            <button type="button" onClick={() => void handleAdjustSubmit()} disabled={modalSaving} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--ss-blue)', color: '#fff', cursor: modalSaving ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: modalSaving ? 0.7 : 1 }}>{modalSaving ? 'Saving…' : 'Save'}</button>
          </div>
        </PackageAdjustModal>
      ) : null}

      {billingDefaultModal ? (
        <PackageBillingDefaultModal
          packageName={billingDefaultModal.packageName}
          price={billingDefaultModal.price}
          saving={modalSaving}
          onPriceChange={(value) => setBillingDefaultModal((current) => current ? { ...current, price: value } : current)}
          onClose={() => setBillingDefaultModal(null)}
          onConfirm={() => void handleConfirmDefaultPrice()}
        />
      ) : null}
    </>
  )
}
