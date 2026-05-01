import { useEffect, useMemo, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ANALYSIS_CHART_COLORS } from './analysis-parity'
import './AnalysisTopSkusChart.css'

type ChartSku = {
  sku: string
  name?: string | null
}

type AnalysisTopSkusChartData = {
  dates: string[]
  topSkus: ChartSku[]
  series: Record<string, number[]>
}

type ZoomSelection = {
  fromIndex: number
  toIndex: number
  from: string
  to: string
}

type ChartMouseState = {
  activeLabel?: string
}

type AnalysisChartType = 'line' | 'bar'

interface AnalysisTopSkusChartProps {
  data: AnalysisTopSkusChartData
}

function readStoredChartType(): AnalysisChartType {
  if (typeof window === 'undefined') return 'line'
  const stored = window.localStorage.getItem('analysis_chart_type')
  return stored === 'bar' || stored === 'line' ? stored : 'line'
}

function clearChartTextSelection() {
  if (typeof window === 'undefined') return
  window.getSelection()?.removeAllRanges()
}

function formatChartDate(value: string | null | undefined) {
  if (!value) return '-'
  return value.length >= 10 ? value.slice(5) : value
}

function buildChartRows(data: AnalysisTopSkusChartData) {
  return data.dates.map((date, index) => {
    const row: Record<string, string | number> = {
      date,
      dayLabel: formatChartDate(date),
    }

    data.topSkus.forEach((sku, skuIndex) => {
      row[`sku_${skuIndex}`] = Number(data.series[sku.sku]?.[index]) || 0
    })

    return row
  })
}

function buildYAxisTicks(maxValue: number) {
  const maxTick = Math.max(1, Math.round(maxValue))
  return Array.from(
    new Set([
      0,
      Math.round(maxTick * 0.25),
      Math.round(maxTick * 0.5),
      Math.round(maxTick * 0.75),
      maxTick,
    ]),
  )
}

function getChartMaxValue(rows: Array<Record<string, string | number>>, topSkus: ChartSku[]) {
  let maxValue = 1
  topSkus.forEach((_, skuIndex) => {
    const rowMax = Math.max(...rows.map((row) => Number(row[`sku_${skuIndex}`]) || 0), 0)
    if (rowMax > maxValue) maxValue = rowMax
  })
  return maxValue
}

function getSelectionFromLabels(
  dates: string[],
  start: string | null,
  end: string | null,
): ZoomSelection | null {
  if (!dates.length || !start || !end || start === end) return null
  const startIndex = dates.indexOf(start)
  const endIndex = dates.indexOf(end)
  if (startIndex < 0 || endIndex < 0) return null

  const fromIndex = Math.min(startIndex, endIndex)
  const toIndex = Math.max(startIndex, endIndex)
  if (toIndex - fromIndex < 1) return null

  return {
    fromIndex,
    toIndex,
    from: dates[fromIndex] ?? start,
    to: dates[toIndex] ?? end,
  }
}

function TopSkusTooltip(props: {
  active?: boolean
  label?: string
  payload?: Array<{ dataKey?: string | number; value?: unknown; color?: string; fill?: string; stroke?: string }>
  topSkus: ChartSku[]
}) {
  if (!props.active || !props.payload?.length) return null

  const items = props.payload
    .filter((item) => item.dataKey && item.dataKey !== 'dayLabel' && Number(item.value) > 0)
    .map((item) => {
      const skuIndex = Number(String(item.dataKey).replace('sku_', ''))
      const sku = props.topSkus[skuIndex]
      return {
        color: item.color || item.fill || item.stroke || ANALYSIS_CHART_COLORS[skuIndex % ANALYSIS_CHART_COLORS.length],
        label: sku?.name || sku?.sku || String(item.dataKey),
        value: Number(item.value) || 0,
      }
    })
    .sort((left, right) => right.value - left.value)

  return (
    <div className="analysis-top-chart-tooltip">
      <div className="analysis-top-chart-tooltip-date">{props.label || '-'}</div>
      {items.length ? items.map((item) => (
        <div className="analysis-top-chart-tooltip-row" key={`${item.label}-${item.color}`}>
          <span style={{ background: item.color }} />
          <p>{item.label}</p>
          <strong>{item.value}</strong>
        </div>
      )) : (
        <div className="analysis-top-chart-tooltip-empty">No sales</div>
      )}
    </div>
  )
}

export function AnalysisTopSkusChart({ data }: AnalysisTopSkusChartProps) {
  const [chartType, setChartType] = useState<AnalysisChartType>(readStoredChartType)
  const [drag, setDrag] = useState<{ start: string | null; end: string | null }>({
    start: null,
    end: null,
  })
  const [zoom, setZoom] = useState<{ fromIndex: number; toIndex: number } | null>(null)

  const rows = useMemo(() => buildChartRows(data), [data])
  const visibleRows = useMemo(() => {
    if (!zoom) return rows
    return rows.slice(zoom.fromIndex, zoom.toIndex + 1)
  }, [rows, zoom])
  const maxValue = useMemo(
    () => getChartMaxValue(visibleRows, data.topSkus),
    [visibleRows, data.topSkus],
  )
  const yAxisTicks = useMemo(() => buildYAxisTicks(maxValue), [maxValue])
  const dragSelection = useMemo(
    () => getSelectionFromLabels(data.dates, drag.start, drag.end),
    [data.dates, drag.start, drag.end],
  )

  useEffect(() => {
    setDrag({ start: null, end: null })
    setZoom(null)
  }, [data])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('analysis_chart_type', chartType)
  }, [chartType])

  function handleMouseDown(state: ChartMouseState | undefined) {
    clearChartTextSelection()
    if (!state?.activeLabel) return
    setDrag({ start: state.activeLabel, end: state.activeLabel })
  }

  function handleMouseMove(state: ChartMouseState | undefined) {
    clearChartTextSelection()
    if (!drag.start || !state?.activeLabel) return
    setDrag((current) => ({ ...current, end: state.activeLabel ?? null }))
  }

  function handleMouseUp() {
    clearChartTextSelection()
    const selection = getSelectionFromLabels(data.dates, drag.start, drag.end)
    setDrag({ start: null, end: null })
    if (selection) setZoom({ fromIndex: selection.fromIndex, toIndex: selection.toIndex })
  }

  return (
    <div id="analysis-chart-wrap" className="analysis-top-chart-card">
      <div className="analysis-top-chart-header">
        <span className="analysis-top-chart-title">Daily Units Sold - Top SKUs</span>
        <div id="analysis-chart-legend" className="analysis-top-chart-legend">
          {data.topSkus.map((sku, index) => (
            <span className="analysis-top-chart-legend-item" key={sku.sku}>
              <span
                className="analysis-top-chart-legend-line"
                style={{ background: ANALYSIS_CHART_COLORS[index % ANALYSIS_CHART_COLORS.length] }}
              />
              <span className="analysis-top-chart-legend-label" title={sku.name || sku.sku}>
                {sku.name || sku.sku}
              </span>
            </span>
          ))}
        </div>
        <span id="analysis-chart-zoom-hint" className="analysis-top-chart-hint">
          drag chart to zoom
        </span>
        <select
          id="analysis-chart-type"
          className="analysis-top-chart-type"
          value={chartType}
          title="Chart type"
          aria-label="Chart type"
          onChange={(event) => setChartType(event.target.value as AnalysisChartType)}
        >
          <option value="line">Line graph</option>
          <option value="bar">Bar graph</option>
        </select>
        <button
          id="analysis-chart-reset"
          type="button"
          className="analysis-top-chart-reset"
          onClick={() => setZoom(null)}
          style={{ display: zoom ? 'inline-flex' : 'none' }}
        >
          Reset
        </button>
      </div>

      <div
        id="analysis-chart"
        className="analysis-top-chart"
        onMouseDown={(event) => {
          event.preventDefault()
          clearChartTextSelection()
        }}
        onDragStart={(event) => event.preventDefault()}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={visibleRows}
            margin={{ top: 6, right: 14, bottom: 0, left: 6 }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => setDrag({ start: null, end: null })}
          >
            <defs>
              {data.topSkus.map((sku, index) => {
                const color = ANALYSIS_CHART_COLORS[index % ANALYSIS_CHART_COLORS.length]
                return (
                  <linearGradient
                    id={`analysisTopSkuGradient${index}`}
                    key={sku.sku}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={color} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                )
              })}
            </defs>
            <CartesianGrid
              stroke="rgba(148,163,184,.28)"
              strokeDasharray="4 6"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: 'var(--text3)' }}
              tickFormatter={formatChartDate}
              minTickGap={28}
              interval="preserveStartEnd"
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 10, fill: 'var(--text3)' }}
              ticks={yAxisTicks}
              domain={[0, maxValue]}
              width={30}
              allowDecimals={false}
              interval={0}
            />
            <Tooltip
              content={(props: any) => (
                <TopSkusTooltip
                  {...props}
                  topSkus={data.topSkus}
                />
              )}
              cursor={{ stroke: 'rgba(15,23,42,.22)', strokeDasharray: '4 4' }}
            />
            {data.topSkus.map((sku, index) => {
              const color = ANALYSIS_CHART_COLORS[index % ANALYSIS_CHART_COLORS.length]
              return chartType === 'bar' ? (
                <Bar
                  key={sku.sku}
                  dataKey={`sku_${index}`}
                  name={sku.name || sku.sku}
                  fill={color}
                  fillOpacity={0.78}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={18}
                  isAnimationActive
                  animationDuration={450}
                />
              ) : (
                <Line
                  key={sku.sku}
                  type="monotone"
                  dataKey={`sku_${index}`}
                  name={sku.name || sku.sku}
                  stroke={color}
                  strokeWidth={2.4}
                  dot={false}
                  activeDot={{
                    r: 4,
                    stroke: '#fff',
                    strokeWidth: 2,
                    fill: color,
                  }}
                  connectNulls
                  isAnimationActive
                  animationDuration={550}
                />
              )
            })}
            {dragSelection ? (
              <ReferenceArea
                x1={dragSelection.from}
                x2={dragSelection.to}
                stroke="rgba(100,116,139,.35)"
                fill="rgba(100,116,139,.12)"
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
