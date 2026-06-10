// Stock-status pill for the SKU Performance table. The status union
// ('in' | 'low' | 'out') mirrors DashboardSkuRow['status'] in
// DashboardView.tsx; inlined here so this primitive carries no
// dependency back into the parent view.
type StockStatus = 'in' | 'low' | 'out'

// Co-located copy of statusLabel (tiny + pure). The parent no longer
// defines it — StatusBadge was its only caller.
function statusLabel(status: StockStatus) {
  if (status === 'out') return 'Out of Stock'
  if (status === 'low') return 'Low Stock'
  return 'In Stock'
}

export function StatusBadge({ status }: { status: StockStatus }) {
  const classes =
    status === 'in'
      ? 'bg-ok/10 text-ok'
      : status === 'low'
        ? 'bg-warn/10 text-warn'
        : 'bg-danger/10 text-danger'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold ${classes}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === 'in' ? 'bg-ok' : status === 'low' ? 'bg-warn' : 'bg-danger'}`} />
      {statusLabel(status)}
    </span>
  )
}

export default StatusBadge
