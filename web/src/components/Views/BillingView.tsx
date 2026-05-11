// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { motion } from 'framer-motion'
import { Receipt } from 'lucide-react'
import { apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type {
  BillingConfigDto,
  BillingDetailDto,
  BillingPackagePriceDto,
  BillingSummaryDto,
  PackageDto,
} from '../../types/api'
import {
  BILLING_DETAIL_COLUMNS,
  aggregateBillingDetailRowsByOrder,
  buildBackfillRefRatesToast,
  buildBillingConfigInput,
  buildBillingPackagePriceRows,
  buildBillingSummaryTotals,
  buildFetchRefRatesDoneText,
  buildFetchRefRatesProgressText,
  buildFetchRefRatesStartText,
  buildGenerateBillingStatus,
  computeBillingDetailMetrics,
  createBillingConfigDraftMap,
  formatBillingDateTime,
  formatBillingMoney,
  getBillingDetailColumnStorageKey,
  getBillingInitialRange,
  getBillingInvoiceUrl,
  getBillingPresetRange,
  getVisibleBillingDetailColumns,
  readBillingDetailColumnIds,
  reorderBillingDetailColumnIds,
  toggleBillingDetailColumnIds,
  type BillingConfigDraft,
  type BillingDetailColumnId,
  type BillingPresetId,
} from './billing-parity'
import { AnalysisPagination } from './AnalysisPagination'
import OrderDetailDrawer from '../OrderDetailDrawer'
import { SortableHeader, nextSortState, sortRows } from '../SortableTable'
import './BillingView.css'

interface BillingDetailState {
  open: boolean
  loading: boolean
  clientId: number | null
  clientName: string
  rows: BillingDetailDto[]
  error: string | null
}

const SUMMARY_COL_COUNT = 8
const BILLING_SUMMARY_PAGE_SIZE_OPTIONS = [10, 25, 50, 100]
const BILLING_DETAIL_PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

function marginColor(value: number) {
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

function getPackageMarginMarkup(row: ReturnType<typeof buildBillingPackagePriceRows>[number]) {
  if (row.marginPct == null || !row.marginColor) {
    return <span style={{ color: 'var(--text4)' }}>—</span>
  }

  return <span style={{ color: row.marginColor, fontWeight: 700 }}>{row.marginPct}%</span>
}

export default function BillingView() {
  const toastContext = useContext(ToastContext)
  const initialRange = getBillingInitialRange(typeof window === 'undefined' ? new Date('2026-03-22T00:00:00Z') : new Date())
  const detailWrapRef = useRef<HTMLDivElement | null>(null)
  const fetchRefPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [configs, setConfigs] = useState<BillingConfigDto[]>([])
  const [configDrafts, setConfigDrafts] = useState<Record<number, BillingConfigDraft>>({})
  const [configsLoading, setConfigsLoading] = useState(true)
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [selectedPkgClientId, setSelectedPkgClientId] = useState('')
  const [savedPackagePrices, setSavedPackagePrices] = useState<BillingPackagePriceDto[]>([])
  const [packagePriceDrafts, setPackagePriceDrafts] = useState<Record<number, string>>({})
  const [packagePricingLoading, setPackagePricingLoading] = useState(false)
  const [packagePricingError, setPackagePricingError] = useState<string | null>(null)
  const [activePreset, setActivePreset] = useState<BillingPresetId>('last_90')
  const [from, setFrom] = useState(initialRange.from)
  const [to, setTo] = useState(initialRange.to)
  const [summaryRows, setSummaryRows] = useState<BillingSummaryDto[]>([])
  const [configSort, setConfigSort] = useState(null)
  const [packagePricingSort, setPackagePricingSort] = useState(null)
  const [summarySort, setSummarySort] = useState(null)
  const [detailSort, setDetailSort] = useState(null)
  const [summaryPage, setSummaryPage] = useState(1)
  const [summaryPageSize, setSummaryPageSize] = useState(25)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [generateLoading, setGenerateLoading] = useState(false)
  const [generateStatus, setGenerateStatus] = useState('')
  const [fetchRefRunning, setFetchRefRunning] = useState(false)
  const [fetchRefStatus, setFetchRefStatus] = useState('')
  const [backfillLoading, setBackfillLoading] = useState(false)
  const [detailState, setDetailState] = useState<BillingDetailState>({
    open: false,
    loading: false,
    clientId: null,
    clientName: '',
    rows: [],
    error: null,
  })
  const [detailPage, setDetailPage] = useState(1)
  const [detailPageSize, setDetailPageSize] = useState(50)
  const [orderDetailModalId, setOrderDetailModalId] = useState<number | null>(null)
  const [detailColumnIds, setDetailColumnIds] = useState<BillingDetailColumnId[]>(() => {
    if (typeof window === 'undefined') return readBillingDetailColumnIds()
    return readBillingDetailColumnIds(window.localStorage)
  })
  // Drag-to-reorder state: tracks which column the user grabbed so we
  // can highlight the drop target and commit the swap on dragend.
  // Stored as refs (instead of state) for two reasons: (a) the drag
  // payload survives re-renders during the dragover stream, and (b) we
  // don't want re-renders firing on every mousemove during a drag.
  const dragColumnIdRef = useRef<BillingDetailColumnId | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<BillingDetailColumnId | null>(null)

  function handleColumnDragStart(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    dragColumnIdRef.current = columnId
    // Setting a payload + 'move' effect activates the native drag
    // cursor. The data string is unused by us — only React tracks it.
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', columnId)
  }

  function handleColumnDragOver(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    // preventDefault is required to allow drop. Without it, browsers
    // reject the drop with the no-entry cursor.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dragColumnIdRef.current && dragColumnIdRef.current !== columnId) {
      setDragOverColumnId(columnId)
    }
  }

  function handleColumnDrop(columnId: BillingDetailColumnId, event: ReactDragEvent) {
    event.preventDefault()
    const fromId = dragColumnIdRef.current
    dragColumnIdRef.current = null
    setDragOverColumnId(null)
    if (!fromId || fromId === columnId) return
    setDetailColumnIds((current) => reorderBillingDetailColumnIds(current, fromId, columnId))
  }

  function handleColumnDragEnd() {
    dragColumnIdRef.current = null
    setDragOverColumnId(null)
  }

  const packagePricingRows = useMemo(
    () => buildBillingPackagePriceRows(packages, savedPackagePrices, packagePriceDrafts),
    [packages, savedPackagePrices, packagePriceDrafts],
  )
  const sortedConfigs = useMemo(() => sortRows(
    configs,
    configSort,
    (config, key) => {
      const draft = configDrafts[config.clientId]

      switch (key) {
        case 'client':
          return config.clientName
        case 'pickPack':
          return Number(draft?.pickPackFee ?? config.pickPackFee ?? 0)
        case 'additional':
          return Number(draft?.additionalUnitFee ?? config.additionalUnitFee ?? 0)
        case 'packageMarkup':
          return Number(draft?.packageCostMarkup ?? config.packageCostMarkup ?? 0)
        case 'shipPct':
          return Number(draft?.shippingMarkupPct ?? config.shippingMarkupPct ?? 0)
        case 'shipFlat':
          return Number(draft?.shippingMarkupFlat ?? config.shippingMarkupFlat ?? 0)
        case 'storage':
          return Number(draft?.storageFeePerCuFt ?? config.storageFeePerCuFt ?? 0)
        case 'maxUnits':
          return Number(draft?.pickPackMaxUnits ?? config.pickPackMaxUnits ?? 0)
        case 'mode':
          return draft?.billingMode ?? config.billingMode ?? ''
        case 'active':
          return draft?.active ?? config.active ?? true
        default:
          return ''
      }
    },
    (config) => config.clientName,
  ), [configDrafts, configSort, configs])
  const sortedPackagePricingRows = useMemo(() => sortRows(
    packagePricingRows,
    packagePricingSort,
    (row, key) => {
      switch (key) {
        case 'box':
          return row.name
        case 'dims':
          return row.dimsText
        case 'cost':
          return row.ourCost
        case 'charge':
          return Number(packagePriceDrafts[row.packageId] ?? row.charge ?? 0)
        case 'margin':
          return row.marginPct
        default:
          return ''
      }
    },
    (row) => row.name,
  ), [packagePriceDrafts, packagePricingRows, packagePricingSort])
  const sortedSummaryRows = useMemo(() => sortRows(
    summaryRows,
    summarySort,
    (row, key) => {
      switch (key) {
        case 'client':
          return row.clientName
        case 'orders':
          return row.orderCount
        case 'pickPack':
          return row.pickPackTotal
        case 'additional':
          return row.additionalTotal
        case 'package':
          return row.packageTotal
        case 'storage':
          return row.storageTotal
        case 'shipping':
          return row.shippingTotal
        case 'total':
          return row.grandTotal
        default:
          return ''
      }
    },
    (row) => row.clientName,
  ), [summaryRows, summarySort])

  const summaryTotals = useMemo(() => buildBillingSummaryTotals(summaryRows), [summaryRows])
  const visibleDetailColumns = useMemo(() => getVisibleBillingDetailColumns(detailColumnIds), [detailColumnIds])
  // Collapse per-lineType API rows into one row per order. Without this
  // the same order shows up 2-5 times in the table — once per fee type
  // — which is what we're fixing here.
  const mergedDetailRows = useMemo(
    () => aggregateBillingDetailRowsByOrder(detailState.rows),
    [detailState.rows],
  )
  const sortedDetailRows = useMemo(() => sortRows(
    mergedDetailRows,
    detailSort,
    (row, key) => {
      const metrics = computeBillingDetailMetrics(row)

      switch (key) {
        case 'orderNumber':
          return row.orderNumber || row.orderId
        case 'shipDate':
          return row.shipDate ? new Date(row.shipDate) : null
        case 'carrierNickname':
          return row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
        case 'itemNames':
          return row.itemNames || row.description
        case 'itemSkus':
          return row.itemSkus
        case 'totalQty':
          return row.totalQty || row.qty
        case 'pickpack':
          return metrics.pickPack
        case 'additional':
          return metrics.additional
        case 'packageCost':
          return metrics.packageCost
        case 'packageName':
          return row.packageName
        case 'bestRate':
          return row.actualLabelCost
        case 'upsss':
          return row.ref_ups_rate
        case 'uspsss':
          return row.ref_usps_rate
        case 'shipping':
          return metrics.shipping
        case 'total':
          return metrics.total
        case 'margin':
          return metrics.margin
        default:
          return ''
      }
    },
    (row) => row.orderNumber || row.id,
  ), [detailSort, mergedDetailRows])
  const summaryPageCount = Math.max(1, Math.ceil(sortedSummaryRows.length / summaryPageSize))
  const currentSummaryPage = Math.min(Math.max(summaryPage, 1), summaryPageCount)
  const pagedSummaryRows = useMemo(() => {
    const start = (currentSummaryPage - 1) * summaryPageSize
    return sortedSummaryRows.slice(start, start + summaryPageSize)
  }, [currentSummaryPage, sortedSummaryRows, summaryPageSize])
  const detailPageCount = Math.max(1, Math.ceil(sortedDetailRows.length / detailPageSize))
  const currentDetailPage = Math.min(Math.max(detailPage, 1), detailPageCount)
  const detailRowOffset = (currentDetailPage - 1) * detailPageSize
  const pagedDetailRows = useMemo(() => {
    const start = (currentDetailPage - 1) * detailPageSize
    return sortedDetailRows.slice(start, start + detailPageSize)
  }, [currentDetailPage, detailPageSize, sortedDetailRows])
  const detailTotals = useMemo(() => {
    // Totals iterate the merged rows so we don't double-count an order
    // whose pick_pack and shipping arrived as separate API rows. Each
    // merged row holds the per-lineType subtotals on a single object.
    return mergedDetailRows.reduce((acc, row) => {
      const metrics = computeBillingDetailMetrics(row)
      return {
        pickPack: acc.pickPack + metrics.pickPack,
        additional: acc.additional + metrics.additional,
        packageCost: acc.packageCost + metrics.packageCost,
        shipping: acc.shipping + metrics.shipping,
        total: acc.total + metrics.total,
        margin: acc.margin + metrics.margin,
      }
    }, { pickPack: 0, additional: 0, packageCost: 0, shipping: 0, total: 0, margin: 0 })
  }, [mergedDetailRows])

  useEffect(() => {
    return () => {
      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(getBillingDetailColumnStorageKey(), JSON.stringify(detailColumnIds))
  }, [detailColumnIds])

  useEffect(() => {
    setSummaryPage(1)
  }, [from, to])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedSummaryRows.length / summaryPageSize))
    setSummaryPage((current) => Math.min(current, maxPage))
  }, [sortedSummaryRows.length, summaryPageSize])

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(sortedDetailRows.length / detailPageSize))
    setDetailPage((current) => Math.min(current, maxPage))
  }, [sortedDetailRows.length, detailPageSize])

  useEffect(() => {
    setSummaryPage(1)
  }, [summarySort])

  useEffect(() => {
    setDetailPage(1)
  }, [detailSort])

  function handleConfigSort(key: string) {
    setConfigSort((current) => nextSortState(current, key))
  }

  function handlePackagePricingSort(key: string) {
    setPackagePricingSort((current) => nextSortState(current, key))
  }

  function handleSummarySort(key: string) {
    setSummaryPage(1)
    setSummarySort((current) => nextSortState(current, key))
  }

  function handleDetailSort(key: BillingDetailColumnId) {
    setDetailPage(1)
    setDetailSort((current) => nextSortState(current, key))
  }

  useEffect(() => {
    let active = true

    const loadConfigs = async () => {
      setConfigsLoading(true)

      try {
        const [nextConfigs, nextPackages] = await Promise.all([
          apiClient.fetchBillingConfigs(),
          apiClient.fetchPackages().catch(() => [] as PackageDto[]),
        ])

        if (!active) return

        setConfigs(nextConfigs)
        setConfigDrafts(createBillingConfigDraftMap(nextConfigs))
        setPackages(nextPackages)

        setSelectedPkgClientId((current) => {
          if (current && nextConfigs.some((config) => String(config.clientId) === current)) return current
          return nextConfigs.length > 0 ? String(nextConfigs[0].clientId) : ''
        })
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load billing config', 'error')
      } finally {
        if (active) setConfigsLoading(false)
      }
    }

    void loadConfigs()

    return () => {
      active = false
    }
  }, [toastContext])

  useEffect(() => {
    if (!selectedPkgClientId) return

    let active = true

    const loadPackagePrices = async () => {
      setPackagePricingLoading(true)
      setPackagePricingError(null)

      try {
        const rows = await apiClient.fetchBillingPackagePrices(Number(selectedPkgClientId))
        if (!active) return

        setSavedPackagePrices(rows)
        const nextRows = buildBillingPackagePriceRows(packages, rows)
        setPackagePriceDrafts(Object.fromEntries(nextRows.map((row) => [row.packageId, (Number(row.charge) || 0).toFixed(2)])))
      } catch (error) {
        if (!active) return
        setSavedPackagePrices([])
        setPackagePriceDrafts({})
        setPackagePricingError(error instanceof Error ? error.message : 'Failed to load package prices')
      } finally {
        if (active) setPackagePricingLoading(false)
      }
    }

    void loadPackagePrices()

    return () => {
      active = false
    }
  }, [packages, selectedPkgClientId])

  useEffect(() => {
    if (!from || !to) return

    let active = true

    const loadSummary = async () => {
      setSummaryLoading(true)
      setSummaryError(null)

      try {
        const rows = await apiClient.fetchBillingSummary(from, to)
        if (!active) return
        setSummaryRows(rows)
      } catch (error) {
        if (!active) return
        setSummaryRows([])
        setSummaryError(error instanceof Error ? error.message : 'Error loading summary')
      } finally {
        if (active) setSummaryLoading(false)
      }
    }

    void loadSummary()

    return () => {
      active = false
    }
  }, [from, to])

  async function handleSaveConfig(clientId: number) {
    const draft = configDrafts[clientId]
    if (!draft) return

    try {
      await apiClient.updateBillingConfig(clientId, buildBillingConfigInput(draft))
      setConfigs((current) => current.map((config) => config.clientId === clientId ? {
        ...config,
        ...buildBillingConfigInput(draft),
      } : config))
      toastContext?.addToast('✅ Config saved', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save config', 'error')
    }
  }

  async function handleGenerateBilling() {
    if (!from || !to) {
      toastContext?.addToast('Select a date range first', 'error')
      return
    }

    setGenerateLoading(true)
    setGenerateStatus('')

    try {
      const result = await apiClient.generateBilling(from, to)
      toastContext?.addToast(`✅ Generated ${result.generated} billing line items`, 'success')

      const rows = await apiClient.fetchBillingSummary(from, to)
      const totals = buildBillingSummaryTotals(rows)
      setGenerateStatus(buildGenerateBillingStatus(result.generated, totals.grand))
      setSummaryRows(rows)
      setSummaryError(null)
      const detailTarget =
        detailState.open && detailState.clientId
          ? rows.find((row) => row.clientId === detailState.clientId)
          : rows.find((row) => (row.orderCount || 0) > 0 || (row.grandTotal || row.total || 0) > 0)
      if (detailTarget) {
        await handleLoadDetails(detailTarget.clientId, detailTarget.clientName)
      }
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to generate billing', 'error')
    } finally {
      setGenerateLoading(false)
    }
  }

  async function handleLoadDetails(clientId: number, clientName: string) {
    setDetailPage(1)
    setDetailState({
      open: true,
      loading: true,
      clientId,
      clientName,
      rows: [],
      error: null,
    })

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        detailWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
    }

    try {
      const rows = await apiClient.fetchBillingDetails(from, to, clientId)
      setDetailState({
        open: true,
        loading: false,
        clientId,
        clientName,
        rows,
        error: null,
      })
    } catch (error) {
      setDetailState({
        open: true,
        loading: false,
        clientId,
        clientName,
        rows: [],
        error: error instanceof Error ? error.message : 'Error loading details',
      })
    }
  }

  async function handleSavePackagePrices() {
    if (!selectedPkgClientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }

    try {
      await apiClient.saveBillingPackagePrices({
        clientId: Number(selectedPkgClientId),
        prices: packagePricingRows.map((row) => ({
          packageId: row.packageId,
          price: Number.parseFloat(packagePriceDrafts[row.packageId] ?? String(row.charge)) || 0,
        })),
      })

      setSavedPackagePrices(packagePricingRows.map((row) => ({
        packageId: row.packageId,
        price: Number.parseFloat(packagePriceDrafts[row.packageId] ?? String(row.charge)) || 0,
        is_custom: row.isCustom ? 1 : 0,
        name: row.name,
        length: packages.find((pkg) => pkg.packageId === row.packageId)?.length ?? null,
        width: packages.find((pkg) => pkg.packageId === row.packageId)?.width ?? null,
        height: packages.find((pkg) => pkg.packageId === row.packageId)?.height ?? null,
      })))
      toastContext?.addToast('Package prices saved ✓', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Error saving prices', 'error')
    }
  }

  async function handleFetchRefRates() {
    setFetchRefRunning(true)
    setFetchRefStatus('Starting…')

    try {
      const result = await apiClient.fetchBillingReferenceRates()
      const nextStatus = buildFetchRefRatesStartText(result)
      setFetchRefStatus(nextStatus)

      if (result.total === 0) {
        setFetchRefRunning(false)
        return
      }

      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)

      fetchRefPollRef.current = setInterval(() => {
        void apiClient.fetchBillingReferenceRateStatus()
          .then((status) => {
            setFetchRefStatus(buildFetchRefRatesProgressText(status))

            if (!status.running) {
              if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
              fetchRefPollRef.current = null
              setFetchRefStatus(buildFetchRefRatesDoneText(status))
              setFetchRefRunning(false)
              toastContext?.addToast(`Ref rates fetched: ${status.done} rate combos`, 'success')
            }
          })
          .catch(() => {
            if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
            fetchRefPollRef.current = null
            setFetchRefStatus('Error — check console')
            setFetchRefRunning(false)
            toastContext?.addToast('Failed to start ref rate fetch', 'error')
          })
      }, 5000)
    } catch (error) {
      if (fetchRefPollRef.current) clearInterval(fetchRefPollRef.current)
      fetchRefPollRef.current = null
      setFetchRefStatus('Error — check console')
      setFetchRefRunning(false)
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to start ref rate fetch', 'error')
    }
  }

  async function handleBackfillRefRates() {
    setBackfillLoading(true)

    try {
      const result = await apiClient.backfillBillingReferenceRates({ from, to })
      toastContext?.addToast(buildBackfillRefRatesToast(result), 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Backfill failed', 'error')
    } finally {
      setBackfillLoading(false)
    }
  }

  function handleExportInvoice(clientId: number, clientName: string) {
    if (!from || !to) {
      toastContext?.addToast('⚠ Select a date range first', 'error')
      return
    }

    toastContext?.addToast(`📄 Opening invoice for ${clientName || 'client'}…`, 'success')
    void apiClient.openBillingInvoice(clientId, from, to).then((ok) => {
      if (!ok) {
        toastContext?.addToast('Failed to open invoice — check console', 'error')
      }
    })
  }

  return (
    <div id="view-billing" className="view-content !p-5 !overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-center gap-3 mb-5"
      >
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md ring-1 ring-emerald-400/20">
          <Receipt size={20} strokeWidth={2.25} className="text-white" />
        </div>
        <div>
          <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight">Billing Dashboard</h2>
          <p className="text-tiny text-ink-3 mt-0.5">Per-client billing config, package pricing and invoice history</p>
        </div>
      </motion.div>

      <div className="billing-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
        <div className="markup-card">
          <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Client Billing Config</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)' }}>
                  <SortableHeader sortKey="client" sortState={configSort} onSort={handleConfigSort} style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Client</SortableHeader>
                  <SortableHeader sortKey="pickPack" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Pick&amp;Pack</SortableHeader>
                  <SortableHeader sortKey="additional" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Addl Unit</SortableHeader>
                  <SortableHeader sortKey="packageMarkup" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }} title="Markup applied to package cost line items (percent on top of the base package price)">Pkg %</SortableHeader>
                  <SortableHeader sortKey="shipPct" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Ship %</SortableHeader>
                  <SortableHeader sortKey="shipFlat" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Ship $</SortableHeader>
                  <SortableHeader sortKey="storage" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }} title="Storage fee in dollars per cubic-foot per month (applied to on-hand inventory)">Storage $/cuft</SortableHeader>
                  <SortableHeader sortKey="maxUnits" sortState={configSort} onSort={handleConfigSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }} title="Max units included in the Pick & Pack base fee — orders at or below this count pay only pickPackFee; excess units are billed at additionalUnitFee">Max Units</SortableHeader>
                  <SortableHeader sortKey="mode" sortState={configSort} onSort={handleConfigSort} align="center" style={{ padding: '5px 8px', textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }}>Mode</SortableHeader>
                  <SortableHeader sortKey="active" sortState={configSort} onSort={handleConfigSort} align="center" style={{ padding: '5px 8px', textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px' }} title="Disable billing for this client (line items won't be generated)">Active</SortableHeader>
                  <th style={{ padding: '5px 4px', textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)' }} />
                </tr>
              </thead>
              <tbody>
                {configsLoading ? (
                  <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>Loading…</td></tr>
                ) : sortedConfigs.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>No clients found.</td></tr>
                ) : sortedConfigs.map((config) => {
                  const draft = configDrafts[config.clientId]

                  return (
                    <tr key={config.clientId}>
                      <td style={{ padding: '4px 8px', fontWeight: 600, fontSize: 11.5 }}>{config.clientName}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 60, textAlign: 'right', fontSize: 11.5 }}
                          value={draft?.pickPackFee ?? '0.00'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], pickPackFee: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 60, textAlign: 'right', fontSize: 11.5 }}
                          value={draft?.additionalUnitFee ?? '0.00'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], additionalUnitFee: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 55, textAlign: 'right', fontSize: 11.5 }}
                          title="Markup applied to package cost lines (percent)"
                          value={draft?.packageCostMarkup ?? '0.0'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], packageCostMarkup: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 55, textAlign: 'right', fontSize: 11.5 }}
                          value={draft?.shippingMarkupPct ?? '0.0'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], shippingMarkupPct: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 60, textAlign: 'right', fontSize: 11.5 }}
                          value={draft?.shippingMarkupFlat ?? '0.00'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], shippingMarkupFlat: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 60, textAlign: 'right', fontSize: 11.5 }}
                          title="$/cuft/month storage fee applied to inventory on hand"
                          value={draft?.storageFeePerCuFt ?? '0.00'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], storageFeePerCuFt: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="1"
                          min="1"
                          className="markup-input-lg"
                          style={{ width: 54, textAlign: 'right', fontSize: 11.5 }}
                          title="Orders with total units ≤ this value pay only the base Pick & Pack fee; excess units are billed at the Addl Unit rate"
                          value={draft?.pickPackMaxUnits ?? '1'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], pickPackMaxUnits: event.target.value },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                        <select
                          className="ship-select"
                          style={{ fontSize: 10, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border)' }}
                          value={draft?.billingMode ?? 'per_shipment'}
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], billingMode: event.target.value },
                          }))}
                        >
                          <option value="label_cost">Label Cost</option>
                          <option value="ss_ref_rate">SS Ref Rate ★</option>
                          <option value="per_shipment">Per Shipment</option>
                          <option value="monthly">Monthly</option>
                        </select>
                      </td>
                      <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={draft?.active !== false}
                          title="Disable to skip billing-line generation for this client"
                          onChange={(event) => setConfigDrafts((current) => ({
                            ...current,
                            [config.clientId]: { ...current[config.clientId], active: event.target.checked },
                          }))}
                        />
                      </td>
                      <td style={{ padding: '4px 4px', textAlign: 'center' }}>
                        <button className="btn btn-outline btn-xs" type="button" onClick={() => void handleSaveConfig(config.clientId)}>Save</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="markup-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', margin: 0 }}>Package Pricing by Client</h3>
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <select className="filter-sel" style={{ fontSize: 12 }} value={selectedPkgClientId} onChange={(event) => setSelectedPkgClientId(event.target.value)}>
                <option value="">Select client…</option>
                {configs.map((config) => (
                  <option key={config.clientId} value={config.clientId}>{config.clientName}</option>
                ))}
              </select>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleSavePackagePrices()}>Save</button>
            </div>
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 320 }}>
            {!selectedPkgClientId ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Select a client to view pricing</div>
            ) : packagePricingLoading ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Loading…</div>
            ) : packagePricingError ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--red)', fontSize: 12 }}>{packagePricingError}</div>
            ) : sortedPackagePricingRows.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>No custom packages found</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)' }}>
                    <SortableHeader sortKey="box" sortState={packagePricingSort} onSort={handlePackagePricingSort} style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Box</SortableHeader>
                    <SortableHeader sortKey="dims" sortState={packagePricingSort} onSort={handlePackagePricingSort} align="center" style={{ padding: '5px 8px', textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Dims</SortableHeader>
                    <SortableHeader sortKey="cost" sortState={packagePricingSort} onSort={handlePackagePricingSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Our Cost</SortableHeader>
                    <SortableHeader sortKey="charge" sortState={packagePricingSort} onSort={handlePackagePricingSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Charge</SortableHeader>
                    <SortableHeader sortKey="margin" sortState={packagePricingSort} onSort={handlePackagePricingSort} align="right" style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.3px', whiteSpace: 'nowrap' }}>Margin</SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedPackagePricingRows.map((row) => (
                    <tr key={row.packageId} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 600, fontSize: 12 }}>
                        {row.name}
                        {row.isCustom ? (
                          <span title="Custom override — won't be changed by Set Default" style={{ fontSize: 9, color: 'var(--ss-blue)', marginLeft: 4, fontWeight: 600, letterSpacing: '.3px' }}>CUSTOM</span>
                        ) : null}
                      </td>
                      <td style={{ padding: '5px 8px', textAlign: 'center', fontSize: 11, color: 'var(--text3)' }}>{row.dimsText}</td>
                      <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 11.5 }}>
                        {row.ourCost == null ? (
                          <span style={{ color: 'var(--text4)', fontSize: 10.5 }}>not set</span>
                        ) : (
                          <span style={{ color: 'var(--text2)' }}>${row.ourCost.toFixed(3)}</span>
                        )}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="markup-input-lg"
                          style={{ width: 62, textAlign: 'right', fontSize: 12 }}
                          value={packagePriceDrafts[row.packageId] ?? (Number(row.charge) || 0).toFixed(2)}
                          onChange={(event) => setPackagePriceDrafts((current) => ({
                            ...current,
                            [row.packageId]: event.target.value,
                          }))}
                        />
                      </td>
                      <td style={{ padding: '5px 8px', textAlign: 'right' }}>{getPackageMarginMarkup(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="markup-card">
        <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 12 }}>Generate &amp; Summary</h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {([
              ['this_month', 'This Month'],
              ['last_month', 'Last Month'],
              ['last_30', 'Last 30 Days'],
              ['last_90', 'Last 90 Days'],
            ] as Array<[BillingPresetId, string]>).map(([preset, label]) => (
              <button
                key={preset}
                className={`btn btn-outline btn-sm analysis-preset${activePreset === preset ? ' active' : ''}`}
                type="button"
                onClick={() => {
                  const range = getBillingPresetRange(preset)
                  setActivePreset(preset)
                  setFrom(range.from)
                  setTo(range.to)
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text2)' }}>
            <span>From</span>
            <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={from} onChange={(event) => setFrom(event.target.value)} />
            <span>To</span>
            <input type="date" className="ship-select" style={{ width: 140, fontSize: 12 }} value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleGenerateBilling()} disabled={generateLoading}>
            {generateLoading ? '⏳ Generating…' : '⚡ Generate Invoices'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            title="Populate SS USPS/UPS reference rates from rate cache"
            disabled={backfillLoading}
            onClick={() => void handleBackfillRefRates()}
          >
            {backfillLoading ? '↺ Backfilling…' : '↺ Backfill Ref Rates'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            title="Re-fetch live SS USPS/UPS reference rates for all reference_rate clients (runs in background)"
            disabled={fetchRefRunning}
            onClick={() => void handleFetchRefRates()}
          >
            ⚡ Fetch Ref Rates
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text3)', marginLeft: 4 }}>{fetchRefStatus}</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{generateStatus}</span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)' }}>
                <SortableHeader sortKey="client" sortState={summarySort} onSort={handleSummarySort} style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Client</SortableHeader>
                <SortableHeader sortKey="orders" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Orders</SortableHeader>
                <SortableHeader sortKey="pickPack" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Pick &amp; Pack</SortableHeader>
                <SortableHeader sortKey="additional" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Addl Units</SortableHeader>
                <SortableHeader sortKey="package" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Box Cost</SortableHeader>
                <SortableHeader sortKey="storage" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Storage</SortableHeader>
                <SortableHeader sortKey="shipping" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Shipping</SortableHeader>
                <SortableHeader sortKey="total" sortState={summarySort} onSort={handleSummarySort} align="right" style={{ padding: '7px 10px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Total</SortableHeader>
              </tr>
            </thead>
            <tbody>
              {summaryLoading ? (
                <tr><td colSpan={SUMMARY_COL_COUNT} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Loading…</td></tr>
              ) : summaryError ? (
                <tr><td colSpan={SUMMARY_COL_COUNT} style={{ padding: 24, textAlign: 'center', color: 'var(--red)' }}>{summaryError}</td></tr>
              ) : sortedSummaryRows.length === 0 ? (
                <tr><td colSpan={SUMMARY_COL_COUNT} style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>No billing data. Generate invoices first.</td></tr>
              ) : (
                <>
                  {pagedSummaryRows.map((row) => (
                    <tr key={row.clientId} className="billing-summary-row" onClick={() => void handleLoadDetails(row.clientId, row.clientName)}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: 'var(--ss-blue)' }}>
                        <span className="billing-summary-client-cell">
                          {row.clientName}
                          <button
                            className="btn btn-ghost btn-xs"
                            type="button"
                            title="Export invoice as PDF"
                            style={{ marginLeft: 6, fontSize: 10, padding: '1px 6px', opacity: 0.7 }}
                            onClick={(event) => {
                              event.stopPropagation()
                              handleExportInvoice(row.clientId, row.clientName)
                            }}
                          >
                            📄 Export
                          </button>
                        </span>
                      </td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{row.orderCount || 0}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{formatBillingMoney(row.pickPackTotal || 0)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{formatBillingMoney(row.additionalTotal || 0)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{formatBillingMoney(row.packageTotal || 0, { dashIfZero: true })}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{formatBillingMoney(row.storageTotal || 0, { dashIfZero: true })}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text2)' }}>{formatBillingMoney(row.shippingTotal || 0)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: 'var(--green)' }}>{formatBillingMoney(row.grandTotal || 0)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 700 }}>Total</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{summaryTotals.orders}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(summaryTotals.pickPack)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(summaryTotals.additional)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(summaryTotals.package, { dashIfZero: true })}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(summaryTotals.storage, { dashIfZero: true })}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(summaryTotals.shipping)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800, color: 'var(--green)', fontSize: 13 }}>{formatBillingMoney(summaryTotals.grand)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        {!summaryLoading && !summaryError && summaryRows.length > 0 ? (
          <AnalysisPagination
            page={summaryPage}
            pageSize={summaryPageSize}
            pageSizeOptions={BILLING_SUMMARY_PAGE_SIZE_OPTIONS}
            totalItems={summaryRows.length}
            onPageChange={setSummaryPage}
            onPageSizeChange={(nextSize) => {
              setSummaryPageSize(nextSize)
              setSummaryPage(1)
            }}
            unitLabel="clients"
            ariaLabel="Billing summary table pagination"
          />
        ) : null}

        {detailState.open ? (
          <div ref={detailWrapRef} style={{ display: 'block', marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Line Items — {detailState.clientName}</h3>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setDetailState((current) => ({ ...current, open: false }))}>✕ Close</button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
              {BILLING_DETAIL_COLUMNS.filter((column) => !column.always).map((column) => {
                const active = detailColumnIds.includes(column.id)
                return (
                  <button
                    key={column.id}
                    type="button"
                    className={`billing-detail-toggle${active ? ' active' : ''}`}
                    onClick={() => setDetailColumnIds((current) => toggleBillingDetailColumnIds(current, column.id))}
                  >
                    {column.label}
                  </button>
                )
              })}
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {visibleDetailColumns.map((column) => {
                      // Drag-over highlight: a 2px brand-blue left
                      // border previews where the dragged column will
                      // land. Drop semantics are "insert BEFORE this
                      // target," so the border lives on the left edge.
                      const isDropTarget = dragOverColumnId === column.id
                      return (
                        <SortableHeader
                          key={column.id}
                          sortKey={column.id}
                          sortState={detailSort}
                          onSort={handleDetailSort}
                          align={column.align}
                          draggable
                          onDragStart={(event) => handleColumnDragStart(column.id, event)}
                          onDragOver={(event) => handleColumnDragOver(column.id, event)}
                          onDrop={(event) => handleColumnDrop(column.id, event)}
                          onDragEnd={handleColumnDragEnd}
                          title={`${column.label} — drag to reorder, click to sort`}
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: 'var(--text3)',
                            textTransform: 'uppercase',
                            letterSpacing: '.4px',
                            padding: '6px 10px',
                            background: 'var(--surface2)',
                            borderBottom: '2px solid var(--border)',
                            borderLeft: isDropTarget ? '2px solid var(--ss-blue)' : '2px solid transparent',
                            textAlign: column.align,
                            cursor: 'grab',
                            userSelect: 'none',
                          }}
                        >
                          {column.label}
                        </SortableHeader>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {detailState.loading ? (
                    <tr><td colSpan={visibleDetailColumns.length} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>Loading…</td></tr>
                  ) : detailState.error ? (
                    <tr><td colSpan={visibleDetailColumns.length} style={{ padding: 20, textAlign: 'center', color: 'var(--red)' }}>{detailState.error}</td></tr>
                  ) : detailState.rows.length === 0 ? (
                    <tr><td colSpan={visibleDetailColumns.length} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>No line items found.</td></tr>
                  ) : (
                    <>
                      {pagedDetailRows.map((row, pageRowIndex) => {
                        const rowIndex = detailRowOffset + pageRowIndex
                        const metrics = computeBillingDetailMetrics(row)
                        const rowKey = row.id ?? `${row.orderId ?? 'storage'}-${row.lineType ?? 'detail'}-${row.description ?? rowIndex}-${rowIndex}`
                        const lineLabel = row.itemNames || row.description || ''

                        return (
                          <tr key={rowKey} style={{ borderBottom: '1px solid var(--border)' }} className={metrics.ssCharged ? 'billing-detail-ss-row' : undefined}>
                            {visibleDetailColumns.map((column) => {
                              if (column.id === 'orderNumber') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', fontWeight: 600, color: 'var(--ss-blue)' }}>
                                    {row.orderId ? (
                                      <button
                                        type="button"
                                        className="inventory-inline-button"
                                        title="Open order detail"
                                        onClick={() => setOrderDetailModalId(row.orderId)}
                                      >
                                        {row.orderNumber}
                                      </button>
                                    ) : (
                                      <span style={{ color: 'var(--text2)' }}>{row.orderNumber || 'Storage'}</span>
                                    )}
                                  </td>
                                )
                              }

                              if (column.id === 'shipDate') {
                                return <td key={column.id} style={{ padding: '5px 10px', color: 'var(--text2)', fontSize: 11 }}>{formatBillingDateTime(row.shipDate)}</td>
                              }

                              if (column.id === 'carrierNickname') {
                                const carrierText = row.carrierNickname || row.providerAccountNickname || row.carrier_nickname || row.provider_account_nickname || row.carrierCode || row.carrier_code || ''
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', color: carrierText ? 'var(--text)' : 'var(--text4)', fontSize: 11, fontWeight: carrierText ? 600 : 400 }}>
                                    {carrierText || '-'}
                                  </td>
                                )
                              }

                              if (column.id === 'itemNames') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', fontSize: 11, maxWidth: 220 }}>
                                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lineLabel}>
                                      {lineLabel ? lineLabel.split(' | ').map((name, index) => (
                                        <div key={`${rowKey}-name-${index}`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                                      )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                                    </div>
                                  </td>
                                )
                              }

                              if (column.id === 'itemSkus') {
                                const skuText = row.itemSkus || ''
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', fontFamily: 'monospace', fontSize: 10.5, color: 'var(--text2)' }}>
                                    {skuText ? skuText.split(' | ').map((sku, index) => (
                                      <div key={`${row.orderId}-sku-${index}`}>{sku || '—'}</div>
                                    )) : <span style={{ color: 'var(--text4)' }}>—</span>}
                                  </td>
                                )
                              }

                              if (column.id === 'totalQty') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right' }}>{row.totalQty || row.qty || 0}</td>
                              }

                              if (column.id === 'pickpack') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right' }}>{formatBillingMoney(metrics.pickPack)}</td>
                              }

                              if (column.id === 'additional') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right' }}>{formatBillingMoney(metrics.additional, { dashIfZero: true })}</td>
                              }

                              if (column.id === 'packageCost') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right' }}>{formatBillingMoney(metrics.packageCost, { dashIfZero: true })}</td>
                              }

                              if (column.id === 'packageName') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'center', fontSize: 10.5, color: 'var(--text2)' }}>{row.packageName || '—'}</td>
                              }

                              if (column.id === 'bestRate') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11 }} className={metrics.chargedRate === 'bestRate' ? 'billing-detail-rate-hit' : undefined}>
                                    {formatBillingMoney(row.actualLabelCost, { dashIfZero: true })}
                                  </td>
                                )
                              }

                              if (column.id === 'upsss') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11, color: row.ref_ups_rate ? '#2563eb' : undefined }} className={metrics.chargedRate === 'upsss' ? 'billing-detail-rate-hit' : undefined}>
                                    {formatBillingMoney(row.ref_ups_rate, { dashIfZero: true })}
                                  </td>
                                )
                              }

                              if (column.id === 'uspsss') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11, color: row.ref_usps_rate ? '#16a34a' : undefined }} className={metrics.chargedRate === 'uspsss' ? 'billing-detail-rate-hit' : undefined}>
                                    {formatBillingMoney(row.ref_usps_rate, { dashIfZero: true })}
                                  </td>
                                )
                              }

                              if (column.id === 'shipping') {
                                return (
                                  <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right' }}>
                                    {metrics.ssCharged ? (
                                      <>
                                        <span style={{ color: '#b45309', fontWeight: 600 }}>{formatBillingMoney(metrics.shipping)}</span>
                                        <span style={{ fontSize: 9, color: 'var(--text3)', marginLeft: 3 }}>↑SS</span>
                                      </>
                                    ) : (
                                      formatBillingMoney(metrics.shipping)
                                    )}
                                  </td>
                                )
                              }

                              if (column.id === 'total') {
                                return <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 700, color: 'var(--green)' }}>{formatBillingMoney(metrics.total)}</td>
                              }

                              return (
                                <td key={column.id} style={{ padding: '5px 10px', textAlign: 'right', fontSize: 11, color: marginColor(metrics.margin), fontWeight: 600 }}>
                                  {metrics.margin > 0 ? '+' : ''}${metrics.margin.toFixed(2)}
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}

                      <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }}>
                        {visibleDetailColumns.map((column) => {
                          if (column.id === 'orderNumber') return <td key={column.id} style={{ padding: '6px 10px', fontWeight: 700 }}>Total</td>
                          if (column.id === 'pickpack') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(detailTotals.pickPack)}</td>
                          if (column.id === 'additional') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(detailTotals.additional, { dashIfZero: true })}</td>
                          if (column.id === 'packageCost') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(detailTotals.packageCost, { dashIfZero: true })}</td>
                          if (column.id === 'shipping') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{formatBillingMoney(detailTotals.shipping)}</td>
                          if (column.id === 'total') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 800, color: 'var(--green)' }}>{formatBillingMoney(detailTotals.total)}</td>
                          if (column.id === 'margin') return <td key={column.id} style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: marginColor(detailTotals.margin) }}>${detailTotals.margin.toFixed(2)}</td>
                          return <td key={column.id} />
                        })}
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
            {!detailState.loading && !detailState.error && detailState.rows.length > 0 ? (
              <AnalysisPagination
                page={detailPage}
                pageSize={detailPageSize}
                pageSizeOptions={BILLING_DETAIL_PAGE_SIZE_OPTIONS}
                totalItems={detailState.rows.length}
                onPageChange={setDetailPage}
                onPageSizeChange={(nextSize) => {
                  setDetailPageSize(nextSize)
                  setDetailPage(1)
                }}
                unitLabel="line items"
                ariaLabel="Billing line items table pagination"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <OrderDetailDrawer
        orderId={orderDetailModalId}
        presentation="modal"
        closeLabel="Close"
        closeTitle="Close order details"
        onClose={() => setOrderDetailModalId(null)}
      />
    </div>
  )
}
