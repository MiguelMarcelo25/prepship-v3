import { formatBillingMoney } from './billing-parity'
import { billingMarginColor } from './BillingShippingMarginSummary'

export type BillingShippingMarginReconciliationRow = {
  orderNumber: string | null
  orderId: number | null
  shipmentId: number | null
  shipDate: string | null
  carrierCode: string | null
  serviceCode: string | null
  providerAccountNickname: string | null
  accountDisplayName?: string | null
  accountDisplaySource?: string | null
  actualShippingCost: number | null
  billableShippingAmount: number | null
  marginAmount: number | null
  marginPct: number | null
  state: string
  missingProofReasons: string[]
}

type BillingShippingMarginReconciliationProps = {
  rows: BillingShippingMarginReconciliationRow[]
  open: boolean
  onToggle: () => void
  limit?: number
}

function missingText(value: string | number | null | undefined) {
  if (value == null || value === '') return '-'
  return String(value)
}

function carrierAccountText(row: BillingShippingMarginReconciliationRow) {
  const carrier = row.carrierCode ?? '-'
  const service = row.serviceCode ? ` - ${row.serviceCode}` : ''
  const account = row.accountDisplayName ?? row.providerAccountNickname
  return account ? `${carrier}${service} (${account})` : `${carrier}${service}`
}

export function BillingShippingMarginReconciliation({
  rows,
  open,
  onToggle,
  limit = 250,
}: BillingShippingMarginReconciliationProps) {
  if (rows.length === 0) return null

  return (
    <div style={{ margin: '0 0 14px' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text3)',
          textTransform: 'uppercase',
          letterSpacing: '.04em',
        }}
      >
        {open ? 'v' : '>'} Per-order reconciliation ({rows.length})
      </button>
      {open ? (
        <div style={{ overflowX: 'auto', marginTop: 6 }}>
          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', whiteSpace: 'nowrap' }}>
            <thead>
              <tr style={{ color: 'var(--text3)', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '3px 8px 3px 0' }}>Order #</th>
                <th style={{ textAlign: 'left', padding: '3px 8px' }}>Shipment</th>
                <th style={{ textAlign: 'left', padding: '3px 8px' }}>Ship date</th>
                <th style={{ textAlign: 'left', padding: '3px 8px' }}>Carrier / account</th>
                <th style={{ padding: '3px 8px' }}>Cost</th>
                <th style={{ padding: '3px 8px' }}>Billable</th>
                <th style={{ padding: '3px 8px' }}>Margin</th>
                <th style={{ padding: '3px 8px' }}>%</th>
                <th style={{ textAlign: 'left', padding: '3px 0 3px 8px' }}>Issues</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((row, index) => (
                <tr
                  key={`${row.shipmentId ?? ''}|${row.orderId ?? ''}|${index}`}
                  style={{ textAlign: 'right', borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.05))' }}
                >
                  <td style={{ textAlign: 'left', padding: '3px 8px 3px 0', fontWeight: 600 }}>{missingText(row.orderNumber)}</td>
                  <td style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text3)' }}>{missingText(row.shipmentId)}</td>
                  <td style={{ textAlign: 'left', padding: '3px 8px', color: 'var(--text2)' }}>{row.shipDate ? row.shipDate.slice(0, 10) : '-'}</td>
                  <td style={{ textAlign: 'left', padding: '3px 8px' }}>{carrierAccountText(row)}</td>
                  <td style={{ padding: '3px 8px' }}>{row.actualShippingCost == null ? '-' : formatBillingMoney(row.actualShippingCost)}</td>
                  <td style={{ padding: '3px 8px' }}>{row.billableShippingAmount == null ? '-' : formatBillingMoney(row.billableShippingAmount)}</td>
                  <td style={{ padding: '3px 8px', fontWeight: 700, color: row.marginAmount == null ? 'var(--text3)' : billingMarginColor(row.marginAmount) }}>
                    {row.marginAmount == null ? '-' : formatBillingMoney(row.marginAmount)}
                  </td>
                  <td style={{ padding: '3px 8px' }}>{row.marginPct == null ? '-' : `${row.marginPct.toFixed(1)}%`}</td>
                  <td
                    style={{
                      textAlign: 'left',
                      padding: '3px 0 3px 8px',
                      color: (row.missingProofReasons ?? []).length > 0 ? 'var(--red)' : 'var(--text3)',
                    }}
                  >
                    {(row.missingProofReasons ?? []).length > 0 ? (row.missingProofReasons ?? []).join(', ') : (row.state ?? '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit ? (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
              Showing first {limit} of {rows.length} shipments - narrow the date range to see the rest.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
