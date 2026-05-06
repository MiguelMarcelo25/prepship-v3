// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { motion } from 'framer-motion'
import { Boxes } from 'lucide-react'
import { apiClient, ApiError } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import { useInitStores } from '../../hooks'
import OrderDetailDrawer from '../OrderDetailDrawer'
import type {
  ClientDto,
  CreateParentSkuResult,
  InventoryAlertDto,
  InventoryItemDto,
  InventoryLedgerEntryDto,
  InventorySkuOrdersDto,
  PackageDto,
  ParentSkuDto,
  UpdateClientInput,
  UpdateInventoryItemInput,
} from '../../types/api'
import {
  applyReceiveSkuInput,
  buildBulkDimensionUpdates,
  buildInventoryLedgerQuery,
  buildReceiveItems,
  createReceiveDraftRow,
  filterInventoryRows,
  getInventoryCuFt,
  getInventoryDateRangePreset,
  getReceiveRowHints,
  groupInventoryRowsByClient,
  type InventoryTab,
  type ReceiveDraftRow,
  type ReceiveSkuLookup,
} from './inventory-parity'
import './InventoryView.css'

type AdjustType = 'receive' | 'return' | 'damage' | 'adjust'
type AdjustSign = 1 | -1

interface ClientFormState {
  clientId: string
  name: string
  contactName: string
  email: string
  phone: string
  storeIds: string
  rateSourceClientId: string
}

interface EditSkuFormState {
  invSkuId: number
  sku: string
  clientId: number
  minStock: string
  weightOz: string
  unitsPerPack: string
  parentSkuId: string
  baseUnitQty: string
  packageLength: string
  packageWidth: string
  packageHeight: string
  productLength: string
  productWidth: string
  productHeight: string
  packageId: string
  cuFtOverride: string
  previousParentSkuId: number | null
}

interface CreateParentFormState {
  clientId: number
  name: string
  sku: string
  baseUnitQty: string
}

interface AdjustModalState {
  invSkuId: number
  sku: string
  qty: string
  note: string
  date: string
  type: AdjustType
  sign: AdjustSign
}

interface ThumbnailPreviewState {
  src: string
  left: number
  top: number
  zoom: number
}

function formatWeight(ounces: number | null | undefined) {
  if (!ounces) return '—'
  const pounds = Math.floor(ounces / 16)
  const remaining = Math.round((ounces % 16) * 10) / 10
  if (pounds === 0) return `${remaining} oz`
  if (remaining === 0) return `${pounds} lb`
  return `${pounds} lb ${remaining} oz`
}

function formatDateTime(value: number | string | null | undefined) {
  if (value == null) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString()
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString()
}

function createClientFormState(client?: ClientDto | null): ClientFormState {
  return {
    clientId: client ? String(client.clientId) : '',
    name: client?.name ?? '',
    contactName: client?.contactName ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    storeIds: client?.storeIds?.join(', ') ?? '',
    rateSourceClientId: client?.rateSourceClientId ? String(client.rateSourceClientId) : '',
  }
}

function createEditSkuFormState(item: InventoryItemDto): EditSkuFormState {
  return {
    invSkuId: item.id,
    sku: item.sku,
    clientId: item.clientId,
    minStock: String(item.minStock ?? 0),
    weightOz: String(item.weightOz ?? 0),
    unitsPerPack: String(item.units_per_pack ?? 1),
    parentSkuId: item.parentSkuId ? String(item.parentSkuId) : '',
    baseUnitQty: String(item.baseUnitQty ?? 1),
    packageLength: String(item.packageLength ?? 0),
    packageWidth: String(item.packageWidth ?? 0),
    packageHeight: String(item.packageHeight ?? 0),
    productLength: String(item.productLength ?? 0),
    productWidth: String(item.productWidth ?? 0),
    productHeight: String(item.productHeight ?? 0),
    packageId: item.packageId ? String(item.packageId) : '',
    cuFtOverride: item.cuFtOverride && item.cuFtOverride > 0 ? String(item.cuFtOverride) : '0',
    previousParentSkuId: item.parentSkuId,
  }
}

function drawSkuSalesChart(canvas: HTMLCanvasElement, dailySales: InventorySkuOrdersDto['dailySales']) {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const parentWidth = canvas.parentElement?.clientWidth ?? 0
  const width = Math.max(260, Math.floor(rect.width || parentWidth || 320))
  const height = Math.max(140, Math.floor(rect.height || 160))
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = '100%'
  canvas.style.maxWidth = '100%'
  canvas.style.height = `${height}px`

  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(dpr, dpr)

  const styles = getComputedStyle(document.documentElement)
  const colorBackground = styles.getPropertyValue('--surface2').trim() || '#f5f5f5'
  const colorGrid = styles.getPropertyValue('--border').trim() || '#e0e0e0'
  const colorText = styles.getPropertyValue('--text3').trim() || '#888'
  const colorBar = '#e07a00'
  const colorToday = '#ff9a1f'

  const padLeft = 36
  const padRight = 8
  const padTop = 10
  const padBottom = 28
  const chartWidth = width - padLeft - padRight
  const chartHeight = height - padTop - padBottom
  const maxValue = Math.max(...dailySales.map((row) => row.units), 1)
  const totalBars = dailySales.length || 1
  const barWidth = Math.max(2, (chartWidth / totalBars) * 0.72)
  const gap = chartWidth / totalBars
  const today = new Date().toISOString().slice(0, 10)

  context.fillStyle = colorBackground
  context.fillRect(0, 0, width, height)

  context.strokeStyle = colorGrid
  context.lineWidth = 1
  context.setLineDash([3, 3])
  for (let grid = 0; grid <= 3; grid += 1) {
    const y = padTop + chartHeight - (grid / 3) * chartHeight
    context.beginPath()
    context.moveTo(padLeft, y)
    context.lineTo(padLeft + chartWidth, y)
    context.stroke()

    if (grid > 0) {
      context.fillStyle = colorText
      context.font = '10px system-ui, sans-serif'
      context.textAlign = 'right'
      context.fillText(String(Math.round((grid / 3) * maxValue)), padLeft - 4, y + 3.5)
    }
  }
  context.setLineDash([])

  dailySales.forEach((row, index) => {
    const currentBarHeight = row.units > 0 ? Math.max(2, (row.units / maxValue) * chartHeight) : 0
    const x = padLeft + index * gap + (gap - barWidth) / 2
    const y = padTop + chartHeight - currentBarHeight
    const isToday = row.day === today

    context.fillStyle = isToday ? colorToday : colorBar
    if (currentBarHeight > 0) {
      const radius = Math.min(3, barWidth / 2)
      context.beginPath()
      context.moveTo(x + radius, y)
      context.lineTo(x + barWidth - radius, y)
      context.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius)
      context.lineTo(x + barWidth, y + currentBarHeight)
      context.lineTo(x, y + currentBarHeight)
      context.lineTo(x, y + radius)
      context.quadraticCurveTo(x, y, x + radius, y)
      context.closePath()
      context.fill()
    }

    if (currentBarHeight > 14 && row.units > 0) {
      context.fillStyle = '#fff'
      context.font = 'bold 9px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText(String(row.units), x + barWidth / 2, y + 10)
    }

    const showLabel = index % 5 === 0 || isToday || index === totalBars - 1
    if (showLabel) {
      context.fillStyle = isToday ? colorBar : colorText
      context.font = isToday ? 'bold 9px system-ui, sans-serif' : '9px system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText(row.day.slice(5), x + barWidth / 2, height - 6)
    }
  })
}

function positionThumbnailPreview(cursorX: number, cursorY: number) {
  const zoom = (Number.parseFloat(document.body.style.zoom) || 100) / 100
  const width = 170
  const height = 170
  const gap = 14
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const rawLeft = cursorX + gap + width > viewportWidth ? cursorX - width - gap : cursorX + gap
  const rawTop = cursorY + gap + height > viewportHeight ? cursorY - height - gap : cursorY + gap

  return {
    left: rawLeft / zoom,
    top: rawTop / zoom,
    zoom: 1 / zoom,
  }
}

interface InventoryViewProps {
  searchQuery?: string
  onOpenOrder?: (orderId: number, status?: string | null) => void
}

export default function InventoryView({ onOpenOrder }: InventoryViewProps = {}) {
  const toastContext = useContext(ToastContext)
  const { stores } = useInitStores()
  const historyDefaults = useMemo(() => getInventoryDateRangePreset(), [])
  // Extend InventoryTab union locally to include ported v2 tabs (alerts, parents)
  const [activeTab, setActiveTab] = useState<InventoryTab | 'alerts' | 'parents'>('stock')
  const [clients, setClients] = useState<ClientDto[]>([])
  const [packages, setPackages] = useState<PackageDto[]>([])
  const [items, setItems] = useState<InventoryItemDto[]>([])
  const [alerts, setAlerts] = useState<InventoryAlertDto[]>([])
  const [ledger, setLedger] = useState<InventoryLedgerEntryDto[]>([])
  const [stockLoading, setStockLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [stockSearch, setStockSearch] = useState('')
  const [stockClientId, setStockClientId] = useState('')
  const [alertOnly, setAlertOnly] = useState(false)
  const [bulkEditMode, setBulkEditMode] = useState(false)
  const [bulkDrafts, setBulkDrafts] = useState<Record<number, { weightOz: string; productLength: string; productWidth: string; productHeight: string }>>({})
  const [receiveClientId, setReceiveClientId] = useState('')
  const [receiveNote, setReceiveNote] = useState('')
  const [receiveDate, setReceiveDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [receiveRows, setReceiveRows] = useState<ReceiveDraftRow[]>([createReceiveDraftRow()])
  const [receiveSkuMap, setReceiveSkuMap] = useState<Record<string, ReceiveSkuLookup>>({})
  const [receiveResultMessage, setReceiveResultMessage] = useState('')
  const [historyClientId, setHistoryClientId] = useState('')
  const [historyType, setHistoryType] = useState('')
  const [historyFrom, setHistoryFrom] = useState(historyDefaults.from)
  const [historyTo, setHistoryTo] = useState(historyDefaults.to)
  const [clientFormOpen, setClientFormOpen] = useState(false)
  const [clientForm, setClientForm] = useState<ClientFormState>(createClientFormState())
  const [clientSyncStatus, setClientSyncStatus] = useState('')
  // Per-client optimistic toggle override + pending flag. While the PATCH
  // /clients/:id call is in flight we paint the toggle in its target state
  // immediately (optimistic) and add an .is-pending class for the spinner
  // visual. On success the override is cleared (server data wins on the
  // refetch). On failure we revert and toast.
  const [clientActiveOverrides, setClientActiveOverrides] = useState<Record<number, boolean>>({})
  const [pendingClientToggleId, setPendingClientToggleId] = useState<number | null>(null)
  const [editSkuForm, setEditSkuForm] = useState<EditSkuFormState | null>(null)
  const [parentSkuOptions, setParentSkuOptions] = useState<Record<number, ParentSkuDto[]>>({})
  const [parentModal, setParentModal] = useState<CreateParentFormState | null>(null)
  const [adjustModal, setAdjustModal] = useState<AdjustModalState | null>(null)
  const [skuDrawer, setSkuDrawer] = useState<InventorySkuOrdersDto | null>(null)
  const [skuDrawerTitle, setSkuDrawerTitle] = useState('Loading…')
  const [skuDrawerError, setSkuDrawerError] = useState<string | null>(null)
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false)
  const [skuDrawerLoading, setSkuDrawerLoading] = useState(false)
  const [orderDetailModal, setOrderDetailModal] = useState<{ orderId: number; status?: string | null } | null>(null)
  const [thumbnailPreview, setThumbnailPreview] = useState<ThumbnailPreviewState | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // ─── Alerts tab state ──────────────────────────────────────────────────────
  const [alertsClientId, setAlertsClientId] = useState('')
  const [focusInvSkuId, setFocusInvSkuId] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({})

  // ─── Parent SKUs tab state ─────────────────────────────────────────────────
  const [parentsClientId, setParentsClientId] = useState('')
  const [parentsList, setParentsList] = useState<ParentSkuDto[]>([])
  const [parentsLoading, setParentsLoading] = useState(false)
  const [parentsCreateOpen, setParentsCreateOpen] = useState(false)
  const [parentsCreateForm, setParentsCreateForm] = useState<CreateParentFormState>({
    clientId: 0,
    name: '',
    sku: '',
    baseUnitQty: '1',
  })

  // ─── Inline-parent-assign state (per inventory row) ────────────────────────
  const [inlineParentRowId, setInlineParentRowId] = useState<number | null>(null)
  const [inlineParentSaving, setInlineParentSaving] = useState(false)

  useEffect(() => {
    if (!thumbnailPreview) return

    const handleMove = (event: MouseEvent) => {
      setThumbnailPreview((current) => {
        if (!current) return current
        return {
          ...current,
          ...positionThumbnailPreview(event.clientX, event.clientY),
        }
      })
    }

    document.addEventListener('mousemove', handleMove)
    return () => document.removeEventListener('mousemove', handleMove)
  }, [thumbnailPreview])

  const filteredRows = useMemo(() => {
    return filterInventoryRows(items, {
      search: stockSearch,
      clientId: stockClientId,
      alertOnly,
    })
  }, [alertOnly, items, stockClientId, stockSearch])

  const groupedRows = useMemo(() => groupInventoryRowsByClient(filteredRows), [filteredRows])
  const storeNameMap = useMemo(() => {
    const nextMap = new Map<number, string>()
    for (const store of stores) {
      nextMap.set(store.storeId, store.storeName)
    }
    return nextMap
  }, [stores])
  const rateSourceOptions = useMemo(() => {
    const currentClientId = Number.parseInt(clientForm.clientId, 10)
    const selectedRateSourceId = Number.parseInt(clientForm.rateSourceClientId, 10)
    return clients
      .filter((client) => {
        if (Number.isFinite(currentClientId) && client.clientId === currentClientId) return false
        return client.hasOwnAccount || client.clientId === selectedRateSourceId
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [clientForm.clientId, clientForm.rateSourceClientId, clients])

  useEffect(() => {
    let active = true

    const loadBootData = async () => {
      setBootError(null)
      setStockLoading(true)
      try {
        const [nextClients, nextPackages, nextAlerts] = await Promise.all([
          apiClient.fetchClients(),
          apiClient.fetchPackages('custom'),
          apiClient.fetchInventoryAlerts(),
        ])
        if (!active) return
        // v4 returns clients with `id`; v2 code reads `clientId`. Normalize.
        setClients((nextClients ?? []).map((c: any) => ({ ...c, clientId: c?.clientId ?? c?.id })))
        setPackages(nextPackages)
        setAlerts(nextAlerts)
      } catch (error) {
        if (!active) return
        setBootError(error instanceof Error ? error.message : 'Failed to load inventory view')
      }
    }

    void loadBootData()

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true

    const loadStock = async () => {
      setStockLoading(true)
      try {
        const nextItems = await apiClient.fetchInventory(stockClientId ? { clientId: Number.parseInt(stockClientId, 10) } : undefined)
        if (!active) return
        setItems(nextItems)
      } catch (error) {
        if (!active) return
        setBootError(error instanceof Error ? error.message : 'Failed to load inventory')
      } finally {
        if (active) setStockLoading(false)
      }
    }

    void loadStock()

    return () => {
      active = false
    }
  }, [stockClientId])

  useEffect(() => {
    if (activeTab !== 'history') return

    let active = true

    const loadHistory = async () => {
      setHistoryLoading(true)
      try {
        const nextLedger = await apiClient.fetchInventoryLedger(buildInventoryLedgerQuery({
          clientId: historyClientId,
          type: historyType,
          from: historyFrom,
          to: historyTo,
        }))
        if (!active) return
        setLedger(nextLedger)
      } catch (error) {
        if (!active) return
        setBootError(error instanceof Error ? error.message : 'Failed to load history')
      } finally {
        if (active) setHistoryLoading(false)
      }
    }

    void loadHistory()

    return () => {
      active = false
    }
  }, [activeTab, historyClientId, historyFrom, historyTo, historyType])

  useEffect(() => {
    let active = true

    const loadReceiveSkuMap = async () => {
      if (!receiveClientId) {
        setReceiveSkuMap({})
        setReceiveRows([createReceiveDraftRow()])
        return
      }

      try {
        const clientRows = await apiClient.fetchInventory({ clientId: Number.parseInt(receiveClientId, 10) })
        if (!active) return
        const nextMap: Record<string, ReceiveSkuLookup> = {}
        for (const row of clientRows) {
          nextMap[row.sku] = {
            invSkuId: row.id,
            name: row.name || '',
            unitsPerPack: row.units_per_pack || 1,
          }
        }
        setReceiveSkuMap(nextMap)
        setReceiveRows([createReceiveDraftRow()])
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load client SKUs', 'error')
      }
    }

    void loadReceiveSkuMap()

    return () => {
      active = false
    }
  }, [receiveClientId, toastContext])

  useEffect(() => {
    if (!skuDrawer || !canvasRef.current) return
    const canvas = canvasRef.current
    const redraw = () => drawSkuSalesChart(canvas, skuDrawer.dailySales)
    redraw()

    const resizeTarget = canvas.parentElement
    let observer: ResizeObserver | null = null
    if (resizeTarget && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(redraw)
      observer.observe(resizeTarget)
    }
    window.addEventListener('resize', redraw)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', redraw)
    }
  }, [skuDrawer])

  // Load parent SKUs whenever the Parent SKUs tab is active or its client filter changes.
  useEffect(() => {
    if (activeTab !== 'parents') return
    let active = true
    const load = async () => {
      setParentsLoading(true)
      try {
        const cid = parentsClientId ? Number.parseInt(parentsClientId, 10) : undefined
        // listParentSkus accepts clientId?; backend filters when provided.
        const rows = await apiClient.listParentSkus(cid as any)
        if (!active) return
        setParentsList(Array.isArray(rows) ? rows : [])
      } catch (error) {
        if (!active) return
        toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parent SKUs', 'error')
      } finally {
        if (active) setParentsLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [activeTab, parentsClientId, toastContext])

  // When switching to the Stock tab with a focused SKU, scroll + flash-highlight the row.
  useEffect(() => {
    if (activeTab !== 'stock' || !focusInvSkuId) return
    // Wait a tick for the stock rows to render.
    const timer = window.setTimeout(() => {
      const el = rowRefs.current[focusInvSkuId]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      // Clear the focus after 2.5s so the highlight fades.
      window.setTimeout(() => setFocusInvSkuId(null), 2500)
    }, 80)
    return () => window.clearTimeout(timer)
  }, [activeTab, focusInvSkuId, groupedRows])

  async function refreshInventoryView() {
    try {
      const [nextClients, nextAlerts, nextItems] = await Promise.all([
        apiClient.fetchClients(),
        apiClient.fetchInventoryAlerts(),
        apiClient.fetchInventory(stockClientId ? { clientId: Number.parseInt(stockClientId, 10) } : undefined),
      ])
      setClients((nextClients ?? []).map((c: any) => ({ ...c, clientId: c?.clientId ?? c?.id })))
      setAlerts(nextAlerts)
      setItems(nextItems)
      if (activeTab === 'history') {
        const nextLedger = await apiClient.fetchInventoryLedger(buildInventoryLedgerQuery({
          clientId: historyClientId,
          type: historyType,
          from: historyFrom,
          to: historyTo,
        }))
        setLedger(nextLedger)
      }
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Refresh failed', 'error')
    }
  }

  async function loadParentOptions(clientId: number) {
    if (parentSkuOptions[clientId]) return parentSkuOptions[clientId]
    const nextOptions = await apiClient.listParentSkus(clientId)
    setParentSkuOptions((current) => ({ ...current, [clientId]: nextOptions }))
    return nextOptions
  }

  function initializeBulkDrafts() {
    const nextDrafts: Record<number, { weightOz: string; productLength: string; productWidth: string; productHeight: string }> = {}
    for (const row of filteredRows) {
      nextDrafts[row.id] = {
        weightOz: String(row.weightOz ?? 0),
        productLength: String(row.productLength ?? 0),
        productWidth: String(row.productWidth ?? 0),
        productHeight: String(row.productHeight ?? 0),
      }
    }
    setBulkDrafts(nextDrafts)
  }

  async function handlePopulateInventory() {
    toastContext?.addToast('📥 Scanning orders for SKUs…')
    try {
      const result = await apiClient.populateInventory()
      toastContext?.addToast(`✅ Imported ${result.skusRegistered} SKUs, processed ${result.shippedProcessed} shipments`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Populate failed', 'error')
    }
  }

  async function handleImportDims() {
    toastContext?.addToast('📐 Importing weight & dims from ShipStation…')
    try {
      const result = await apiClient.importInventoryDimensions(stockClientId ? Number.parseInt(stockClientId, 10) : undefined)
      toastContext?.addToast(`✅ Updated ${result.updated} SKUs — ${result.skipped} already had dims, ${result.noMatch} not in SS catalog`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Import failed', 'error')
    }
  }

  async function handleSaveBulkDims() {
    try {
      const result = await apiClient.bulkUpdateInventoryDimensions(buildBulkDimensionUpdates(filteredRows, bulkDrafts))
      setBulkEditMode(false)
      toastContext?.addToast(`✅ Saved dims for ${result.updated} SKUs`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  async function openEditSku(item: InventoryItemDto) {
    try {
      await loadParentOptions(item.clientId)
      setEditSkuForm(createEditSkuFormState(item))
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parent SKUs', 'error')
    }
  }

  async function handleSaveSku() {
    if (!editSkuForm) return

    const updatePayload: UpdateInventoryItemInput = {
      name: items.find((row) => row.id === editSkuForm.invSkuId)?.name,
      minStock: Number.parseFloat(editSkuForm.minStock) || 0,
      weightOz: Number.parseFloat(editSkuForm.weightOz) || 0,
      length: Number.parseFloat(editSkuForm.packageLength) || 0,
      width: Number.parseFloat(editSkuForm.packageWidth) || 0,
      height: Number.parseFloat(editSkuForm.packageHeight) || 0,
      productLength: Number.parseFloat(editSkuForm.productLength) || 0,
      productWidth: Number.parseFloat(editSkuForm.productWidth) || 0,
      productHeight: Number.parseFloat(editSkuForm.productHeight) || 0,
      packageId: editSkuForm.packageId ? Number.parseInt(editSkuForm.packageId, 10) : null,
      units_per_pack: Math.max(1, Number.parseInt(editSkuForm.unitsPerPack, 10) || 1),
      cuFtOverride: (Number.parseFloat(editSkuForm.cuFtOverride) || 0) > 0 ? Number.parseFloat(editSkuForm.cuFtOverride) : null,
    }

    try {
      const nextParentSkuId = editSkuForm.parentSkuId ? Number.parseInt(editSkuForm.parentSkuId, 10) : null

      if (nextParentSkuId) {
        await apiClient.setInventoryParent(editSkuForm.invSkuId, {
          parentSkuId: nextParentSkuId,
          baseUnitQty: Math.max(1, Number.parseInt(editSkuForm.baseUnitQty, 10) || 1),
        })
      } else if (editSkuForm.previousParentSkuId) {
        await apiClient.setInventoryParent(editSkuForm.invSkuId, {
          parentSkuId: null,
        })
      }

      await apiClient.updateInventoryItem(editSkuForm.invSkuId, updatePayload)
      setEditSkuForm(null)
      toastContext?.addToast('✅ Saved', 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }

  async function handleCreateParent() {
    if (!parentModal) return
    if (!parentModal.name.trim()) {
      toastContext?.addToast('Parent name is required', 'error')
      return
    }

    try {
      const result: CreateParentSkuResult = await apiClient.createParentSku({
        clientId: parentModal.clientId,
        name: parentModal.name.trim(),
        sku: parentModal.sku.trim() || undefined,
        baseUnitQty: Math.max(1, Number.parseInt(parentModal.baseUnitQty, 10) || 1),
      })

      const nextOptions = await apiClient.listParentSkus(parentModal.clientId)
      setParentSkuOptions((current) => ({ ...current, [parentModal.clientId]: nextOptions }))
      setEditSkuForm((current) => {
        if (!current || current.clientId !== parentModal.clientId) return current
        return {
          ...current,
          parentSkuId: String(result.parentSkuId),
        }
      })
      setParentModal(null)
      toastContext?.addToast(`✅ Created parent: ${parentModal.name.trim()}`, 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to create parent', 'error')
    }
  }

  async function handleInlineParentChange(row: InventoryItemDto, nextValue: string) {
    setInlineParentSaving(true)
    try {
      const nextParentSkuId = nextValue ? Number.parseInt(nextValue, 10) : null
      await apiClient.setInventoryParent(row.id, { parentSkuId: nextParentSkuId })
      toastContext?.addToast(
        nextParentSkuId ? '✅ Parent SKU assigned' : '✅ Parent SKU cleared',
        'success',
      )
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to set parent SKU', 'error')
    } finally {
      setInlineParentSaving(false)
      setInlineParentRowId(null)
    }
  }

  async function handleCreateParentFromTab() {
    if (!parentsCreateForm.clientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }
    if (!parentsCreateForm.name.trim()) {
      toastContext?.addToast('Parent name is required', 'error')
      return
    }
    try {
      await apiClient.createParentSku({
        clientId: parentsCreateForm.clientId,
        name: parentsCreateForm.name.trim(),
        sku: parentsCreateForm.sku.trim() || undefined,
        baseUnitQty: Math.max(1, Number.parseInt(parentsCreateForm.baseUnitQty, 10) || 1),
      })
      toastContext?.addToast(`✅ Created parent: ${parentsCreateForm.name.trim()}`, 'success')
      setParentsCreateOpen(false)
      setParentsCreateForm({ clientId: parentsCreateForm.clientId, name: '', sku: '', baseUnitQty: '1' })
      // Reload list (also reset the cache so the edit-SKU modal sees it).
      setParentSkuOptions((current) => ({ ...current, [parentsCreateForm.clientId]: undefined as any }))
      const cid = parentsClientId ? Number.parseInt(parentsClientId, 10) : undefined
      const rows = await apiClient.listParentSkus(cid as any)
      setParentsList(Array.isArray(rows) ? rows : [])
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to create parent', 'error')
    }
  }

  async function handleReceiveSubmit() {
    if (!receiveClientId) {
      toastContext?.addToast('Select a client first', 'error')
      return
    }

    const itemsToReceive = buildReceiveItems(receiveRows, receiveSkuMap)
    if (!itemsToReceive.length) {
      toastContext?.addToast('Add at least one SKU with quantity', 'error')
      return
    }

    const receivedAt = receiveDate
      ? new Date(`${receiveDate}T12:00:00`).toISOString()
      : new Date().toISOString()

    try {
      const result = await apiClient.submitInventoryReceive({
        clientId: Number.parseInt(receiveClientId, 10),
        items: itemsToReceive,
        note: receiveNote.trim() || undefined,
        receivedAt,
      })

      const receivedRows = Array.isArray(result.received) ? result.received : []
      if (!result.ok || receivedRows.length === 0) {
        throw new Error(result.error || 'No inventory rows were received')
      }

      const dateLabel = new Date(receivedAt).toLocaleDateString()
      const failureNote = result.failed ? ` (${result.failed} failed)` : ''
      setReceiveResultMessage(`✅ Received ${receivedRows.length} SKU(s) on ${dateLabel}${failureNote}: ${receivedRows.map((row) => `${row.sku} (${row.qty} units → ${row.newStock} total)`).join(', ')}`)
      setHistoryClientId(receiveClientId)
      setHistoryType('receive')
      setHistoryFrom(receiveDate)
      setHistoryTo(receiveDate)
      setReceiveRows([createReceiveDraftRow()])
      setReceiveNote('')
      setReceiveDate(new Date().toISOString().slice(0, 10))
      await refreshInventoryView()
      toastContext?.addToast('Inventory received', 'success')
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Receive failed', 'error')
    }
  }

  async function handleSaveClient() {
    const rateSourceClientId = clientForm.rateSourceClientId ? Number.parseInt(clientForm.rateSourceClientId, 10) : null
    const currentClientId = clientForm.clientId ? Number.parseInt(clientForm.clientId, 10) : null
    const payload: UpdateClientInput = {
      name: clientForm.name.trim(),
      contactName: clientForm.contactName.trim(),
      email: clientForm.email.trim(),
      phone: clientForm.phone.trim(),
      storeIds: clientForm.storeIds
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10))
        .filter((value) => Number.isFinite(value)),
      rateSourceClientId,
    }

    if (!payload.name) {
      toastContext?.addToast('Client name is required', 'error')
      return
    }
    if (rateSourceClientId != null && currentClientId != null && rateSourceClientId === currentClientId) {
      toastContext?.addToast('Rate source must be a different client account', 'error')
      return
    }

    try {
      if (clientForm.clientId) {
        await apiClient.updateClientRecord(Number.parseInt(clientForm.clientId, 10), payload)
        toastContext?.addToast('✅ Client updated', 'success')
      } else {
        await apiClient.createClientRecord(payload)
        toastContext?.addToast(`✅ Client "${payload.name}" added`, 'success')
      }

      setClientFormOpen(false)
      setClientForm(createClientFormState())
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to save client', 'error')
    }
  }

  async function handleDeleteClient(client: ClientDto) {
    if (!window.confirm(`Delete client "${client.name}"? Their inventory records will be preserved.`)) return
    try {
      await apiClient.deleteClientRecord(client.clientId)
      toastContext?.addToast('✅ Client deleted', 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Delete failed', 'error')
    }
  }

  // Toggles the client's `active` flag — same behavior as the Test Orders
  // sidebar switch but per-client. Inactive clients are hidden from the
  // sidebar (init/stores already filters by active=true) and from the
  // sidebar bucket counts. Doesn't delete the client or its data.
  //
  // Optimistic UI: the toggle paints its target state immediately on click
  // (clientActiveOverrides), and the row gets an .is-pending visual
  // (pendingClientToggleId) so the user sees the slide animation right away
  // without waiting for the API round-trip. If the PATCH fails the override
  // is dropped (toggle snaps back) and a toast explains why.
  async function handleToggleClientActive(client: ClientDto) {
    if (pendingClientToggleId === client.clientId) return // ignore double-click while pending
    const next = !(client.active ?? true)
    setClientActiveOverrides((current) => ({ ...current, [client.clientId]: next }))
    setPendingClientToggleId(client.clientId)
    try {
      await apiClient.updateClientRecord(client.clientId, { active: next })
      toastContext?.addToast(
        `${next ? '✅' : '⏸️'} ${client.name} ${next ? 'enabled' : 'disabled'}`,
        'success'
      )
      await refreshInventoryView()
      // Drop the override — fresh server data is now authoritative.
      setClientActiveOverrides((current) => {
        const { [client.clientId]: _removed, ...rest } = current
        return rest
      })
    } catch (error) {
      // Revert: drop the override so the toggle snaps back to the server's
      // truth on next render.
      setClientActiveOverrides((current) => {
        const { [client.clientId]: _removed, ...rest } = current
        return rest
      })
      toastContext?.addToast(error instanceof Error ? error.message : 'Toggle failed', 'error')
    } finally {
      setPendingClientToggleId((current) => (current === client.clientId ? null : current))
    }
  }

  async function handleSyncClients() {
    setClientSyncStatus('Syncing…')
    try {
      const result = await apiClient.syncClientsFromStores()
      setClients(result.clients)
      setClientSyncStatus(`✅ ${result.clients.length} clients synced`)
      window.setTimeout(() => setClientSyncStatus(''), 4000)
    } catch (error) {
      setClientSyncStatus(error instanceof Error ? `⚠ Error: ${error.message}` : '⚠ Sync failed')
    }
  }

  async function openSkuDrawer(invSkuId: number) {
    setSkuDrawerOpen(true)
    setSkuDrawerLoading(true)
    setSkuDrawerError(null)
    setSkuDrawer(null)
    setSkuDrawerTitle('Loading…')
    try {
      const result = await apiClient.fetchInventorySkuOrders(invSkuId)
      setSkuDrawer(result)
      setSkuDrawerTitle(result.name || result.sku)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load SKU activity'
      setSkuDrawerError(message)
      setSkuDrawerTitle(error instanceof ApiError && error.status === 404 ? 'SKU not found' : 'Error')
    } finally {
      setSkuDrawerLoading(false)
    }
  }

  function openSkuDrawerOrder(order: InventorySkuOrdersDto['orders'][number]) {
    const orderId = Number(order?.orderId)
    if (!Number.isFinite(orderId) || orderId <= 0) return

    setOrderDetailModal({ orderId, status: order?.orderStatus ?? null })
  }

  async function handleAdjustSubmit() {
    if (!adjustModal) return
    const qty = Number.parseInt(adjustModal.qty, 10) || 0
    if (qty <= 0) {
      toastContext?.addToast('Enter a positive quantity', 'error')
      return
    }

    const signedQty = adjustModal.sign * qty
    const defaultNote = signedQty > 0 ? `Manual ${adjustModal.type}` : 'Manual remove'
    const adjustedAt = adjustModal.date
      ? new Date(`${adjustModal.date}T12:00:00`).toISOString()
      : new Date().toISOString()

    try {
      const result = await apiClient.submitInventoryAdjustment({
        invSkuId: adjustModal.invSkuId,
        qty: signedQty,
        note: adjustModal.note.trim() || defaultNote,
        type: adjustModal.type,
        adjustedAt,
      })
      setAdjustModal(null)
      toastContext?.addToast(`✅ ${adjustModal.type.charAt(0).toUpperCase()}${adjustModal.type.slice(1)} recorded on ${new Date(adjustedAt).toLocaleDateString()}. New total: ${result.newStock}`, 'success')
      await refreshInventoryView()
    } catch (error) {
      toastContext?.addToast(error instanceof Error ? error.message : 'Adjust failed', 'error')
    }
  }

  function showThumbnailPreview(src: string, event: ReactMouseEvent<HTMLImageElement>) {
    if (!src) return
    setThumbnailPreview({
      src,
      ...positionThumbnailPreview(event.clientX, event.clientY),
    })
  }

  return (
    <div id="view-inventory" className="view-content !p-5 !overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-center gap-4 mb-4 flex-wrap"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sky-500 to-sky-600 flex items-center justify-center shadow-md ring-1 ring-sky-400/20">
            <Boxes size={20} strokeWidth={2.25} className="text-white" />
          </div>
          <h2 className="text-[16px] font-extrabold text-ink font-display tracking-tight m-0">Inventory</h2>
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {([
            ['stock', 'Stock Levels'],
            ['receive', 'Receive'],
            ['alerts', alerts.length > 0 ? `Alerts (${alerts.length})` : 'Alerts'],
            ['parents', 'Parent SKUs'],
            ['clients', 'Clients'],
            ['history', 'History'],
          ] as Array<[InventoryTab | 'alerts' | 'parents', string]>).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              className={`inv-tab${activeTab === tab ? ' active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
        {alerts.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setActiveTab('stock')
              setAlertOnly(true)
            }}
            style={{ background: 'var(--red)', color: '#fff', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: 'none' }}
          >
            ⚠ {alerts.length} Low/Out
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        <button className="btn btn-outline btn-sm" type="button" onClick={handlePopulateInventory}>📥 Import SKUs from Orders</button>
        <button className="btn btn-outline btn-sm" type="button" onClick={handleImportDims} title="Pull weight & dims from ShipStation product catalog into inventory SKUs">📐 Import Dims from SS</button>
        <button
          className="btn btn-outline btn-sm"
          type="button"
          onClick={() => {
            if (bulkEditMode) {
              setBulkEditMode(false)
              return
            }
            initializeBulkDrafts()
            setBulkEditMode(true)
          }}
          style={bulkEditMode ? { background: 'var(--ss-blue)', color: '#fff', borderColor: 'var(--ss-blue)' } : undefined}
        >
          {bulkEditMode ? '✕ Exit Bulk' : '✏️ Bulk Edit'}
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => void refreshInventoryView()}>↻ Refresh</button>
      </motion.div>

      {bootError ? (
        <div className="empty-state" style={{ marginBottom: 12 }}>Error: {bootError}</div>
      ) : null}

      {activeTab === 'stock' ? (
        <div id="inv-panel-stock">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="search-wrap" style={{ flex: 1, maxWidth: 280 }}>
              <input
                type="text"
                value={stockSearch}
                onChange={(event) => setStockSearch(event.target.value)}
                placeholder="Filter SKU or name…"
                style={{ width: '100%' }}
              />
            </div>
            <select className="filter-sel" value={stockClientId} onChange={(event) => setStockClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <label style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={alertOnly} onChange={(event) => setAlertOnly(event.target.checked)} /> Low/Out only
            </label>
          </div>

          {bulkEditMode ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 12px', background: 'var(--ss-blue-bg)', border: '1px solid var(--ss-blue)', borderRadius: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--ss-blue)', fontWeight: 600, flex: 1 }}>✏️ Bulk Dims Mode — edit weight & dims inline, then save all at once</span>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveBulkDims}>💾 Save All</button>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setBulkEditMode(false)}>✕ Cancel</button>
            </div>
          ) : null}

          {stockLoading ? (
            <div className="loading"><div className="spinner" /><div style={{ fontSize: 12, marginTop: 4 }}>Loading inventory…</div></div>
          ) : groupedRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📭</div>
              <div>{alertOnly ? 'No low/out stock' : 'No SKUs found'}</div>
            </div>
          ) : (
            <div id="inv-stock-content">
              {groupedRows.map((group) => (
                <div key={group.clientId} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 6 }}>{group.clientName}</div>
                  {/* Tailwind-only table — see below for the full styling
                      story.

                      * NO overflow:hidden on this wrapper. Any overflow value
                        other than `visible` becomes the sticky element's
                        scroll container and silently breaks `position: sticky`
                        on the <th> cells.
                      * Wrapper provides bg + border + radius. The table inside
                        uses border-separate so individual cell sticky works
                        (border-collapse:collapse silently disables sticky on
                        <th> in all major browsers — known bug since 2017). */}
                  <div className="bg-surface ring-1 ring-line rounded-lg">
                    <table
                      className={[
                        // Layout
                        'w-full m-0 table-fixed border-separate border-spacing-0',

                        // ─── Header cells (sticky + styled) ───────────────
                        // top:-1px slides the 2px bottom border flush to the
                        // scroll-area top. z-10 sits above tbody but below
                        // modal overlays (which use z-[3000]+).
                        '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                        '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                        '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                        '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                        '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                        // Subtle 1px shadow under the sticky header so rows
                        // scrolling underneath have a visual separator.
                        '[&_thead_th]:shadow-[0_1px_0_var(--border)]',

                        // ─── Body cells ──────────────────────────────────
                        '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                        '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                        '[&_tbody_td]:overflow-hidden [&_tbody_td]:text-ellipsis',

                        // Last row: drop the bottom border so it doesn't
                        // double up against the wrapper's ring.
                        '[&_tbody_tr:last-child_td]:border-b-0',

                        // Hover state on body rows
                        '[&_tbody_tr:hover_td]:bg-surface-2',
                      ].join(' ')}
                    >
                      {/* colgroup pins column widths so EVERY client's table
                          renders the same layout — auto-sizing was the cause
                          of the visual drift between groups. */}
                      {bulkEditMode ? (
                        <colgroup>
                          <col style={{ width: 140 }} />
                          <col style={{ width: 48 }} />
                          <col />
                          <col style={{ width: 90 }} />
                          <col style={{ width: 72 }} />
                          <col style={{ width: 72 }} />
                          <col style={{ width: 72 }} />
                        </colgroup>
                      ) : (
                        <colgroup>
                          {/* SKU */}
                          <col style={{ width: 150 }} />
                          {/* Image */}
                          <col style={{ width: 56 }} />
                          {/* Name (flex) */}
                          <col />
                          {/* Weight */}
                          <col style={{ width: 90 }} />
                          {/* Dims */}
                          <col style={{ width: 100 }} />
                          {/* Cu Ft/Unit */}
                          <col style={{ width: 80 }} />
                          {/* Package */}
                          <col style={{ width: 110 }} />
                          {/* Stock */}
                          <col style={{ width: 70 }} />
                          {/* Sold 30d */}
                          <col style={{ width: 75 }} />
                          {/* Units/Pack */}
                          <col style={{ width: 85 }} />
                          {/* Total Units */}
                          <col style={{ width: 90 }} />
                          {/* Min */}
                          <col style={{ width: 55 }} />
                          {/* Status */}
                          <col style={{ width: 70 }} />
                          {/* Actions */}
                          <col style={{ width: 110 }} />
                        </colgroup>
                      )}
                      <thead>
                        {bulkEditMode ? (
                          <tr>
                            <th>SKU</th>
                            <th />
                            <th>Name</th>
                            <th>Wt (oz)</th>
                            <th>L (in)</th>
                            <th>W (in)</th>
                            <th>H (in)</th>
                          </tr>
                        ) : (
                          <tr>
                            <th>SKU</th>
                            <th />
                            <th>Name</th>
                            <th style={{ textAlign: 'right' }}>Weight</th>
                            <th style={{ textAlign: 'center' }}>Dims (L×W×H)</th>
                            <th style={{ textAlign: 'center' }} title="Cubic footage per unit (used for storage fee billing). Auto-computed from dims or manually overridden.">Cu Ft/Unit</th>
                            <th>Package</th>
                            <th style={{ textAlign: 'center' }}>Stock</th>
                            <th style={{ textAlign: 'center' }} title="Units sold in the last 30 days">Sold 30d</th>
                            <th style={{ textAlign: 'center' }}>Units/Pack</th>
                            <th style={{ textAlign: 'center' }}>Total Units</th>
                            <th style={{ textAlign: 'center' }}>Min</th>
                            <th style={{ textAlign: 'center' }}>Status</th>
                            <th />
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {group.rows.map((row) => {
                          if (bulkEditMode) {
                            const draft = bulkDrafts[row.id] ?? {
                              weightOz: String(row.weightOz ?? 0),
                              productLength: String(row.productLength ?? 0),
                              productWidth: String(row.productWidth ?? 0),
                              productHeight: String(row.productHeight ?? 0),
                            }
                            return (
                              <tr key={row.id}>
                                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{row.sku}</td>
                                <td style={{ padding: '4px 6px' }}>
                                  {row.imageUrl ? (
                                    <img src={row.imageUrl} style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                                  ) : (
                                    <div style={{ width: 32, height: 32, background: 'var(--surface3)', borderRadius: 4, border: '1px dashed var(--border)' }} />
                                  )}
                                </td>
                                <td style={{ fontSize: 11.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name || '—'}</td>
                                <td><input type="number" step="0.1" min="0" value={draft.weightOz} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, weightOz: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productLength} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productLength: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productWidth} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productWidth: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                                <td><input type="number" step="0.1" min="0" value={draft.productHeight} onChange={(event) => setBulkDrafts((current) => ({ ...current, [row.id]: { ...draft, productHeight: event.target.value } }))} style={{ padding: '3px 5px', border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--surface2)', color: 'var(--text)', fontSize: 11.5, width: '100%', boxSizing: 'border-box' }} /></td>
                              </tr>
                            )
                          }

                          const cuFt = getInventoryCuFt(row)
                          const isFocused = focusInvSkuId === row.id
                          return (
                            <tr
                              key={row.id}
                              ref={(el) => { rowRefs.current[row.id] = el }}
                              style={isFocused ? { background: 'var(--ss-blue-bg)', transition: 'background 1.5s ease' } : undefined}
                            >
                              <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>
                                <button type="button" className="inventory-inline-button" style={{ color: 'var(--ss-blue)' }} onClick={() => void openSkuDrawer(row.id)} title="View orders & sales trend">{row.sku}</button>
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                {row.imageUrl ? (
                                  <img
                                    src={row.imageUrl}
                                    style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5, display: 'block', cursor: 'zoom-in' }}
                                    onMouseEnter={(event) => showThumbnailPreview(row.imageUrl ?? '', event)}
                                    onMouseLeave={() => setThumbnailPreview(null)}
                                  />
                                ) : (
                                  <div style={{ width: 40, height: 40, background: 'var(--surface3)', border: '1px dashed var(--border)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--text4)', textAlign: 'center', lineHeight: 1.2 }}>no<br />img</div>
                                )}
                              </td>
                              <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                <button type="button" className="inventory-inline-button" onClick={() => void openSkuDrawer(row.id)} title="View orders & sales trend">{row.name || <span style={{ color: 'var(--text3)' }}>—</span>}</button>
                              </td>
                              <td style={{ textAlign: 'right', fontSize: 11.5 }}>{row.weightOz > 0 ? formatWeight(row.weightOz) : <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                              <td style={{ textAlign: 'center', fontSize: 11.5, fontFamily: 'monospace' }}>{row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0 ? `${row.packageLength}×${row.packageWidth}×${row.packageHeight}` : <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                              <td style={{ textAlign: 'center', fontSize: 11, color: 'var(--text3)' }}>
                                {cuFt > 0 ? (
                                  <span title={row.cuFtOverride && row.cuFtOverride > 0 ? 'Manual override' : 'Auto-computed from product dims'}>
                                    {cuFt.toFixed(3)}{row.cuFtOverride && row.cuFtOverride > 0 ? <span style={{ color: 'var(--ss-blue)', fontSize: 9, marginLeft: 2 }}>✎</span> : null}
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--text4)' }}>—</span>
                                )}
                              </td>
                              {/* Package column — falls back to the L×W×H
                                  dimensions when no named package is assigned.
                                  Previously showed "—" which left the cell
                                  empty even though the row already had usable
                                  dim data in the Dims column. */}
                              <td style={{ fontSize: 11.5 }}>
                                {row.packageName ? (
                                  row.packageName
                                ) : (row.packageLength > 0 || row.packageWidth > 0 || row.packageHeight > 0) ? (
                                  <span style={{ fontFamily: 'monospace', color: 'var(--text3)' }} title="No named package — showing product dims (L×W×H)">
                                    {row.packageLength}×{row.packageWidth}×{row.packageHeight}
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--text4)' }}>—</span>
                                )}
                              </td>
                              <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, color: row.currentStock <= 0 ? 'var(--red)' : 'var(--text)' }}>{row.currentStock}</td>
                              <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 12, color: (row.soldLast30Days ?? 0) > 0 ? 'var(--ss-blue)' : 'var(--text3)' }}>{row.soldLast30Days ?? 0}</td>
                              <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
                                {row.units_per_pack > 1 ? <span style={{ background: 'var(--ss-blue-bg)', color: 'var(--ss-blue)', fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4 }}>×{row.units_per_pack}</span> : '—'}
                              </td>
                              <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text2)' }}>{row.units_per_pack > 1 ? <span style={{ fontWeight: 700 }}>{row.currentStock * row.units_per_pack}</span> : '—'}</td>
                              <td style={{ textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>{row.minStock}</td>
                              <td style={{ textAlign: 'center' }}>
                                <span className={`stock-badge ${row.status === 'out' ? 'stock-out' : row.status === 'low' ? 'stock-low' : 'stock-ok'}`}>
                                  {row.status === 'out' ? 'OUT' : row.status === 'low' ? 'LOW' : 'OK'}
                                </span>
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <button className="btn btn-ghost btn-xs" type="button" onClick={() => void openEditSku(row)} title="Edit SKU details">✏️</button>
                                <button
                                  className="btn btn-ghost btn-xs"
                                  type="button"
                                  title={row.parentSkuId ? 'Change parent SKU' : 'Assign parent SKU'}
                                  onClick={async () => {
                                    try {
                                      await loadParentOptions(row.clientId)
                                      setInlineParentRowId((current) => (current === row.id ? null : row.id))
                                    } catch (error) {
                                      toastContext?.addToast(error instanceof Error ? error.message : 'Failed to load parents', 'error')
                                    }
                                  }}
                                  style={{ fontSize: 12, color: row.parentSkuId ? 'var(--ss-blue)' : 'var(--text3)' }}
                                >
                                  🔗
                                </button>
                                <button
                                  className="btn btn-ghost btn-xs"
                                  type="button"
                                  onClick={() => setAdjustModal({
                                    invSkuId: row.id,
                                    sku: row.sku,
                                    qty: '1',
                                    note: '',
                                    date: new Date().toISOString().slice(0, 10),
                                    type: 'receive',
                                    sign: 1,
                                  })}
                                  title="Add / Remove Stock"
                                  style={{ fontSize: 13, fontWeight: 700, color: 'var(--ss-blue)' }}
                                >
                                  +
                                </button>
                                {inlineParentRowId === row.id ? (
                                  <div style={{ display: 'inline-flex', gap: 4, marginLeft: 6, alignItems: 'center' }}>
                                    <select
                                      className="ship-select"
                                      style={{ fontSize: 11, padding: '2px 4px' }}
                                      defaultValue={row.parentSkuId ? String(row.parentSkuId) : ''}
                                      disabled={inlineParentSaving}
                                      onChange={(event) => void handleInlineParentChange(row, event.target.value)}
                                    >
                                      <option value="">— No Parent —</option>
                                      {(parentSkuOptions[row.clientId] ?? []).map((option) => (
                                        <option key={option.parentSkuId} value={option.parentSkuId}>{option.name}</option>
                                      ))}
                                    </select>
                                    <button className="btn btn-ghost btn-xs" type="button" onClick={() => setInlineParentRowId(null)} title="Close">✕</button>
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'receive' ? (
        <div id="inv-panel-receive">
          <div style={{ maxWidth: 640 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="ship-select" value={receiveClientId} style={{ flex: 1, maxWidth: 240 }} onChange={(event) => setReceiveClientId(event.target.value)}>
                <option value="">Select Client…</option>
                {clients.map((client) => (
                  <option key={client.clientId} value={client.clientId}>{client.name}</option>
                ))}
              </select>
              <input type="text" value={receiveNote} onChange={(event) => setReceiveNote(event.target.value)} className="ship-select" placeholder="Note (e.g. PO#, shipment ref)" style={{ flex: 1, maxWidth: 240 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                📅 Received On:
                <input type="date" value={receiveDate} onChange={(event) => setReceiveDate(event.target.value)} className="ship-select" style={{ fontSize: 11.5, padding: '4px 6px', width: 'auto' }} />
              </label>
            </div>
            <div id="inv-recv-rows">
              {receiveRows.map((row) => {
                const lookup = row.sku.trim() ? receiveSkuMap[row.sku.trim()] ?? null : null
                const hints = getReceiveRowHints(row, lookup)
                return (
                  <div key={row.id} className="inventory-recv-row">
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        type="text"
                        className="ship-select"
                        placeholder="SKU"
                        style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}
                        list="react-recv-sku-datalist"
                        value={row.sku}
                        onChange={(event) => {
                          const nextSku = event.target.value
                          setReceiveRows((current) => current.map((entry) => {
                            if (entry.id !== row.id) return entry
                            return applyReceiveSkuInput({ ...entry, sku: nextSku }, receiveSkuMap[nextSku.trim()] ?? null)
                          }))
                        }}
                      />
                      <input
                        type="text"
                        className="ship-select"
                        placeholder="Product name (auto-fills)"
                        style={{ fontSize: 12, flex: 2 }}
                        value={row.name}
                        onChange={(event) => {
                          const nextName = event.target.value
                          setReceiveRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, name: nextName, autofilledName: false } : entry))
                        }}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                        <input
                          type="number"
                          className="ship-select"
                          placeholder="Qty"
                          min="1"
                          style={{ width: 72, fontSize: 12, textAlign: 'center' }}
                          value={row.qty}
                          onChange={(event) => setReceiveRows((current) => current.map((entry) => entry.id === row.id ? { ...entry, qty: event.target.value } : entry))}
                        />
                        {hints.totalHint ? <span style={{ fontSize: 10, color: 'var(--ss-blue)', fontWeight: 700, whiteSpace: 'nowrap' }}>{hints.totalHint}</span> : null}
                      </div>
                      {hints.packHint ? <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap', alignSelf: 'flex-start', paddingTop: 6 }}>{hints.packHint}</span> : null}
                      <button className="btn btn-ghost btn-xs" type="button" onClick={() => setReceiveRows((current) => current.length === 1 ? [createReceiveDraftRow()] : current.filter((entry) => entry.id !== row.id))} title="Remove row" style={{ alignSelf: 'flex-start' }}>✕</button>
                    </div>
                  </div>
                )
              })}
              <datalist id="react-recv-sku-datalist">
                {Object.entries(receiveSkuMap).map(([sku, info]) => (
                  <option key={sku} value={sku}>{info.name || sku}</option>
                ))}
              </datalist>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setReceiveRows((current) => [...current, createReceiveDraftRow()])}>＋ Add SKU</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleReceiveSubmit} style={{ marginLeft: 'auto' }}>✅ Receive All</button>
            </div>
            {receiveResultMessage ? (
              <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--green)' }}>
                {receiveResultMessage}{' '}
                <button type="button" className="inventory-inline-button" style={{ color: 'var(--ss-blue)', textDecoration: 'underline' }} onClick={() => setActiveTab('history')}>
                  View History
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeTab === 'clients' ? (
        <div id="inv-panel-clients">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="button" onClick={() => {
              setClientFormOpen(true)
              setClientForm(createClientFormState())
            }}>
              ＋ Add Client
            </button>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => void handleSyncClients()}>↻ Sync from ShipStation</button>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>{clientSyncStatus}</span>
          </div>

          {clientFormOpen ? (
            <div style={{ display: '', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14, maxWidth: 540 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{clientForm.clientId ? 'Edit Client' : 'Add Client'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Client Name *</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.name} onChange={(event) => setClientForm((current) => ({ ...current, name: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Contact Name</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.contactName} onChange={(event) => setClientForm((current) => ({ ...current, contactName: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Email</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.email} onChange={(event) => setClientForm((current) => ({ ...current, email: event.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Phone</label>
                  <input type="text" className="ship-select" style={{ width: '100%' }} value={clientForm.phone} onChange={(event) => setClientForm((current) => ({ ...current, phone: event.target.value }))} />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Rate Source Account</label>
                  <select className="ship-select" style={{ width: '100%' }} value={clientForm.rateSourceClientId} onChange={(event) => setClientForm((current) => ({ ...current, rateSourceClientId: event.target.value }))}>
                    <option value="">DR PREPPER</option>
                    {rateSourceOptions.map((client) => (
                      <option key={client.clientId} value={client.clientId}>{client.name}</option>
                    ))}
                  </select>
                </div>
                {/* Chip-style storeIds editor — replaces the previous
                    comma-separated text input with individually-removable
                    chips so users can drop a single store ID without
                    counting commas. The underlying value is still stored
                    as a comma-separated string in clientForm.storeIds (so
                    handleSaveClient's existing parse logic still works);
                    this is purely a UI-layer transformation. */}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>ShipStation Store IDs</label>
                  {(() => {
                    const ids = clientForm.storeIds
                      .split(',')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0 && /^\d+$/.test(s))
                    const removeId = (target: string) => {
                      const next = ids.filter((id) => id !== target).join(', ')
                      setClientForm((current) => ({ ...current, storeIds: next }))
                    }
                    const addIdFromKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key !== 'Enter' && e.key !== ',' && e.key !== ' ') return
                      e.preventDefault()
                      const raw = (e.currentTarget.value ?? '').trim()
                      if (!raw || !/^\d+$/.test(raw) || ids.includes(raw)) {
                        e.currentTarget.value = ''
                        return
                      }
                      const next = [...ids, raw].join(', ')
                      setClientForm((current) => ({ ...current, storeIds: next }))
                      e.currentTarget.value = ''
                    }
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md ring-1 ring-line bg-surface min-h-[36px]">
                        {ids.length === 0 ? (
                          <span className="text-[11px] italic text-ink-3 px-1">No store IDs yet — type below to add</span>
                        ) : (
                          ids.map((id) => {
                            const storeName = storeNameMap.get(Number(id))
                            return (
                              <span
                                key={id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-brand/10 text-brand text-[11.5px] font-mono font-semibold ring-1 ring-brand/20"
                                title={storeName ? `Store: ${storeName}` : 'Unrecognized store ID'}
                              >
                                #{id}
                                {storeName ? (
                                  <span className="text-[10px] font-sans font-normal text-ink-3 not-italic">({storeName})</span>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => removeId(id)}
                                  className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded text-brand hover:text-white hover:bg-brand transition"
                                  aria-label={`Remove store ID ${id}`}
                                  title={`Remove ${id}`}
                                >
                                  ×
                                </button>
                              </span>
                            )
                          })
                        )}
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="\d*"
                          placeholder={ids.length === 0 ? 'e.g. 356678' : '+ add another'}
                          onKeyDown={addIdFromKey}
                          onBlur={(e) => {
                            const raw = e.currentTarget.value.trim()
                            if (raw && /^\d+$/.test(raw) && !ids.includes(raw)) {
                              setClientForm((current) => ({ ...current, storeIds: [...ids, raw].join(', ') }))
                            }
                            e.currentTarget.value = ''
                          }}
                          className="flex-1 min-w-[100px] px-1 py-0.5 text-[12px] bg-transparent border-0 outline-none text-ink placeholder:text-ink-3"
                        />
                      </div>
                    )
                  })()}
                  {/* Multi-store warning — explains the merge semantics so
                      users intentionally adding 2+ IDs know what they're
                      doing (and users who see 2+ existing IDs understand
                      why). */}
                  {clientForm.storeIds.split(',').filter((s) => s.trim()).length > 1 ? (
                    <div className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">
                      <span className="font-semibold text-amber-700">⚠ Multi-store client:</span>{' '}
                      Orders from all listed stores will roll up under this single client for billing, analytics, and reporting. Press <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">,</kbd> to add an ID; click <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">×</kbd> to remove one.
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">
                      Press <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded bg-surface-2 ring-1 ring-line text-[10px] font-mono">,</kbd> to add a store ID.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
                  setClientFormOpen(false)
                  setClientForm(createClientFormState())
                }}>
                  Cancel
                </button>
                <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveClient}>💾 Save Client</button>
              </div>
            </div>
          ) : null}

          {!clients.length ? (
            <div className="empty-state">
              <div className="empty-icon">🏢</div>
              <div style={{ marginBottom: 10 }}>No clients yet.</div>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleSyncClients()}>↻ Import from ShipStation Stores</button>
            </div>
          ) : (
            // Tailwind-only Clients table — sticky headers, theme-aware,
            // border-separate so sticky on <th> works (border-collapse:collapse
            // silently disables sticky in all major browsers).
            <div className="bg-surface ring-1 ring-line rounded-lg">
              <table
                className={[
                  'w-full m-0 border-separate border-spacing-0',
                  '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                  '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                  '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                  '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                  '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                  '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                  '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                  '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                  '[&_tbody_tr:last-child_td]:border-b-0',
                  '[&_tbody_tr:hover_td]:bg-surface-2',
                ].join(' ')}
              >
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    <th>Email</th>
                    <th>Store ID</th>
                    <th>Source</th>
                    <th>Rate Source</th>
                    <th style={{ textAlign: 'center', width: 70 }}>Active</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => {
                    const override = clientActiveOverrides[client.clientId]
                    const isActive = override !== undefined ? override : (client.active ?? true)
                    const isPending = pendingClientToggleId === client.clientId

                    // Source detection — infers the integration channel from
                    // the client name (matches our STORE_PROVIDERS naming
                    // convention) and falls back to "ShipStation" if storeIds
                    // exist (came from ShipStation sync) or "Manual" if neither
                    // a name pattern nor ShipStation IDs exist (added by hand).
                    // Color-coded badge so sources are scannable at a glance.
                    const lowerName = (client.name ?? '').toLowerCase()
                    const sourceInfo: { label: string; cls: string } = lowerName.includes('walmart')
                      ? { label: 'Walmart', cls: 'bg-blue-50 text-blue-700 ring-blue-200' }
                      : lowerName.includes('ebay')
                        ? { label: 'eBay', cls: 'bg-rose-50 text-rose-700 ring-rose-200' }
                        : lowerName.includes('amazon')
                          ? { label: 'Amazon', cls: 'bg-amber-50 text-amber-700 ring-amber-200' }
                          : lowerName.includes('shopify')
                            ? { label: 'Shopify', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' }
                            : lowerName.includes('etsy')
                              ? { label: 'Etsy', cls: 'bg-orange-50 text-orange-700 ring-orange-200' }
                              : lowerName.includes('tiktok')
                                ? { label: 'TikTok Shop', cls: 'bg-pink-50 text-pink-700 ring-pink-200' }
                                : lowerName.includes('woo') || lowerName.includes('woocomm')
                                  ? { label: 'WooCommerce', cls: 'bg-violet-50 text-violet-700 ring-violet-200' }
                                  : lowerName.includes('bigcomm') || lowerName.includes('bigcommerce')
                                    ? { label: 'BigCommerce', cls: 'bg-cyan-50 text-cyan-700 ring-cyan-200' }
                                    : client.storeIds.length > 0
                                      ? { label: 'ShipStation', cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200' }
                                      : { label: 'Manual', cls: 'bg-slate-100 text-slate-600 ring-slate-200' }

                    return (
                    <tr key={client.clientId} style={{ opacity: isActive ? 1 : 0.55, transition: 'opacity .28s ease' }}>
                      <td style={{ fontWeight: 600 }}>{client.name}</td>
                      <td style={{ fontSize: 12 }}>{client.contactName || '—'}</td>
                      <td style={{ fontSize: 12 }}>{client.email || '—'}</td>
                      {/* Store ID — each ID rendered as a small chip with
                          the resolved ShipStation store name in the tooltip
                          (so admins can hover to see what each ID maps to
                          without leaving the table). */}
                      <td>
                        {client.storeIds.length === 0 ? (
                          <span style={{ color: 'var(--text4)' }}>—</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {client.storeIds.map((id) => {
                              const storeName = storeNameMap.get(id)
                              return (
                                <span
                                  key={id}
                                  className="inline-flex items-center px-1.5 py-px rounded bg-surface-2 text-ink-2 text-[11px] font-mono font-semibold ring-1 ring-line/70"
                                  title={storeName ? `${storeName}` : 'Unrecognized store'}
                                >
                                  #{id}
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </td>
                      {/* Source — colored badge inferred from client name +
                          presence of storeIds. See sourceInfo computation
                          above. */}
                      <td>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10.5px] font-bold uppercase tracking-wide ring-1 ${sourceInfo.cls}`}
                          title={`Inferred from client name${client.storeIds.length ? ' + ShipStation store IDs' : ''}`}
                        >
                          {sourceInfo.label}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, fontWeight: 500 }}>{client.rateSourceName || 'DR PREPPER'}</td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          className={`ss-test-toggle${isActive ? ' is-on' : ' is-off'}${isPending ? ' is-pending' : ''}`}
                          aria-label={isActive ? `Disable ${client.name}` : `Enable ${client.name}`}
                          aria-busy={isPending}
                          title={isPending ? 'Saving…' : isActive ? `Disable ${client.name} (hide from sidebar + views)` : `Enable ${client.name}`}
                          onClick={() => void handleToggleClientActive(client)}
                          disabled={isPending}
                        >
                          <span className="ss-test-toggle-knob" />
                        </button>
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-xs" type="button" onClick={() => {
                          setClientFormOpen(true)
                          setClientForm(createClientFormState(client))
                        }}>
                          Edit
                        </button>
                        <button className="btn btn-ghost btn-xs" type="button" onClick={() => void handleDeleteClient(client)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'history' ? (
        <div id="inv-panel-history">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={historyClientId} onChange={(event) => setHistoryClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <select className="filter-sel" value={historyType} onChange={(event) => setHistoryType(event.target.value)}>
              <option value="">All Types</option>
              <option value="receive">Receive</option>
              <option value="ship">Ship</option>
              <option value="adjust">Adjust</option>
              <option value="return">Return</option>
              <option value="damage">Damage</option>
            </select>
            <input type="date" className="filter-sel" style={{ fontSize: 11.5, padding: '4px 6px', width: 'auto' }} value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} title="From date" />
            <span style={{ color: 'var(--text3)', fontSize: 11 }}>–</span>
            <input type="date" className="filter-sel" style={{ fontSize: 11.5, padding: '4px 6px', width: 'auto' }} value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} title="To date" />
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
              setHistoryFrom('')
              setHistoryTo('')
            }} title="Clear dates">
              ✕ Clear
            </button>
          </div>

          {historyLoading ? (
            <div className="loading"><div className="spinner" /></div>
          ) : !ledger.length ? (
            <div className="empty-state">No movements found</div>
          ) : (
            <div id="inv-history-content">
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Recent Movements</div>
              {/* Tailwind-only History table — same sticky pattern as
                  Stock Levels and Alerts above. NO overflow:hidden on the
                  wrapper (would silently disable sticky on the th cells),
                  table uses border-separate (border-collapse:collapse
                  silently disables sticky on th in all major browsers). */}
              <div className="bg-surface ring-1 ring-line rounded-lg">
                <table
                  className={[
                    'w-full m-0 border-separate border-spacing-0 text-[11.5px]',
                    // Sticky header cells
                    '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                    '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                    '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                    '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                    '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                    '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                    // Body cells
                    '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2',
                    '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                    '[&_tbody_tr:last-child_td]:border-b-0',
                    '[&_tbody_tr:hover_td]:bg-surface-2',
                  ].join(' ')}
                >
                  <thead>
                    <tr><th>Date</th><th>SKU</th><th>Type</th><th style={{ textAlign: 'right' }}>Qty</th><th>Note</th><th>Source</th></tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry) => {
                      const typeColor = entry.type === 'receive' ? 'var(--green)' : entry.type === 'adjust' ? 'var(--ss-blue)' : entry.type === 'ship' ? 'var(--red)' : entry.type === 'return' ? 'var(--yellow)' : entry.type === 'damage' ? 'var(--red)' : 'var(--text3)'
                      return (
                        <tr key={entry.id}>
                          <td style={{ color: 'var(--text3)' }}>{formatDateTime(entry.createdAt)}</td>
                          <td style={{ fontFamily: 'monospace' }}>{entry.sku || '—'}</td>
                          <td><span style={{ fontWeight: 700, color: typeColor, textTransform: 'capitalize' }}>{entry.type}</span></td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: entry.qty > 0 ? 'var(--green)' : 'var(--red)' }}>{entry.qty > 0 ? `+${entry.qty}` : entry.qty}</td>
                          <td style={{ color: 'var(--text2)' }}>{entry.note || '—'}</td>
                          <td style={{ color: 'var(--text3)' }}>{entry.createdBy || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'alerts' ? (
        <div id="inv-panel-alerts">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={alertsClientId} onChange={(event) => setAlertsClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>
              {(() => {
                const filtered = alertsClientId
                  ? alerts.filter((a: any) => String(a?.clientId ?? '') === alertsClientId)
                  : alerts
                const out = filtered.filter((a: any) => (a?.currentStock ?? a?.stockQty ?? 0) <= 0).length
                const low = filtered.length - out
                return `${out} out of stock • ${low} low`
              })()}
            </span>
          </div>

          {alerts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✅</div>
              <div>All stocked — no low/out SKUs.</div>
            </div>
          ) : (
            // Tailwind-only Alerts table — same sticky pattern as Stock
            // Levels above. Wrapper has NO overflow:hidden (would disable
            // sticky on the th cells), and the table uses border-separate
            // because border-collapse:collapse silently disables sticky on
            // th in all major browsers (known bug since 2017).
            <div className="bg-surface ring-1 ring-line rounded-lg">
              <table
                className={[
                  'w-full m-0 border-separate border-spacing-0',
                  // Sticky header cells
                  '[&_thead_th]:sticky [&_thead_th]:top-[-1px] [&_thead_th]:z-10',
                  '[&_thead_th]:bg-surface-2 [&_thead_th]:text-ink-3',
                  '[&_thead_th]:text-[10px] [&_thead_th]:font-extrabold [&_thead_th]:uppercase [&_thead_th]:tracking-[0.4px]',
                  '[&_thead_th]:text-left [&_thead_th]:px-2.5 [&_thead_th]:py-2',
                  '[&_thead_th]:border-b-2 [&_thead_th]:border-line [&_thead_th]:whitespace-nowrap',
                  '[&_thead_th]:shadow-[0_1px_0_var(--border)]',
                  // Body cells
                  '[&_tbody_td]:px-2.5 [&_tbody_td]:py-2 [&_tbody_td]:text-[12px]',
                  '[&_tbody_td]:border-b [&_tbody_td]:border-line [&_tbody_td]:align-middle',
                  // Drop bottom border on last row so it doesn't double up
                  '[&_tbody_tr:last-child_td]:border-b-0',
                  // Hover
                  '[&_tbody_tr:hover_td]:bg-surface-2',
                ].join(' ')}
              >
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Name</th>
                    <th>Client</th>
                    <th style={{ textAlign: 'center' }}>Current Stock</th>
                    <th style={{ textAlign: 'center' }}>Min Stock</th>
                    <th style={{ textAlign: 'center' }}>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(alertsClientId
                    ? alerts.filter((a: any) => String(a?.clientId ?? '') === alertsClientId)
                    : alerts
                  ).map((alert: any) => {
                    const stock = alert?.currentStock ?? alert?.stockQty ?? 0
                    const minStock = alert?.minStock ?? 0
                    const isOut = stock <= 0
                    const isLow = !isOut && minStock > 0 && stock <= minStock
                    const clientName = alert?.clientName
                      ?? clients.find((c) => c.clientId === alert?.clientId)?.name
                      ?? '—'
                    return (
                      <tr key={alert?.id ?? `${alert?.clientId}-${alert?.sku}`}>
                        <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{alert?.sku || '—'}</td>
                        <td style={{ fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert?.name || '—'}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{clientName}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700, fontSize: 13, color: isOut ? 'var(--red)' : 'var(--text)' }}>{stock}</td>
                        <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>{minStock}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`stock-badge ${isOut ? 'stock-out' : isLow ? 'stock-low' : 'stock-ok'}`}>
                            {isOut ? 'OUT' : isLow ? 'LOW' : 'OK'}
                          </span>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => {
                              if (alert?.clientId != null) {
                                setStockClientId(String(alert.clientId))
                              }
                              setAlertOnly(false)
                              setStockSearch('')
                              setFocusInvSkuId(alert?.id ?? null)
                              setActiveTab('stock')
                            }}
                            title="Jump to this SKU on the Stock tab"
                            style={{ color: 'var(--ss-blue)', fontWeight: 600 }}
                          >
                            Go to SKU →
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === 'parents' ? (
        <div id="inv-panel-parents">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="filter-sel" value={parentsClientId} onChange={(event) => setParentsClientId(event.target.value)}>
              <option value="">All Clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>{client.name}</option>
              ))}
            </select>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => {
                const defaultClient = parentsClientId
                  ? Number.parseInt(parentsClientId, 10)
                  : clients[0]?.clientId ?? 0
                setParentsCreateForm({
                  clientId: defaultClient,
                  name: '',
                  sku: '',
                  baseUnitQty: '1',
                })
                setParentsCreateOpen(true)
              }}
            >
              ＋ Create Parent SKU
            </button>
          </div>

          {parentsCreateOpen ? (
            <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 14, maxWidth: 560 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Create Parent SKU</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Client</label>
                  <select
                    className="ship-select"
                    style={{ width: '100%' }}
                    value={parentsCreateForm.clientId ? String(parentsCreateForm.clientId) : ''}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, clientId: Number.parseInt(event.target.value, 10) || 0 }))}
                  >
                    <option value="">Select client…</option>
                    {clients.map((client) => (
                      <option key={client.clientId} value={client.clientId}>{client.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Name *</label>
                  <input
                    type="text"
                    className="ship-select"
                    style={{ width: '100%' }}
                    placeholder="e.g., Banana Drink"
                    value={parentsCreateForm.name}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>SKU (optional)</label>
                  <input
                    type="text"
                    className="ship-select"
                    style={{ width: '100%', fontFamily: 'monospace' }}
                    placeholder="e.g., BANANA-DRINK-PARENT"
                    value={parentsCreateForm.sku}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, sku: event.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)' }}>Base Unit Qty</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    className="ship-select"
                    style={{ width: '100%' }}
                    value={parentsCreateForm.baseUnitQty}
                    onChange={(event) => setParentsCreateForm((current) => ({ ...current, baseUnitQty: event.target.value }))}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setParentsCreateOpen(false)}>Cancel</button>
                <button className="btn btn-primary btn-sm" type="button" onClick={() => void handleCreateParentFromTab()}>💾 Create</button>
              </div>
            </div>
          ) : null}

          {parentsLoading ? (
            <div className="loading"><div className="spinner" /></div>
          ) : !parentsList.length ? (
            <div className="empty-state">
              <div className="empty-icon">🧬</div>
              <div>No parent SKUs yet.</div>
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <table className="inv-table" style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>SKU</th>
                    <th>Client</th>
                    <th style={{ textAlign: 'center' }}>Base Unit Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {parentsList.map((parent: any) => {
                    const clientName = clients.find((c) => c.clientId === parent?.clientId)?.name ?? '—'
                    return (
                      <tr key={parent?.parentSkuId ?? parent?.id}>
                        <td style={{ fontWeight: 600, fontSize: 12 }}>{parent?.name || '—'}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 11.5 }}>{parent?.sku || <span style={{ color: 'var(--text4)' }}>—</span>}</td>
                        <td style={{ fontSize: 12, color: 'var(--text2)' }}>{clientName}</td>
                        <td style={{ textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>{parent?.baseUnitQty ?? 1}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {editSkuForm ? (
        <div className="inventory-overlay" onClick={() => setEditSkuForm(null)}>
          <div className="inventory-modal" onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Edit SKU Details</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 14, fontFamily: 'monospace' }}>{editSkuForm.sku}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Weight (oz)</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.weightOz} onChange={(event) => setEditSkuForm((current) => current ? { ...current, weightOz: event.target.value } : current)} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Min Stock</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.minStock} onChange={(event) => setEditSkuForm((current) => current ? { ...current, minStock: event.target.value } : current)} />
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="How many individual units are in one of this SKU (e.g. 10 for a 10-pack)">Units / Pack</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} min="1" step="1" value={editSkuForm.unitsPerPack} onChange={(event) => setEditSkuForm((current) => current ? { ...current, unitsPerPack: event.target.value } : current)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Parent SKU (for variants)</label>
                <select
                  className="ship-select"
                  style={{ width: '100%', fontSize: 12 }}
                  value={editSkuForm.parentSkuId}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === '__create__') {
                      setParentModal({
                        clientId: editSkuForm.clientId,
                        name: '',
                        sku: '',
                        baseUnitQty: '1',
                      })
                      return
                    }
                    setEditSkuForm((current) => current ? { ...current, parentSkuId: value } : current)
                  }}
                >
                  <option value="">— No Parent —</option>
                  {(parentSkuOptions[editSkuForm.clientId] ?? []).map((option) => (
                    <option key={option.parentSkuId} value={option.parentSkuId}>{option.name}</option>
                  ))}
                  <option value="__create__">➕ Create New Parent…</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="How many base units per pack (e.g. 6 for 6-pack, 12 for 12-pack). Used to calculate total inventory across variants.">Base Unit Qty (per pack)</label>
                <input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} min="1" step="1" value={editSkuForm.baseUnitQty} onChange={(event) => setEditSkuForm((current) => current ? { ...current, baseUnitQty: event.target.value } : current)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg L</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageLength} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageLength: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg W</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageWidth} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageWidth: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Pkg H</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageHeight} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageHeight: event.target.value } : current)} /></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod L</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productLength} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productLength: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod W</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productWidth} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productWidth: event.target.value } : current)} /></div>
              <div><label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Product dimensions for storage fee calculations">📦 Prod H</label><input type="number" className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.productHeight} onChange={(event) => setEditSkuForm((current) => current ? { ...current, productHeight: event.target.value } : current)} /></div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>📦 Shipping Package</label>
              <select className="ship-select" style={{ width: '100%', fontSize: 12 }} value={editSkuForm.packageId} onChange={(event) => setEditSkuForm((current) => current ? { ...current, packageId: event.target.value } : current)}>
                <option value="">— No Package —</option>
                {packages.map((pkg) => (
                  <option key={pkg.packageId} value={pkg.packageId}>{pkg.name} ({pkg.length}×{pkg.width}×{pkg.height})</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }} title="Override the auto-computed cubic footage based on product dims (L×W×H÷1728). Leave 0 to compute from product dimensions automatically.">
                Cu Ft Override <span style={{ color: 'var(--text4)', fontWeight: 400, textTransform: 'none' }}>(0 = auto from product dims)</span>
              </label>
              <input type="number" className="ship-select" style={{ width: 130, fontSize: 12 }} value={editSkuForm.cuFtOverride} onChange={(event) => setEditSkuForm((current) => current ? { ...current, cuFtOverride: event.target.value } : current)} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setEditSkuForm(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleSaveSku}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {parentModal ? (
        <div className="inventory-overlay" onClick={() => setParentModal(null)}>
          <div className="inventory-modal" onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Create Parent SKU</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Parent Name <span style={{ color: 'var(--red)' }}>*</span></label>
              <input type="text" className="ship-select" style={{ width: '100%', fontSize: 13 }} placeholder="e.g., Banana Drink" value={parentModal.name} onChange={(event) => setParentModal((current) => current ? { ...current, name: event.target.value } : current)} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Parent SKU Code <span style={{ color: 'var(--text4)', fontWeight: 400 }}>(optional)</span></label>
              <input type="text" className="ship-select" style={{ width: '100%', fontSize: 13, fontFamily: 'monospace' }} placeholder="e.g., BANANA-DRINK-PARENT" value={parentModal.sku} onChange={(event) => setParentModal((current) => current ? { ...current, sku: event.target.value } : current)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Base Unit Qty <span style={{ color: 'var(--text4)', fontWeight: 400 }}>(default: 1)</span></label>
              <input type="number" className="ship-select" style={{ width: '100%', fontSize: 13 }} min="1" step="1" value={parentModal.baseUnitQty} onChange={(event) => setParentModal((current) => current ? { ...current, baseUnitQty: event.target.value } : current)} />
              <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>Units per case (e.g., 6 for 6-pack, 1 for single units)</div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setParentModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleCreateParent}>Create</button>
            </div>
          </div>
        </div>
      ) : null}

      {adjustModal ? (
        <div className="inventory-overlay" onClick={() => setAdjustModal(null)}>
          <div className="inventory-modal" style={{ width: 380 }} onClick={(event) => event.stopPropagation()}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Inventory Entry</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14, fontFamily: 'monospace' }}>{adjustModal.sku}</div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Type</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {([
                  ['receive', '📦 Receive'],
                  ['return', '↩ Return'],
                  ['damage', '⚠ Damage'],
                  ['adjust', '± Adjust'],
                ] as Array<[AdjustType, string]>).map(([type, label]) => {
                  const isActive = adjustModal.type === type
                  const accent = type === 'damage' ? 'var(--red)' : type === 'return' ? '#d97706' : 'var(--ss-blue)'
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setAdjustModal((current) => current ? { ...current, type, sign: type === 'damage' ? -1 : 1 } : current)}
                      style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: `2px solid ${isActive ? accent : 'var(--border2)'}`, background: isActive ? accent : 'var(--surface2)', color: isActive ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Direction</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setAdjustModal((current) => current ? { ...current, sign: 1 } : current)}
                  style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--border2)'}`, background: adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--surface2)', color: adjustModal.sign > 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  + Add
                </button>
                <button
                  type="button"
                  onClick={() => setAdjustModal((current) => current ? { ...current, sign: -1 } : current)}
                  style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign < 0 ? 'var(--red)' : 'var(--border2)'}`, background: adjustModal.sign < 0 ? 'var(--red)' : 'var(--surface2)', color: adjustModal.sign < 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  − Remove
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', width: 16, textAlign: 'center' }}>{adjustModal.sign > 0 ? '+' : '−'}</span>
              <input type="number" min="1" step="1" value={adjustModal.qty} onChange={(event) => setAdjustModal((current) => current ? { ...current, qty: event.target.value } : current)} style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />
            </div>

            <input type="text" value={adjustModal.note} onChange={(event) => setAdjustModal((current) => current ? { ...current, note: event.target.value } : current)} placeholder="Note (e.g. PO#, reason, ref)" maxLength={120} style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, marginBottom: 10 }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>📅 Date:</span>
              <input type="date" value={adjustModal.date} onChange={(event) => setAdjustModal((current) => current ? { ...current, date: event.target.value } : current)} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12 }} />
              <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{adjustModal.date === new Date().toISOString().slice(0, 10) ? '(today)' : ''}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setAdjustModal(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" type="button" onClick={handleAdjustSubmit}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {skuDrawerOpen ? (
        <div className="inventory-drawer-overlay" onClick={() => setSkuDrawerOpen(false)}>
          <div className="inventory-drawer-panel" onClick={(event) => event.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{skuDrawerTitle}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'monospace' }}>{skuDrawer?.sku ?? ''}</div>
              </div>
              <button type="button" onClick={() => setSkuDrawerOpen(false)} style={{ padding: '5px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>✕</button>
            </div>
            <div className="inventory-drawer-body">
              {skuDrawerLoading ? (
                <div className="loading"><div className="spinner" /></div>
              ) : skuDrawerError ? (
                <div style={{ color: 'var(--red)', padding: 16 }}>Failed to load: {skuDrawerError}</div>
              ) : skuDrawer ? (
                <>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>30-Day Units Sold</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#e07a00' }}>{skuDrawer.totalUnits.toLocaleString()}</div>
                    </div>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Total Orders</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{skuDrawer.orders.length.toLocaleString()}</div>
                    </div>
                    <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', flex: 1, minWidth: 120 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Avg/Day (30d)</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>{(skuDrawer.totalUnits / 30).toFixed(1)}</div>
                    </div>
                  </div>

                  <div className="inventory-sku-chart-card" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 18 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Units Sold — Last 30 Days</div>
                    <canvas ref={canvasRef} className="inventory-sku-chart-canvas" width={620} height={160} />
                  </div>

                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>Recent Orders ({skuDrawer.orders.length})</div>
                  {skuDrawer.orders.length === 0 ? (
                    <div style={{ color: 'var(--text3)', fontSize: 12, padding: 16, textAlign: 'center' }}>No orders found for this SKU.</div>
                  ) : (
                    <div className="inventory-sku-orders-wrap">
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Order #</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Customer</th>
                            <th style={{ padding: '7px 6px', textAlign: 'center', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Qty</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Status</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)' }}>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {skuDrawer.orders.map((order, index) => {
                            const statusColor = order.orderStatus === 'shipped' ? 'var(--green)' : order.orderStatus === 'awaiting_shipment' ? 'var(--ss-blue)' : 'var(--text3)'
                            return (
                              <tr key={order.orderId} style={{ borderTop: '1px solid var(--border)', background: index % 2 === 0 ? '' : 'var(--surface2)' }}>
                                <td style={{ padding: '6px 10px' }}>
                                  <button
                                    type="button"
                                    className="inventory-order-link"
                                    disabled={!Number.isFinite(Number(order.orderId)) || Number(order.orderId) <= 0}
                                    onClick={() => openSkuDrawerOrder(order)}
                                  >
                                    {order.orderNumber || String(order.orderId)}
                                  </button>
                                </td>
                                <td style={{ padding: '6px 10px', fontSize: 11.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{order.shipToName || '—'}</td>
                                <td style={{ padding: '6px 6px', textAlign: 'center', fontWeight: 700 }}>{order.qty || 1}</td>
                                <td style={{ padding: '6px 10px', fontSize: 11, fontWeight: 700, color: statusColor }}>{order.orderStatus || '—'}</td>
                                <td style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text3)' }}>{formatDateOnly(order.orderDate)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <OrderDetailDrawer
        orderId={orderDetailModal?.orderId ?? null}
        displayStatus={orderDetailModal?.status ?? undefined}
        presentation="modal"
        closeLabel="Close"
        closeTitle="Close order details"
        onClose={() => setOrderDetailModal(null)}
      />

      {thumbnailPreview ? (
        <div
          className="inventory-thumb-preview"
          style={{
            left: `${thumbnailPreview.left}px`,
            top: `${thumbnailPreview.top}px`,
            zoom: String(thumbnailPreview.zoom),
          }}
        >
          <img src={thumbnailPreview.src} alt="" />
        </div>
      ) : null}
    </div>
  )
}
