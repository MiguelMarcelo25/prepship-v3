// PS-155: "Package Pricing by Client" card extracted verbatim from BillingView.tsx (behavior-preserving).
// Note: the package-price rows carry phantom fields
// (marginPct / marginColor / ourCost / dimsText / isCustom) produced by buildBillingPackagePriceRows.
//
// IMPORTANT — money/state ownership stays in BillingView:
//   • The price DRAFT map (packagePriceDrafts) + setter, the selected client id + setter, and the
//     pricing rows (packagePricingRows, built by the PURE buildBillingPackagePriceRows in the parent)
//     are all OWNED by BillingView and passed in as props.
//   • The Save action (onSavePackagePrices) — which calls apiClient.saveBillingPackagePrices — stays
//     in BillingView. This component only renders inputs and forwards onChange/onSave.
//   • getPackageMarginMarkup is the parent's byte-identical PURE render helper (reads only row.marginPct
//     / row.marginColor), relocated here because it's used only by this table.
type BillingConfigDto = any // TODO PS-257: restore real type
import { Package } from 'lucide-react'
import type { buildBillingPackagePriceRows } from './billing-parity'
import { Table } from '../ui/Table'

function getPackageMarginMarkup(row: ReturnType<typeof buildBillingPackagePriceRows>[number]) {
  if (row.marginPct == null || !row.marginColor) {
    return <span style={{ color: 'var(--text4)' }}>—</span>
  }

  return <span style={{ color: row.marginColor, fontWeight: 700 }}>{row.marginPct}%</span>
}

export function BillingPackagePricingTable({
  configs,
  selectedPkgClientId,
  setSelectedPkgClientId,
  packagePricingRows,
  packagePriceDrafts,
  setPackagePriceDrafts,
  packagePricingLoading,
  packagePricingError,
  onSavePackagePrices,
}: {
  configs: BillingConfigDto[]
  selectedPkgClientId: string
  setSelectedPkgClientId: (value: string) => void
  packagePricingRows: ReturnType<typeof buildBillingPackagePriceRows>
  packagePriceDrafts: Record<number, string>
  setPackagePriceDrafts: (updater: (current: Record<number, string>) => Record<number, string>) => void
  packagePricingLoading: boolean
  packagePricingError: string | null
  onSavePackagePrices: () => void
}) {
  return (
    <div className="rounded-xl bg-surface ring-1 ring-line p-4">
      <div className="billing-package-card-head flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <div className="flex items-center gap-2">
          <Package size={16} strokeWidth={2.25} className="text-ink-3" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold text-ink">Package pricing by client</h3>
        </div>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          <select className="filter-sel" style={{ fontSize: 12 }} value={selectedPkgClientId} onChange={(event) => setSelectedPkgClientId(event.target.value)}>
            <option value="">Select client…</option>
            {configs.map((config) => (
              <option key={config.clientId} value={config.clientId}>{config.clientName}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-sm" type="button" onClick={() => void onSavePackagePrices()}>Save</button>
        </div>
      </div>
      <div className="billing-package-table-wrap">
        {!selectedPkgClientId ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>Select a client to view pricing</div>
        ) : packagePricingError ? (
          <div style={{ padding: 16, textAlign: 'center', color: 'var(--red)', fontSize: 12 }}>{packagePricingError}</div>
        ) : (
          <Table
            data={packagePricingRows}
            rowKey={(row) => row.packageId}
            storageKey="billing-package-pricing-table"
            density="compact"
            stickyHeader={false}
            showColumnControls={false}
            loading={packagePricingLoading}
            emptyMessage="No custom packages found"
            defaultSort={{ key: 'box', direction: 'asc' }}
            columns={[
              {
                key: 'box',
                label: 'Box',
                width: 150,
                minWidth: 110,
                pinned: true,
                hideable: false,
                sortable: true,
                sortValue: (row) => row.name ?? '',
                render: (row) => (
                  <span style={{ fontWeight: 600, fontSize: 12 }}>
                    {row.name}
                    {row.isCustom ? (
                      <span title="Custom override — won't be changed by Set Default" style={{ fontSize: 9, color: 'var(--ss-blue)', marginLeft: 4, fontWeight: 600, letterSpacing: '.3px' }}>CUSTOM</span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'dims',
                label: 'Dims',
                width: 120,
                minWidth: 90,
                align: 'center',
                sortable: true,
                sortValue: (row) => row.dimsText ?? '',
                render: (row) => <span style={{ fontSize: 11, color: 'var(--text3)' }}>{row.dimsText}</span>,
              },
              {
                key: 'cost',
                label: 'Our Cost',
                width: 92,
                minWidth: 76,
                align: 'right',
                sortable: true,
                sortValue: (row) => row.ourCost,
                render: (row) => (
                  <span style={{ textAlign: 'right', display: 'block', fontSize: 11.5 }}>
                    {row.ourCost == null ? (
                      <span style={{ color: 'var(--text4)', fontSize: 10.5 }}>not set</span>
                    ) : (
                      <span style={{ color: 'var(--text2)' }}>${row.ourCost.toFixed(3)}</span>
                    )}
                  </span>
                ),
              },
              {
                key: 'charge',
                label: 'Charge',
                width: 92,
                minWidth: 76,
                align: 'right',
                sortable: true,
                sortValue: (row) => Number(packagePriceDrafts[row.packageId] ?? row.charge ?? 0),
                render: (row) => (
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    className="markup-input-lg billing-config-input"
                    style={{ width: '100%', textAlign: 'right', fontSize: 12 }}
                    value={packagePriceDrafts[row.packageId] ?? (Number(row.charge) || 0).toFixed(2)}
                    onChange={(event) => setPackagePriceDrafts((current) => ({
                      ...current,
                      [row.packageId]: event.target.value,
                    }))}
                  />
                ),
              },
              {
                key: 'margin',
                label: 'Margin',
                width: 84,
                minWidth: 64,
                align: 'right',
                sortable: true,
                sortValue: (row) => row.marginPct,
                render: (row) => <span style={{ display: 'block', textAlign: 'right' }}>{getPackageMarginMarkup(row)}</span>,
              },
            ]}
          />
        )}
      </div>
    </div>
  )
}
