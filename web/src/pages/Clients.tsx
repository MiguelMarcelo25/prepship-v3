// Clients page.
//
// 2026-05-13: The "Choose your Clients design" picker that previously
// dispatched to one of 11 design variants is gone — operator picked
// the dense-sortable Table variant as the only one they want, so the
// page now renders that directly.
//
// What we kept:
//   - The reusable <Table> primitive at components/ui/Table.tsx
//     gives this page (and every other table in the app) sortable
//     columns, drag-to-reorder column headers, drag-to-resize column
//     widths, localStorage persistence, and the Columns ▾ visibility
//     popover for free.
//   - All client data fetching + mutations live in useClientsData;
//     none of that moved.
//
// What we removed:
//   - The floating V## design picker button (bottom-right)
//   - The variant modal ("Choose your Clients design")
//   - The lazy-loaded dispatcher and the 11-variant Record map
//   - The useClientsVariant hook + localStorage key
//
// The 11 variant files in Clients_variants/ are intentionally kept on
// disk for now in case the operator ever wants to reference them. They
// are NOT imported from anywhere anymore, so they don't ship in the
// production bundle (Vite tree-shakes unimported files). A follow-up
// cleanup pass can delete them if desired.

import { lazy, Suspense, useMemo, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
// 2026-05-13: migrated icons from lucide-react → react-icons (Heroicons
// v2, solid variants). Visual style is noticeably different from
// lucide's feather-derived outline geometry — rounded corners, heavier
// fill, more modern dashboard feel. Solid variants picked specifically
// because they read better at 11–13px row-action sizes than outline
// strokes would. The Users icon sits in a saturated gradient pill on
// the page header where solid also looks better than outline.
//
// API note: react-icons accepts `size` and `className` like lucide,
// but does NOT accept `strokeWidth` (icons are pre-baked SVG paths
// with fixed weight, not stroked). Every `strokeWidth={...}` prop
// was removed during this port.
//
// Semantic mapping:
//   Plus       → HiPlus              ("New client" + page-actions)
//   Pencil     → HiPencilSquare      (Edit row)
//   Trash2     → HiTrash             (Delete row)
//   Wand2      → HiSparkles          (Backfill = "magic" auto-assign)
//   RefreshCw  → HiArrowPath         (Sync stores button)
//   Users      → HiUsers             (Page header icon)
//   Building2  → HiBuildingStorefront (Stores column — semantic upgrade
//                                       from "building" to "storefront")
//   Search     → HiMagnifyingGlass   (Search input)
import {
  HiPlus,
  HiPencilSquare,
  HiTrash,
  HiSparkles,
  HiArrowPath,
  HiUsers,
  HiBuildingStorefront,
  HiMagnifyingGlass,
} from 'react-icons/hi2'
import { Button } from '../components/ui/Button'
import { ConfirmModal } from '../components/ui/ConfirmModal'
import { Table, type TableColumn } from '../components/ui/Table'
import {
  useClientsData,
  type Client,
  type ClientStats,
  type OrderStatus,
} from './Clients_variants/useClientsData'

const ClientModal = lazy(() => import('../components/ClientModal'))

interface Row extends Client {
  // Flatten stats onto the row so column sortValue() and render()
  // don't need to do a Map lookup per cell. Computed once below.
  stats: ClientStats | undefined
}

export default function Clients() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const [search, setSearch] = useState('')
  // 2026-05-13: portal anchor for the <Table>'s Columns ▾ button.
  // Operator asked to move the picker out of the table card and into
  // the page-level toolbar (to the LEFT of "Sync stores"). Callback
  // ref + state so React re-renders Table when the anchor mounts.
  // Same pattern used by Inventory and Packages.
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
  // 2026-05-13: row-action confirmations. Each holds the targeted
  // row (so the modal can show the client's name in the prompt) or
  // null when the modal is closed. Native confirm()/alert() were
  // replaced with these in-app modals so the dialog matches the rest
  // of the app's design + animations.
  //   confirmBackfill — "Assign matching orders" magic action
  //   confirmDelete   — destructive client deletion
  //   resultDialog    — generic post-action toast (success/error)
  //                     shown after backfill / sync finishes
  const [confirmBackfill, setConfirmBackfill] = useState<Row | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null)
  const [resultDialog, setResultDialog] = useState<{
    title: string
    description: string
    tone: 'default' | 'danger' | 'magic' | 'info'
  } | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const {
    clients,
    statsByClient,
    isLoading,
    sync,
    remove,
    toggleActive,
    backfill,
    openClientOrders,
    confirmActiveToggleDialog,
  } = useClientsData()

  // Pre-flatten stats so each row is self-contained for the Table.
  // useMemo with [clients, statsByClient] keeps this O(n) once per
  // refetch rather than per render.
  const rows: Row[] = useMemo(
    () => clients.map((c) => ({ ...c, stats: statsByClient.get(c.id) })),
    [clients, statsByClient],
  )

  // Search + status filter — applied BEFORE the Table sees the data
  // so the Table only sorts/paginates what's actually visible. Sort
  // direction and column order are handled inside <Table> itself.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((c) => {
      if (statusFilter === 'active' && !c.active) return false
      if (statusFilter === 'inactive' && c.active) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        (c.contactName ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        c.storeIds.some((id) => String(id).includes(q))
      )
    })
  }, [rows, search, statusFilter])

  // Helper that renders order-count cells with consistent behavior:
  //   - 0 → plain muted text, not clickable
  //   - >0 → button that opens that status's order list, filtered
  //     to this client, in a new view
  // toneClass colors the number by status (amber=awaiting, ok=shipped,
  // rose=cancelled). Click stops propagation so it doesn't also fire
  // the row's onRowClick (which opens the edit modal).
  const orderCountCell = (
    row: Row,
    value: number,
    status: OrderStatus,
    toneClass: string,
  ) => {
    if (value <= 0) {
      return <span className="font-mono tabular-nums text-ink-3">{value.toLocaleString()}</span>
    }
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          openClientOrders(row, status)
        }}
        className={`font-mono tabular-nums font-semibold rounded px-1.5 py-0.5 -mr-1 hover:bg-brand/8 hover:text-brand transition ${toneClass}`}
        title={`Open ${status.replace('_', ' ')} orders for ${row.name}`}
      >
        {value.toLocaleString()}
      </button>
    )
  }

  // ─── Column definitions ────────────────────────────────────────
  // Order = initial render order — operators can drag headers to
  // reorder, drag column edges to resize, and click the Columns ▾
  // button (rendered inside the Table's toolbar) to show/hide. All
  // three persist to localStorage under `clients-table:*` keys.
  //
  // sortValue() is per-column so e.g. the Status column sorts by the
  // boolean active flag (1/0) instead of trying to compare on the
  // column's `key` field naively.
  //
  // 2026-05-13: every column (including actions) is now toggleable +
  // draggable per operator request — matches the Awaiting Shipment
  // view's behavior. The Table primitive's Columns ▾ popover has a
  // Reset button that restores defaults if an operator hides the
  // actions column or any other column by mistake.
  const columns: TableColumn<Row>[] = [
    {
      key: 'active',
      label: 'Status',
      width: 110,
      minWidth: 90,
      sortable: true,
      sortValue: (row) => (row.active ? 1 : 0),
      render: (row) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggleActive.mutate({ id: row.id, active: !row.active })
          }}
          disabled={toggleActive.isPending}
          title={row.active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full ring-1 text-[10px] font-extrabold uppercase tracking-wider transition ${
            row.active
              ? 'bg-ok-bg text-ok-dark ring-ok/25 hover:ring-ok/50'
              : 'bg-surface-2 text-ink-3 ring-line hover:text-ink-2'
          } disabled:opacity-60 disabled:cursor-wait`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${row.active ? 'bg-ok' : 'bg-line-2'}`} />
          {row.active ? 'Active' : 'Off'}
        </button>
      ),
    },
    {
      key: 'name',
      label: 'Client',
      width: 240,
      minWidth: 140,
      sortable: true,
      sortValue: (row) => row.name,
      // 2026-05-13: added `items-center` to the flex-col so the
      // name + optional contactName subline both center within the
      // cell. Without it, the stacked spans aligned to the start of
      // the flex column (text-center on the parent td applies to
      // text nodes, not to flex children's bounding boxes).
      render: (row) => (
        <div className="flex flex-col items-center min-w-0">
          <span className="font-semibold text-ink truncate max-w-full" title={row.name}>{row.name}</span>
          {row.contactName ? (
            <span className="text-[11px] text-ink-3 truncate max-w-full">{row.contactName}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      width: 220,
      minWidth: 140,
      sortable: true,
      sortValue: (row) => row.email ?? '',
      render: (row) => (
        row.email ? (
          <span className="font-mono text-[11.5px] text-ink-2 truncate block" title={row.email}>{row.email}</span>
        ) : (
          <span className="text-[11px] text-ink-3 italic">—</span>
        )
      ),
    },
    {
      key: 'storeIds',
      label: 'Stores',
      width: 180,
      minWidth: 120,
      sortable: true,
      sortValue: (row) => row.storeIds.length,
      // 2026-05-14 (operator request): left-align the Stores cell so the
      // store icon + id badges anchor to the cell's left edge, matching
      // the Client column to its left and reading naturally as a row
      // starting from the client's name. Previously `justify-center`
      // pushed the badges to the cell midline. The earlier comment
      // about the parent <td> being `text-center` is stale — Table
      // (web/src/components/ui/Table.tsx:1103) actually hardcodes
      // text-left on every cell regardless of column.align, so the
      // outer alignment was already left; only the inner flex was
      // overriding it.
      render: (row) => (
        row.storeIds.length === 0 ? (
          <span className="text-[11px] text-ink-3 italic">none</span>
        ) : (
          <div className="flex items-center justify-start gap-1 flex-wrap">
            <HiBuildingStorefront size={13} className="text-indigo-500 flex-shrink-0" />
            {row.storeIds.slice(0, 3).map((sid) => (
              <span key={sid} className="font-mono text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-surface-2 text-ink-2 ring-1 ring-line/70" title={`Store ${sid}`}>
                {sid}
              </span>
            ))}
            {row.storeIds.length > 3 ? (
              <span className="text-[10.5px] text-ink-3" title={`+${row.storeIds.length - 3} more: ${row.storeIds.slice(3).join(', ')}`}>
                +{row.storeIds.length - 3}
              </span>
            ) : null}
          </div>
        )
      ),
    },
    {
      key: 'awaiting',
      label: 'Awaiting',
      width: 100,
      minWidth: 80,
      align: 'right',
      sortable: true,
      sortValue: (row) => row.stats?.awaiting ?? 0,
      render: (row) => {
        const v = row.stats?.awaiting ?? 0
        return orderCountCell(row, v, 'awaiting_shipment', 'text-amber-700')
      },
    },
    {
      key: 'shipped',
      label: 'Shipped',
      width: 100,
      minWidth: 80,
      align: 'right',
      sortable: true,
      sortValue: (row) => row.stats?.shipped ?? 0,
      render: (row) => {
        const v = row.stats?.shipped ?? 0
        return orderCountCell(row, v, 'shipped', 'text-ok-dark')
      },
    },
    {
      key: 'cancelled',
      label: 'Cancelled',
      width: 100,
      minWidth: 80,
      align: 'right',
      sortable: true,
      sortValue: (row) => row.stats?.cancelled ?? 0,
      render: (row) => {
        const v = row.stats?.cancelled ?? 0
        return orderCountCell(row, v, 'cancelled', 'text-rose-700')
      },
    },
    {
      key: 'total',
      label: 'Total',
      width: 100,
      minWidth: 80,
      align: 'right',
      sortable: true,
      sortValue: (row) => row.stats?.total ?? 0,
      render: (row) => {
        const v = row.stats?.total ?? 0
        return (
          <span className={`font-mono tabular-nums font-bold ${v > 0 ? 'text-ink' : 'text-ink-3'}`}>
            {v.toLocaleString()}
          </span>
        )
      },
    },
    {
      key: 'actions',
      // 2026-05-14 (operator request): give the actions column a
      // visible header label instead of an empty string — operators
      // scanning the table want a textual cue above the icon row that
      // matches the conventions of every other column. Header text
      // alignment currently rides on the Table primitive's hardcoded
      // text-left (see Table.tsx:1103) so the title reads at the left
      // edge of the column even though icons sit at the right edge —
      // separate latent Table bug to fix once we audit other tables.
      label: 'Actions',
      // 2026-05-13: bumped width 110 → 140 and minWidth 90 → 120 to
      // accommodate the larger 36×36 row-action buttons (was 28×28).
      width: 140,
      minWidth: 120,
      align: 'right',
      // 2026-05-13: removed pinned + hideable:false per operator
      // request — every column should be toggleable AND draggable,
      // matching Awaiting Shipment behavior. The Table primitive's
      // Columns ▾ picker has a Reset button if an operator hides
      // this by accident.
      render: (row) => (
        <div className="inline-flex items-center gap-0">
          {/* 2026-05-13: bumped icons from size=12 → size=16 and
              relied on the larger RowAction button (w-9 h-9) so the
              tap target hits modern UI guidelines (~32px+) instead
              of the previous tight 28px target. Edit still opens the
              ClientModal directly (no confirmation needed for non-
              destructive actions). Backfill and Delete now route
              through ConfirmModal — see the modal block below. */}
          <RowAction tone="edit" title="Edit" onClick={(e) => { e.stopPropagation(); setEditing(row) }}>
            <HiPencilSquare size={16} />
          </RowAction>
          <RowAction
            tone="magic"
            title={!row.storeIds.length ? 'Add at least one storeId first' : 'Assign matching orders to this client'}
            disabled={!row.storeIds.length || backfill.isPending}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmBackfill(row)
            }}
          >
            <HiSparkles size={16} />
          </RowAction>
          <RowAction
            title={`Delete "${row.name}"`}
            tone="danger"
            disabled={remove.isPending}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDelete(row)
            }}
          >
            <HiTrash size={16} />
          </RowAction>
        </div>
      ),
    },
  ]

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-page">
      {/* Page header — title + actions. Matches the visual treatment
          of other top-level views (Inventory, Packages) so the
          header height + spacing stay consistent across pages. */}
      <header className="flex-shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 bg-surface border-b border-line sm:px-6 sm:py-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-brand-dark flex items-center justify-center shadow-sm ring-1 ring-brand/30 flex-shrink-0">
            <HiUsers size={17} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[16px] font-extrabold tracking-tight text-ink m-0 leading-none">Clients</h1>
            <p className="text-[11px] text-ink-3 mt-1 leading-none">
              {clients.length} total · {clients.filter((c) => c.active).length} active
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 2026-05-13: portal anchor for the <Table>'s Columns ▾
              button. Sits HERE so the picker lives next to "Sync
              stores" instead of inside the table card below. */}
          <span ref={setColumnsAnchor} className="inline-flex items-center" />
          <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <HiArrowPath size={13} className={`text-emerald-600 ${sync.isPending ? 'animate-spin' : ''}`} />
            {sync.isPending ? 'Syncing…' : 'Sync stores'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/settings/store')}>
            <HiPlus size={13} />
            New client
          </Button>
        </div>
      </header>

      {/* Table shell — search + status filter live inside the Table's
          toolbar slot so they share the table card's rounded shell.
          The Table itself owns: sort state, column widths, column
          ORDER (drag headers to reorder), and column visibility
          (Columns ▾ button on the right of the toolbar). All persist
          per-browser via the `clients-table:*` localStorage keys. */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-4 sm:px-6 sm:py-5">
        <Table<Row>
          data={filteredRows}
          columns={columns}
          rowKey={(row) => row.id}
          storageKey="clients-table"
          defaultSort={{ key: 'total', direction: 'desc' }}
          onRowClick={(row) => setEditing(row)}
          density="normal"
          // 2026-05-13: portal the Columns ▾ button into the page
          // toolbar (left of "Sync stores"). When the anchor is
          // null (first render before the span mounts), Table
          // falls back to inline — but the span attaches on the
          // same tick, so the callback ref fires and Table
          // re-renders with the portal target. No flicker.
          columnsAnchorEl={columnsAnchor}
          loading={isLoading}
          emptyMessage={
            search || statusFilter !== 'all'
              ? 'No clients match the filter.'
              : 'No clients yet. Click "New client" to add one.'
          }
          toolbar={
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <HiMagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, contact, email, store ID…"
                  className="w-full h-8 pl-9 pr-3 rounded-md ring-1 ring-line bg-surface text-[12.5px] text-ink placeholder:text-ink-3 focus:ring-2 focus:ring-brand/40 focus:outline-none transition-shadow"
                />
              </div>
              <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-surface-2 ring-1 ring-line">
                {(['all', 'active', 'inactive'] as const).map((f) => {
                  const isActive = statusFilter === f
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setStatusFilter(f)}
                      // 2026-05-14 (operator request): active pill now uses
                      // the PrepShip brand color #03A9F4 (Material Light
                      // Blue 500) instead of the previous flat dark `bg-ink`.
                      // Hex literal kept inline (rather than swapped for
                      // `bg-brand`) so the color is exact regardless of
                      // whatever the active theme's --brand-rgb is set to;
                      // if/when the global theme is updated to 03A9F4 this
                      // can be folded back to `bg-brand`.
                      className={`px-2.5 py-1 rounded text-[10.5px] font-bold uppercase tracking-wider transition ${
                        isActive ? 'bg-[#03A9F4] text-white shadow-sm' : 'text-ink-2 hover:text-ink hover:bg-white/60'
                      }`}
                    >
                      {f}
                    </button>
                  )
                })}
              </div>
              <div className="text-[11px] text-ink-3 tabular-nums ml-auto">
                {filteredRows.length === rows.length
                  ? `${rows.length} rows`
                  : `${filteredRows.length} of ${rows.length}`}
              </div>
            </div>
          }
        />
      </div>

      {/* 2026-05-13: ClientModal now wrapped in AnimatePresence so
          the modal animates IN on mount and OUT on unmount. The
          modal's outer + inner divs were converted to motion.divs in
          the same commit so AnimatePresence has motion children to
          drive enter/exit. Suspense stays outside AnimatePresence
          because the lazy chunk fetch only runs once per session —
          subsequent opens reuse the cached module and animate
          normally. */}
      <AnimatePresence>
        {editing ? (
          <Suspense fallback={null}>
            <ClientModal existing={editing} onClose={() => setEditing(null)} />
          </Suspense>
        ) : null}
      </AnimatePresence>

      {/* Backfill confirmation — explains what the action will do
          (assign matching orders by storeId) so the operator isn't
          surprised by what they're about to trigger. Result lands
          in the shared resultDialog state. */}
      <ConfirmModal
        open={!!confirmBackfill}
        tone="magic"
        title={`Assign orders to "${confirmBackfill?.name ?? ''}"?`}
        description={
          <>
            This will scan every order whose storeId matches one of{' '}
            <span className="font-mono font-semibold text-ink">
              {confirmBackfill?.storeIds.slice(0, 3).join(', ')}
              {confirmBackfill && confirmBackfill.storeIds.length > 3
                ? ` +${confirmBackfill.storeIds.length - 3}`
                : ''}
            </span>{' '}
            and assign them to this client. Existing client assignments
            won't be overwritten.
          </>
        }
        confirmLabel="Assign orders"
        loading={backfill.isPending}
        onCancel={() => {
          if (!backfill.isPending) setConfirmBackfill(null)
        }}
        onConfirm={() => {
          if (!confirmBackfill) return
          backfill.mutate(
            { id: confirmBackfill.id, overwrite: false },
            {
              onSuccess: (r) => {
                setConfirmBackfill(null)
                setResultDialog({
                  title: 'Orders assigned',
                  description: r.message ?? `Assigned ${r.updated} orders to ${confirmBackfill.name}.`,
                  tone: 'magic',
                })
              },
              onError: (err) => {
                setConfirmBackfill(null)
                setResultDialog({
                  title: 'Backfill failed',
                  description: (err as Error).message,
                  tone: 'danger',
                })
              },
            },
          )
        }}
      />

      {/* Delete confirmation — destructive, surfaces the full
          consequence text (billing config also goes) so operator
          knows what they're agreeing to. tone=danger drives a rose
          icon + rose confirm button. */}
      <ConfirmModal
        open={!!confirmDelete}
        tone="danger"
        title={`Delete "${confirmDelete?.name ?? ''}"?`}
        description="This also deletes their billing config and removes the client from any carrier-account assignments. This action cannot be undone."
        confirmLabel="Delete client"
        loading={remove.isPending}
        onCancel={() => {
          if (!remove.isPending) setConfirmDelete(null)
        }}
        onConfirm={() => {
          if (!confirmDelete) return
          remove.mutate(confirmDelete.id, {
            onSuccess: () => {
              setConfirmDelete(null)
            },
            onError: (err) => {
              setConfirmDelete(null)
              setResultDialog({
                title: 'Delete failed',
                description: (err as Error).message,
                tone: 'danger',
              })
            },
          })
        }}
      />

      {/* Result dialog — shared single-button "OK" modal that any
          row-action mutation result can populate. Replaces the
          previous alert() calls so success/error feedback stays in
          the same visual language as the rest of the app. */}
      <ConfirmModal
        open={!!resultDialog}
        tone={resultDialog?.tone ?? 'default'}
        title={resultDialog?.title ?? ''}
        description={resultDialog?.description}
        acknowledgeOnly
        onCancel={() => setResultDialog(null)}
        onConfirm={() => setResultDialog(null)}
      />

      {confirmActiveToggleDialog}
    </div>
  )
}

// Small icon-only button used inside the actions column.
//
// 2026-05-13: extended the `tone` prop from a single 'danger' opt-in
// to a three-way union ('edit' | 'magic' | 'danger') so each row
// action carries an at-a-glance color cue. Color picks chosen to be
// semantically meaningful AND visually distinct so operators can
// scan a long list and locate the right action quickly:
//
//   edit   → sky-600   (calm, informational blue — the "modify"
//                       color used in most dashboard UIs)
//   magic  → violet-600 (matches HiSparkles' "magic auto-assign"
//                        semantic — purple = AI/automation in 2026)
//   danger → rose-500  (destructive — stays distinct from any
//                       sortable-cancellation-count text-rose-700
//                       used elsewhere so they don't visually
//                       compete; lighter rose works at icon scale)
//
// idle = colored, hover = darker shade of same hue + faint matching
// background tint. Coordinating both idle and hover keeps the
// affordance consistent — operators don't have to hover to find out
// what each icon does, but hover still gives clear "I'm targeting
// this one" feedback.
//
// stopPropagation lives on the parent column's onClick so the row's
// onRowClick (open modal) doesn't also fire when the operator just
// wanted to delete or edit a row.
function RowAction({ children, onClick, title, disabled, tone }: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  disabled?: boolean
  tone?: 'edit' | 'magic' | 'danger'
}) {
  const toneClasses =
    tone === 'edit'
      ? 'text-sky-600 hover:bg-sky-50 hover:text-sky-700'
      : tone === 'magic'
        ? 'text-violet-600 hover:bg-violet-50 hover:text-violet-700'
        : tone === 'danger'
          ? 'text-rose-500 hover:bg-rose-50 hover:text-rose-600'
          : 'text-ink-3 hover:bg-line/60 hover:text-ink'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`w-9 h-9 inline-flex items-center justify-center rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition ${toneClasses}`}
    >
      {children}
    </button>
  )
}
