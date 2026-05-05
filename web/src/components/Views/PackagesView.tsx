// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Box, CalendarPlus, Plus, RefreshCw, Ruler, Search, X } from 'lucide-react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type {
  PackageDto,
  PackageLedgerEntryDto,
  PackageMutationResult,
} from '../../types/api'
import {
  buildPackageAdjustInput,
  buildPackageReceiveInput,
  buildPackageSaveInput,
  buildSetDefaultPackagePriceToast,
  createPackageFormState,
  createPackageQuantityFormState,
  getPackagesContentState,
  splitPackagesBySource,
  type PackageFormState,
  type PackageQuantityFormState,
} from './packages-parity'
import {
  PackagesDataTable,
  type PackagesColumnKey,
  type PackagesColumnWidths,
} from './PackagesDataTable'
import { AnalysisPagination } from './AnalysisPagination'
import { LowStockBanner } from './LowStockBanner'
import './PackagesView.css'

const PACKAGES_PAGE_SIZE_OPTIONS = [25, 50, 100]
const PACKAGES_DEFAULT_PAGE_SIZE = 50
const RECENT_PACKAGE_DAYS = 30

function wasPackageCreatedWithinDays(pkg: PackageDto, days: number): boolean {
  const created = Date.parse(String(pkg.createdAt ?? ''))
  if (!Number.isFinite(created)) return false
  return created >= Date.now() - days * 24 * 60 * 60 * 1000
}

function hasCompletePackageDimensions(pkg: PackageDto): boolean {
  return Number(pkg.length ?? 0) > 0 && Number(pkg.width ?? 0) > 0 && Number(pkg.height ?? 0) > 0
}

function sortPackagesWithCompleteDimsFirst(packages: PackageDto[]): PackageDto[] {
  return [...packages].sort((a, b) => {
    const aComplete = hasCompletePackageDimensions(a)
    const bComplete = hasCompletePackageDimensions(b)
    if (aComplete !== bComplete) return aComplete ? -1 : 1
    return 0
  })
}

function readStoredPackagesPageSize(): number {
  if (typeof window === 'undefined') return PACKAGES_DEFAULT_PAGE_SIZE
  const raw = window.localStorage.getItem('packages_page_size')
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return PACKAGES_PAGE_SIZE_OPTIONS.includes(parsed) ? parsed : PACKAGES_DEFAULT_PAGE_SIZE
}

function readStoredPackageColumnWidths(): PackagesColumnWidths {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem('packages_column_widths')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const cleaned: PackagesColumnWidths = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        cleaned[key as PackagesColumnKey] = value
      }
    }
    return cleaned
  } catch {
    return {}
  }
}

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

function PackageFormModal({
  form,
  saving,
  onChange,
  onSubmit,
  onClose,
}: {
  form: PackageFormState
  saving: boolean
  onChange: <K extends keyof PackageFormState>(field: K, value: PackageFormState[K]) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClose: () => void
}) {
  const isEditing = Boolean(form.packageId)

  return (
    <div className="packages-overlay" onClick={saving ? undefined : onClose}>
      <form
        className="packages-modal packages-modal-package-form"
        id="pkgFormCard"
        onSubmit={onSubmit}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="packages-form-modal-header">
          <div>
            <div className="packages-form-modal-kicker">Package Library</div>
            <h3 id="pkgFormTitle">{isEditing ? 'Edit Custom Package' : 'Add Custom Package'}</h3>
            <p>{isEditing ? 'Update this reusable package size and cost.' : 'Create a reusable package size for future shipments.'}</p>
          </div>
          <button
            type="button"
            className="packages-modal-close"
            aria-label="Close package form"
            title="Close"
            onClick={onClose}
            disabled={saving}
          >
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <input id="pkgFormId" type="hidden" value={form.packageId} readOnly />

        <div className="packages-form-modal-grid">
          <div className="pkg-form-field packages-form-field-wide">
            <label htmlFor="pkgFormName">
              Name <span className="packages-required-mark" aria-hidden="true">*</span>
            </label>
            <input
              id="pkgFormName"
              type="text"
              required
              placeholder="e.g. Small Poly Mailer"
              value={form.name}
              autoFocus
              onChange={(event) => onChange('name', event.target.value)}
            />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormType">Type</label>
            <select id="pkgFormType" value={form.type} onChange={(event) => onChange('type', event.target.value)}>
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
            <input id="pkgFormTare" type="number" min="0" step="0.5" value={form.tareWeightOz} onChange={(event) => onChange('tareWeightOz', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormL">Length (in)</label>
            <input id="pkgFormL" type="number" min="0" step="0.25" value={form.length} onChange={(event) => onChange('length', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormW">Width (in)</label>
            <input id="pkgFormW" type="number" min="0" step="0.25" value={form.width} onChange={(event) => onChange('width', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormH">Height (in)</label>
            <input id="pkgFormH" type="number" min="0" step="0.25" value={form.height} onChange={(event) => onChange('height', event.target.value)} />
          </div>
          <div className="pkg-form-field">
            <label htmlFor="pkgFormCost">Unit Cost ($)</label>
            <input id="pkgFormCost" type="number" min="0" step="0.001" placeholder="0.000" value={form.unitCost} onChange={(event) => onChange('unitCost', event.target.value)} />
          </div>
        </div>

        <div className="packages-form-modal-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save Package'}
          </button>
        </div>
      </form>
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
  const [importingStandardDims, setImportingStandardDims] = useState(false)
  const [ledgerByPackageId, setLedgerByPackageId] = useState<Record<number, LedgerState>>({})
  const [reorderInputs, setReorderInputs] = useState<Record<number, string>>({})
  const [receiveModal, setReceiveModal] = useState<ReceiveModalState | null>(null)
  const [adjustModal, setAdjustModal] = useState<AdjustModalState | null>(null)
  const [billingDefaultModal, setBillingDefaultModal] = useState<BillingDefaultModalState | null>(null)
  const [modalSaving, setModalSaving] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [highlightedPackageId, setHighlightedPackageId] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({})
  const [columnWidths, setColumnWidths] = useState<PackagesColumnWidths>(readStoredPackageColumnWidths)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(readStoredPackagesPageSize)
  const [search, setSearch] = useState('')
  const [showRecentlyAdded, setShowRecentlyAdded] = useState(false)
  const [usageByPackageId, setUsageByPackageId] = useState<Record<number, number | null>>({})
  const [usageLoading, setUsageLoading] = useState(false)

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
    if (typeof window === 'undefined') return
    window.localStorage.setItem('packages_column_widths', JSON.stringify(columnWidths))
  }, [columnWidths])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('packages_page_size', String(pageSize))
  }, [pageSize])

  // Compute "Last 30 days used" per package by parallel-fetching ledgers and
  // summing negative deltas in the past 30 days. Backend has no aggregate
  // endpoint, so we fan out one request per package — fine for typical sizes.
  useEffect(() => {
    if (packages.length === 0) {
      setUsageByPackageId({})
      return
    }
    let cancelled = false
    setUsageLoading(true)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const work = packages.map(async (pkg) => {
      try {
        const rows = await apiClient.fetchPackageLedger(pkg.packageId)
        const used = (rows ?? []).reduce((sum, row) => {
          const delta = Number(row?.delta ?? 0)
          if (!Number.isFinite(delta) || delta >= 0) return sum
          const created = Date.parse(String(row?.createdAt ?? ''))
          if (!Number.isFinite(created) || created < cutoff) return sum
          return sum + Math.abs(delta)
        }, 0)
        return [pkg.packageId, used] as const
      } catch {
        return [pkg.packageId, null] as const
      }
    })
    void Promise.allSettled(work).then((results) => {
      if (cancelled) return
      const next: Record<number, number | null> = {}
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [id, value] = result.value
          next[id] = value
        }
      }
      setUsageByPackageId(next)
      setUsageLoading(false)
    })
    return () => { cancelled = true }
  }, [packages])

  function handleResizePackageColumn(key: PackagesColumnKey, width: number) {
    setColumnWidths((current) => ({ ...current, [key]: width }))
  }

  function handleResetPackageColumn(key: PackagesColumnKey) {
    setColumnWidths((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  useEffect(() => {
    if (!formOpen && !receiveModal && !adjustModal && !billingDefaultModal) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (formOpen && !saving) {
        setFormOpen(false)
        setForm(createPackageFormState())
      }
      setReceiveModal(null)
      setAdjustModal(null)
      setBillingDefaultModal(null)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [formOpen, saving, receiveModal, adjustModal, billingDefaultModal])

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
  const orderedCustomPackages = useMemo(() => {
    return sortPackagesWithCompleteDimsFirst(customPackages)
  }, [customPackages])
  const recentlyAddedPackages = useMemo(() => {
    return orderedCustomPackages
      .filter((pkg) => wasPackageCreatedWithinDays(pkg, RECENT_PACKAGE_DAYS))
      .sort((a, b) => {
        const aComplete = hasCompletePackageDimensions(a)
        const bComplete = hasCompletePackageDimensions(b)
        if (aComplete !== bComplete) return aComplete ? -1 : 1
        return Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? ''))
      })
  }, [orderedCustomPackages])
  const filteredPackages = useMemo(() => {
    const basePackages = showRecentlyAdded ? recentlyAddedPackages : orderedCustomPackages
    const term = search.trim().toLowerCase()
    if (!term) return basePackages
    return basePackages.filter((pkg) => {
      const fields = [
        pkg.name,
        pkg.type,
        pkg.length != null ? `${pkg.length}` : '',
        pkg.width != null ? `${pkg.width}` : '',
        pkg.height != null ? `${pkg.height}` : '',
      ]
      return fields.some((field) => String(field ?? '').toLowerCase().includes(term))
    })
  }, [orderedCustomPackages, recentlyAddedPackages, search, showRecentlyAdded])
  const pagedPackages = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredPackages.slice(start, start + pageSize)
  }, [filteredPackages, page, pageSize])

  useEffect(() => {
    setPage(1)
  }, [search, showRecentlyAdded])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredPackages.length / pageSize))
    setPage((current) => Math.min(current, maxPage))
  }, [filteredPackages.length, pageSize])
  const contentState = getPackagesContentState({ loading, error, packages })

  const handleFormChange = <K extends keyof PackageFormState>(field: K, value: PackageFormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const closeFormModal = () => {
    if (saving) return
    setFormOpen(false)
    setForm(createPackageFormState())
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

  const handleImportStandardDimensions = async () => {
    if (importingStandardDims) return
    setImportingStandardDims(true)

    try {
      const result = await apiClient.importStandardPackageDimensions()
      await refreshPackages()
      setShowRecentlyAdded(true)
      const inserted = Number(result?.inserted ?? 0)
      const skippedExisting = Number(result?.skippedExisting ?? 0)
      showToast(`Added ${inserted} package sizes (${skippedExisting} already existed)`, 'success')
    } catch (importError) {
      showToast(`Failed to add dimensions: ${importError instanceof Error ? importError.message : 'Import failed'}`, 'error')
    } finally {
      setImportingStandardDims(false)
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
      if (!result?.package) throw new Error('Receive failed')
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
      if (!result?.package) throw new Error('Adjust failed')
      setAdjustModal(null)
      showToast(`✅ Adjusted. New total: ${result.package?.stockQty ?? '?'}`)
      await refreshPackages()
    } catch (adjustError) {
      showToast(`❌ ${adjustError instanceof Error ? adjustError.message : 'Adjust failed'}`, 'error')
    } finally {
      setModalSaving(false)
    }
  }

  const scrollToPackageRow = (packageId: number) => {
    setHighlightedPackageId(packageId)
    const row = rowRefs.current[packageId]
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    window.setTimeout(() => {
      setHighlightedPackageId((current) => (current === packageId ? null : current))
    }, 2200)
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
      if (typeof result?.updated !== 'number') throw new Error('Failed to set default price')
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
      <div id="view-packages" className="view-content !p-5 !overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="flex items-start justify-between gap-3 mb-5 flex-wrap"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-md ring-1 ring-amber-400/20">
              <Box size={20} strokeWidth={2.25} className="text-white" />
            </div>
            <div>
              <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Package Library</h2>
              <p className="text-tiny text-ink-3 mt-0.5">Define reusable package types. Select in the right panel when shipping.</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="pkg-search-wrap">
              <Search size={13} strokeWidth={2.25} className="pkg-search-icon" />
              <input
                id="pkgSearch"
                type="text"
                placeholder="Search packages…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pkg-search-input"
              />
              {search ? (
                <button
                  type="button"
                  className="pkg-search-clear"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => setSearch('')}
                >
                  ×
                </button>
              ) : null}
            </div>
            <button className="btn btn-outline btn-sm pkg-header-btn" type="button" onClick={() => void handleSyncCarrierPackages()} id="pkgSyncBtn" disabled={syncing}>
              <RefreshCw size={14} strokeWidth={2} className={syncing ? 'pkg-spin' : undefined} />
              {syncing ? 'Syncing…' : 'Sync from ShipStation'}
            </button>
            <button className="btn btn-outline btn-sm pkg-header-btn" type="button" onClick={() => void handleImportStandardDimensions()} disabled={importingStandardDims}>
              <Ruler size={14} strokeWidth={2.2} />
              {importingStandardDims ? 'Adding...' : 'Add Dims'}
            </button>
            <button
              className={`btn ${showRecentlyAdded ? 'btn-primary' : 'btn-outline'} btn-sm pkg-header-btn`}
              type="button"
              aria-pressed={showRecentlyAdded}
              title="Show packages added in the last 30 days"
              onClick={() => setShowRecentlyAdded((current) => !current)}
            >
              <CalendarPlus size={14} strokeWidth={2.2} />
              30d Added ({recentlyAddedPackages.length})
            </button>
            <button className="btn btn-primary btn-sm pkg-header-btn" type="button" onClick={handleShowAdd}>
              <Plus size={14} strokeWidth={2.5} />
              Add Custom
            </button>
          </div>
        </motion.div>

        {/* Legacy inline form replaced by PackageFormModal.
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
        */}

        {lowStockPackages.length > 0 && !bannerDismissed ? (
          <LowStockBanner
            packages={lowStockPackages}
            onJumpTo={(packageId) => scrollToPackageRow(packageId)}
            onDismiss={() => setBannerDismissed(true)}
          />
        ) : null}

        <div id="packagesContent">
          {contentState === 'loading' ? (
            <div className="loading"><div className="spinner" /><div style={{ fontSize: 12, marginTop: 4 }}>Loading packages…</div></div>
          ) : contentState === 'error' ? (
            <div className="empty-state"><div className="empty-icon">⚠️</div><div>{error}</div></div>
          ) : contentState === 'empty' ? (
            <div className="empty-state"><div className="empty-icon">📐</div><div>No packages yet. Add one or sync from ShipStation.</div></div>
          ) : customPackages.length > 0 ? (
            filteredPackages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🔍</div>
                <div>
                  {search
                    ? `No packages match "${search}"`
                    : showRecentlyAdded
                      ? `No packages were added in the last ${RECENT_PACKAGE_DAYS} days`
                      : 'No packages match this filter'}
                </div>
              </div>
            ) : (
              <>
                <PackagesDataTable
                  packages={pagedPackages}
                  ledgerByPackageId={ledgerByPackageId}
                  reorderInputs={reorderInputs}
                  highlightedPackageId={highlightedPackageId}
                  rowRefs={rowRefs}
                  onToggleLedger={(packageId) => void handleToggleLedger(packageId)}
                  onReorderInputChange={handleReorderInputChange}
                  onSaveReorderLevel={(pkg) => void handleSaveReorderLevel(pkg)}
                  onReceive={(pkg) => setReceiveModal({ packageId: pkg.packageId, packageName: pkg.name, form: createPackageQuantityFormState(pkg.unitCost != null ? String(pkg.unitCost) : '') })}
                  onAdjust={(pkg) => setAdjustModal({ packageId: pkg.packageId, packageName: pkg.name, sign: 1, form: createPackageQuantityFormState() })}
                  onEdit={handleEdit}
                  onSetBillingDefault={(pkg) => setBillingDefaultModal({ packageId: pkg.packageId, packageName: pkg.name, price: pkg.unitCost != null ? pkg.unitCost.toFixed(2) : '' })}
                  onDelete={(packageId) => void handleDelete(packageId)}
                  onOpenOrder={onOpenOrder}
                  columnWidths={columnWidths}
                  onResizeColumn={handleResizePackageColumn}
                  onResetColumn={handleResetPackageColumn}
                  usageByPackageId={usageByPackageId}
                  usageLoading={usageLoading}
                />
                <AnalysisPagination
                  page={page}
                  pageSize={pageSize}
                  pageSizeOptions={PACKAGES_PAGE_SIZE_OPTIONS}
                  totalItems={filteredPackages.length}
                  onPageChange={setPage}
                  onPageSizeChange={(nextSize) => {
                    setPageSize(nextSize)
                    setPage(1)
                  }}
                  unitLabel="packages"
                  ariaLabel="Packages table pagination"
                />
              </>
            )
          ) : null}
        </div>
      </div>

      {formOpen ? (
        <PackageFormModal
          form={form}
          saving={saving}
          onChange={handleFormChange}
          onSubmit={handleSubmit}
          onClose={closeFormModal}
        />
      ) : null}

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
