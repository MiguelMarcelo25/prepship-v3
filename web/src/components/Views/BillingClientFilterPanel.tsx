// PS-155: Billing client-filter panel extracted verbatim from BillingView.tsx
// (behavior-preserving). The selection state (selectedBillingClientIdSet), the available-client
// list, and all toggle handlers stay OWNED by BillingView and are passed in — pure presentation.
import { Check, ListFilter, SlidersHorizontal, X } from 'lucide-react'

export function BillingClientFilterPanel({
  clientFilterOpen,
  selectedBillingClientCount,
  availableBillingClients,
  summaryRowsLength,
  billingClientFilterActive,
  excludedBillingClientNames,
  selectedBillingClientIdSet,
  missingShipStationClientNames,
  onToggleAdvanced,
  onSelectShipStation,
  onSelectAll,
  onToggleClient,
}: {
  clientFilterOpen: boolean
  selectedBillingClientCount: number
  availableBillingClients: Array<{ clientId: number; clientName: string; inShipStation: boolean }>
  summaryRowsLength: number
  billingClientFilterActive: boolean
  excludedBillingClientNames: string[]
  selectedBillingClientIdSet: Set<number>
  missingShipStationClientNames: string[]
  onToggleAdvanced: () => void
  onSelectShipStation: () => void
  onSelectAll: () => void
  onToggleClient: (clientId: number) => void
}) {
  return (
    <div className="billing-client-filter">
      <div className="billing-client-filter-head">
        <div className="billing-client-filter-copy">
          <div className="billing-client-filter-title">
            <ListFilter size={14} strokeWidth={2.4} aria-hidden />
            <span>Client Filter</span>
            <span className="billing-client-filter-count">
              {selectedBillingClientCount} of {availableBillingClients.length || summaryRowsLength} clients
            </span>
          </div>
          <div className="billing-client-filter-subtitle">
            {billingClientFilterActive
              ? `Visible billing excludes: ${excludedBillingClientNames.length ? excludedBillingClientNames.join(', ') : 'none'}`
              : 'All PrepShip billing clients are included.'}
          </div>
        </div>
        <div className="billing-client-filter-actions">
          <button className="btn btn-outline btn-sm billing-filter-action" type="button" onClick={onSelectShipStation} title="Show only clients that exist in ShipStation">
            <Check size={12} strokeWidth={2.5} aria-hidden />
            ShipStation only
          </button>
          <button className="btn btn-ghost btn-sm billing-filter-action" type="button" onClick={onSelectAll} title="Restore every PrepShip billing client">
            <X size={12} strokeWidth={2.5} aria-hidden />
            All clients
          </button>
          <button className="btn btn-ghost btn-sm billing-filter-action" type="button" onClick={onToggleAdvanced} aria-expanded={clientFilterOpen}>
            <SlidersHorizontal size={12} strokeWidth={2.5} aria-hidden />
            Advanced
          </button>
        </div>
      </div>

      {clientFilterOpen ? (
        <div className="billing-client-filter-options">
          {availableBillingClients.map((client) => {
            const checked = billingClientFilterActive ? selectedBillingClientIdSet.has(client.clientId) : true
            return (
              <label key={client.clientId} className={`billing-client-filter-option${checked ? ' is-selected' : ''}${client.inShipStation ? '' : ' is-prepship-only'}`}>
                <input type="checkbox" checked={checked} onChange={() => onToggleClient(client.clientId)} />
                <span className="billing-client-filter-name">{client.clientName}</span>
                <span className="billing-client-filter-badge">{client.inShipStation ? 'ShipStation' : 'PrepShip only'}</span>
              </label>
            )
          })}
          {missingShipStationClientNames.length > 0 ? (
            <div className="billing-client-filter-note">
              ShipStation-only client not in PrepShip billing: {missingShipStationClientNames.join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
