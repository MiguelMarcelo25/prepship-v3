import { motion } from 'framer-motion'

// Co-located private copy of MiniSparkline. The parent DashboardView.tsx
// keeps its own MiniSparkline because TinyTrend (a column renderer that
// stays in the parent) still consumes it; we duplicate the tiny pure SVG
// helper here so KpiCard is self-contained and importable on its own.
function MiniSparkline({ values, positive = true, size = 'md' }: { values: number[]; positive?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  const points = values.length ? values : [0, 0]
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const span = Math.max(1, max - min)
  // Larger viewBox + bigger CSS size for the inline-next-to-value
  // sparkline. The old corner-only sparkline was 62×28 px; the new
  // inline placement needs more horizontal room to read as a chart
  // and to balance visually with the big value number.
  const width = size === 'lg' ? 88 : size === 'sm' ? 48 : 72
  const height = size === 'lg' ? 32 : size === 'sm' ? 24 : 30
  const step = width / Math.max(1, points.length - 1)
  const path = points
    .map((value, index) => {
      const x = index * step
      const y = height - ((value - min) / span) * (height - 4) - 2
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const sizeClass = size === 'lg' ? 'h-8 w-[88px]' : size === 'sm' ? 'h-6 w-12' : 'h-7 w-[72px]'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`${sizeClass} ${positive ? 'text-brand' : 'text-danger'}`} aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function KpiCard({
  title,
  value,
  suffix,
  helper,
  tone,
  icon,
  spark,
  progress,
}: {
  title: string
  value: React.ReactNode
  suffix?: string
  helper: React.ReactNode
  tone?: 'green' | 'orange' | 'red' | 'blue'
  icon?: React.ReactNode
  spark?: number[]
  progress?: number
}) {
  const toneClass =
    tone === 'green'
      ? 'text-ok bg-ok/10 ring-ok/20'
      : tone === 'orange'
        ? 'text-warn bg-warn/10 ring-warn/20'
        : tone === 'red'
          ? 'text-danger bg-danger/10 ring-danger/20'
          : 'text-brand bg-brand-bg ring-brand/20'
  const titleClass =
    tone === 'green'
      ? 'text-ok'
      : tone === 'orange'
        ? 'text-warn'
        : tone === 'red'
          ? 'text-danger'
          : 'text-ink-2'
  const progressClass =
    tone === 'green'
      ? 'bg-ok'
      : tone === 'orange'
        ? 'bg-warn'
        : tone === 'red'
          ? 'bg-danger'
          : 'bg-brand'

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex min-h-[112px] flex-col justify-between rounded-card border border-line bg-surface px-3 py-3 shadow-sm sm:min-h-[118px] sm:px-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className={`text-xs font-semibold ${titleClass}`}>{title}</div>
          {/* Value row — sparkline now sits INLINE next to the
              number (operator request 2026-05-13: match the new
              design where the chart visually anchors the metric
              instead of floating in the top-right corner). The
              flex-1 + ml-auto pattern pushes the sparkline to the
              far right of the value row so the number stays
              left-anchored with the title above it. */}
          <div className="mt-3 flex items-end gap-3 text-[24px] font-extrabold leading-none tracking-[-0.02em] text-ink font-mono tabular-nums sm:text-[26px]">
            <div className="inline-flex items-end gap-1.5">
              {value}
              {suffix ? <span className="pb-0.5 text-xs font-bold tracking-normal text-ink-2">{suffix}</span> : null}
            </div>
            {spark ? (
              <span className="ml-auto pb-0.5">
                <MiniSparkline values={spark} positive={tone !== 'red'} size="md" />
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-tiny">{helper}</div>
        </div>
        {/* Stock-card icon — kept in the top-right corner. Slightly
            larger now (10×10 was 9×9) for a punchier presence that
            matches the design reference. */}
        {icon ? (
          <div className={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-full ring-1 ${toneClass}`}>
            {icon}
          </div>
        ) : null}
      </div>
      {typeof progress === 'number' ? (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-line/70">
          <div className={`h-full rounded-full ${progressClass}`} style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      ) : null}
    </motion.div>
  )
}

export default KpiCard
