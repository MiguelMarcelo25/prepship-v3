// @ts-nocheck
// Small inline SVG sparkline used in the AnalysisView "Units Trend"
// column. Renders 50+ rows without a chart library — recharts/svg would
// each pay a per-row mount cost, plain SVG is essentially free. Line
// color tracks the trend direction (green/red/grey) so a glance across
// the column tells the operator which SKUs are growing vs fading.
import { computeUnitsTrend } from './analysis-parity'

interface UnitsTrendSparklineProps {
  series: number[]
  width?: number
  height?: number
}

// Tuned to fit the 80–90px column without crowding adjacent text.
const DEFAULT_WIDTH = 84
const DEFAULT_HEIGHT = 28

// Material-Blue-aligned greens/reds matching the rest of the v4-stable
// theme. The flat color picks up the muted-line token so it blends in
// when there's nothing meaningful to show.
const COLORS = {
  up: { stroke: '#16a34a', fill: 'rgba(22, 163, 74, 0.18)' },
  down: { stroke: '#dc2626', fill: 'rgba(220, 38, 38, 0.16)' },
  flat: { stroke: '#94a3b8', fill: 'rgba(148, 163, 184, 0.12)' },
}

export function UnitsTrendSparkline({
  series,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: UnitsTrendSparklineProps) {
  // Fall back to a dashed baseline when there's no data — keeps the
  // cell from looking broken on SKUs with one or zero days of activity.
  if (!Array.isArray(series) || series.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="No trend data"
        className="overflow-visible"
      >
        <line
          x1={2}
          y1={height / 2}
          x2={width - 2}
          y2={height / 2}
          stroke="#cbd5e1"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    )
  }

  const trend = computeUnitsTrend(series)
  const palette = COLORS[trend.direction]

  const max = Math.max(...series, 1)
  const min = Math.min(...series, 0)
  const range = Math.max(max - min, 1)

  // Project the series onto the SVG box. The 2px inset on each axis
  // keeps the stroke from getting clipped against the cell edge.
  const xInset = 2
  const yInset = 3
  const innerWidth = width - xInset * 2
  const innerHeight = height - yInset * 2
  const step = innerWidth / (series.length - 1)

  const points = series.map((value, index) => {
    const x = xInset + index * step
    // SVG y grows downward — flip so larger values rise toward the top.
    const y = yInset + innerHeight - ((value - min) / range) * innerHeight
    return [x, y] as const
  })

  const polyline = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')

  // Closed polygon for the gradient fill underneath the stroke. We
  // anchor it on the bottom edge so the area shading reads as "units
  // sitting on a baseline."
  const baseY = yInset + innerHeight
  const areaPath =
    `M ${points[0][0].toFixed(2)} ${baseY.toFixed(2)} ` +
    points.map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') +
    ` L ${points[points.length - 1][0].toFixed(2)} ${baseY.toFixed(2)} Z`

  const totalUnits = trend.total.toLocaleString()
  const directionWord =
    trend.direction === 'up' ? 'trending up' : trend.direction === 'down' ? 'trending down' : 'flat'
  const pct = `${(trend.strength * 100).toFixed(0)}%`
  const title = `${totalUnits} units · ${directionWord} (${pct})`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
      className="overflow-visible"
    >
      <title>{title}</title>
      <path d={areaPath} fill={palette.fill} stroke="none" />
      <polyline
        points={polyline}
        fill="none"
        stroke={palette.stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
