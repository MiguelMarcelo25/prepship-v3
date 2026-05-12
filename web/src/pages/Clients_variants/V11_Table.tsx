// @ts-nocheck
// Variant 11 — Table (DEFAULT). Consumes the reusable
// <Table> primitive from components/ui/Table.tsx, which gives this
// variant — and every future page that uses Table — sortable
// columns, drag-to-resize widths, localStorage persistence, and
// the full table-fixed truncation recipe for free.
//
// Picked as the new default because:
//   - it's the most data-dense / scannable layout of the 10
//   - it sets a baseline pattern for every other table in the app
//     (Manifests, future audit logs, etc.) to consume
//   - column widths persist per browser, so each operator shapes
//     the table to their workflow
//
// Operators who prefer one of the other 10 aesthetics can swap via
// the floating design picker bottom-right.

import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Pencil,
  Trash2,
  Wand2,
  RefreshCw,
  Users,
  Building2,
  Search,
} from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Table, type TableColumn } from '../../components/ui/Table'
import { useClientsData, type Client, type ClientStats, type OrderStatus } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

interface Row extends Client {
  // Flatten stats onto the row so column sortValue() and render()
  // don't need to do a Map lookup per cell. Computed once below.
  stats: ClientStats | undefined
}

export default function ClientsV11_Table() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill, openClientOrders, confirmActiveToggleDialog } = useClientsData()

  // Pre-flatten stats so each row is self-contained for the Table.
  const rows: Row[] = useMemo(
    () => clients.map((c) => ({ ...c, stats: statsByClient.get(c.id) })),
    [clients, statsByClient],
  )

  // Search + status filter — applied before the Table sees the
  // data so the Table only sorts what's actually visible.
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

  const orderCountCell = (row: Row, value: number, status: OrderStatus, toneClass: string) => {
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
  // Order = render order. Operator-resizable via the column edges;
  // widths persist to localStorage under 'clients-table:widths'.
  // sortValue() is per-column so e.g. the Status column sorts by
  // boolean active flag instead of trying to compare on `key`.
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
      render: (row) => (
        <div className="flex flex-col min-w-0">
          <span className="font-semibold text-ink truncate" title={row.name}>{row.name}</span>
          {row.contactName ? (
            <span className="text-[11px] text-ink-3 truncate">{row.contactName}</span>
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
      render: (row) => (
        row.storeIds.length === 0 ? (
          <span className="text-[11px] text-ink-3 italic">none</span>
        ) : (
          <div className="flex items-center gap-1 flex-wrap">
            <Building2 size={10} strokeWidth={2.25} className="text-ink-3 flex-shrink-0" />
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
      label: '',
      width: 110,
      minWidth: 90,
      align: 'right',
      pinned: true, // not resizable — keeps the action column stable
      render: (row) => (
        <div className="inline-flex items-center gap-0">
          <RowAction title="Edit" onClick={(e) => { e.stopPropagation(); setEditing(row) }}>
            <Pencil size={11} strokeWidth={2.25} />
          </RowAction>
          <RowAction
            title={!row.storeIds.length ? 'Add at least one storeId first' : 'Assign matching orders to this client'}
            disabled={!row.storeIds.length || backfill.isPending}
            onClick={(e) => {
              e.stopPropagation()
              backfill.mutate(
                { id: row.id, overwrite: false },
                {
                  onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated} orders`),
                  onError: (err) => alert(`Backfill failed: ${(err as Error).message}`),
                },
              )
            }}
          >
            <Wand2 size={11} strokeWidth={2.25} />
          </RowAction>
          <RowAction
            title={`Delete "${row.name}"`}
            tone="danger"
            disabled={remove.isPending}
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete client "${row.name}"? This also deletes their billing config.`)) {
                remove.mutate(row.id)
              }
            }}
          >
            <Trash2 size={11} strokeWidth={2.25} />
          </RowAction>
        </div>
      ),
    },
  ]

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-page">
      {/* Page header — title + actions */}
      <header className="flex-shrink-0 flex items-center justify-between gap-3 px-6 py-4 bg-surface border-b border-line">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-brand-dark flex items-center justify-center shadow-sm ring-1 ring-brand/30 flex-shrink-0">
            <Users size={16} strokeWidth={2.25} className="text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[16px] font-extrabold tracking-tight text-ink m-0 leading-none">Clients</h1>
            <p className="text-[11px] text-ink-3 mt-1 leading-none">
              {clients.length} total · {clients.filter((c) => c.active).length} active
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={12} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? 'Syncing…' : 'Sync stores'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => navigate('/settings/store')}>
            <Plus size={12} />
            New client
          </Button>
        </div>
      </header>

      {/* Table area — toolbar (search + filters) lives inside the Table shell */}
      <div className="flex-1 min-h-0 overflow-auto px-6 py-5">
        <Table<Row>
          data={filteredRows}
          columns={columns}
          rowKey={(row) => row.id}
          storageKey="clients-table"
          defaultSort={{ key: 'total', direction: 'desc' }}
          onRowClick={(row) => setEditing(row)}
          density="normal"
          loading={isLoading}
          emptyMessage={
            search || statusFilter !== 'all'
              ? 'No clients match the filter.'
              : 'No clients yet. Click "New client" to add one.'
          }
          toolbar={
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" strokeWidth={2.25} />
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
                      className={`px-2.5 py-1 rounded text-[10.5px] font-bold uppercase tracking-wider transition ${
                        isActive ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink hover:bg-white/60'
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

      {editing ? (
        <Suspense fallback={null}>
          <ClientModal existing={editing} onClose={() => setEditing(null)} />
        </Suspense>
      ) : null}

      {confirmActiveToggleDialog}
    </div>
  )
}

function RowAction({ children, onClick, title, disabled, tone }: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  disabled?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`w-7 h-7 inline-flex items-center justify-center rounded text-ink-3 hover:bg-line/60 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition ${tone === 'danger' ? 'hover:text-rose-600 hover:bg-rose-50' : ''}`}
    >
      {children}
    </button>
  )
}
