// @ts-nocheck
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from 'recharts'
import type {
  AnalysisDailySalesResponse,
  AnalysisSkuDto,
} from '@prepshipv2/contracts/analysis/contracts'
import { ApiError, apiClient } from '../../api/client'
import { ToastContext } from '../../contexts/ToastContext'
import type { ClientDto, InventorySkuOrdersDto } from '../../types/api'
import {
  ANALYSIS_CHART_COLORS,
  ANALYSIS_SORT_LABELS,
  filterAnalysisRows,
  formatAnalysisMoney,
  getAnalysisChartMaxValue,
  getAnalysisEmptyMessage,
  getAnalysisPresetRange,
  getAnalysisSortDirection,
  getAnalysisSummaryText,
  getChartSelectionRange,
  getInitialAnalysisFilters,
  sortAnalysisRows,
  buildAnalysisTotals,
  type AnalysisSortDir,
  type AnalysisSortKey,
} from './analysis-parity'
import './InventoryView.css'
import './AnalysisView.css'

const TABLE_COLUMN_COUNT = 10

interface AnalysisDataState {
  loading: boolean
  error: string | null
  rows: AnalysisSkuDto[]
  orderCount: number
  chartData: AnalysisDailySalesResponse | null
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleDateString()
}

interface ChartMeta {
  W: number
  H: number
  PAD: { top: number; right: number; bottom: number; left: number }
  cW: number
  cH: number
  data: AnalysisDailySalesResponse
  maxVal: number
}

function drawAnalysisChartBase(
  canvas: HTMLCanvasElement,
  meta: ChartMeta,
  highlightIndex: number | null,
  dragX1: number | null,
  dragX2: number | null,
) {
  const context = canvas.getContext('2d')
  if (!context) return

  const { W, H, PAD, cW, cH, data, maxVal } = meta
  context.clearRect(0, 0, W, H)

  context.strokeStyle = '#e2e6ea'
  context.lineWidth = 1
  for (let tick = 0; tick <= 4; tick += 1) {
    const y = PAD.top + cH - (tick / 4) * cH
    context.beginPath()
    context.moveTo(PAD.left, y)
    context.lineTo(PAD.left + cW, y)
    context.stroke()
    context.fillStyle = '#8a95a3'
    context.font = '9px sans-serif'
    context.textAlign = 'right'
    context.fillText(String(Math.round((tick / 4) * maxVal)), PAD.left - 4, y + 3)
  }

  const dates = data.dates
  const step = Math.max(1, Math.floor(dates.length / 6))
  context.fillStyle = '#8a95a3'
  context.font = '9px sans-serif'
  context.textAlign = 'center'
  dates.forEach((date, index) => {
    if (index % step !== 0 && index !== dates.length - 1) return
    const x = PAD.left + (index / Math.max(dates.length - 1, 1)) * cW
    context.fillText(date.slice(5), x, H - 8)
  })

  data.topSkus.forEach((sku, skuIndex) => {
    const values = data.series[sku.sku] || []
    const color = ANALYSIS_CHART_COLORS[skuIndex % ANALYSIS_CHART_COLORS.length]
    context.strokeStyle = color
    context.lineWidth = 2
    context.lineJoin = 'round'
    context.beginPath()
    values.forEach((value, index) => {
      const x = PAD.left + (index / Math.max(values.length - 1, 1)) * cW
      const y = PAD.top + cH - (value / maxVal) * cH
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.stroke()

    context.globalAlpha = 0.07
    context.fillStyle = color
    context.beginPath()
    values.forEach((value, index) => {
      const x = PAD.left + (index / Math.max(values.length - 1, 1)) * cW
      const y = PAD.top + cH - (value / maxVal) * cH
      if (index === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    })
    context.lineTo(PAD.left + cW, PAD.top + cH)
    context.lineTo(PAD.left, PAD.top + cH)
    context.closePath()
    context.fill()
    context.globalAlpha = 1
  })

  if (highlightIndex != null) {
    const x = PAD.left + (highlightIndex / Math.max(dates.length - 1, 1)) * cW
    context.strokeStyle = 'rgba(0,0,0,.18)'
    context.lineWidth = 1
    context.setLineDash([4, 4])
    context.beginPath()
    context.moveTo(x, PAD.top)
    context.lineTo(x, PAD.top + cH)
    context.stroke()
    context.setLineDash([])

    data.topSkus.forEach((sku, skuIndex) => {
      const value = (data.series[sku.sku] || [])[highlightIndex] || 0
      const y = PAD.top + cH - (value / maxVal) * cH
      context.beginPath()
      context.arc(x, y, 4, 0, Math.PI * 2)
      context.fillStyle = ANALYSIS_CHART_COLORS[skuIndex % ANALYSIS_CHART_COLORS.length]
      context.fill()
      context.strokeStyle = '#fff'
      context.lineWidth = 1.5
      context.stroke()
    })
  }

  if (dragX1 != null && dragX2 != null) {
    const x1 = Math.min(dragX1, dragX2)
    const x2 = Math.max(dragX1, dragX2)
    context.fillStyle = 'rgba(42,91,215,.12)'
    context.fillRect(x1, PAD.top, x2 - x1, cH)
    context.strokeStyle = 'rgba(42,91,215,.5)'
    context.lineWidth = 1
    context.strokeRect(x1, PAD.top, x2 - x1, cH)
  }
}

function buildDrawerChartRows(dailySales: InventorySkuOrdersDto['dailySales']) {
  if (!Array.isArray(dailySales)) return []
  return dailySales.map((row) => ({
    day: row.day,
    units: Number(row.units) || 0,
  }))
}

function buildDrawerYAxisTicks(maxValue: number) {
  const maxTick = Math.max(1, Math.round(maxValue))
  return Array.from(
    new Set([
      Math.max(1, Math.round(maxTick / 3)),
      Math.max(1, Math.round((maxTick * 2) / 3)),
      maxTick,
    ]),
  )
}

function DrawerBarValueLabel(props: {
  x?: number
  y?: number
  width?: number
  height?: number
  value?: number
}) {
  const value = Number(props.value) || 0
  if (value <= 0) return null

  const x = Number(props.x) || 0
  const y = Number(props.y) || 0
  const width = Number(props.width) || 0
  const height = Number(props.height) || 0
  const drawInside = height >= 12

  return (
    <text
      x={x + width / 2}
      y={drawInside ? y + 9 : y - 4}
      textAnchor="middle"
      fill={drawInside ? '#fff' : '#e07a00'}
      fontSize={9}
      fontWeight={700}
    >
      {value}
    </text>
  )
}

export default function AnalysisView() {
  const toastContext = useContext(ToastContext)
  const initialFilters = getInitialAnalysisFilters(
    typeof window === 'undefined' ? null : window.localStorage,
  )
  const [from, setFrom] = useState(initialFilters.from)
  const [to, setTo] = useState(initialFilters.to)
  const [presetDays, setPresetDays] = useState<number | null>(initialFilters.presetDays)
  const [clientId, setClientId] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<AnalysisSortKey>('total')
  const [sortDir, setSortDir] = useState<AnalysisSortDir>('desc')
  const [clients, setClients] = useState<ClientDto[]>([])
  const [dataState, setDataState] = useState<AnalysisDataState>({
    loading: true,
    error: null,
    rows: [],
    orderCount: 0,
    chartData: null,
  })
  const [skuDrawer, setSkuDrawer] = useState<InventorySkuOrdersDto | null>(null)
  const [skuDrawerTitle, setSkuDrawerTitle] = useState('Loading…')
  const [skuDrawerError, setSkuDrawerError] = useState<string | null>(null)
  const [skuDrawerOpen, setSkuDrawerOpen] = useState(false)
  const [skuDrawerLoading, setSkuDrawerLoading] = useState(false)
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartOriginalRangeRef = useRef<{ from: string; to: string } | null>(null)
  const [chartResetVisible, setChartResetVisible] = useState(false)
  const [tooltip, setTooltip] = useState({
    visible: false,
    top: 0,
    title: '',
    items: [] as Array<{ color: string; label: string; value: number }>,
    hasAny: false,
  })

  const filteredRows = useMemo(
    () => filterAnalysisRows(dataState.rows, search),
    [dataState.rows, search],
  )
  const sortedRows = useMemo(
    () => sortAnalysisRows(filteredRows, sortKey, sortDir),
    [filteredRows, sortKey, sortDir],
  )
  const totals = useMemo(() => buildAnalysisTotals(sortedRows), [sortedRows])
  const maxQty = useMemo(
    () => Math.max(...sortedRows.map((row) => row.qty), 1),
    [sortedRows],
  )
  const drawerChartRows = useMemo(
    () => (skuDrawer ? buildDrawerChartRows(skuDrawer.dailySales) : []),
    [skuDrawer],
  )
  const drawerYAxisMax = useMemo(
    () => Math.max(...drawerChartRows.map((row) => row.units), 1),
    [drawerChartRows],
  )
  const drawerYAxisTicks = useMemo(
    () => buildDrawerYAxisTicks(drawerYAxisMax),
    [drawerYAxisMax],
  )

  // Load clients once for the filter dropdown.
  useEffect(() => {
    let active = true
    const loadClients = async () => {
      try {
        const nextClients = await apiClient.fetchClients()
        if (active) setClients(nextClients)
      } catch {}
    }
    void loadClients()
    return () => {
      active = false
    }
  }, [])

  // Persist date filters to localStorage so presets survive reloads.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (from) window.localStorage.setItem('analysis_from', from)
    if (to) window.localStorage.setItem('analysis_to', to)
    if (presetDays == null) {
      window.localStorage.removeItem('analysis_preset_days')
      return
    }
    window.localStorage.setItem('analysis_preset_days', String(presetDays))
  }, [from, to, presetDays])

  // Main load: SKU breakdown + daily sales chart data, in parallel.
  useEffect(() => {
    let active = true
    const loadAnalysis = async () => {
      setDataState((current) => ({ ...current, loading: true, error: null }))
      try {
        const query = {
          from: from || undefined,
          to: to || undefined,
          clientId: clientId ? Number.parseInt(clientId, 10) : undefined,
        }
        const [skuData, chartData] = await Promise.all([
          apiClient.fetchAnalysisSkus(query),
          apiClient.fetchAnalysisDailySales(query).catch(() => null),
        ])
        if (!active) return
        setDataState({
          loading: false,
          error: null,
          rows: skuData.skus || [],
          orderCount: skuData.orderCount || 0,
          chartData,
        })
      } catch (error) {
        if (!active) return
        setDataState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to load analysis',
        }))
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [from, to, clientId])

  useEffect(() => {
    const canvas = chartCanvasRef.current
    const data = dataState.chartData
    if (!canvas || !data || !data.topSkus.length || !data.dates.length) {
      setTooltip((current) => (current.visible ? { ...current, visible: false } : current))
      return
    }

    let meta: ChartMeta | null = null
    let dragStart: number | null = null
    let isDragging = false

    const getCanvasX = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      if (!meta || rect.width <= 0) return 0
      return (event.clientX - rect.left) * (meta.W / rect.width)
    }

    const redraw = (highlightIndex: number | null = null, dragCurrent: number | null = null) => {
      if (!meta) return
      drawAnalysisChartBase(canvas, meta, highlightIndex, dragStart, dragCurrent)
    }

    const resizeChart = () => {
      const parent = canvas.parentElement
      if (!parent) return
      const width = Math.max(parent.clientWidth - 32, 220)
      const height = 140
      canvas.width = width
      canvas.height = height
      meta = {
        W: width,
        H: height,
        PAD: { top: 10, right: 10, bottom: 28, left: 34 },
        cW: width - 34 - 10,
        cH: height - 10 - 28,
        data,
        maxVal: getAnalysisChartMaxValue(data),
      }
      redraw()
    }

    const handleMove = (event: MouseEvent) => {
      if (!meta) return
      const x = getCanvasX(event)

      if (x < meta.PAD.left || x > meta.PAD.left + meta.cW) {
        if (!isDragging) {
          setTooltip((current) => (current.visible ? { ...current, visible: false } : current))
          redraw()
        }
        return
      }

      const index = Math.max(0, Math.min(
        data.dates.length - 1,
        Math.round(((x - meta.PAD.left) / meta.cW) * (data.dates.length - 1)),
      ))

      if (dragStart != null && Math.abs(x - dragStart) > 4) {
        isDragging = true
      }

      if (isDragging) {
        redraw(null, Math.min(Math.max(x, meta.PAD.left), meta.PAD.left + meta.cW))
        setTooltip((current) => (current.visible ? { ...current, visible: false } : current))
        return
      }

      redraw(index)

      const items = data.topSkus
        .map((sku, skuIndex) => ({
          color: ANALYSIS_CHART_COLORS[skuIndex % ANALYSIS_CHART_COLORS.length],
          label: (sku.name || sku.sku).slice(0, 28),
          value: (data.series[sku.sku] || [])[index] || 0,
          order: skuIndex,
        }))
        .filter((item) => item.value > 0)
        .sort((left, right) => right.value - left.value || left.order - right.order)
        .map(({ order: _order, ...item }) => item)

      const screenMargin = 8
      const viewportHeight = window.innerHeight
      let top = Math.round(event.clientY - 48)
      if (top < screenMargin) top = Math.round(event.clientY + 20)
      if (top > viewportHeight - 120) top = Math.max(screenMargin, viewportHeight - 120)

      setTooltip({
        visible: true,
        top,
        title: data.dates[index] || '',
        items,
        hasAny: items.length > 0,
      })
    }

    const handleDown = (event: MouseEvent) => {
      if (!meta) return
      const x = getCanvasX(event)
      if (x >= meta.PAD.left && x <= meta.PAD.left + meta.cW) {
        dragStart = x
        isDragging = false
      }
    }

    const handleUp = (event: MouseEvent) => {
      if (!meta || dragStart == null) return

      const x = getCanvasX(event)
      const selection = getChartSelectionRange(data, dragStart, x, meta.PAD.left, meta.cW)
      dragStart = null
      isDragging = false

      if (!selection) {
        redraw()
        return
      }

      if (!chartOriginalRangeRef.current) {
        chartOriginalRangeRef.current = { from, to }
      }

      setTooltip((current) => (current.visible ? { ...current, visible: false } : current))
      setPresetDays(null)
      setChartResetVisible(true)
      setFrom(selection.from)
      setTo(selection.to)
    }

    const handleLeave = () => {
      dragStart = null
      isDragging = false
      setTooltip((current) => (current.visible ? { ...current, visible: false } : current))
      redraw()
    }

    resizeChart()
    window.addEventListener('resize', resizeChart)
    canvas.addEventListener('mousemove', handleMove)
    canvas.addEventListener('mousedown', handleDown)
    canvas.addEventListener('mouseup', handleUp)
    canvas.addEventListener('mouseleave', handleLeave)

    return () => {
      window.removeEventListener('resize', resizeChart)
      canvas.removeEventListener('mousemove', handleMove)
      canvas.removeEventListener('mousedown', handleDown)
      canvas.removeEventListener('mouseup', handleUp)
      canvas.removeEventListener('mouseleave', handleLeave)
    }
  }, [dataState.chartData, from, to])

  function handlePresetClick(days: number) {
    const range = getAnalysisPresetRange(days)
    setPresetDays(days)
    setFrom(range.from)
    setTo(range.to)
    chartOriginalRangeRef.current = null
    setChartResetVisible(false)
  }

  function handleResetChartZoom() {
    const original = chartOriginalRangeRef.current
    if (!original) return
    setFrom(original.from)
    setTo(original.to)
    chartOriginalRangeRef.current = null
    setChartResetVisible(false)
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
      setSkuDrawerTitle(
        error instanceof ApiError && error.status === 404 ? 'SKU not found' : 'Error',
      )
      toastContext?.addToast(message, 'error')
    } finally {
      setSkuDrawerLoading(false)
    }
  }

  function handleSort(nextKey: AnalysisSortKey) {
    setSortDir((currentDir) => getAnalysisSortDirection(nextKey, sortKey, currentDir))
    setSortKey(nextKey)
  }

  const hasChart =
    dataState.chartData
    && (dataState.chartData.topSkus?.length ?? 0) > 0
    && (dataState.chartData.dates?.length ?? 0) > 0

  return (
    <div className="view-content" id="view-analysis">
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--bg)',
          paddingBottom: 6,
          margin: '-18px -18px 10px -18px',
          padding: '12px 18px 8px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', margin: 0 }}>
            📊 SKU Analysis
          </h2>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { days: 30, label: '30d' },
              { days: 90, label: '90d' },
              { days: 180, label: '180d' },
              { days: 365, label: '1yr' },
              { days: 0, label: 'All' },
            ].map((preset) => (
              <button
                key={preset.days}
                type="button"
                className={`btn btn-outline btn-sm analysis-preset${presetDays === preset.days ? ' active' : ''}`}
                onClick={() => handlePresetClick(preset.days)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              color: 'var(--text2)',
            }}
          >
            <input
              id="analysis-from"
              type="date"
              className="ship-select"
              style={{ width: 130, fontSize: 11.5 }}
              value={from}
              onChange={(event) => {
                setFrom(event.target.value)
                setPresetDays(null)
                chartOriginalRangeRef.current = null
                setChartResetVisible(false)
              }}
            />
            <span>–</span>
            <input
              id="analysis-to"
              type="date"
              className="ship-select"
              style={{ width: 130, fontSize: 11.5 }}
              value={to}
              onChange={(event) => {
                setTo(event.target.value)
                setPresetDays(null)
                chartOriginalRangeRef.current = null
                setChartResetVisible(false)
              }}
            />
          </div>
          <input
            id="analysis-search"
            type="text"
            placeholder="Search SKU or item…"
            className="ship-select"
            style={{ width: 160, fontSize: 12 }}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            id="analysis-client"
            className="filter-sel"
            style={{ fontSize: 12 }}
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
          >
            <option value="">All Clients</option>
            {clients.map((client, i) => {
              const id = client.clientId ?? client.id ?? i
              return (
                <option key={id} value={String(id)}>
                  {client.name}
                </option>
              )
            })}
          </select>
          <span
            id="analysis-summary"
            style={{ fontSize: 11.5, color: 'var(--text3)', marginLeft: 'auto' }}
          >
            {getAnalysisSummaryText(dataState.rows.length, dataState.orderCount)}
          </span>
        </div>

        {hasChart ? (
          <div
            id="analysis-chart-wrap"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text3)',
                  textTransform: 'uppercase',
                  letterSpacing: '.4px',
                }}
              >
                Daily Units Sold — Top SKUs
              </span>
              <div
                id="analysis-chart-legend"
                style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginLeft: 4, flex: 1 }}
              >
                {dataState.chartData!.topSkus.map((sku, index) => (
                  <span
                    key={sku.sku}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10.5,
                      color: 'var(--text2)',
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 3,
                        background: ANALYSIS_CHART_COLORS[index % ANALYSIS_CHART_COLORS.length],
                        borderRadius: 2,
                        display: 'inline-block',
                      }}
                    />
                    <span
                      title={sku.name}
                      style={{
                        maxWidth: 140,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {sku.name || sku.sku}
                    </span>
                  </span>
                ))}
              </div>
              <span id="analysis-chart-zoom-hint" style={{ fontSize: 10, color: 'var(--text4)' }}>
                drag to zoom
              </span>
              <button
                id="analysis-chart-reset"
                type="button"
                onClick={handleResetChartZoom}
                style={{
                  display: chartResetVisible ? 'inline-block' : 'none',
                  padding: '2px 8px',
                  fontSize: 10.5,
                  border: '1px solid var(--border2)',
                  borderRadius: 4,
                  background: 'var(--surface2)',
                  color: 'var(--ss-blue)',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                ↺ Reset
              </button>
            </div>
            <canvas
              id="analysis-chart"
              ref={chartCanvasRef}
              height={140}
              style={{ width: '100%', display: 'block', cursor: 'crosshair' }}
            />
          </div>
        ) : null}
      </div>

      {tooltip.visible ? (
        <div className="analysis-chart-tooltip" style={{ top: tooltip.top }}>
          <div
            style={{
              fontWeight: 700,
              borderBottom: '1px solid rgba(255,255,255,.15)',
              marginBottom: 4,
              paddingBottom: 3,
            }}
          >
            {tooltip.title}
          </div>
          {tooltip.hasAny ? tooltip.items.map((item) => (
            <div
              key={`${item.label}-${item.color}`}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: item.color,
                  flexShrink: 0,
                  display: 'inline-block',
                }}
              />
              <span
                style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
              >
                {item.label}
              </span>
              <b>{item.value}</b>
            </div>
          )) : (
            <div style={{ color: 'rgba(255,255,255,.5)', fontSize: 10 }}>No sales</div>
          )}
        </div>
      ) : null}

      {dataState.loading ? (
        <div
          id="analysis-loading"
          style={{ textAlign: 'center', padding: 30, color: 'var(--text3)', fontSize: 13 }}
        >
          ⏳ Loading…
        </div>
      ) : null}

      <div style={{ overflowX: 'auto' }}>
        <table
          id="analysis-table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
        >
          <thead>
            <tr style={{ background: 'var(--surface2)', borderBottom: '2px solid var(--border)' }}>
              {([
                { key: 'name' },
                { key: 'sku' },
                { key: 'client' },
                { key: 'orders', align: 'right' },
                { key: 'pending', title: 'Awaiting shipment — not yet labeled', align: 'right' },
                { key: 'external', title: 'Orders shipped externally (no ShipStation label)', align: 'right' },
                { key: 'qty', align: 'right' },
                { key: 'stdOrders', title: 'SS-labeled standard service orders (count + avg cost)', align: 'right' },
                { key: 'expOrders', title: 'SS-labeled expedited service orders (count + avg cost)', align: 'right' },
                { key: 'total', title: 'Total SS label cost (proportionally allocated across SKUs in multi-item orders)', align: 'right' },
              ] as Array<{ key: AnalysisSortKey; title?: string; align?: 'right' }>).map((column) => (
                <th
                  key={column.key}
                  title={column.title}
                  onClick={() => handleSort(column.key)}
                  style={{
                    padding: '6px 8px',
                    textAlign: column.align ?? 'left',
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '.4px',
                    color: 'var(--text3)',
                    cursor: 'pointer',
                    whiteSpace: column.align ? 'nowrap' : undefined,
                  }}
                >
                  {ANALYSIS_SORT_LABELS[column.key]}
                  {sortKey === column.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody id="analysis-tbody">
            {dataState.error ? (
              <tr>
                <td
                  colSpan={TABLE_COLUMN_COUNT}
                  style={{ padding: 30, textAlign: 'center', color: 'var(--red)' }}
                >
                  Error: {dataState.error}
                </td>
              </tr>
            ) : !dataState.loading && sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={TABLE_COLUMN_COUNT}
                  style={{ padding: 30, textAlign: 'center', color: 'var(--text3)' }}
                >
                  {getAnalysisEmptyMessage(search)}
                </td>
              </tr>
            ) : !dataState.loading ? (
              sortedRows.map((row) => {
                const qtyBarWidth = Math.round((row.qty / maxQty) * 80)
                const isClickable = Boolean(row.invSkuId)
                const stdAvg =
                  row.standardShipCount > 0
                    ? (row.standardShipTotal ?? 0) / row.standardShipCount
                    : 0
                const expAvg =
                  row.expeditedShipCount > 0
                    ? (row.expeditedShipTotal ?? 0) / row.expeditedShipCount
                    : 0

                return (
                  <tr
                    key={`${row.sku || row.name}-${row.clientName}`}
                    className={isClickable ? 'analysis-clickable-row' : undefined}
                    style={isClickable ? { cursor: 'pointer' } : undefined}
                    title={isClickable ? 'View SKU details' : undefined}
                    tabIndex={isClickable ? 0 : undefined}
                    onKeyDown={
                      isClickable
                        ? (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              void openSkuDrawer(row.invSkuId as number)
                            }
                          }
                        : undefined
                    }
                    onClick={
                      isClickable ? () => void openSkuDrawer(row.invSkuId as number) : undefined
                    }
                  >
                    <td style={{ padding: '5px 8px', maxWidth: 200 }}>
                      <div
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                        }}
                        title={row.name}
                      >
                        {row.name}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: '5px 8px',
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: isClickable ? 'var(--ss-blue)' : undefined,
                        fontWeight: isClickable ? 700 : undefined,
                        textDecoration: isClickable ? 'underline' : undefined,
                        textDecorationThickness: isClickable ? 1 : undefined,
                        textUnderlineOffset: isClickable ? 2 : undefined,
                      }}
                    >
                      {row.sku || <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ padding: '5px 8px', fontSize: 11, color: 'var(--text2)' }}>
                      {row.clientName || '—'}
                    </td>
                    <td
                      style={{
                        padding: '5px 8px',
                        textAlign: 'right',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {row.orders}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 12 }}>
                      {row.pendingOrders > 0 ? (
                        <>
                          <span style={{ color: '#e07a00', fontWeight: 600 }}>
                            {row.pendingOrders}
                          </span>
                          <span
                            style={{ fontSize: 10, color: 'var(--text4)', marginLeft: 2 }}
                          >
                            pend
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--border2)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 12 }}>
                      {row.externalOrders > 0 ? (
                        <>
                          <span style={{ color: 'var(--text3)', fontWeight: 600 }}>
                            {row.externalOrders}
                          </span>
                          <span
                            style={{ fontSize: 10, color: 'var(--text4)', marginLeft: 2 }}
                          >
                            ext
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--border2)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          justifyContent: 'flex-end',
                        }}
                      >
                        <div
                          style={{
                            width: qtyBarWidth,
                            height: 5,
                            background: 'var(--ss-blue)',
                            borderRadius: 3,
                            opacity: 0.55,
                          }}
                        />
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {row.qty.toLocaleString()}
                        </span>
                      </div>
                    </td>
                    <td
                      style={{ padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}
                    >
                      {row.standardShipCount > 0 ? (
                        <>
                          <span style={{ fontWeight: 600 }}>{row.standardShipCount}</span>
                          <span
                            style={{ fontSize: 10, color: 'var(--green)', marginLeft: 3 }}
                          >
                            {formatAnalysisMoney(stdAvg)}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--border2)' }}>—</span>
                      )}
                    </td>
                    <td
                      style={{ padding: '5px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}
                    >
                      {row.expeditedShipCount > 0 ? (
                        <>
                          <span style={{ fontWeight: 600, color: '#e07a00' }}>
                            {row.expeditedShipCount}
                          </span>
                          <span
                            style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 3 }}
                          >
                            {formatAnalysisMoney(expAvg)}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--border2)' }}>—</span>
                      )}
                    </td>
                    <td
                      style={{
                        padding: '5px 8px',
                        textAlign: 'right',
                        fontWeight: 700,
                        fontSize: 12,
                      }}
                    >
                      {row.totalShipping > 0 ? (
                        formatAnalysisMoney(row.totalShipping)
                      ) : (
                        <span style={{ color: 'var(--text3)' }}>—</span>
                      )}
                    </td>
                  </tr>
                )
              })
            ) : null}
          </tbody>
          <tfoot id="analysis-tfoot">
            {!dataState.loading && !dataState.error && sortedRows.length > 0 ? (
              <tr
                style={{
                  background: 'var(--surface2)',
                  borderTop: '2px solid var(--border)',
                  fontWeight: 700,
                }}
              >
                <td
                  colSpan={3}
                  style={{ padding: '6px 8px', fontSize: 11.5, color: 'var(--text2)' }}
                >
                  <span
                    style={{
                      color: 'var(--text3)',
                      fontWeight: 400,
                      fontSize: 10.5,
                      marginRight: 8,
                    }}
                  >
                    TOTALS
                  </span>
                  {totals.skuCount.toLocaleString()} SKUs
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11.5 }}>
                  {totals.totalOrders.toLocaleString()}
                </td>
                <td
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontSize: 11,
                    color: '#e07a00',
                  }}
                >
                  {totals.totalPending > 0 ? totals.totalPending.toLocaleString() : '—'}
                </td>
                <td
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontSize: 11,
                    color: 'var(--text3)',
                  }}
                >
                  {totals.totalExternal > 0 ? totals.totalExternal.toLocaleString() : '—'}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11.5 }}>
                  {totals.totalQty.toLocaleString()}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 11 }}>
                  {totals.totalStdCount > 0 ? totals.totalStdCount.toLocaleString() : '—'}
                </td>
                <td
                  style={{
                    padding: '6px 8px',
                    textAlign: 'right',
                    fontSize: 11,
                    color: '#e07a00',
                  }}
                >
                  {totals.totalExpCount > 0 ? totals.totalExpCount.toLocaleString() : '—'}
                </td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 12 }}>
                  {totals.totalShipping > 0 ? formatAnalysisMoney(totals.totalShipping) : '—'}
                </td>
              </tr>
            ) : null}
          </tfoot>
        </table>
      </div>

      {skuDrawerOpen ? (
        <div className="inventory-drawer-overlay" onClick={() => setSkuDrawerOpen(false)}>
          <div
            className="inventory-drawer-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexShrink: 0,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                  {skuDrawerTitle}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text3)',
                    marginTop: 2,
                    fontFamily: 'monospace',
                  }}
                >
                  {skuDrawer?.sku ?? ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSkuDrawerOpen(false)}
                style={{
                  padding: '5px 10px',
                  border: '1px solid var(--border2)',
                  borderRadius: 6,
                  background: 'var(--surface2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
              {skuDrawerLoading ? (
                <div className="loading">
                  <div className="spinner" />
                </div>
              ) : skuDrawerError ? (
                <div style={{ color: 'var(--red)', padding: 16 }}>
                  Failed to load: {skuDrawerError}
                </div>
              ) : skuDrawer ? (
                <>
                  <div
                    style={{
                      display: 'flex',
                      gap: 12,
                      marginBottom: 18,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        30-Day Units Sold
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#e07a00' }}>
                        {skuDrawer.totalUnits.toLocaleString()}
                      </div>
                    </div>
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        Total Orders
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                        {skuDrawer.orders.length.toLocaleString()}
                      </div>
                    </div>
                    <div
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '10px 16px',
                        flex: 1,
                        minWidth: 120,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '.4px',
                          color: 'var(--text3)',
                          marginBottom: 4,
                        }}
                      >
                        Avg/Day (30d)
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)' }}>
                        {(skuDrawer.totalUnits / 30).toFixed(1)}
                      </div>
                    </div>
                  </div>

                  <div
                    style={{
                      background: 'var(--surface2)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '14px 16px',
                      marginBottom: 18,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text)',
                        marginBottom: 10,
                      }}
                    >
                      📊 Units Sold — Last 30 Days
                    </div>
                    <div style={{ width: '100%', height: 160 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={drawerChartRows}
                          margin={{ top: 10, right: 8, bottom: 6, left: 0 }}
                        >
                          <CartesianGrid
                            stroke="var(--border)"
                            strokeDasharray="3 3"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="day"
                            tick={{ fontSize: 9, fill: 'var(--text3)' }}
                            tickFormatter={(value: string) =>
                              typeof value === 'string' ? value.slice(5) : value
                            }
                            minTickGap={16}
                          />
                          <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 9, fill: 'var(--text3)' }}
                            ticks={drawerYAxisTicks}
                            domain={[0, drawerYAxisMax]}
                            width={28}
                            allowDecimals={false}
                            interval={0}
                          />
                          <Tooltip
                            contentStyle={{
                              background: 'rgba(20,20,30,.92)',
                              border: 'none',
                              borderRadius: 6,
                              color: '#fff',
                              fontSize: 11,
                            }}
                            itemStyle={{ color: '#fff' }}
                            labelStyle={{ color: '#fff', fontWeight: 700 }}
                          />
                          <Bar dataKey="units" fill="#e07a00" isAnimationActive={false}>
                            <LabelList
                              dataKey="units"
                              content={(props) => <DrawerBarValueLabel {...props} />}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--text)',
                      marginBottom: 8,
                    }}
                  >
                    Recent Orders ({skuDrawer.orders.length})
                  </div>
                  {skuDrawer.orders.length === 0 ? (
                    <div
                      style={{
                        color: 'var(--text3)',
                        fontSize: 12,
                        padding: 16,
                        textAlign: 'center',
                      }}
                    >
                      No orders found for this SKU.
                    </div>
                  ) : (
                    <div
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        overflow: 'hidden',
                      }}
                    >
                      <table
                        style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
                      >
                        <thead>
                          <tr
                            style={{
                              background: 'var(--surface2)',
                              borderBottom: '1px solid var(--border)',
                            }}
                          >
                            <th
                              style={{
                                padding: '7px 10px',
                                textAlign: 'left',
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '.4px',
                                color: 'var(--text3)',
                              }}
                            >
                              Order #
                            </th>
                            <th
                              style={{
                                padding: '7px 10px',
                                textAlign: 'left',
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '.4px',
                                color: 'var(--text3)',
                              }}
                            >
                              Customer
                            </th>
                            <th
                              style={{
                                padding: '7px 6px',
                                textAlign: 'center',
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '.4px',
                                color: 'var(--text3)',
                              }}
                            >
                              Qty
                            </th>
                            <th
                              style={{
                                padding: '7px 10px',
                                textAlign: 'left',
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '.4px',
                                color: 'var(--text3)',
                              }}
                            >
                              Status
                            </th>
                            <th
                              style={{
                                padding: '7px 10px',
                                textAlign: 'left',
                                fontSize: 10,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '.4px',
                                color: 'var(--text3)',
                              }}
                            >
                              Date
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {skuDrawer.orders.map((order, index) => {
                            const statusColor =
                              order.orderStatus === 'shipped'
                                ? 'var(--green)'
                                : order.orderStatus === 'awaiting_shipment'
                                  ? 'var(--ss-blue)'
                                  : 'var(--text3)'

                            return (
                              <tr
                                key={order.orderId}
                                style={{
                                  borderTop: '1px solid var(--border)',
                                  background: index % 2 === 0 ? '' : 'var(--surface2)',
                                }}
                              >
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    fontFamily: 'monospace',
                                    fontSize: 11,
                                    color: 'var(--ss-blue)',
                                  }}
                                >
                                  {order.orderNumber || String(order.orderId)}
                                </td>
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    fontSize: 11.5,
                                    maxWidth: 180,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {order.shipToName || '—'}
                                </td>
                                <td
                                  style={{
                                    padding: '6px 6px',
                                    textAlign: 'center',
                                    fontWeight: 700,
                                  }}
                                >
                                  {order.qty || 1}
                                </td>
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: statusColor,
                                  }}
                                >
                                  {order.orderStatus || '—'}
                                </td>
                                <td
                                  style={{
                                    padding: '6px 10px',
                                    fontSize: 11,
                                    color: 'var(--text3)',
                                  }}
                                >
                                  {formatDateOnly(order.orderDate)}
                                </td>
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
    </div>
  )
}
