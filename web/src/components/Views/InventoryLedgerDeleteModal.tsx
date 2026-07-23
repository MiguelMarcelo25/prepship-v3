// PS-154 extraction: pure-presentation confirm modal lifted verbatim out
// of InventoryView.tsx. The stock-reversal logic + API call
// (confirmDeleteLedgerEntry) and the ledgerDeleteModal / in-flight state
// stay in the parent; this component only renders and forwards intent.
import { formatCaDateTime } from '../../lib/ca-time'

// Mirrors lib/ca-time's (non-exported) DateInput union — the value forwarded
// straight into formatCaDateTime.
type LedgerDateInput = Date | string | number | null | undefined

// Local subset of the parent's InventoryLedgerEntryDto (that DTO isn't
// exported from types/api). This component only reads the fields below; the
// parent passes the full entry, which is structurally assignable here.
export interface InventoryLedgerDeleteModalEntry {
  sku?: string | null
  type?: string | null
  qty: number
  note?: string | null
  effectiveAt?: LedgerDateInput
  createdAt?: LedgerDateInput
}

export interface InventoryLedgerDeleteModalProps {
  ledgerDeleteModal: InventoryLedgerDeleteModalEntry | null
  onClose: () => void
  onConfirmDelete: () => void | Promise<void>
  isDeleting: boolean
}

function formatDateTime(value: LedgerDateInput) {
  return formatCaDateTime(value)
}

export function InventoryLedgerDeleteModal({
  ledgerDeleteModal,
  onClose,
  onConfirmDelete,
  isDeleting,
}: InventoryLedgerDeleteModalProps) {
  if (!ledgerDeleteModal) return null
  return (
    <div className="inventory-overlay" onClick={() => !isDeleting && onClose()}>
      <div className="inventory-modal" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 style={{ marginTop: 0, marginBottom: 6 }}>Reverse inventory movement?</h3>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
          The original history row remains immutable. PrepShip will append an equal and opposite movement to reverse its stock impact.
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface2)', padding: 12, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr', rowGap: 8, columnGap: 10, fontSize: 12 }}>
            <span style={{ color: 'var(--text3)', fontWeight: 700 }}>SKU</span>
            <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{ledgerDeleteModal.sku || '-'}</span>
            <span style={{ color: 'var(--text3)', fontWeight: 700 }}>Type</span>
            <span style={{ textTransform: 'capitalize', color: 'var(--text)' }}>{ledgerDeleteModal.type}</span>
            <span style={{ color: 'var(--text3)', fontWeight: 700 }}>Qty</span>
            <span style={{ fontWeight: 800, color: ledgerDeleteModal.qty > 0 ? 'var(--green)' : 'var(--red)' }}>
              {ledgerDeleteModal.qty > 0 ? `+${ledgerDeleteModal.qty}` : ledgerDeleteModal.qty}
            </span>
            <span style={{ color: 'var(--text3)', fontWeight: 700 }}>Note</span>
            <span style={{ color: 'var(--text2)' }}>{ledgerDeleteModal.note || '-'}</span>
            <span style={{ color: 'var(--text3)', fontWeight: 700 }}>Date</span>
            <span style={{ color: 'var(--text2)' }}>{formatDateTime(ledgerDeleteModal.effectiveAt ?? ledgerDeleteModal.createdAt)}</span>
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--red)', marginBottom: 16, fontWeight: 700 }}>
          Ship/order-linked rows stay locked and cannot be reversed from History.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline btn-sm" type="button" disabled={isDeleting} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            disabled={isDeleting}
            onClick={() => void onConfirmDelete()}
            style={{ borderColor: 'var(--red)', color: 'var(--red)' }}
          >
            {isDeleting ? 'Reversing...' : 'Append reversal'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default InventoryLedgerDeleteModal
