// PS-155: Client Billing Config table extracted verbatim from BillingView.tsx (behavior-preserving).
// The billing DTO types (BillingConfigDto, etc.) are phantom names not actually exported from
// types/api, so they're defined locally in ./billing-parity (the most-shared billing module) and
// imported from there. The extraction is a verbatim JSX move.
//
// IMPORTANT — money/state ownership stays in BillingView:
//   • The config DRAFT map (configDrafts) and its setter (setConfigDrafts) are OWNED by BillingView
//     and passed in as props. Every numeric input still writes straight into the parent's draft state.
//   • The Save action (handleSaveConfig) — which calls buildBillingConfigInput + apiClient.updateBillingConfig
//     — stays in BillingView. This component only renders the cells and forwards onChange/onSave.
//   • renderConfigNumberCell is the parent's byte-identical inline cell helper, relocated here because
//     it only closes over the draft map + setter, both of which arrive as props.
import type { BillingConfigDto, BillingConfigDraft } from './billing-parity'
import { Table } from '../ui/Table'

export function BillingConfigTable({
  configs,
  configsLoading,
  configDrafts,
  setConfigDrafts,
  onSaveConfig,
  onToggleHouseAccount,
}: {
  configs: BillingConfigDto[]
  configsLoading: boolean
  configDrafts: Record<number, BillingConfigDraft>
  setConfigDrafts: (updater: (current: Record<number, BillingConfigDraft>) => Record<number, BillingConfigDraft>) => void
  onSaveConfig: (clientId: number) => void
  // PS-220 (P4): immediate per-client opt-in into the SHIPP house-account margin model.
  onToggleHouseAccount: (clientId: number, enabled: boolean) => void
}) {
  // Editable numeric cell for the Client Billing Config <Table>. The input
  // fills the cell (width:100%) and right-aligns its own text; the column's
  // `align:'right'` only drives the header label, so the numeric look comes
  // from this inline style (Table hardcodes cell text-align to left).
  function renderConfigNumberCell(
    config: BillingConfigDto,
    field: Exclude<keyof BillingConfigDraft, 'active'>,
    fallback: string,
    step: string,
    min: string,
    title?: string,
  ) {
    const draft = configDrafts[config.clientId]
    return (
      <input
        type="number"
        step={step}
        min={min}
        className="markup-input-lg billing-config-input"
        style={{ width: '100%', textAlign: 'right', fontSize: 11.5 }}
        title={title}
        value={draft?.[field] ?? fallback}
        onChange={(event) => setConfigDrafts((current) => ({
          ...current,
          [config.clientId]: { ...current[config.clientId], [field]: event.target.value } as BillingConfigDraft,
        }))}
      />
    )
  }

  return (
    <div className="markup-card">
      <h3 style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Client Billing Config</h3>
      <div className="billing-config-table-wrap">
        <Table<BillingConfigDto>
          data={configs}
          rowKey={(row) => row.clientId}
          storageKey="billing-config-table"
          density="compact"
          stickyHeader={false}
          showColumnControls={false}
          loading={configsLoading}
          emptyMessage="No clients found."
          defaultSort={{ key: 'client', direction: 'asc' }}
          columns={[
            {
              key: 'client',
              label: 'Client',
              width: 150,
              minWidth: 120,
              pinned: true,
              hideable: false,
              sortable: true,
              sortValue: (row) => row.clientName ?? '',
              render: (row) => <span style={{ fontWeight: 600, fontSize: 11.5 }}>{row.clientName}</span>,
            },
            {
              key: 'pickPack',
              label: 'Pick & Pack',
              width: 84,
              minWidth: 70,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.pickPackFee ?? row.pickPackFee ?? 0),
              render: (row) => renderConfigNumberCell(row, 'pickPackFee', '0.00', '0.01', '0'),
            },
            {
              key: 'additional',
              label: 'Addl Unit',
              width: 84,
              minWidth: 70,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.additionalUnitFee ?? row.additionalUnitFee ?? 0),
              render: (row) => renderConfigNumberCell(row, 'additionalUnitFee', '0.00', '0.01', '0'),
            },
            {
              key: 'packageMarkup',
              label: 'Pkg %',
              width: 76,
              minWidth: 64,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.packageCostMarkup ?? row.packageCostMarkup ?? 0),
              render: (row) => renderConfigNumberCell(row, 'packageCostMarkup', '0.0', '0.1', '0', 'Markup applied to package cost lines (percent)'),
            },
            {
              key: 'shipPct',
              label: 'Ship %',
              width: 76,
              minWidth: 64,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.shippingMarkupPct ?? row.shippingMarkupPct ?? 0),
              render: (row) => renderConfigNumberCell(row, 'shippingMarkupPct', '0.0', '0.1', '0'),
            },
            {
              key: 'shipFlat',
              label: 'Ship $',
              width: 84,
              minWidth: 70,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.shippingMarkupFlat ?? row.shippingMarkupFlat ?? 0),
              render: (row) => renderConfigNumberCell(row, 'shippingMarkupFlat', '0.00', '0.01', '0'),
            },
            {
              key: 'storage',
              label: 'Storage $/cuft',
              width: 96,
              minWidth: 80,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.storageFeePerCuFt ?? row.storageFeePerCuFt ?? 0),
              render: (row) => renderConfigNumberCell(row, 'storageFeePerCuFt', '0.00', '0.01', '0', '$/cuft/month storage fee applied to inventory on hand'),
            },
            {
              key: 'maxUnits',
              label: 'Max Units',
              width: 84,
              minWidth: 70,
              align: 'right',
              sortable: true,
              sortValue: (row) => Number(configDrafts[row.clientId]?.pickPackMaxUnits ?? row.pickPackMaxUnits ?? 0),
              render: (row) => renderConfigNumberCell(row, 'pickPackMaxUnits', '1', '1', '1', 'Orders with total units ≤ this value pay only the base Pick & Pack fee; excess units are billed at the Addl Unit rate'),
            },
            {
              key: 'mode',
              label: 'Mode',
              width: 118,
              minWidth: 100,
              align: 'center',
              sortable: true,
              sortValue: (row) => configDrafts[row.clientId]?.billingMode ?? row.billingMode ?? '',
              render: (row) => {
                const draft = configDrafts[row.clientId]
                return (
                  <select
                    className="ship-select billing-config-select"
                    style={{ width: '100%', fontSize: 10, padding: '2px 4px', borderRadius: 4, border: '1px solid var(--border)' }}
                    value={draft?.billingMode ?? 'per_shipment'}
                    onChange={(event) => setConfigDrafts((current) => ({
                      ...current,
                      [row.clientId]: { ...current[row.clientId], billingMode: event.target.value } as BillingConfigDraft,
                    }))}
                  >
                    <option value="label_cost">Label Cost</option>
                    <option value="ss_ref_rate">SS Ref Rate ★</option>
                    <option value="per_shipment">Per Shipment</option>
                    <option value="monthly">Monthly</option>
                  </select>
                )
              },
            },
            {
              key: 'active',
              label: 'Active',
              width: 64,
              minWidth: 52,
              align: 'center',
              sortable: true,
              sortValue: (row) => (configDrafts[row.clientId]?.active ?? row.active ?? true) ? 1 : 0,
              render: (row) => {
                const draft = configDrafts[row.clientId]
                return (
                  <input
                    type="checkbox"
                    checked={draft?.active !== false}
                    title="Disable to skip billing-line generation for this client"
                    onChange={(event) => setConfigDrafts((current) => ({
                      ...current,
                      [row.clientId]: { ...current[row.clientId], active: event.target.checked } as BillingConfigDraft,
                    }))}
                  />
                )
              },
            },
            {
              // PS-220 (P4): SHIPP house-account opt-in. Immediate toggle (its own admin endpoint),
              // NOT part of the draft Save above. ON => this client's SHIPP-winning orders bill the
              // captured customer_rate (cheapest eligible non-SHIPP) and DRP keeps the spread.
              key: 'houseAccount',
              label: 'House Acct',
              width: 78,
              minWidth: 64,
              align: 'center',
              sortable: true,
              sortValue: (row) => ((row as { houseAccountEnabled?: boolean }).houseAccountEnabled ? 1 : 0),
              render: (row) => (
                <input
                  type="checkbox"
                  checked={(row as { houseAccountEnabled?: boolean }).houseAccountEnabled === true}
                  title="SHIPP house account: when SHIPP wins for this client, bill the cheapest eligible non-SHIPP rate (customer_rate) and keep the spread as DRP margin. Default off."
                  onChange={(event) => onToggleHouseAccount(row.clientId, event.target.checked)}
                />
              ),
            },
            {
              key: 'actions',
              label: '',
              width: 70,
              minWidth: 60,
              align: 'center',
              sortable: false,
              hideable: false,
              render: (row) => (
                <button className="btn btn-outline btn-xs" type="button" onClick={() => void onSaveConfig(row.clientId)}>Save</button>
              ),
            },
          ]}
        />
      </div>
    </div>
  )
}
