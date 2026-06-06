// Shared constant for the Daily Orders Trend chart. Lives in its own tiny
// module so DashboardView (eager) and DashboardCharts (lazy-loaded) can both
// import it WITHOUT pulling the heavy chart bundle into the main chunk.

// Series key for the aggregate "Total orders across all stores" line. The
// DashboardView pivot sums every client's daily order count into this key, and
// DashboardCharts renders it as a thick dark line on top of the per-client lines.
export const TOTAL_TREND_SERIES_KEY = '__total__'
