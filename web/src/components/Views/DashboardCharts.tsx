import {
  CartesianGrid,
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

type DashboardChartsProps = {
  trend: TrendPoint[]
}

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

export default function DashboardCharts({ trend }: DashboardChartsProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
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
          width={48}
        />
        <YAxis
          yAxisId="revenue"
          orientation="right"
          tick={{ fontSize: 10, fill: 'var(--text3)' }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
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
          type="monotone"
          dataKey="current"
          stroke="var(--brand)"
          strokeWidth={2.25}
          dot={{ r: 2 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
        <Line
          yAxisId="revenue"
          type="monotone"
          dataKey="currentRevenue"
          stroke="rgb(16 185 129)"
          strokeWidth={2}
          dot={{ r: 2 }}
          activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
