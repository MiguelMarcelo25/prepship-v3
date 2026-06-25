// PS-296 (FE) restyle: the "Margin by carrier / account" rollup, moved onto the shared <Table> so it
// gets pagination (10/25/50, page state persisted) + the consistent Tailwind table styling. The long
// flat list that used to render every carrier inline is now paged. Display-only — it consumes the
// backend analytics.carriers[] rows passed in from BillingView (and DashboardView); no money logic
// lives here. `storageKey` defaults to the Billing key; the Dashboard passes its own so the two views
// keep independent page/sort/column state instead of silently moving each other.
import { Table } from '../ui/Table'
import { formatBillingMoney } from './billing-parity'

export type CarrierMarginRow = {
  carrierCode: string | null
  serviceCode: string | null
  providerAccountNickname: string | null
  actualShippingTotal: number
  billableShippingTotal: number
  marginTotal: number
  marginPct: number | null
  marginRowCount: number
  negativeMarginCount: number
}

// Byte-identical to BillingView/BillingDetailTable's local helper (small pure render util).
function marginColor(value: number) {
  if (value > 0) return 'var(--green)'
  if (value < 0) return 'var(--red)'
  return 'var(--text3)'
}

export function BillingCarrierMarginTable({
  carriers,
  storageKey = 'billing-carrier-margin',
}: {
  carriers: CarrierMarginRow[]
  storageKey?: string
}) {
  if (carriers.length === 0) return null

  // The carrier rollup has no natural id and carrier+service+account can repeat across accounts, so
  // bake the original index into a stable unique key (survives sort/pagination).
  const rows = carriers.map((carrier, index) => ({
    ...carrier,
    _key: `${carrier.carrierCode ?? ''}|${carrier.serviceCode ?? ''}|${carrier.providerAccountNickname ?? ''}|${index}`,
  }))

  return (
    <section className="mb-3.5">
      <Table<(typeof rows)[number]>
        data={rows}
        rowKey={(row) => row._key}
        storageKey={storageKey}
        density="compact"
        stickyHeader={false}
        showColumnControls={false}
        paginated
        pageSizeOptions={[10, 25, 50]}
        defaultPageSize={10}
        emptyMessage="No carrier rows"
        defaultSort={{ key: 'margin', direction: 'desc' }}
        toolbar={
          <div className="flex items-center gap-2 w-full">
            <span className="text-[12.5px] font-semibold text-ink">Margin by carrier / account</span>
            <span className="ml-auto text-[11px] text-ink-3">{carriers.length} carrier{carriers.length === 1 ? '' : 's'}</span>
          </div>
        }
        columns={[
          {
            key: 'carrier',
            label: 'Carrier / service',
            width: 200,
            minWidth: 140,
            pinned: true,
            hideable: false,
            sortable: true,
            sortValue: (row) => `${row.carrierCode ?? ''} ${row.serviceCode ?? ''}`,
            render: (row) => (
              <span className="font-semibold text-ink">
                {row.carrierCode ?? '—'}
                {row.serviceCode ? ` · ${row.serviceCode}` : ''}
              </span>
            ),
          },
          {
            key: 'account',
            label: 'Account',
            width: 110,
            minWidth: 70,
            sortable: true,
            sortValue: (row) => row.providerAccountNickname ?? '',
            render: (row) =>
              row.providerAccountNickname ? (
                <span className="text-ink-2">{row.providerAccountNickname}</span>
              ) : (
                <span className="text-ink-3">—</span>
              ),
          },
          {
            key: 'cost',
            label: 'Cost',
            width: 92,
            minWidth: 72,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.actualShippingTotal,
            render: (row) => <span className="tabular-nums">{formatBillingMoney(row.actualShippingTotal, { dashIfZero: true })}</span>,
          },
          {
            key: 'billable',
            label: 'Billable',
            width: 92,
            minWidth: 72,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.billableShippingTotal,
            render: (row) => <span className="tabular-nums">{formatBillingMoney(row.billableShippingTotal, { dashIfZero: true })}</span>,
          },
          {
            key: 'margin',
            label: 'Margin',
            width: 96,
            minWidth: 72,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.marginTotal,
            render: (row) => (
              <span className="tabular-nums font-semibold" style={{ color: marginColor(row.marginTotal) }}>
                {formatBillingMoney(row.marginTotal, { dashIfZero: true })}
              </span>
            ),
          },
          {
            key: 'marginPct',
            label: 'Margin %',
            width: 84,
            minWidth: 60,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.marginPct ?? Number.NEGATIVE_INFINITY,
            render: (row) => <span className="tabular-nums">{row.marginPct == null ? '—' : `${row.marginPct.toFixed(1)}%`}</span>,
          },
          {
            key: 'rows',
            label: 'Rows',
            width: 66,
            minWidth: 50,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.marginRowCount,
            render: (row) => <span className="tabular-nums">{row.marginRowCount}</span>,
          },
          {
            key: 'neg',
            label: 'Neg',
            width: 60,
            minWidth: 48,
            align: 'right',
            sortable: true,
            sortValue: (row) => row.negativeMarginCount,
            render: (row) => (
              <span
                className="tabular-nums"
                style={{
                  color: row.negativeMarginCount > 0 ? 'var(--red)' : 'var(--text3)',
                  fontWeight: row.negativeMarginCount > 0 ? 600 : 400,
                }}
              >
                {row.negativeMarginCount}
              </span>
            ),
          },
        ]}
      />
    </section>
  )
}
