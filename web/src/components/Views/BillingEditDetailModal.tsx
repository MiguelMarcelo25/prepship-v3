import { Check, Loader2, X } from 'lucide-react'
import type { PackageDto } from '../../types/api'
import type { BillingEditDraft } from './billing-edit-draft-cache'
import {
  formatBillingMoney,
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

function moneyDraft(value: string) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? amount : 0
}

export function BillingEditDetailModal({
  modal,
  packages,
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
          <div><span>Ship Date</span><strong>{formatBillingShipDate(row.shipDate)}</strong></div>
          <div><span>Carrier</span><strong>{fallbackText(row.carrierNickname || row.providerAccountNickname || row.carrierCode)}</strong></div>
          <div><span>Qty</span><strong>{row.totalQty || row.qty || 0}</strong></div>
          <div><span>Item Name</span><strong>{fallbackText(row.itemNames || row.description)}</strong></div>
          <div><span>SKU</span><strong>{fallbackText(row.itemSkus)}</strong></div>
          <div>
            <span>Box Size</span>
            <select
              className="ship-select billing-edit-box-select"
              style={{ width: '100%', fontSize: 12, fontWeight: 600 }}
              value={draft.packageId}
              disabled={saving}
              onChange={(event) => onPackageChange(event.target.value)}
            >
              <option value="">{row.packageName ? `${row.packageName} (shipment box)` : '- (shipment box)'}</option>
              {packages.map((pkg) => {
                const id = String(pkg.packageId ?? pkg.id)
                return <option key={id} value={id}>{pkg.name || id}</option>
              })}
            </select>
          </div>
          <div><span>Selected Rate</span><strong>{formatBillingMoney(row.selectedRateCost ?? row.selected_rate_cost, { dashIfZero: true })}</strong></div>
          <div><span>UPS SS</span><strong>{formatBillingMoney(row.refUpsRate ?? row.ref_ups_rate, { dashIfZero: true })}</strong></div>
          <div><span>USPS SS</span><strong>{formatBillingMoney(row.refUspsRate ?? row.ref_usps_rate, { dashIfZero: true })}</strong></div>
        </div>

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

        {error ? <div className="billing-edit-error">{error}</div> : null}

        <div className="billing-edit-actions">
          <button className="btn btn-secondary btn-sm" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" disabled={saving} onClick={() => void onSave()}>
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
