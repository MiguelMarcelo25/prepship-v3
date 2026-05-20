// @ts-nocheck
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Box, CalendarClock, CalendarPlus, Plus, RefreshCw, Ruler, Search, X } from 'lucide-react'
import { apiClient } from '../../api/client'
import { api } from '../../lib/api'
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
  PACKAGES_COLUMNS_ORDER,
  PACKAGES_REQUIRED_COLUMNS,
  PACKAGES_COLUMN_LABELS,
  type PackagesColumnKey,
  type PackagesColumnWidths,
  type PackagesSortKey,
  type PackagesSortState,
} from './PackagesDataTable'
import { AnalysisPagination } from './AnalysisPagination'
import { LowStockBanner } from './LowStockBanner'
import './PackagesView.css'

const OrderDetailDrawer = lazy(() => import('../OrderDetailDrawer'))

const PACKAGES_PAGE_SIZE_OPTIONS = [25, 50, 100]
const PACKAGES_DEFAULT_PAGE_SIZE = 50
const RECENT_PACKAGE_DAYS = 30

// Module-scope cache for the /packages/usage-summary aggregate.
// Surviving unmount/remount means re-visiting /packages within 30s
// (e.g. flipping tabs, closing a drawer) skips even the single backend
// request. Keyed by the `days` window so future filter UIs can vary
// the window without invalidating each other. The TTL is short enough
// that fresh-shipped data still appears on a normal page reload, but
// long enough that nav-pop / drawer-close / settings-tab-bounce feels
// instant. Mutations (adjust, receive, sync, purge) call
// `clearPackagesUsageCache()` so the next read is fresh.
const USAGE_CACHE_TTL_MS = 30_000
const USAGE_CACHE = new Map<number, { byPackageId: Record<number, number | null>; fetchedAt: number }>()
function clearPackagesUsageCache(): void {
  USAGE_CACHE.clear()
}

function getLowStockPackages(packages: PackageDto[]): PackageDto[] {
  return packages.filter(
    (pkg) =>
      typeof pkg.stockQty === 'number' &&
      typeof pkg.reorderLevel === 'number' &&
      pkg.stockQty <= pkg.reorderLevel,
  )
}

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

function compareText(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
}

function getPackageSortValue(
  pkg: PackageDto,
  key: PackagesSortKey,
  usageByPackageId: Record<number, number | null>,
): string | number | null {
  if (key === 'package') return pkg.name ?? ''
  if (key === 'stock') return Number(pkg.stockQty ?? 0)
  if (key === 'usage30') return usageByPackageId[pkg.packageId] ?? null
  if (key === 'reorder') return Number(pkg.reorderLevel ?? 10)
  if (key === 'cost') return pkg.unitCost == null ? null : Number(pkg.unitCost)
  return null
}

function sortPackages(
  packages: PackageDto[],
  sortState: PackagesSortState | null,
  usageByPackageId: Record<number, number | null>,
): PackageDto[] {
  if (!sortState) return packages
  const direction = sortState.direction === 'asc' ? 1 : -1
  return [...packages].sort((a, b) => {
    const aValue = getPackageSortValue(a, sortState.key, usageByPackageId)
    const bValue = getPackageSortValue(b, sortState.key, usageByPackageId)
    const aMissing = aValue === null || (typeof aValue === 'number' && Number.isNaN(aValue))
    const bMissing = bValue === null || (typeof bValue === 'number' && Number.isNaN(bValue))
    if (aMissing !== bMissing) return aMissing ? 1 : -1

    let result = 0
    if (typeof aValue === 'number' && typeof bValue === 'number') {
      result = aValue - bValue
    } else {
      result = compareText(aValue, bValue)
    }
    return result === 0 ? compareText(a.name, b.name) : result * direction
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

// ──────────────────────────────────────────────────────────────────
// Column layout (order + hidden). Persisted per-browser so each
// operator can shape the Packages table to fit their workflow.
// Defensive against malformed storage: unknown keys are dropped,
// missing keys are appended at the end so a newly added column
// auto-shows for returning operators.
// ──────────────────────────────────────────────────────────────────
interface PackagesColumnLayout {
  order: PackagesColumnKey[]
  hidden: PackagesColumnKey[]
}

const PACKAGES_COLUMN_LAYOUT_KEY = 'packages_column_layout'
const PACKAGES_COLUMN_KEY_SET = new Set<PackagesColumnKey>(PACKAGES_COLUMNS_ORDER)

function isPackagesColumnKey(value: unknown): value is PackagesColumnKey {
  return typeof value === 'string' && PACKAGES_COLUMN_KEY_SET.has(value as PackagesColumnKey)
}

function readStoredPackagesColumnLayout(): PackagesColumnLayout {
  if (typeof window === 'undefined') {
    return { order: [...PACKAGES_COLUMNS_ORDER], hidden: [] }
  }
  try {
    const raw = window.localStorage.getItem(PACKAGES_COLUMN_LAYOUT_KEY)
    if (!raw) return { order: [...PACKAGES_COLUMNS_ORDER], hidden: [] }
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return { order: [...PACKAGES_COLUMNS_ORDER], hidden: [] }
    }
    const seen = new Set<PackagesColumnKey>()
    const cleanOrder: PackagesColumnKey[] = []
    for (const k of Array.isArray(parsed.order) ? parsed.order : []) {
      if (isPackagesColumnKey(k) && !seen.has(k)) {
        cleanOrder.push(k)
        seen.add(k)
      }
    }
    // Append any default-order keys that weren't in storage so a new
    // column added later doesn't get hidden by stale layouts.
    for (const k of PACKAGES_COLUMNS_ORDER) {
      if (!seen.has(k)) {
        cleanOrder.push(k)
        seen.add(k)
      }
    }
    const cleanHidden: PackagesColumnKey[] = []
    const hiddenSeen = new Set<PackagesColumnKey>()
    for (const k of Array.isArray(parsed.hidden) ? parsed.hidden : []) {
      if (isPackagesColumnKey(k) && !PACKAGES_REQUIRED_COLUMNS.has(k) && !hiddenSeen.has(k)) {
        cleanHidden.push(k)
        hiddenSeen.add(k)
      }
    }
    return { order: cleanOrder, hidden: cleanHidden }
  } catch {
    return { order: [...PACKAGES_COLUMNS_ORDER], hidden: [] }
  }
}

function writeStoredPackagesColumnLayout(layout: PackagesColumnLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      PACKAGES_COLUMN_LAYOUT_KEY,
      JSON.stringify({ order: layout.order, hidden: layout.hidden }),
    )
  } catch {
    /* quota/private-mode: best-effort */
  }
}

interface PackagesViewProps {
  // Accepts an optional orderStatus so package-ledger order links can
  // route operators to the correct status tab (Awaiting / Shipped /
  // Cancelled) — many ledger entries point at shipped orders, and
  // navigating to the default Awaiting view would otherwise mean the
  // detail drawer opens but the surrounding list doesn't show the
  // selected row in context.
  onOpenOrder?: (orderId: number, orderStatus?: string | null) => void
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
  const [backfillingStartDate, setBackfillingStartDate] = useState(false)
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
  // Operator-defined column order + hidden set, persisted to
  // localStorage. Drag a header to reorder; the Columns button opens
  // a checklist to toggle visibility.
  const [columnLayout, setColumnLayout] = useState<PackagesColumnLayout>(readStoredPackagesColumnLayout)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  // 2026-05-13: portal anchor for the <Table>'s Columns ▾ button.
  // Operator asked: (1) move the picker to the LEFT of "Sync from
  // ShipStation" and (2) remove the duplicate bespoke columns
  // button that was rendering alongside Table's built-in one.
  // Solution: keep ONLY the Table primitive's picker, portaled here.
  // Same pattern used by Inventory and Clients.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(readStoredPackagesPageSize)
  const [search, setSearch] = useState('')
  const [showRecentlyAdded, setShowRecentlyAdded] = useState(false)
  const [usageByPackageId, setUsageByPackageId] = useState<Record<number, number | null>>({})
  const [usageLoading, setUsageLoading] = useState(false)
  const [sortState, setSortState] = useState<PackagesSortState | null>(null)

  // Drag-reorder: insert `fromKey` immediately before `toKey` in the
  // saved order. Identical semantics to the analysis table — same
  // mental model for operators across pages.
  function handleReorderPackageColumn(fromKey: PackagesColumnKey, toKey: PackagesColumnKey) {
    setColumnLayout((current) => {
      const next = current.order.filter((k) => k !== fromKey)
      const idx = next.indexOf(toKey)
      if (idx < 0) next.push(fromKey)
      else next.splice(idx, 0, fromKey)
      return { ...current, order: next }
    })
  }

  function handleTogglePackageColumnVisibility(key: PackagesColumnKey) {
    if (PACKAGES_REQUIRED_COLUMNS.has(key)) return
    setColumnLayout((current) => {
      const hiddenSet = new Set(current.hidden)
      if (hiddenSet.has(key)) hiddenSet.delete(key)
      else hiddenSet.add(key)
      return { ...current, hidden: Array.from(hiddenSet) }
    })
  }

  function handleResetPackageColumnLayout() {
    setColumnLayout({ order: [...PACKAGES_COLUMNS_ORDER], hidden: [] })
  }

  useEffect(() => {
    writeStoredPackagesColumnLayout(columnLayout)
  }, [columnLayout])

  useEffect(() => {
    if (!columnsMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-packages-columns-menu]')) return
      if (target?.closest('[data-packages-columns-trigger]')) return
      setColumnsMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [columnsMenuOpen])

  useEffect(() => {
    let cancelled = false

    const loadPackages = async () => {
      setLoading(true)
      setError(null)

      const packagesResult = await apiClient.fetchPackages()

      if (cancelled) return

      const nextPackages = packagesResult
      setPackages(nextPackages)
      setReorderInputs(Object.fromEntries(nextPackages.map((pkg) => [pkg.packageId, String(pkg.reorderLevel ?? 10)])))
      setError(null)
      setLowStockPackages(getLowStockPackages(nextPackages))

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

  // Compute "Last 30 days used" per package via a SINGLE backend
  // aggregate (GET /packages/usage-summary?days=30). Replaces the old
  // N+1 fan-out (one fetchPackageLedger per package on every mount)
  // — with ~500 packages that was 500 round-trips and ~50K ledger
  // rows transferred just to fill in one column. The new path is one
  // request, ~500 small {packageId, used} entries (and only for packages
  // with non-zero usage in the window — empties are omitted server-side).
  //
  // Module-level 30-second cache (USAGE_CACHE) survives unmount/remount
  // (e.g. tab navigation, drawer close + reopen) so re-visiting /packages
  // within 30s reuses the in-memory result and skips even the one
  // remaining request. Cache is keyed by `days` so future filter UIs
  // can vary the window without colliding.
  useEffect(() => {
    if (packages.length === 0) {
      setUsageByPackageId({})
      return
    }
    let cancelled = false
    const days = 30

    const cached = USAGE_CACHE.get(days)
    const now = Date.now()
    if (cached && now - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
      // Hydrate from cache instantly — no flash, no spinner.
      setUsageByPackageId(cached.byPackageId)
      setUsageLoading(false)
      return
    }

    setUsageLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
      try {
        const rows = await apiClient.fetchPackagesUsageSummary(days)
        if (cancelled) return
        const next: Record<number, number | null> = {}
        for (const row of rows ?? []) {
          if (typeof row?.packageId === 'number') {
            next[row.packageId] = Number(row.used) || 0
          }
        }
        USAGE_CACHE.set(days, { byPackageId: next, fetchedAt: Date.now() })
        setUsageByPackageId(next)
      } catch {
        if (!cancelled) setUsageByPackageId({})
      } finally {
        if (!cancelled) setUsageLoading(false)
      }
      })()
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
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

  function handleSortPackages(key: PackagesSortKey) {
    setSortState((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: key === 'package' ? 'asc' : 'desc' }
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
    const nextPackages = await apiClient.fetchPackages()
    setPackages(nextPackages)
    setReorderInputs(Object.fromEntries(nextPackages.map((pkg) => [pkg.packageId, String(pkg.reorderLevel ?? 10)])))
    setLowStockPackages(getLowStockPackages(nextPackages))
    setError(null)
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
  const sortedPackages = useMemo(() => {
    return sortPackages(filteredPackages, sortState, usageByPackageId)
  }, [filteredPackages, sortState, usageByPackageId])
  const pagedPackages = useMemo(() => {
    const start = (page - 1) * pageSize
    return sortedPackages.slice(start, start + pageSize)
  }, [page, pageSize, sortedPackages])

  useEffect(() => {
    setPage(1)
  }, [search, showRecentlyAdded, sortState])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedPackages.length / pageSize))
    setPage((current) => Math.min(current, maxPage))
  }, [pageSize, sortedPackages.length])
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

  // 🧹 Purge Test Data — same /admin/purge-test-orders endpoint the
  // Inventory + Settings pages call. Adds a Packages-page-specific
  // confirmation prompt that calls out exactly what changes here:
  // • test-tagged ledger rows ("...for order TESTING-...") are deleted
  // • each affected package's stockQty is restored by +|qtyDelta|
  // • the package rows themselves are NOT deleted (packages are global,
  //   shared across clients — they have no client_id, so deleting them
  //   would affect real fulfillment).
  // The endpoint is idempotent: rerunning on a clean DB returns 0s.
  const [purgingTest, setPurgingTest] = useState(false)
  const handlePurgeTestData = async () => {
    if (purgingTest) return
    if (
      !window.confirm(
        '🧹 Purge ALL test data?\n\n' +
          'This will:\n' +
          '  • Delete every package_ledger row tagged "for order TESTING-…"\n' +
          '  • Restore each affected package\'s stock by adding back the deducted qty\n' +
          '  • Also clean orders, shipments, billing, inventory & queue rows for is_test clients\n\n' +
          'Real packages and real customer ledger rows are NOT touched.\n' +
          'This cannot be undone.'
      )
    ) {
      return
    }
    setPurgingTest(true)
    showToast('🧹 Purging test data…')
    try {
      const res = await api.post<{
        deleted: {
          orders: number
          shipments: number
          ledger: number
          billing: number
          inventory: number
          ledgerByInventory: number
          orderOverrides: number
          printQueue: number
          pkgLedger: number
          pkgStockRestored: number
          pkgsAffected: number
        }
        message?: string
      }>('/admin/purge-test-orders', {})
      const d = res.deleted
      const total =
        d.orders +
        d.shipments +
        d.ledger +
        d.billing +
        d.inventory +
        d.ledgerByInventory +
        d.orderOverrides +
        d.printQueue +
        d.pkgLedger

      if (total === 0) {
        showToast(res.message ?? '✓ Already clean — nothing to purge', 'success')
      } else {
        // Packages-centric summary first, then full breakdown.
        showToast(
          `✅ Cleaned ${d.pkgLedger} pkg-ledger row(s) across ${d.pkgsAffected} pkg(s) ` +
            `(+${d.pkgStockRestored} stock restored). Plus ${d.orders} orders, ${d.shipments} shipments, ` +
            `${d.inventory} test SKUs, ${d.ledger + d.ledgerByInventory} inv-ledger, ${d.billing} billing.`,
          'success'
        )
      }
      // Purge wipes test ledger rows AND restores stock — both invalidate
      // the cached 30-day usage numbers. Without this clear, the column
      // would still show the pre-purge "USED" totals until the TTL.
      clearPackagesUsageCache()
      await refreshPackages()
      window.dispatchEvent(new CustomEvent('prepship:client-active-changed'))
    } catch (purgeError) {
      showToast(
        `❌ Purge failed: ${purgeError instanceof Error ? purgeError.message : 'Unknown error'}`,
        'error'
      )
    } finally {
      setPurgingTest(false)
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

  // Order-detail modal state. When the operator clicks an order number
  // inside a package's ledger reason ("Shipment XXX for order YYY"),
  // we resolve the number → local PK and pop the OrderDetailDrawer in
  // its centered/modal mode RIGHT INSIDE Packages — the operator no
  // longer leaves the page or context-switches to /orders. They get
  // the same shipment/items/history/actions panel that clicking an
  // order in the orders table shows, just as a centered overlay.
  const [orderDetailModal, setOrderDetailModal] = useState<{
    orderId: number
    status: string | null
  } | null>(null)

  const orderLookupInflight = useRef<Set<string>>(new Set())
  const handleOpenOrderByNumber = async (orderNumber: string) => {
    const trimmed = String(orderNumber ?? '').trim()
    if (!trimmed) return
    if (orderLookupInflight.current.has(trimmed)) return
    orderLookupInflight.current.add(trimmed)
    try {
      const found = await apiClient.findOrderByNumber(trimmed)
      if (!found) {
        // Lookup returned null — order is purged OR the by-number
        // endpoint isn't deployed in this environment. Toast tells
        // the operator what happened; the legacy "navigate to Orders
        // with number prefilled" fallback still fires for those who
        // want to go look manually.
        showToast(
          `Order ${trimmed} couldn't be opened (purged or not in DB)`,
          'error'
        )
        try {
          window.dispatchEvent(
            new CustomEvent('prepship:open-orders-search', { detail: { query: trimmed } }),
          )
        } catch {
          /* event dispatch is a best-effort hint to whoever's listening */
        }
        return
      }
      // Open the modal RIGHT HERE in the Packages page — no
      // navigation, no context-switch. OrderDetailDrawer in
      // presentation="centered" mode renders as a centered overlay
      // with backdrop dim + click-to-close.
      setOrderDetailModal({ orderId: found.id, status: found.orderStatus })
    } catch (lookupError) {
      // Log the underlying error so support can diagnose — safe()
      // upstream eats it and returns null.
      console.warn(
        `[PackagesView] Order lookup failed for "${trimmed}":`,
        lookupError,
      )
      showToast(
        `❌ Could not open order ${trimmed}: ${lookupError instanceof Error ? lookupError.message : 'Lookup failed'}`,
        'error'
      )
    } finally {
      orderLookupInflight.current.delete(trimmed)
    }
  }

  const handleBackfillPackageStartDate = async () => {
    if (backfillingStartDate) return
    setBackfillingStartDate(true)

    try {
      const result = await apiClient.backfillPackageStartDate()
      await refreshPackages()
      setShowRecentlyAdded(false)
      const updated = Number(result?.updated ?? 0)
      showToast(`Package start dates set to 04/01/2026 (${updated} updated)`, 'success')
    } catch (backfillError) {
      showToast(`Failed to backfill start dates: ${backfillError instanceof Error ? backfillError.message : 'Backfill failed'}`, 'error')
    } finally {
      setBackfillingStartDate(false)
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
      // Receive creates a positive ledger row — usage-summary only
      // counts negatives, so technically nothing to invalidate, but
      // future windowed views may diff stock-in vs stock-out, so we
      // bust the cache to be safe + it forces a fresh aggregate.
      clearPackagesUsageCache()
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
      // Adjust can be positive OR negative — negatives change usage-30d.
      clearPackagesUsageCache()
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
            {/* 2026-05-13: portal anchor for the <Table>'s Columns ▾
                button. Sits HERE so the picker lives next to "Sync
                from ShipStation" instead of inside the table card.
                Replaces the OLD bespoke Packages columns button +
                popover that lived right after the Add Custom button
                — see further down for the removal site. Two pickers
                doing the same job was confusing operators (see
                screenshot in 2026-05-13 ticket). */}
            <span ref={setColumnsAnchor} className="inline-flex items-center" />
            <button className="btn btn-outline btn-sm pkg-header-btn" type="button" onClick={() => void handleSyncCarrierPackages()} id="pkgSyncBtn" disabled={syncing}>
              <RefreshCw size={14} strokeWidth={2} className={syncing ? 'pkg-spin' : undefined} />
              {syncing ? 'Syncing…' : 'Sync from ShipStation'}
            </button>
            <button className="btn btn-outline btn-sm pkg-header-btn" type="button" onClick={() => void handleImportStandardDimensions()} disabled={importingStandardDims}>
              <Ruler size={14} strokeWidth={2.2} />
              {importingStandardDims ? 'Adding...' : 'Add Dims'}
            </button>
            <button className="btn btn-outline btn-sm pkg-header-btn" type="button" onClick={() => void handleBackfillPackageStartDate()} disabled={backfillingStartDate}>
              <CalendarClock size={14} strokeWidth={2.2} />
              {backfillingStartDate ? 'Backfilling...' : 'Backfill Start'}
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
            <button
              className="btn btn-outline btn-sm pkg-header-btn"
              type="button"
              onClick={() => void handlePurgeTestData()}
              disabled={purgingTest}
              title="Delete test-order ledger rows ('Shipment XXX for order TESTING-…') and restore each package's stockQty. Real packages + real customer ledger rows are NOT touched."
              style={{
                color: 'var(--red, #dc2626)',
                borderColor: 'var(--red, #dc2626)',
                opacity: purgingTest ? 0.6 : 1,
                cursor: purgingTest ? 'wait' : 'pointer',
              }}
            >
              {purgingTest ? '🧹 Purging…' : '🧹 Purge Test Data'}
            </button>
            <button className="btn btn-primary btn-sm pkg-header-btn" type="button" onClick={handleShowAdd}>
              <Plus size={14} strokeWidth={2.5} />
              Add Custom
            </button>
            {/* 2026-05-13: REMOVED — bespoke Packages columns button +
                popover. It duplicated the Table primitive's built-in
                Columns picker, which now lives at the portal anchor
                above (next to "Sync from ShipStation"). Operators saw
                "Columns (6/6)" in the header AND "Columns 6/6" inside
                the table card — same UI, same data, different state
                stores. Keeping ONLY the Table primitive's picker now;
                same pattern landed on Inventory earlier this session.
                Legacy state (`columnLayout`, `columnsMenuOpen`,
                `handleTogglePackageColumnVisibility`,
                `handleResetPackageColumnLayout`) is intentionally
                kept declared for the moment — the Table picker's
                state is independent and lives under
                'packages-table:hidden' / ':order' localStorage keys.
                A follow-up cleanup commit can prune the dead helpers. */}
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
                {/* Migrated 2026-05-12 to the reusable <Table> primitive.
                    Sort, widths, column order, visibility, AND pagination
                    are now managed inside the Table under storageKey
                    'packages-table:*'. The legacy state above (sortState,
                    columnWidths, columnLayout, page, pageSize) is no
                    longer threaded in — kept temporarily for any code
                    that still reads it (e.g. focus restoration), but
                    can be cleaned up in a follow-up. Pass the full
                    filteredPackages so Table can sort + paginate. */}
                <PackagesDataTable
                  packages={filteredPackages}
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
                  onOpenOrderByNumber={(orderNumber) => void handleOpenOrderByNumber(orderNumber)}
                  usageByPackageId={usageByPackageId}
                  usageLoading={usageLoading}
                  columnsAnchorEl={columnsAnchor}
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

      {/* Order detail modal — opens when an operator clicks an order
          number link inside a package's ledger reason. Same component
          OrdersView uses for its row-click drawer; presentation set to
          "centered" so it floats over Packages as a true modal with
          a dim backdrop and click-to-close. The drawer fetches its
          own order/shipment data based on orderId, so we just need
          to flip the state and let it do the work. */}
      {orderDetailModal ? (
        <Suspense fallback={null}>
          <OrderDetailDrawer
            orderId={orderDetailModal.orderId}
            displayStatus={orderDetailModal.status ?? undefined}
            presentation="centered"
            onClose={() => setOrderDetailModal(null)}
          />
        </Suspense>
      ) : null}
    </>
  )
}
