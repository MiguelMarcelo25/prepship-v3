import { useState } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type TrendPoint = {
  day: string
  current: number
  prior: number
  currentRevenue?: number
}

type ClientSeries = {
  key: string
  name: string
}

type DashboardChartsProps = {
  trend: TrendPoint[]
  // Optional multi-client revenue mode. When `clientSeries` is non-empty
  // the chart renders one line per client (daily order value) instead of
  // the default Orders + Order value dual-axis view. `clientTrend` holds
  // wide rows: { day, [series.key]: revenue, ... }.
  clientTrend?: Array<Record<string, number | string>>
  clientSeries?: ClientSeries[]
}

// Color a non-focused line is washed out to when another series is focused.
const MUTED_STROKE = 'var(--text3)'

// Distinct, reasonably color-blind-friendly palette. Cycles if there are
// more clients than colors.
const CLIENT_PALETTE = [
  '#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#7c3aed', '#0891b2',
  '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#b91c1c',
  '#9333ea', '#ca8a04', '#0284c7', '#e11d48', '#15803d', '#9a3412',
  '#6d28d9', '#4d7c0f',
]

function num(value: unknown, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function formatInt(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function formatDayLabel(day: string) {
  if (!day) return ''
  const [year, month, date] = day.split('-').map((part) => Number(part))
  if (!year || !month || !date) return day
  return new Date(year, month - 1, date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function MultiClientChart({
  data,
  series,
}: {
  data: Array<Record<string, number | string>>
  series: ClientSeries[]
}) {
  // Which client line is "focused". When set, that line keeps its color and
  // every other line is washed out to gray. Clicking the same series again (or
  // its legend label) clears the focus and restores all colors. This is a
  // purely visual, in-chart highlight — it does NOT filter the dashboard.
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const toggleFocus = (key: string | undefined) => {
    if (!key) return
    setFocusedKey((current) => (current === key ? null : key))
  }
  // Stable legend entries in the ORIGINAL series order. We render this
  // explicitly (rather than letting recharts derive it from child order) so the
  // labels don't reshuffle when the focused line is re-ordered to paint on top.
  // The icon color is grayed for non-focused series to mirror the lines.
  const legendPayload = series.map((s, index) => {
    const dimmed = focusedKey != null && focusedKey !== s.key
    return {
      value: s.name,
      id: s.key,
      dataKey: s.key,
      type: 'plainline' as const,
      color: dimmed ? MUTED_STROKE : CLIENT_PALETTE[index % CLIENT_PALETTE.length],
      // recharts' plainline legend icon reads `entry.payload.strokeDasharray`.
      // A custom `payload` array MUST include this nested `payload` object or
      // recharts throws "Cannot read properties of undefined (reading
      // 'strokeDasharray')" and the whole chart (and dashboard) fails to render.
      payload: { strokeDasharray: '0', value: s.name },
    }
  })
  return (
    <div className="h-full min-h-0 w-full overflow-hidden rounded-md [&_.recharts-wrapper]:!overflow-hidden [&_.recharts-surface]:!overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 14, bottom: 8, left: 8 }}>
          <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={formatDayLabel}
            tick={{ fontSize: 10, fill: 'var(--text3)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--line)' }}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'var(--text3)' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={[0, 'dataMax']}
            width={56}
            tickFormatter={(value: number) => `$${formatInt(value)}`}
          />
          <Tooltip
            labelFormatter={formatDayLabel}
            formatter={(value: number, name: string) => [`$${formatInt(num(value))}`, name]}
            itemSorter={(item: { value?: number }) => -num(item?.value)}
            contentStyle={{
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              boxShadow: '0 12px 28px rgba(15,23,42,0.08)',
              fontSize: 12,
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 6, cursor: 'pointer' }}
            iconType="plainline"
            payload={legendPayload}
            onClick={(entry: { dataKey?: unknown; value?: unknown }) => {
              // Click a bottom-legend label -> focus that line (gray out the
              // rest). Resolve the series key from the payload's dataKey,
              // falling back to matching the displayed name.
              const fromDataKey = typeof entry?.dataKey === 'string' ? entry.dataKey : undefined
              const fromName = series.find((s) => s.name === entry?.value)?.key
              toggleFocus(fromDataKey ?? fromName)
            }}
            formatter={(value: unknown, entry: { dataKey?: unknown } | undefined) => {
              // Dim the labels of non-focused series so the legend mirrors the
              // grayscale state of the lines themselves.
              const key =
                typeof entry?.dataKey === 'string'
                  ? entry.dataKey
                  : series.find((s) => s.name === value)?.key
              const dimmed = focusedKey != null && key !== focusedKey
              return (
                <span
                  style={{
                    color: dimmed ? 'var(--text3)' : 'var(--text2)',
                    opacity: dimmed ? 0.55 : 1,
                    fontWeight: focusedKey != null && key === focusedKey ? 600 : 400,
                  }}
                >
                  {String(value ?? '')}
                </span>
              )
            }}
          />
          {series
            // Draw the focused series LAST so it paints on top of the grayed
            // lines. Keep each series' palette color keyed to its ORIGINAL index
            // so colors stay stable regardless of paint order.
            .map((s, index) => ({ s, index }))
            .sort((a, b) => {
              const aFocused = a.s.key === focusedKey
              const bFocused = b.s.key === focusedKey
              return aFocused === bFocused ? 0 : aFocused ? 1 : -1
            })
            .map(({ s, index }) => {
              const isFocused = focusedKey === s.key
              const isDimmed = focusedKey != null && !isFocused
              return (
                <Line
                  key={s.key}
                  type="linear"
                  dataKey={s.key}
                  name={s.name}
                  stroke={isDimmed ? MUTED_STROKE : CLIENT_PALETTE[index % CLIENT_PALETTE.length]}
                  strokeWidth={isFocused ? 2.75 : 1.75}
                  strokeOpacity={isDimmed ? 0.25 : 1}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                  isAnimationActive={false}
                  // Click a client line -> focus it (gray out the rest).
                  onClick={() => toggleFocus(s.key)}
                  style={{ cursor: 'pointer' }}
                />
              )
            })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function DashboardCharts({ trend, clientTrend, clientSeries }: DashboardChartsProps) {
  // Multi-client revenue mode (the "All Clients" breakdown).
  if (clientSeries && clientSeries.length > 0 && clientTrend && clientTrend.length > 0) {
    return <MultiClientChart data={clientTrend} series={clientSeries} />
  }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden rounded-md [&_.recharts-wrapper]:!overflow-hidden [&_.recharts-surface]:!overflow-hidden">
      <ResponsiveContainer width="100%" height="100%">
      <LineChart data={trend} margin={{ top: 10, right: 14, bottom: 8, left: 8 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={formatDayLabel}
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickLine={false}
          axisLine={{ stroke: 'var(--line)' }}
          minTickGap={24}
        />
        <YAxis
          yAxisId="orders"
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          domain={[0, 'dataMax']}
          width={48}
        />
        <YAxis
          yAxisId="revenue"
          orientation="right"
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          domain={[0, 'dataMax']}
          width={56}
          tickFormatter={(value: number) => `$${formatInt(value)}`}
        />
        <Tooltip
          labelFormatter={formatDayLabel}
          formatter={(value: number, name: string) => {
            if (name === 'currentRevenue') return [`$${formatInt(num(value))}`, 'Order value']
            return [formatInt(num(value)), 'Orders']
          }}
          contentStyle={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 12px 28px rgba(15,23,42,0.08)',
            fontSize: 12,
          }}
        />
        <Line
          yAxisId="orders"
          type="linear"
          dataKey="current"
          stroke="var(--brand)"
          strokeWidth={2.25}
          dot={{ r: 2 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
        <Line
          yAxisId="revenue"
          type="linear"
          dataKey="currentRevenue"
          stroke="rgb(16 185 129)"
          strokeWidth={2}
          dot={{ r: 2 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
      </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
