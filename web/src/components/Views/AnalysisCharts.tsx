// FE-5 (audit 2026-07-13): recharts (the app's largest vendor chunk, ~430kB)
// was statically imported by AnalysisView, so every Analysis visit — including
// table-only visits — downloaded the whole charting library. This module now
// owns BOTH Analysis chart regions and is loaded exclusively via lazy() from
// AnalysisView (mirroring DashboardView's DashboardCharts split), so recharts
// stays out of the Analysis eager path until a chart actually renders.
//
// Contents (moved verbatim, display-only — no data fetching, no business logic):
//   - AnalysisTopSkusChart: re-exported from its existing module so the lazy
//     import of THIS file pulls it (and recharts) into the same async chunk.
//   - AnalysisDrawerUnitsChart: the SKU-drawer "Units Sold — Last 30 Days" bar
//     chart, extracted from AnalysisView's drawer JSX. Rows/ticks/max are
//     computed by the caller exactly as before and passed in as props.
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export { AnalysisTopSkusChart } from './AnalysisTopSkusChart'

// Moved verbatim from AnalysisView.tsx (was DrawerBarValueLabel beside the
// drawer chart): per-bar numeric label, drawn inside the bar when it is tall
// enough, otherwise just above it.
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

export interface AnalysisDrawerUnitsChartProps {
  rows: Array<{ day: string; units: number }>
  yAxisTicks: number[]
  yAxisMax: number
}

// The drawer chart markup below is byte-identical to what AnalysisView rendered
// inline before the FE-5 split (same margins, ticks, tooltip styling, bar fill).
export function AnalysisDrawerUnitsChart({ rows, yAxisTicks, yAxisMax }: AnalysisDrawerUnitsChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={rows}
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
          ticks={yAxisTicks}
          domain={[0, yAxisMax]}
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
            content={(props) => <DrawerBarValueLabel {...(props as any)} />}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
