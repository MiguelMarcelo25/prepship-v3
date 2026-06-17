// PS-154 extraction: pure-presentation modal lifted verbatim out of
// InventoryView.tsx. ALL state (adjustModal) and the payload-building /
// API-calling handler (handleAdjustSubmit) stay in the parent; this
// component only renders the modal and forwards user intent through the
// callback props below.
import { californiaDateInputValue } from '../../lib/ca-time'

// Local mirrors of the parent's AdjustType/AdjustSign/AdjustModalState
// (those live in InventoryView.tsx and aren't exported). This component
// only reads the fields below; the parent passes the full state object,
// which is structurally assignable to this subset.
export type InventoryAdjustType = 'receive' | 'return' | 'damage' | 'adjust'
export type InventoryAdjustSign = 1 | -1

export interface InventoryAdjustModalState {
  sku: string
  qty: string
  note: string
  date: string
  type: InventoryAdjustType
  sign: InventoryAdjustSign
}

export interface InventoryAdjustModalProps {
  adjustModal: InventoryAdjustModalState | null
  onClose: () => void
  onSubmit: () => void
  onChangeType: (type: InventoryAdjustType) => void
  onChangeSign: (sign: InventoryAdjustSign) => void
  onChangeQty: (qty: string) => void
  onChangeNote: (note: string) => void
  onChangeDate: (date: string) => void
}

export function InventoryAdjustModal({
  adjustModal,
  onClose,
  onSubmit,
  onChangeType,
  onChangeSign,
  onChangeQty,
  onChangeNote,
  onChangeDate,
}: InventoryAdjustModalProps) {
  if (!adjustModal) return null
  return (
    <div className="inventory-overlay" onClick={onClose}>
      <div className="inventory-modal" style={{ width: 380 }} onClick={(event) => event.stopPropagation()}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>Inventory Entry</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14, fontFamily: 'monospace' }}>{adjustModal.sku}</div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Type</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {([
              ['receive', '📦 Receive'],
              ['return', '↩ Return'],
              ['damage', '⚠ Damage'],
              ['adjust', '± Adjust'],
            ] as [InventoryAdjustType, string][]).map(([type, label]) => {
              const isActive = adjustModal.type === type
              const accent = type === 'damage' ? 'var(--red)' : type === 'return' ? '#d97706' : 'var(--ss-blue)'
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => onChangeType(type)}
                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: `2px solid ${isActive ? accent : 'var(--border2)'}`, background: isActive ? accent : 'var(--surface2)', color: isActive ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px', display: 'block', marginBottom: 4 }}>Direction</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => onChangeSign(1)}
              style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--border2)'}`, background: adjustModal.sign > 0 ? 'var(--ss-blue)' : 'var(--surface2)', color: adjustModal.sign > 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
            >
              + Add
            </button>
            <button
              type="button"
              onClick={() => onChangeSign(-1)}
              style={{ flex: 1, padding: 7, borderRadius: 6, border: `2px solid ${adjustModal.sign < 0 ? 'var(--red)' : 'var(--border2)'}`, background: adjustModal.sign < 0 ? 'var(--red)' : 'var(--surface2)', color: adjustModal.sign < 0 ? '#fff' : 'var(--text)', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
            >
              − Remove
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', width: 16, textAlign: 'center' }}>{adjustModal.sign > 0 ? '+' : '−'}</span>
          <input type="number" min="1" step="1" value={adjustModal.qty} onChange={(event) => onChangeQty(event.target.value)} style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />
        </div>

        <input type="text" value={adjustModal.note} onChange={(event) => onChangeNote(event.target.value)} placeholder="Note (e.g. PO#, reason, ref)" maxLength={120} style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12, marginBottom: 10 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>📅 Date:</span>
          <input type="date" value={adjustModal.date} onChange={(event) => onChangeDate(event.target.value)} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--surface2)', color: 'var(--text)', fontSize: 12 }} />
          <span style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{adjustModal.date === californiaDateInputValue() ? '(today)' : ''}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline btn-sm" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="button" onClick={onSubmit}>Save</button>
        </div>
      </div>
    </div>
  )
}

export default InventoryAdjustModal
