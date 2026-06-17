// PS-258 (slice): the orders-table "no results" region (the PS-218 Searching…
// spinner + the "No orders match" empty state) extracted from OrdersView.tsx
// with BYTE-IDENTICAL markup. PRESENTATIONAL only — this component owns NO
// state, hooks, or handlers. Every gating boolean and display value is passed
// in as a prop, so the React execution model and control flow are UNCHANGED
// (the same proven leaf pattern already shipped in OrdersBatchPanel.tsx,
// OrdersPanelSections.tsx, and orders-empty-panel.tsx). The two mutually
// exclusive conditional blocks are kept verbatim, in the same order, so the
// rendered DOM is identical to the inline version.
//
// LOCKDOWN: this region is the awaiting/empty results placeholder — it reads no
// shipped/cancelled data and contains no mutation gate. The isReadOnly flag,
// the read-only banner, and all batch-action gating stay in the OrdersView
// shell and are untouched.
import { motion } from 'framer-motion'
import { Inbox, Loader2 } from 'lucide-react'

export type OrdersResultsEmptyStateProps = {
  loading: boolean
  error: unknown
  ordersSearching: boolean
  hasNoFilteredOrders: boolean
  searchQuery: string
  isGlobalSearchActive: boolean
}

export function OrdersResultsEmptyState({
  loading,
  error,
  ordersSearching,
  hasNoFilteredOrders,
  searchQuery,
  isGlobalSearchActive,
}: OrdersResultsEmptyStateProps) {
  return (
    <>
      {/* PS-218: while a search/filter request is in flight, show a
          Searching… spinner — never the false "No orders match" empty
          state. The empty state below only renders once the request has
          settled (ordersSearching === false). */}
      {!loading && !error && hasNoFilteredOrders && ordersSearching ? (
        <motion.div
          id="searchingState"
          data-testid="orders-searching"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="flex flex-col items-center justify-center gap-3 py-16 px-6"
        >
          <Loader2 size={26} strokeWidth={2.25} className="animate-spinSlow text-brand" />
          <div className="text-sm font-semibold text-ink font-display tracking-tight">
            {searchQuery.trim() ? `Searching for “${searchQuery.trim()}”…` : 'Searching orders…'}
          </div>
          {isGlobalSearchActive ? (
            <div className="text-xs2 text-ink-3 max-w-sm text-center leading-relaxed">
              Searching all statuses &amp; stores in the selected date range.
            </div>
          ) : null}
        </motion.div>
      ) : null}

      {!loading && !error && !ordersSearching && hasNoFilteredOrders ? (
        <motion.div
          id="emptyState"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center justify-center gap-3 py-16 px-6"
        >
          <motion.div
            initial={{ scale: 0.5, rotate: -10 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 14, delay: 0.05 }}
            className="w-16 h-16 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 ring-1 ring-line flex items-center justify-center"
          >
            <Inbox size={30} strokeWidth={2} className="text-ink-3" />
          </motion.div>
          <div className="text-sm font-semibold text-ink font-display tracking-tight mt-1">No orders match</div>
          <div className="text-xs2 text-ink-3 max-w-sm text-center leading-relaxed">
            Try clearing the search, broadening your date range, or selecting a different status.
          </div>
        </motion.div>
      ) : null}
    </>
  )
}
