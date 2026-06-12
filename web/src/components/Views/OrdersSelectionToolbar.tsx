// @ts-nocheck — extracted VERBATIM from the @ts-nocheck OrdersView.tsx; strict
// typing is a later Phase 6 part so this extraction stays byte-identical.
//
// PS-178 (Phase 6, part 4) — the selected-rows toolbar, extracted VERBATIM from
// OrdersView's renderSelectionToolbar. RENDER-ONLY: selection state, the batch
// handlers (print/queue/mark-shipped/queue-existing/clear), and the busy flags
// all stay in OrdersView and arrive via props — the toolbar owns zero batch
// logic, so the batch-safety guards (test weight fallback, proof forwarding,
// never-buy ladder) keep their single owner.
import { AnimatePresence, motion } from 'framer-motion'
import {
  X as XIcon,
  CheckSquare,
  Printer as PrinterIcon,
  ChevronDown,
  BadgeCheck,
  ClipboardList,
} from 'lucide-react'

export type OrdersSelectionToolbarProps = {
  selectedOrderIds: number[]
  allMatchingSelection: { active: boolean; scopeKey: string; ids: number[]; truncated?: boolean } | null
  selectionScopeKey: string
  currentStatus: string
  isMobileViewport: boolean
  batchBusy: boolean
  extShipBusy: boolean
  batchExtShipMenuOpen: boolean
  setBatchExtShipMenuOpen: (updater: (open: boolean) => boolean) => void
  batchTestMode: boolean
  setBatchTestMode: (checked: boolean) => void
  handleBatchAction: (mode: 'print' | 'queue') => unknown
  handleBatchMarkAsShipped: (source: string) => unknown
  queueExistingLabels: (orderIds: number[]) => unknown
  clearSelection: () => void
}

export function OrdersSelectionToolbar({
  selectedOrderIds,
  allMatchingSelection,
  selectionScopeKey,
  currentStatus,
  isMobileViewport,
  batchBusy,
  extShipBusy,
  batchExtShipMenuOpen,
  setBatchExtShipMenuOpen,
  batchTestMode,
  setBatchTestMode,
  handleBatchAction,
  handleBatchMarkAsShipped,
  queueExistingLabels,
  clearSelection,
}: OrdersSelectionToolbarProps) {
    if (selectedOrderIds.length === 0) return null

    const selectedCount = selectedOrderIds.length
    const selectionIsAllMatching =
      allMatchingSelection?.active === true &&
      allMatchingSelection.scopeKey === selectionScopeKey &&
      allMatchingSelection.ids.length === selectedOrderIds.length

    // Per user override (`unlock shipped data`): keep the locked cancelled
    // selection surface explicit that it is review/copy only, not editable.
    const helperText =
      selectionIsAllMatching
        ? allMatchingSelection.truncated
          ? `First ${selectedCount.toLocaleString()} matching orders selected across pages.`
          : `${selectedCount.toLocaleString()} matching orders selected across pages.`
        : currentStatus === 'awaiting_shipment'
          ? selectedCount === 1
            ? 'Order panel active.'
            : 'Batch Actions panel active.'
          : currentStatus === 'shipped'
            ? 'Shipped review active.'
            : 'Cancelled orders can be selected for review or copy only.'

    return (
      <AnimatePresence initial={false}>
        <motion.div
          key="orders-selection-toolbar"
          id="ordersSelectionToolbar"
          data-testid="orders-selection-toolbar"
          role="region"
          aria-label={`${selectedCount} selected order${selectedCount === 1 ? '' : 's'}`}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="orders-selection-toolbar"
        >
          <div className="orders-selection-main">
            <div className="orders-selection-count">
              <CheckSquare size={14} strokeWidth={2.5} aria-hidden />
              <span className="font-mono tabular-nums">{selectedCount}</span>
              <span>selected</span>
            </div>
            <div className="orders-selection-copy">
              <span className="orders-selection-label">
                {currentStatus === 'awaiting_shipment'
                  ? 'Selected orders'
                  : currentStatus === 'shipped'
                    ? 'Shipped selection'
                    : 'Cancelled selection'}
              </span>
              <span className="orders-selection-helper">{helperText}</span>
            </div>
          </div>

          {isMobileViewport ? (
            <div className="orders-selection-actions orders-selection-actions-mobile" aria-label="Selected order actions">
              {currentStatus === 'awaiting_shipment' ? (
                <>
                  <button
                    type="button"
                    className="orders-selection-btn orders-selection-btn-primary"
                    onClick={() => void handleBatchAction('print')}
                    disabled={batchBusy || selectedCount === 0}
                    aria-label={`Create and print labels for ${selectedCount} selected orders`}
                  >
                    <PrinterIcon size={14} strokeWidth={2.4} aria-hidden />
                    <span>Print Label</span>
                  </button>
                  <button
                    type="button"
                    className="orders-selection-btn"
                    onClick={() => void handleBatchAction('queue')}
                    disabled={batchBusy || selectedCount === 0}
                    aria-label={`Send ${selectedCount} selected orders to the print queue`}
                  >
                    <ClipboardList size={14} strokeWidth={2.4} aria-hidden />
                    <span>Print to Queue</span>
                  </button>
                  <div className="orders-selection-menu-wrap">
                    <button
                      type="button"
                      className="orders-selection-btn orders-selection-btn-warn"
                      onClick={() => setBatchExtShipMenuOpen((open) => !open)}
                      disabled={extShipBusy || selectedCount === 0}
                      aria-expanded={batchExtShipMenuOpen}
                      aria-haspopup="menu"
                    >
                      <BadgeCheck size={14} strokeWidth={2.4} aria-hidden />
                      <span>Mark Shipped</span>
                      <ChevronDown size={12} strokeWidth={2.5} aria-hidden />
                    </button>
                    {batchExtShipMenuOpen ? (
                      <div className="orders-selection-menu" role="menu" aria-label="Mark selected orders as shipped">
                        <div className="orders-selection-menu-head">
                          <div className="font-semibold text-ink">Mark selected as shipped</div>
                          <div className="text-[10.5px] text-ink-3">Choose the source marketplace.</div>
                        </div>
                        {['Shopify', 'Amazon', 'Walmart', 'eBay', 'Etsy', 'Other'].map((source) => (
                          <button
                            key={source}
                            type="button"
                            role="menuitem"
                            disabled={extShipBusy}
                            onClick={() => {
                              setBatchExtShipMenuOpen(false)
                              void handleBatchMarkAsShipped(source)
                            }}
                          >
                            {source}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <label className="orders-selection-test">
                    <input
                      type="checkbox"
                      checked={batchTestMode}
                      onChange={(event) => setBatchTestMode(event.target.checked)}
                    />
                    <span>Test mode</span>
                  </label>
                </>
              ) : currentStatus === 'shipped' ? (
                <button
                  type="button"
                  className="orders-selection-btn"
                  onClick={() => void queueExistingLabels(selectedOrderIds)}
                  disabled={selectedCount === 0}
                  aria-label={`Queue existing labels for ${selectedCount} shipped orders`}
                >
                  <PrinterIcon size={14} strokeWidth={2.4} aria-hidden />
                  <span>Queue Existing Labels</span>
                </button>
              ) : (
                <span className="orders-selection-readonly" role="note">
                  Shipping actions disabled
                </span>
              )}

              <button
                type="button"
                className="orders-selection-btn orders-selection-btn-clear"
                onClick={clearSelection}
                aria-label="Clear selected orders"
              >
                <XIcon size={14} strokeWidth={2.5} aria-hidden />
                <span>Clear</span>
              </button>
            </div>
          ) : null}

        </motion.div>
      </AnimatePresence>
    )
}
