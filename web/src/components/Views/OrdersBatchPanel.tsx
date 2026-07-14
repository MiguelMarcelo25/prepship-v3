// PS-166 (Wave 2d): the batch-actions panel (shown when 2+ orders are
// selected) extracted from OrdersView.tsx with BYTE-IDENTICAL markup. Unlike
// the renderTableCell dispatcher, this is a cohesive UI region, so a normal
// React component with a typed props interface is the right shape — and the
// STRICT interface compiler-enforces the dependency set: the body cannot
// reference a closure dep that isn't a declared prop (defeats the
// silent-missing-dep class from the component side). The parent OrdersView
// keeps every piece of state and all the handlers; it passes them in and the
// behavior is identical.
//
// LOCKDOWN (R5, unchanged): the isReadOnly null-guard stays verbatim — the
// batch panel never renders on Shipped/Cancelled views. The shipped/cancelled
// read-only banner and all backend mutation gates are untouched.
import type { Dispatch, SetStateAction } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BadgeCheck, ChevronDown, Check as CheckIcon, Copy as CopyIcon } from 'lucide-react'
import type { OrderSummaryDto } from '../../types/api'
import { getDimensions } from './orders-items'

export type OrdersBatchPanelProps = {
  isReadOnly: boolean
  orders: OrderSummaryDto[]
  selectedIdSet: Set<number>
  selectedOrderIds: number[]
  currentStatus: string
  clearSelection: () => void
  batchExtShipMenuOpen: boolean
  setBatchExtShipMenuOpen: Dispatch<SetStateAction<boolean>>
  extShipBusy: boolean
  extShipNotifyCustomer: boolean
  setExtShipNotifyCustomer: Dispatch<SetStateAction<boolean>>
  extShipNotifyMarketplace: boolean
  setExtShipNotifyMarketplace: Dispatch<SetStateAction<boolean>>
  handleBatchMarkAsShipped: (source: string) => void | Promise<void>
  copiedAll: boolean
  setCopiedAll: Dispatch<SetStateAction<boolean>>
  copiedOrderNum: string | null
  setCopiedOrderNum: Dispatch<SetStateAction<string | null>>
  handleBatchAction: (mode: 'print' | 'queue') => void | Promise<void>
  batchBusy: boolean
  // PS-312/PS-317 (S4): combine the selected orders into ONE combined-shipment bundle (the backend
  // validates eligibility — same client/store/recipient, awaiting, not already bundled).
  handleCombineShipments: () => void | Promise<void>
  combineBusy: boolean
  batchTestMode: boolean
  setBatchTestMode: Dispatch<SetStateAction<boolean>>
  callerIsAdmin: boolean
  assignBusy: boolean
  assignTo: string
  setAssignTo: Dispatch<SetStateAction<string>>
  assignableUsers: Array<{ id: string; email: string; isAdmin: boolean }>
  handleAssignSelectedOrders: () => void | Promise<void>
}

export function OrdersBatchPanel({
  isReadOnly,
  orders,
  selectedIdSet,
  selectedOrderIds,
  currentStatus,
  clearSelection,
  batchExtShipMenuOpen,
  setBatchExtShipMenuOpen,
  extShipBusy,
  extShipNotifyCustomer,
  setExtShipNotifyCustomer,
  extShipNotifyMarketplace,
  setExtShipNotifyMarketplace,
  handleBatchMarkAsShipped,
  copiedAll,
  setCopiedAll,
  copiedOrderNum,
  setCopiedOrderNum,
  handleBatchAction,
  batchBusy,
  handleCombineShipments,
  combineBusy,
  batchTestMode,
  setBatchTestMode,
  callerIsAdmin,
  assignBusy,
  assignTo,
  setAssignTo,
  assignableUsers,
  handleAssignSelectedOrders,
}: OrdersBatchPanelProps) {
  // Lockdown — Shipped / Cancelled views never show the batch panel
  // since selection itself is disabled (no orderIds can be in
  // selectedOrderIds). Returning null here is a belt-and-suspenders
  // safeguard against any future bug that re-enables selection.
  if (isReadOnly) return null

  const selectedOrders = orders.filter((order) => selectedIdSet.has(order.orderId))
  const firstOrder = selectedOrders[0] ?? null
  const firstDims = firstOrder ? getDimensions(firstOrder, null) : null
  const firstWeight = firstOrder?.weight?.value ?? 0
  const firstWeightLb = Math.floor(firstWeight / 16)
  const firstWeightOz = Math.round(firstWeight % 16)

  return (
    <>
      <div className="panel-topbar">
        <button className="panel-topbar-btn" type="button" onClick={clearSelection}>Clear Selection</button>
        <div className="panel-ordnum">📦 {selectedOrderIds.length} order{selectedOrderIds.length === 1 ? '' : 's'} selected</div>
        {/* Batch Mark-as-Shipped — placed in the topbar to mirror the
            single-order panel (which has the same affordance in the
            same spot under the AWAITING / TEST badges). Operators
            learn one place to find this action regardless of
            single-vs-multi mode. Only shown on awaiting view since
            shipped/cancelled orders aren't editable. */}
        {currentStatus === 'awaiting_shipment' ? (
          <div className="ml-auto relative mr-2">
            <button
              type="button"
              onClick={() => setBatchExtShipMenuOpen((open) => !open)}
              disabled={extShipBusy || selectedOrderIds.length === 0}
              title="Mark every selected order as shipped externally (no label purchase)"
              className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10.5px] font-semibold text-amber-800 bg-amber-50/80 ring-1 ring-amber-200 hover:bg-amber-100 hover:ring-amber-300 transition disabled:opacity-50 disabled:cursor-wait"
            >
              <BadgeCheck size={10} strokeWidth={2.5} />
              {extShipBusy
                ? `Marking ${selectedOrderIds.length}…`
                : `Mark ${selectedOrderIds.length} as Shipped`}
              <ChevronDown size={8} strokeWidth={2.5} className="opacity-60" />
            </button>
            {batchExtShipMenuOpen ? (
              <div className="absolute top-[calc(100%+4px)] right-0 z-30 w-[260px] rounded-lg bg-surface ring-1 ring-line shadow-lg overflow-hidden text-[12px]">
                <div className="px-3 py-2 bg-surface-2 border-b border-line">
                  <div className="font-semibold text-ink text-[12px]">
                    Mark {selectedOrderIds.length} order{selectedOrderIds.length === 1 ? '' : 's'} as Shipped
                  </div>
                  <div className="text-ink-3 text-[10.5px] mt-0.5">
                    Closes the orders locally. Optional notify:
                  </div>
                </div>

                {/* Notify Customer toggle — shared state with single popover */}
                <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink-2 text-[11.5px]">Notify customer</span>
                    <span className="text-ink-3 text-[10px]">Email shipping confirmation via ShipStation</span>
                  </div>
                  <span
                    className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyCustomer ? 'bg-emerald-500' : 'bg-line'}`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyCustomer ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                      aria-hidden
                    />
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={extShipNotifyCustomer}
                    onChange={(e) => setExtShipNotifyCustomer(e.target.checked)}
                  />
                </label>

                <label className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface-2 cursor-pointer border-b border-line">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink-2 text-[11.5px]">Notify marketplace</span>
                    <span className="text-ink-3 text-[10px]">Push shipped status to Amazon/eBay/etc.</span>
                  </div>
                  <span
                    className={`relative inline-flex w-8 h-4 rounded-full transition-colors duration-150 flex-shrink-0 ${extShipNotifyMarketplace ? 'bg-emerald-500' : 'bg-line'}`}
                    aria-hidden
                  >
                    <span
                      className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-150 ${extShipNotifyMarketplace ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
                      aria-hidden
                    />
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={extShipNotifyMarketplace}
                    onChange={(e) => setExtShipNotifyMarketplace(e.target.checked)}
                  />
                </label>

                {(extShipNotifyCustomer || extShipNotifyMarketplace) ? (
                  <div className="px-3 py-1.5 bg-amber-50 border-b border-line text-[10px] text-amber-700 flex items-start gap-1">
                    <span aria-hidden>⚠</span>
                    <span>Batch mode sends notifications without tracking numbers (use single-order popover if you have tracking).</span>
                  </div>
                ) : null}

                <div className="px-2 py-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-3 px-1 pb-1">
                    Source marketplace
                  </div>
                  {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                    <button
                      key={source}
                      type="button"
                      disabled={extShipBusy}
                      className="w-full text-left px-2 py-1.5 rounded text-ink-2 hover:text-ink hover:bg-surface-2 transition disabled:opacity-50 disabled:cursor-wait text-[11.5px]"
                      onClick={() => void handleBatchMarkAsShipped(source)}
                    >
                      {extShipBusy ? `Working… (${source})` : source}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <button className="panel-close" type="button" onClick={clearSelection}>✕</button>
      </div>

      <div className="panel-body">
        <div className="panel-section">
          <div className="panel-section-header">
            <span className="panel-section-title">Batch Actions</span>
          </div>
          <div className="panel-section-body">
            {/* Selected-orders pill list. Replaces the previous wordBreak:
                break-all comma-soup which was illegible at >5 orders. Each
                order# is its own monospace pill in a scrollable tray; click
                to copy that ID, or use "Copy all" in the header for the
                whole list joined by newlines (paste-friendly for tickets). */}
            <div className="px-3 pt-3 pb-3 -mx-3 mb-3 border-b border-line">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                    Selected
                  </span>
                  <span className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-brand/10 text-brand text-[10.5px] font-bold tabular-nums ring-1 ring-brand/20">
                    {selectedOrders.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const all = selectedOrders
                      .map((o) => o.orderNumber ?? `#${o.orderId}`)
                      .sort()
                      .join('\n')
                    void navigator.clipboard.writeText(all).then(() => {
                      setCopiedAll(true)
                      window.setTimeout(() => setCopiedAll(false), 1200)
                    })
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-semibold text-ink-2 hover:text-brand bg-surface-2 hover:bg-brand/5 ring-1 ring-line hover:ring-brand/30 transition"
                  title="Copy all order numbers to clipboard (newline-separated)"
                >
                  <AnimatePresence initial={false}>
                    {copiedAll ? (
                      <motion.span
                        key="copied"
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.6, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="inline-flex items-center gap-1 text-emerald-600"
                      >
                        <CheckIcon size={11} strokeWidth={3} />
                        Copied
                      </motion.span>
                    ) : (
                      <motion.span
                        key="copy"
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.6, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="inline-flex items-center gap-1"
                      >
                        <CopyIcon size={11} strokeWidth={2.5} />
                        Copy all
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </div>
              {/* Scrollable pill tray. max-height fits ~4-5 rows of pills
                  before scroll kicks in; far fewer cognitive bumps than
                  word-broken IDs spilling across full width. Empty-state
                  safety net even though parent only renders this section
                  when selection > 0. */}
              <div
                className="flex flex-wrap gap-1.5 max-h-[148px] overflow-y-auto pr-0.5"
                role="list"
                aria-label={`${selectedOrders.length} selected orders`}
              >
                {selectedOrders.length === 0 ? (
                  <span className="text-[11px] italic text-ink-3 py-1">No orders selected</span>
                ) : (
                  selectedOrders
                    .map((o) => o.orderNumber ?? `#${o.orderId}`)
                    .sort()
                    .map((orderNum) => {
                      const wasCopied = copiedOrderNum === orderNum
                      return (
                        <button
                          key={orderNum}
                          type="button"
                          role="listitem"
                          onClick={() => {
                            void navigator.clipboard.writeText(orderNum).then(() => {
                              setCopiedOrderNum(orderNum)
                              window.setTimeout(() => {
                                setCopiedOrderNum((current) => (current === orderNum ? null : current))
                              }, 1100)
                            })
                          }}
                          title={`Click to copy ${orderNum}`}
                          className={`group/pill inline-flex items-center gap-1 px-2 py-1 rounded-md font-mono text-[10.5px] font-semibold tabular-nums ring-1 transition ${wasCopied
                              ? 'bg-emerald-50 text-emerald-700 ring-emerald-300 shadow-sm'
                              : 'bg-surface-2 text-ink-2 ring-line hover:ring-brand/40 hover:bg-brand/5 hover:text-brand'
                            }`}
                        >
                          <span className="truncate max-w-[180px]">{orderNum}</span>
                          <AnimatePresence initial={false}>
                            {wasCopied ? (
                              <motion.span
                                key="check"
                                initial={{ scale: 0, rotate: -90 }}
                                animate={{ scale: 1, rotate: 0 }}
                                exit={{ scale: 0, rotate: 90 }}
                                transition={{ duration: 0.18 }}
                                className="inline-flex"
                              >
                                <CheckIcon size={10} strokeWidth={3} />
                              </motion.span>
                            ) : (
                              <motion.span
                                key="copy"
                                initial={{ scale: 0, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0, opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="inline-flex opacity-0 group-hover/pill:opacity-100 transition-opacity"
                              >
                                <CopyIcon size={10} strokeWidth={2.5} />
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </button>
                      )
                    })
                )}
              </div>
            </div>

            {/* Label-creation actions only on awaiting_shipment view.
                Shipped/Cancelled views show a read-only banner instead —
                these orders already have labels or were cancelled, and
                the backend would reject any modify call via
                assertOrderEditable() anyway. Showing the buttons disabled
                trains operators to feel locked-out when the action is
                genuinely inapplicable; hiding them with an explanatory
                banner is clearer. The selected-orders pill tray + Copy
                All actions above remain available — those are read-only
                and useful for any view (audit, export, ticket triage).
            */}
            {currentStatus === 'awaiting_shipment' ? (
              <>
                {/* Both buttons share the SAME brand-blue style. The
                    previous green Send-to-Queue created a visual
                    hierarchy that wasn't real — both actions are
                    equally important. The Mark-as-Shipped action
                    lives in the panel topbar (matching single-order
                    placement), not down here. */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="create-label-btn"
                    type="button"
                    style={{ flex: 1 }}
                    onClick={() => void handleBatchAction('print')}
                    disabled={batchBusy}
                  >
                    🖨️ Create + Print Label
                  </button>
                  <button
                    className="create-label-btn"
                    type="button"
                    style={{ flex: 1 }}
                    onClick={() => void handleBatchAction('queue')}
                    disabled={batchBusy}
                  >
                    📥 Send to Queue
                  </button>
                </div>

                {/* PS-312/PS-317 (S4): combine the selected same-recipient orders into ONE shipment.
                    The backend validates eligibility + creates the bundle; on failure the toast says why. */}
                <button
                  className="create-label-btn"
                  type="button"
                  style={{ width: '100%', marginTop: 8 }}
                  onClick={() => void handleCombineShipments()}
                  disabled={combineBusy || batchBusy}
                  title="Combine the selected orders (same recipient) into one combined shipment — they ship together under one label. The backend validates eligibility."
                >
                  🔗 {combineBusy ? 'Combining…' : 'Combine shipments'}
                </button>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600 }}>
                  <input type="checkbox" checked={batchTestMode} onChange={(event) => setBatchTestMode(event.target.checked)} />
                  🧪 Test mode (no charges)
                </label>
              </>
            ) : (
              <div className="rounded-lg bg-surface-2 ring-1 ring-line p-3 text-[11.5px] text-ink-2 leading-relaxed">
                <div className="flex items-center gap-1.5 mb-1 font-semibold text-ink">
                  <CheckIcon size={12} strokeWidth={2.5} className="text-ok" />
                  {currentStatus === 'shipped' ? 'Shipped orders' : 'Cancelled orders'} — read only
                </div>
                <p className="text-ink-3">
                  {currentStatus === 'shipped'
                    ? 'These orders already have labels. To reprint, open an individual order and use the Print menu in the side panel.'
                    : 'These orders were cancelled and cannot have labels created.'}
                  {' '}Selection is enabled for copy/export only.
                </p>
              </div>
            )}

            {callerIsAdmin ? (
              <div style={{ marginTop: 16, padding: 12, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  👤 Assign Orders
                </div>
                <select
                  style={{
                    width: '100%',
                    fontSize: 13,
                    padding: '8px 10px',
                    border: '1px solid var(--border2)',
                    borderRadius: 4,
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    cursor: assignBusy ? 'not-allowed' : 'pointer',
                    marginBottom: 8,
                  }}
                  value={assignTo}
                  onChange={(e) => setAssignTo(e.target.value)}
                  disabled={assignBusy}
                >
                  <option value="">— Pick a user —</option>
                  {assignableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}{u.isAdmin ? ' (admin)' : ''}
                    </option>
                  ))}
                  <option value="unassign">— Unassign (clear) —</option>
                </select>
                <button
                  type="button"
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#fff',
                    background: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 'var(--text4)' : 'var(--ss-blue)',
                    border: 'none',
                    borderRadius: 5,
                    cursor: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: assignBusy || !assignTo || selectedOrderIds.length === 0 ? 0.7 : 1,
                  }}
                  onClick={() => void handleAssignSelectedOrders()}
                  disabled={assignBusy || !assignTo || selectedOrderIds.length === 0}
                >
                  {assignBusy ? 'Assigning…' : `Assign ${selectedOrderIds.length} order${selectedOrderIds.length === 1 ? '' : 's'}`}
                </button>
                <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 }}>
                  Workers see only orders assigned to them. Pick "Unassign" to clear.
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 16, padding: 12, background: 'var(--surface2)', borderRadius: 4, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8, fontWeight: 600 }}>Shipping Parameters (from 1st order):</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8, fontSize: 12 }}>
                <div>
                  <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 2 }}>Weight</div>
                  <div style={{ color: 'var(--text2)', fontWeight: 600 }}>{firstOrder ? `${firstWeightLb} lb ${firstWeightOz} oz` : '—'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 2 }}>Dimensions</div>
                  <div style={{ color: 'var(--text2)', fontWeight: 600 }}>
                    {firstDims ? `${firstDims.length} × ${firstDims.width} × ${firstDims.height} in` : '—'}
                  </div>
                </div>
              </div>
            </div>

            <div style={{ fontSize: 10, color: 'var(--text4)', lineHeight: 1.5 }}>
              Print creates labels and opens PDFs. Queue creates labels and adds them to the print queue without opening PDFs.
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
