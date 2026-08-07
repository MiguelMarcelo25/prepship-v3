import { useMemo, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import type { PackageDto } from '../../types/api'
import type { BillingEditDraft } from './billing-edit-draft-cache'
import {
  formatBillingMoney,
  billingDetailQtyDisplay,
  formatBillingShipDate,
  type BillingDetailDto,
} from './billing-parity'
import { hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'
import { BillingNoBoxCostPreview } from './BillingNoBoxCostPreview'
import { billingMarginColor } from './BillingShippingMarginSummary'

export type BillingEditModalViewState = {
  row: BillingDetailDto
  draft: BillingEditDraft
  saving: boolean
  error: string | null
}

type ZeroShippingDecision = 'waived' | 'not_waived'

type BillingEditDetailModalProps = {
  modal: BillingEditModalViewState
  packages: PackageDto[]
  /**
   * Package ids this client has a saved price row for, derived from the backend
   * package-pricing owner. Display grouping only — the charge itself still comes
   * from that owner via onPackageChange.
   */
  clientPricedPackageIds: number[]
  noBoxCostRows: BillingDetailDto[]
  clientId: number | null
  clientName: string
  from: string
  to: string
  draftTotal: number
  draftMargin: number
  zeroShippingReviewSaving: boolean
  onClose: () => void
  onPackageChange: (value: string) => void
  onDraftChange: (field: keyof BillingEditDraft, value: string) => void
  onOpenBillingEdit: (row: BillingDetailDto) => void
  onOpenNoBoxCostBulkApply: (row: BillingDetailDto) => void
  onOpenBoxReviewSweep: () => void
  onOpenBulkBoxCost: () => void
  onZeroShippingReview: (decision: ZeroShippingDecision) => void | Promise<void>
  onSave: () => void | Promise<void>
}

function fallbackText(value: unknown) {
  const text = String(value ?? '').trim()
  return text || '-'
}

function packageOptionId(pkg: PackageDto): string {
  return String(pkg.packageId ?? pkg.id)
}

/**
 * Loose match so "12x10" and "12 x 10" both find "Custom 12x10x3": compare on
 * alphanumerics only.
 */
function matchesBoxFilter(pkg: PackageDto, needle: string): boolean {
  if (!needle) return true
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalize(String(pkg.name || packageOptionId(pkg))).includes(normalize(needle))
}

function moneyDraft(value: string) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? amount : 0
}

function manualBillingOverrideLabels(row: BillingDetailDto): string[] {
  const raw = row.manualBillingOverrideLabels ?? row.manual_billing_override_labels
  if (Array.isArray(raw)) return [...new Set(raw.map((value) => String(value)).filter(Boolean))]
  const types = row.manualBillingOverrideLineTypes ?? row.manual_billing_override_line_types
  if (!Array.isArray(types)) return []
  return [
    ...new Set(
      types.map((value) => String(value) === 'shipping' ? 'Shipping override' : 'Manual override'),
    ),
  ]
}

export function BillingEditDetailModal({
  modal,
  packages,
  clientPricedPackageIds,
  noBoxCostRows,
  clientId,
  clientName,
  from,
  to,
  draftTotal,
  draftMargin,
  zeroShippingReviewSaving,
  onClose,
  onPackageChange,
  onDraftChange,
  onOpenBillingEdit,
  onOpenNoBoxCostBulkApply,
  onOpenBoxReviewSweep,
  onOpenBulkBoxCost,
  onZeroShippingReview,
  onSave,
}: BillingEditDetailModalProps) {
  const { row, draft, saving, error } = modal
  const prepTotal = moneyDraft(draft.pickPack) + moneyDraft(draft.additional)
  const manualOverrideLabels = manualBillingOverrideLabels(row)

  const [boxFilter, setBoxFilter] = useState('')

  // This client's priced boxes first, everything else still reachable. Hard-filtering
  // the rest out would strand the "Box needs review" flow below, which exists exactly
  // for a shipped box that matched no priced package.
  const { clientBoxes, otherBoxes } = useMemo(() => {
    const priced = new Set(clientPricedPackageIds)
    const mine: PackageDto[] = []
    const rest: PackageDto[] = []
    for (const pkg of packages) {
      if (!matchesBoxFilter(pkg, boxFilter)) continue
      const id = Number(pkg.packageId ?? pkg.id)
      if (Number.isFinite(id) && priced.has(id)) mine.push(pkg)
      else rest.push(pkg)
    }
    return { clientBoxes: mine, otherBoxes: rest }
  }, [packages, clientPricedPackageIds, boxFilter])

  const clientBoxLabel = clientName ? `${clientName} boxes` : 'Client boxes'
  const noBoxMatches = boxFilter.trim().length > 0 && clientBoxes.length === 0 && otherBoxes.length === 0

  return (
    <div className="billing-edit-backdrop" role="presentation" onMouseDown={() => !saving && onClose()}>
      <div
        className="billing-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit billing detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="billing-edit-head">
          <div>
            <h3>Edit Billing Detail</h3>
            <p>{row.orderNumber || `Order ${row.orderId}`}</p>
          </div>
          <button className="btn btn-ghost btn-xs" type="button" disabled={saving} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="billing-edit-readonly-grid">
          <div><span>Order #</span><strong>{fallbackText(row.orderNumber)}</strong></div>
          <div>
            <span>Billing Date</span>
            <strong>{formatBillingShipDate(row.billingEffectiveDate ?? row.shipDate)}</strong>
          </div>
          {row.rolledFromWeekend === true && (
            <div>
              <span>Actual Activity</span>
              <strong>{formatBillingShipDate(row.actualActivityDate ?? row.shipDate)}</strong>
            </div>
          )}
          <div><span>Carrier</span><strong>{fallbackText(row.carrierNickname || row.providerAccountNickname || row.carrierCode)}</strong></div>
          <div><span>Qty</span><strong>{billingDetailQtyDisplay(row)}</strong></div>
          <div><span>Item Name</span><strong>{fallbackText(row.itemNames || row.description)}</strong></div>
          <div><span>SKU</span><strong>{fallbackText(row.itemSkus)}</strong></div>
          <div>
            <span>Box Size</span>
            <input
              className="ship-input billing-edit-box-filter"
              style={{ width: '100%', fontSize: 12, marginBottom: 4 }}
              type="search"
              value={boxFilter}
              disabled={saving}
              placeholder="Type to filter, e.g. 12x10"
              aria-label="Filter box sizes"
              onChange={(event) => setBoxFilter(event.target.value)}
            />
            <select
              className="ship-select billing-edit-box-select"
              style={{ width: '100%', fontSize: 12, fontWeight: 600 }}
              value={draft.packageId}
              disabled={saving}
              onChange={(event) => onPackageChange(event.target.value)}
            >
              <option value="">{row.packageName ? `${row.packageName} (shipment box)` : '- (shipment box)'}</option>
              {clientBoxes.length ? (
                <optgroup label={clientBoxLabel}>
                  {clientBoxes.map((pkg) => {
                    const id = packageOptionId(pkg)
                    return <option key={id} value={id}>{pkg.name || id}</option>
                  })}
                </optgroup>
              ) : null}
              {otherBoxes.length ? (
                <optgroup label={clientBoxes.length ? 'All other boxes' : 'All boxes'}>
                  {otherBoxes.map((pkg) => {
                    const id = packageOptionId(pkg)
                    return <option key={id} value={id}>{pkg.name || id}</option>
                  })}
                </optgroup>
              ) : null}
            </select>
            {noBoxMatches ? (
              <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                No box matches “{boxFilter}”.
              </div>
            ) : null}
          </div>
          <div><span>Selected Rate</span><strong>{formatBillingMoney(row.selectedRateCost ?? row.selected_rate_cost, { dashIfZero: true })}</strong></div>
          <div><span>UPS SS</span><strong>{formatBillingMoney(row.refUpsRate ?? row.ref_ups_rate, { dashIfZero: true })}</strong></div>
          <div><span>USPS SS</span><strong>{formatBillingMoney(row.refUspsRate ?? row.ref_usps_rate, { dashIfZero: true })}</strong></div>
        </div>

        {manualOverrideLabels.length ? (
          <div
            role="status"
            style={{
              margin: '8px 0',
              padding: '6px 12px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg2)',
              fontSize: 11.5,
              color: 'var(--text)',
            }}
          >
            <strong>Manual override:</strong> {manualOverrideLabels.join(', ')}. Saved backend override will be reused when this billing range is regenerated.
          </div>
        ) : null}

        {hasBillingNoBoxCostAlert(row) ? (
          <BillingNoBoxCostPreview
            rows={noBoxCostRows}
            activeRow={row}
            onOpenBillingEdit={onOpenBillingEdit}
            onBulkApplyBoxCost={onOpenNoBoxCostBulkApply}
          />
        ) : null}

        {row.packageCostNeedsReview ? (
          <div
            role="alert"
            style={{
              margin: '8px 0',
              padding: '8px 12px',
              border: '1px solid #fde68a',
              borderRadius: 8,
              background: 'rgba(245, 158, 11, 0.10)',
              fontSize: 11.5,
              color: 'var(--text)',
            }}
          >
            <strong style={{ color: '#b45309' }}>Box needs review:</strong>{' '}
            {row.packageCostReviewReason || 'the shipped box could not be matched to a known package.'}
            {' '}Pick the correct Box Size or set a Box Cost, then Save. The decision persists across billing regeneration.
            {clientId != null ? (
              <div style={{ marginTop: 8 }}>
                <button
                  data-box-review-sweep-trigger
                  className="btn btn-secondary btn-xs"
                  type="button"
                  onClick={onOpenBoxReviewSweep}
                >
                  Set this box cost across a date range...
                </button>
              </div>
            ) : null}
            {draft.packageId && clientId != null ? (
              <div style={{ marginTop: 8 }}>
                <button
                  data-bulk-box-cost-trigger
                  className="btn btn-secondary btn-xs"
                  type="button"
                  onClick={onOpenBulkBoxCost}
                >
                  Re-price the chosen box across {from} to {to}...
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {row.shippingZeroNeedsReview && row.feeWaiverDecision == null ? (
          <div
            role="group"
            aria-label="Review $0 shipping"
            style={{
              margin: '8px 0',
              padding: '8px 12px',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              background: 'rgba(59, 130, 246, 0.08)',
              fontSize: 11.5,
              color: 'var(--text)',
            }}
          >
            <div style={{ marginBottom: 6 }}>
              <strong style={{ color: '#1d4ed8' }}>$0 shipping - review:</strong>{' '}
              this order shipped at a recorded cost of exactly $0.00 - often the customer handled
              shipping themselves. If they did, waive the DR PREPPER prep/fulfillment fees.
              {row.feeWaived ? ' Prep fee is currently WAIVED.' : ''}
            </div>
            <div style={{ marginBottom: 8, fontSize: 11, opacity: 0.85 }}>
              Client <strong>{clientName || '-'}</strong> - waiving sets these to $0:{' '}
              Pick &amp; Pack <strong>{formatBillingMoney(moneyDraft(draft.pickPack))}</strong>
              {' '}+ Add&apos;l Units <strong>{formatBillingMoney(moneyDraft(draft.additional))}</strong>
              {' '}= <strong>{formatBillingMoney(prepTotal)}</strong>
              {' '}prep. Box, storage, shipping label, product &amp; marketplace fees are NOT touched.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-xs"
                type="button"
                disabled={zeroShippingReviewSaving}
                onClick={() => void onZeroShippingReview('waived')}
              >
                {zeroShippingReviewSaving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
                Customer handled shipping - set prep fees to $0
              </button>
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                disabled={zeroShippingReviewSaving}
                onClick={() => void onZeroShippingReview('not_waived')}
              >
                DR PREPPER handled - keep fees
              </button>
            </div>
          </div>
        ) : row.feeWaived ? (
          prepTotal > 0 ? (
            <div
              role="status"
              style={{
                margin: '8px 0', padding: '6px 12px',
                border: '1px solid #fde68a', borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.10)', fontSize: 11.5, color: '#92400e',
              }}
            >
              <strong>Prep fee waived - pending.</strong> The decision is saved; run{' '}
              <strong>Update Billing</strong> for this range to zero the prep lines on the invoice. (Reversible.)
            </div>
          ) : (
            <div
              role="status"
              style={{
                margin: '8px 0', padding: '6px 12px',
                border: '1px solid #bbf7d0', borderRadius: 8,
                background: 'rgba(34, 197, 94, 0.08)', fontSize: 11.5, color: '#166534',
              }}
            >
              <strong>Prep fee waived - applied</strong> ($0 prep). Reversible via Update Billing.
            </div>
          )
        ) : row.feeWaiverDecision === 'not_waived' ? (
          <div
            role="status"
            style={{
              margin: '8px 0',
              padding: '6px 12px',
              border: '1px solid #bfdbfe',
              borderRadius: 8,
              background: 'rgba(59, 130, 246, 0.08)',
              fontSize: 11.5,
              color: '#1d4ed8',
            }}
          >
            <strong>$0 shipping reviewed - prep fee kept.</strong> Reversible via the $0-shipping review action if this order should be waived later.
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                className="btn btn-secondary btn-xs"
                type="button"
                disabled={zeroShippingReviewSaving}
                onClick={() => void onZeroShippingReview('waived')}
              >
                {zeroShippingReviewSaving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : null}
                Change to waive prep fees
              </button>
            </div>
          </div>
        ) : null}

        <div className="billing-edit-money-grid">
          <label>
            <span>Pick &amp; Pack</span>
            <input type="number" min="0" step="0.01" value={draft.pickPack} onChange={(event) => onDraftChange('pickPack', event.target.value)} />
          </label>
          <label>
            <span>Addl Units</span>
            <input type="number" min="0" step="0.01" value={draft.additional} onChange={(event) => onDraftChange('additional', event.target.value)} />
          </label>
          <label>
            <span>Box Cost</span>
            <input type="number" min="0" step="0.01" value={draft.packageCost} onChange={(event) => onDraftChange('packageCost', event.target.value)} />
          </label>
          <label>
            <span>Shipping</span>
            <input type="number" min="0" step="0.01" value={draft.shipping} onChange={(event) => onDraftChange('shipping', event.target.value)} />
          </label>
        </div>

        <div className="billing-edit-total-row">
          <div><span>Total</span><strong>{formatBillingMoney(draftTotal)}</strong></div>
          <div><span>Shipping Margin</span><strong style={{ color: billingMarginColor(draftMargin) }}>{draftMargin > 0 ? '+' : ''}${draftMargin.toFixed(2)}</strong></div>
        </div>

        <label style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Reason for edit</span>
          <textarea
            value={draft.reason}
            disabled={saving}
            maxLength={500}
            rows={3}
            placeholder="Required: explain why this invoice line is changing"
            onChange={(event) => onDraftChange('reason', event.target.value)}
          />
        </label>

        {error ? <div className="billing-edit-error">{error}</div> : null}

        <div className="billing-edit-actions">
          <button className="btn btn-secondary btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" disabled={saving || draft.reason.trim().length < 3} onClick={() => void onSave()}>
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
