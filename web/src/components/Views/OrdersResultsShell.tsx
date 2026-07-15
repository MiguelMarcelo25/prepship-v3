// PS-166/PS-306/PS-258 (Wave 3): the loading / error / results-gating WRAPPER
// around the orders table, extracted from OrdersView.tsx with BYTE-IDENTICAL
// markup. PRESENTATIONAL only — this component owns NO data state, hooks, or
// handlers (same proven leaf pattern as OrdersDailyStrip.tsx and
// OrdersResultsEmptyState.tsx). Every gating boolean, display value, and the
// onRetry callback are passed in as props; the React execution model and
// control flow are UNCHANGED.
//
// The <table id="ordersTable"> itself is NOT owned here — OrdersView passes the
// gated table JSX in as `children` (a table slot) and the shell renders it at
// the exact position the table sits today, between the error block and the
// empty state. So `#ordersSection`, `#loadingState`, `#ordersTable`,
// `#ordersBody`, and `#tableHead` (the DOM byte-equality cert anchors) stay
// byte-identical and the shell never owns table state.
//
// LOCKDOWN: this region is the awaiting/results framing — it reads no
// shipped/cancelled data and contains no mutation gate. The isReadOnly flag,
// the read-only banner, and all batch-action gating stay in the OrdersView
// shell and are untouched. The error block's Retry button is the PS-020
// non-mutating Orders recovery action; it delegates to OrdersView's
// refetchOrders via the onRetry prop (no data-fetching moves here).
import type { ReactNode, RefObject } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Loader2, RefreshCcw } from 'lucide-react'
import { OrdersResultsEmptyState } from './OrdersResultsEmptyState'

export type OrdersResultsShellProps = {
  loading: boolean
  error: Error | null
  onRetry: () => void | Promise<void>
  ordersSearching: boolean
  hasNoFilteredOrders: boolean
  searchQuery: string
  isGlobalSearchActive: boolean
  scrollRef: RefObject<HTMLDivElement>
  children: ReactNode
}

export function OrdersResultsShell({
  loading,
  error,
  onRetry,
  ordersSearching,
  hasNoFilteredOrders,
  searchQuery,
  isGlobalSearchActive,
  scrollRef,
  children,
}: OrdersResultsShellProps) {
  return (
    <div ref={scrollRef} className="orders-wrap">
      {loading ? (
        <motion.div
          id="loadingState"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="p-4"
        >
          <motion.div
            className="space-y-2"
            variants={{
              hidden: {},
              show: { transition: { staggerChildren: 0.04 } },
            }}
            initial="hidden"
            animate="show"
          >
            {Array.from({ length: 8 }).map((_, idx) => (
              <motion.div
                key={idx}
                variants={{
                  hidden: { opacity: 0, y: 6 },
                  show: { opacity: 1, y: 0 },
                }}
                className="flex items-center gap-3 px-3 py-2 rounded-md bg-white border border-line"
              >
                <div className="w-4 h-4 rounded bg-line/60 animate-pulse" />
                <div className="w-20 h-3 rounded bg-line/60 animate-pulse" />
                <div className="w-32 h-3 rounded bg-line/60 animate-pulse" />
                <div className="flex-1 h-3 rounded bg-line/60 animate-pulse" />
                <div className="w-16 h-3 rounded bg-line/60 animate-pulse" />
                <div className="w-12 h-3 rounded bg-line/60 animate-pulse" />
              </motion.div>
            ))}
          </motion.div>
          <div className="flex items-center justify-center gap-2 text-tiny text-ink-3 mt-4 font-sans tracking-wide uppercase">
            <Loader2 size={12} strokeWidth={2.5} className="animate-spinSlow" />
            Loading orders
          </div>
        </motion.div>
      ) : null}

      {!loading && error ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="p-8 flex flex-col items-center justify-center gap-3"
        >
          <motion.div
            initial={{ scale: 0.6, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 18 }}
            className="w-14 h-14 rounded-full bg-danger-bg ring-2 ring-danger/15 flex items-center justify-center"
          >
            <AlertTriangle size={26} strokeWidth={2.25} className="text-danger" />
          </motion.div>
          <div className="text-sm2 font-semibold text-danger font-display tracking-tight">Failed to load orders</div>
          <div className="text-xs2 text-ink-3 max-w-md text-center leading-relaxed">{error.message}</div>
          {/* Per user override unlock shipped data on 2026-05-23: add a non-mutating Orders recovery action for PS-020 API failure states. */}
          <button
            type="button"
            onClick={() => void onRetry()}
            className="inline-flex items-center gap-2 h-8 px-3 rounded-md bg-surface text-ink text-xs2 font-semibold ring-1 ring-line hover:bg-surface-2 hover:ring-brand/30 active:scale-95 transition"
          >
            <RefreshCcw size={13} strokeWidth={2.4} />
            Retry
          </button>
        </motion.div>
      ) : null}

      {children}

      {/* PS-258 (slice): the Searching… spinner + "No orders match"
          empty state extracted VERBATIM to <OrdersResultsEmptyState/>.
          The gating booleans and display values are passed in; the two
          mutually exclusive blocks render byte-identically. */}
      <OrdersResultsEmptyState
        loading={loading}
        error={error}
        ordersSearching={ordersSearching}
        hasNoFilteredOrders={hasNoFilteredOrders}
        searchQuery={searchQuery}
        isGlobalSearchActive={isGlobalSearchActive}
      />
    </div>
  )
}
