// PS-257: type-checked. Extracted VERBATIM from OrdersView.tsx. The shipping_hold /
// held_reason fields it reads are now declared on PrintQueueEntryDto (orders-parity.ts),
// so no casts are needed. This extraction stays byte-identical to the source block.
//
// PS-178 (Phase 6, part 3) — the Print Queue drawer, extracted VERBATIM from
// OrdersView.tsx. RENDER-ONLY: every piece of state, every derived list, and
// every handler (hydrate/print/confirm/remove/open-detail) stays in OrdersView
// and arrives via props — this component owns zero queue logic, so the queue
// guards' behavior pins (client scope, clear-queue gating, holds, history
// filter, delivered retirement) keep their single owner.
import type { Dispatch, SetStateAction } from 'react'
import {
  Search as SearchIcon,
  X as XIcon,
  Check as CheckIcon,
  Printer,
} from 'lucide-react'
import { apiClient } from '../../api/client'
import { CALIFORNIA_TZ } from '../../lib/ca-time'
import type { PrintQueueEntryDto } from '../../types/api'
import type { PrintQueueGroup } from './orders-parity'

export type OrdersPrintQueueDrawerProps = {
  queueClients: Array<{ id: number; label: string }>
  pqClientFilter: number | null
  setPqClientFilter: (id: number | null) => void
  queueClientLabel: string
  queueClientId: number | null
  queueHistoryVisible: boolean
  setQueueHistoryVisible: Dispatch<SetStateAction<boolean>>
  setQueueOpen: (open: boolean) => void
  pqSearch: string
  setPqSearch: Dispatch<SetStateAction<string>>
  pqHistoryAsc: boolean
  setPqHistoryAsc: Dispatch<SetStateAction<boolean>>
  queueCount: number
  queuedEntries: PrintQueueEntryDto[]
  visibleQueueGroups: PrintQueueGroup[]
  queueHasVisibleEntries: boolean
  queueLoading: boolean
  pqSearchLower: string
  printedEntries: PrintQueueEntryDto[]
  visiblePrintedEntries: PrintQueueEntryDto[]
  unprintedQueueCount: number
  queueConfirmPrintedReady: boolean
  queuePrintMessage: string | null
  queuePrintProgress: number | null
  queuePrintInFlight: boolean
  hydrateQueue: () => unknown
  showToast: (message: string, type?: string) => void
  printQueueEntries: (entryIds: string[]) => unknown
  confirmQueueEntriesPrinted: (entryIds: string[]) => unknown
  openDetailDrawer: (orderId: number, fromQueue: boolean) => void
}

export function OrdersPrintQueueDrawer({
  queueClients,
  pqClientFilter,
  setPqClientFilter,
  queueClientLabel,
  queueClientId,
  queueHistoryVisible,
  setQueueHistoryVisible,
  setQueueOpen,
  pqSearch,
  setPqSearch,
  pqHistoryAsc,
  setPqHistoryAsc,
  queueCount,
  queuedEntries,
  visibleQueueGroups,
  queueHasVisibleEntries,
  queueLoading,
  pqSearchLower,
  printedEntries,
  visiblePrintedEntries,
  unprintedQueueCount,
  queueConfirmPrintedReady,
  queuePrintMessage,
  queuePrintProgress,
  queuePrintInFlight,
  hydrateQueue,
  showToast,
  printQueueEntries,
  confirmQueueEntriesPrinted,
  openDetailDrawer,
}: OrdersPrintQueueDrawerProps) {
  return (
        <div
          id="print-queue-panel"
          style={{
            display: 'grid',
            gridTemplateRows: queuePrintMessage ? 'auto auto auto auto 1fr auto' : 'auto auto auto 1fr auto',
            position: 'fixed',
            top: 56,
            right: 12,
            bottom: 12,
            width: 520,
            maxWidth: 'calc(100vw - 24px)',
            background: 'var(--surface)',
            border: '1px solid var(--border2)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(var(--shadow-color, 15 23 42), .18)',
            zIndex: 1200,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-line">
            <div className="min-w-0">
              <strong className="block text-ink text-[13px]">Print Queue</strong>
              <select
                className="mt-1 h-7 max-w-[210px] rounded-md bg-surface-2 px-2 text-[11px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand/40"
                value={pqClientFilter == null ? 'all' : String(pqClientFilter)}
                onChange={(event) =>
                  setPqClientFilter(event.target.value === 'all' ? null : Number(event.target.value))
                }
                aria-label="Filter Print Queue by client"
                title={pqClientFilter == null ? 'Showing all authorized client queues' : 'Filtering to one client'}
              >
                <option value="all">All clients{queueClients.length ? ` (${queueClients.length})` : ''}</option>
                {queueClients.map((client) => (
                  <option key={client.id} value={String(client.id)}>{client.label}</option>
                ))}
              </select>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                id="pq-history-btn"
                onClick={() => setQueueHistoryVisible((value) => !value)}
              >
                {queueHistoryVisible ? '🔼 Hide History' : '🕐 History'}
              </button>
              <button
                className="btn btn-ghost btn-xs"
                type="button"
                disabled={pqClientFilter == null}
                title={pqClientFilter != null ? 'Clear active queue entries for the selected client' : 'Select a client to clear its queue'}
                onClick={() =>
                  pqClientFilter != null
                    ? window.confirm(`This removes the ${queuedEntries.length} listed unprinted label${queuedEntries.length === 1 ? '' : 's'} from the active print queue for this client. Use only if you are sure these labels should not be printed from PrepShip. Continue?`)
                      // PS-195: the clear names EXACTLY the entries on screen —
                      // the backend rejects blanket clears without explicit ids
                      // and refuses entries inside a running merge job.
                      ? void apiClient
                        .clearQueue(pqClientFilter, queuedEntries.map((entry) => entry.queue_entry_id))
                        .then((result: any) => {
                          const blocked = Number(result?.blocked_in_flight ?? 0)
                          if (blocked > 0) {
                            showToast(`${blocked} label${blocked === 1 ? '' : 's'} kept — currently in a running print merge`, 'info')
                          }
                          return hydrateQueue()
                        })
                        .catch((error) => showToast(error instanceof Error ? error.message : 'Failed to clear queue', 'error'))
                      : undefined
                    : undefined
                }
              >
                🗑️ Clear
              </button>
              <button className="btn btn-ghost btn-xs" type="button" onClick={() => setQueueOpen(false)}>
                ✕
              </button>
            </div>
          </div>

          {/* Search + sort row */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <div className="relative flex-1">
              <SearchIcon
                size={12}
                strokeWidth={2.25}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
                aria-hidden
              />
              <input
                type="text"
                id="pq-search"
                value={pqSearch}
                onChange={(event) => setPqSearch(event.target.value)}
                placeholder="Search order #, ID, SKU…"
                aria-label="Search Print Queue"
                className="
                  w-full h-8 pl-8 pr-7 rounded-lg
                  bg-surface-2 ring-1 ring-line
                  text-[12px] text-ink placeholder:text-ink-3
                  focus:bg-surface focus:ring-2 focus:ring-brand/40
                  focus:outline-none transition-all duration-150
                "
              />
              {pqSearch ? (
                <button
                  type="button"
                  onClick={() => setPqSearch('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 active:scale-90 transition-all duration-150"
                >
                  <XIcon size={11} strokeWidth={2.5} />
                </button>
              ) : null}
            </div>
            {queueHistoryVisible ? (
              <button
                type="button"
                onClick={() => setPqHistoryAsc((v) => !v)}
                aria-label={pqHistoryAsc ? 'History sorted oldest first — switch to newest first' : 'History sorted newest first — switch to oldest first'}
                title={pqHistoryAsc ? 'Sort: Oldest → Newest (click for newest first)' : 'Sort: Newest → Oldest (click for oldest first)'}
                className="
                  inline-flex items-center gap-1 h-8 px-2.5 rounded-lg
                  ring-1 ring-line bg-surface
                  text-[11.5px] font-mono text-ink-2
                  hover:text-ink hover:ring-line-2 active:scale-95
                  transition-all duration-150
                "
              >
                <span>{pqHistoryAsc ? '↑ Oldest' : '↓ Newest'}</span>
              </button>
            ) : null}
          </div>

          <div id="pq-summary" className="flex gap-3 px-3 py-2 border-b border-line text-[11px] text-ink-2">
            <div><span className="font-semibold text-ink">{queueCount}</span> Orders</div>
            <div><span className="font-semibold text-ink">{queuedEntries.reduce((sum, entry) => sum + (entry.order_qty ?? 1), 0)}</span> Total Qty</div>
            <div><span className="font-semibold text-ink">{visibleQueueGroups.length}</span> SKU Groups</div>
            <div className="hidden sm:block text-ink-3">{pqClientFilter == null ? 'All clients' : (queueClients.find((client) => client.id === pqClientFilter)?.label ?? queueClientLabel)}</div>
            {pqSearchLower ? (
              <div className="ml-auto text-ink-3 italic">filtered</div>
            ) : null}
          </div>
          {queuePrintMessage ? (
            <div id="pq-progress" style={{ padding: '8px 12px', fontSize: 11, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>{queuePrintMessage}</span>
                <span style={{ fontFamily: 'monospace', color: 'var(--ss-blue)', fontWeight: 700 }}>{queuePrintProgress ?? 0}%</span>
              </div>
              <div style={{ height: 5, marginTop: 6, background: 'var(--surface3)', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, queuePrintProgress ?? 0))}%`, background: 'var(--ss-blue)', borderRadius: 999, transition: 'width .25s ease' }} />
              </div>
            </div>
          ) : null}
          <div id="pq-order-list" style={{ overflowY: 'auto', overflowX: 'hidden', padding: 12, minHeight: 0 }}>
            {queueLoading && !queueHasVisibleEntries ? <div className="empty-state">Loading queue…</div> : null}
            {!queueLoading && !queueHasVisibleEntries ? (
              <div className="pq-empty">
                {pqSearchLower
                  ? <>🔍 No matches for <strong>"{pqSearch}"</strong><br /><small>Clear the search to see all entries.</small></>
                  : <>📭 Queue is empty<br /><small>Click "Send to Queue" on any order with a label</small></>}
              </div>
            ) : null}
            {visibleQueueGroups.map((group) => (
              <div
                key={group.groupId}
                className="pq-group mb-3 overflow-hidden rounded-xl bg-surface ring-1 ring-line shadow-sm"
              >
                <div className="pq-group-header flex items-center gap-2 px-3 py-2.5 bg-surface-2 border-b border-line">
                  <span
                    className={`pq-group-label truncate font-semibold text-ink text-[12.5px] ${group.isMultiSku ? 'shrink-0' : 'flex-1 min-w-0'
                      }`}
                  >
                    {/* Multi-SKU groups show just "MULTI-SKU" — the SKU chips
                        beside it already list the items, so the truncated
                        "— Booster-gel-001…" description was redundant noise.
                        shrink-0 keeps the label at its natural width so the
                        chips sit right next to it. */}
                    {group.isMultiSku
                      ? group.label
                      : `${group.label}${group.description ? ` — ${group.description}` : ''}`}
                  </span>
                  {group.isMultiSku ? (
                    <span className="flex flex-1 flex-wrap gap-1.5">
                      {group.skuLines.map((line) => (
                        <span
                          key={`${line.sku}:${line.qty}`}
                          className="inline-flex max-w-full items-center gap-1 rounded-md border border-brand/35 bg-brand/5 px-2 py-1 font-mono text-[11px] font-semibold text-ink"
                          title={line.description || undefined}
                        >
                          <span className="truncate">{line.sku}</span>
                          <span className="shrink-0 font-bold text-brand">x{line.qty}</span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  <span className="pq-group-meta hidden sm:inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-3 uppercase tracking-wide">
                    {group.orders.length} order{group.orders.length === 1 ? '' : 's'} · Qty {group.perOrderQty} ea
                  </span>
                  <button
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-brand text-white text-[11px] font-semibold shadow-sm hover:opacity-90 active:opacity-100 transition"
                    type="button"
                    onClick={() => void printQueueEntries(group.orders.map((entry) => entry.queue_entry_id))}
                  >
                    <Printer size={15} aria-hidden className="shrink-0" /> Print Group
                  </button>
                </div>
                <div className="pq-group-orders flex flex-col gap-1.5 p-2 bg-page/40">
                  {group.orders.map((entry) => {
                    const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                    const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                    return (
                      <div
                        key={entry.queue_entry_id}
                        className="pq-order-row group/row flex items-center gap-2 px-3 py-2 rounded-lg bg-surface ring-1 ring-line hover:ring-brand/40 hover:shadow-sm transition"
                      >
                        <button
                          type="button"
                          className="pq-order-num flex-1 min-w-0 text-left font-mono text-[12px] text-brand disabled:cursor-default disabled:no-underline hover:underline underline-offset-2"
                          disabled={!orderClickable}
                          title={orderClickable ? 'View order details' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (orderClickable) openDetailDrawer(numericOrderId, true)
                          }}
                        >
                          <span className="block">Order #{entry.order_number || entry.order_id}</span>
                          {group.isMultiSku ? (
                            <span className="mt-1 flex flex-col gap-0.5 font-sans text-[10.5px] text-ink-2 no-underline">
                              {group.skuLines.map((line) => (
                                <span key={`${entry.queue_entry_id}:${line.sku}:${line.qty}`} className="block">
                                  <span className="font-mono font-semibold text-ink">{line.sku} x{line.qty}</span>
                                  {line.description ? <span className="text-ink-3"> - {line.description}</span> : null}
                                </span>
                              ))}
                            </span>
                          ) : null}
                          {entry.print_count > 0 ? (
                            <span className="ml-1.5 inline-flex items-center px-1.5 py-px rounded-sm bg-amber-100 text-amber-800 text-[9.5px] font-semibold uppercase tracking-wide">
                              Reprint #{entry.print_count}
                            </span>
                          ) : null}
                        </button>
                        {/* PS-129: shipping-hold badge. The merge job excludes these from the
                            printed batch server-side; this shows the operator why. */}
                        {entry.shipping_hold ? (
                          <span
                            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-danger-bg text-danger ring-1 ring-danger-border/40 text-[9.5px] font-semibold uppercase tracking-wide"
                            title={(entry.held_reason as string | undefined) || 'On hold — excluded from print'}
                          >
                            ⛔ {(entry.held_reason as string | undefined) || 'On hold'}
                          </span>
                        ) : null}
                        {/* Per user override unlock shipped data on 2026-07-25:
                            display-only badge from the immutable backend snapshot.
                            PS-477 Task 4: gate moved from hazmat_profile to hazmat_is_hazmat.
                            An unsealed declaration (label bought outside PrepShip) legitimately
                            has profile:null — a carrier profile can't be named for a shipment
                            PrepShip never rated/purchased. Gating on profile hid exactly the
                            case this ticket exists to fix. One badge either way; provenance
                            (sealed vs. declared_unsealed) only changes the tooltip. */}
                        {entry.hazmat_is_hazmat ? (
                          <span
                            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800 ring-1 ring-amber-300 text-[9.5px] font-semibold uppercase tracking-wide"
                            title={entry.hazmat_provenance === 'sealed'
                              ? `Immutable hazmat snapshot revision ${entry.hazmat_declaration_revision ?? 'unknown'} · ${entry.hazmat_profile}`
                              : 'Dangerous goods declared. This label was not purchased through PrepShip, so no snapshot was sealed at purchase.'}
                          >
                            ⚠ Hazmat
                          </span>
                        ) : null}
                        <span className="pq-order-qty inline-flex items-center px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-2 text-[10.5px] font-semibold tabular-nums ring-1 ring-line/70">
                          Qty {entry.order_qty ?? 1}
                        </span>
                        <span className="pq-order-time text-[10.5px] text-ink-3 tabular-nums">
                          {new Date(entry.queued_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: CALIFORNIA_TZ })}
                        </span>
                        <button
                          className="pq-remove-btn inline-flex items-center justify-center w-6 h-6 rounded-md text-ink-3 hover:text-rose-600 hover:bg-rose-50 ring-1 ring-transparent hover:ring-rose-200 transition opacity-60 group-hover/row:opacity-100"
                          type="button"
                          title="Remove from queue"
                          onClick={() => void apiClient.removeFromQueue(entry.queue_entry_id, queueClientId)
                            .then(() => hydrateQueue())
                            .catch((error) => showToast(error instanceof Error ? error.message : 'Failed to remove queue entry', 'error'))}
                        >
                          ✕
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {visiblePrintedEntries.length > 0 ? (
              <div className="mt-3 pt-3 border-t border-line">
                <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                  <span>📋 History</span>
                  <span className="inline-flex items-center px-1.5 py-px rounded-sm bg-surface-2 text-ink-2 text-[10px] tabular-nums ring-1 ring-line/70">
                    {visiblePrintedEntries.length}
                    {pqSearchLower && visiblePrintedEntries.length !== printedEntries.length ? ` / ${printedEntries.length}` : ''}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {visiblePrintedEntries.map((entry) => {
                    const numericOrderId = Number.parseInt(String(entry.order_id), 10)
                    const orderClickable = Number.isFinite(numericOrderId) && numericOrderId > 0
                    // Tracking-retired entries show the carrier-confirmed delivery
                    // instead of the printed checkmark (the label never needed printing).
                    const wasDelivered = entry.status === 'delivered'
                    const historyStamp = wasDelivered
                      ? (entry.auto_retired_at ?? entry.last_printed_at)
                      : entry.last_printed_at
                    return (
                      <div
                        key={entry.queue_entry_id}
                        className="pq-order-row flex items-center gap-2 px-3 py-2 rounded-lg bg-surface/80 ring-1 ring-line hover:ring-brand/30 hover:bg-surface transition"
                      >
                        <button
                          type="button"
                          className="pq-order-num flex-1 min-w-0 text-left font-mono text-[12px] text-brand truncate disabled:cursor-default disabled:no-underline hover:underline underline-offset-2"
                          disabled={!orderClickable}
                          title={orderClickable ? 'View order details' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (orderClickable) openDetailDrawer(numericOrderId, true)
                          }}
                        >
                          Order #{entry.order_number || entry.order_id}
                        </button>
                        {wasDelivered ? (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-wide ring-1 ring-emerald-200"
                            title="Carrier tracking confirmed delivery — this label left the queue automatically"
                          >
                            Delivered
                          </span>
                        ) : null}
                        {/* PS-477 Task 4: gate on hazmat_is_hazmat, not hazmat_profile — profile
                            is legitimately null for a declared-but-unsealed hazmat order. */}
                        {entry.hazmat_is_hazmat ? (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800 text-[10px] font-bold uppercase tracking-wide ring-1 ring-amber-200"
                            title={entry.hazmat_provenance === 'sealed'
                              ? `Immutable hazmat snapshot · ${entry.hazmat_profile}`
                              : 'Dangerous goods declared. This label was not purchased through PrepShip, so no snapshot was sealed at purchase.'}
                          >
                            Hazmat
                          </span>
                        ) : null}
                        <span className="pq-order-qty inline-flex items-center px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-2 text-[10.5px] font-semibold tabular-nums ring-1 ring-line/70">
                          Qty {entry.order_qty ?? 1}
                        </span>
                        <span className="pq-order-time inline-flex items-center gap-1 text-[10.5px] text-ink-3 tabular-nums">
                          {wasDelivered ? <span className="text-emerald-600">📦</span> : <span className="text-emerald-600">✓</span>}
                          {historyStamp ? new Date(historyStamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: CALIFORNIA_TZ }) : '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
          {!queueHistoryVisible && queueCount > 0 && !queueConfirmPrintedReady ? (
            <div
              role="status"
              className="mx-3 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900"
            >
              {unprintedQueueCount} queued label{unprintedQueueCount === 1 ? '' : 's'} not printed yet. Click Print All first, then Confirm Printed after the PDF opens.
            </div>
          ) : null}
          <div className="flex items-center gap-2 p-3 border-t border-line bg-surface/95">
            {/* Print All hidden while History is being viewed (it would print
                from the active queue, which is irrelevant in history view). */}
            {!queueHistoryVisible ? (
              <>
                <button
                  className="
                  inline-flex items-center justify-center gap-1.5
                  h-8 px-3 rounded-lg
                  text-[12px] font-bold text-white
                  bg-gradient-to-br from-brand to-indigo-600
                  shadow-md hover:shadow-lg active:scale-95
                  ring-1 ring-brand/30
                  transition-all duration-150
                  disabled:cursor-not-allowed disabled:opacity-55
                  disabled:shadow-none disabled:active:scale-100
                "
                  id="pq-print-all-btn"
                  type="button"
                  disabled={queueCount === 0 || queuePrintInFlight}
                  onClick={() => void printQueueEntries(queuedEntries.map((entry) => entry.queue_entry_id))}
                >
                  <Printer size={16} aria-hidden className="shrink-0 drop-shadow-sm" />
                  Print All
                </button>
                <button
                  className="
                  inline-flex items-center justify-center gap-1.5
                  h-8 px-3 rounded-lg
                  text-[12px] font-bold text-white
                  bg-gradient-to-br from-brand to-indigo-600
                  shadow-md hover:shadow-lg active:scale-95
                  ring-1 ring-brand/30
                  transition-all duration-150
                  disabled:cursor-not-allowed disabled:opacity-55
                  disabled:shadow-none disabled:active:scale-100
                "
                  type="button"
                  title={queueConfirmPrintedReady ? 'Confirm all printed labels' : 'Print all queued labels before confirming printed'}
                  disabled={queueCount === 0 || queuePrintInFlight || !queueConfirmPrintedReady}
                  onClick={() => void confirmQueueEntriesPrinted(queuedEntries.map((entry) => entry.queue_entry_id))}
                >
                  <CheckIcon size={12.5} strokeWidth={2.75} />
                  Confirm Printed
                </button>
              </>
            ) : (
              <div className="text-[11px] text-ink-3 italic px-1">
                Viewing history · {visiblePrintedEntries.length}{pqSearchLower && visiblePrintedEntries.length !== printedEntries.length ? ` of ${printedEntries.length}` : ''} record{printedEntries.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>
  )
}
