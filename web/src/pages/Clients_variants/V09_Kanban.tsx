// Variant 09 — Kanban Board. Active vs Inactive as two columns
// side by side. Trello / Linear board feel. Drag-to-toggle (click
// the column-cross-over arrow). Cards are slim; the WIN is
// at-a-glance roster-health view.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, ArrowRight, ArrowLeft, Users, Pause, Play } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV09_Kanban() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill, confirmActiveToggleDialog } = useClientsData()

  const active = clients.filter((c) => c.active)
  const inactive = clients.filter((c) => !c.active)

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-slate-100">
      <header className="flex-shrink-0 px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
            <Users size={15} strokeWidth={2.25} className="text-white" />
          </div>
          <div>
            <h1 className="text-[15px] font-extrabold tracking-tight text-slate-900 m-0 leading-none">Clients board</h1>
            <p className="text-[10.5px] text-slate-500 mt-1 leading-none">{active.length} active · {inactive.length} inactive</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white hover:bg-slate-50 ring-1 ring-slate-300 text-slate-700 text-[12px] font-semibold transition">
            <RefreshCw size={11} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? 'Syncing…' : 'Sync'}
          </button>
          <button type="button" onClick={() => navigate('/settings/store')} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-[12px] font-bold transition">
            <Plus size={11} />
            New client
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-5">
        {isLoading ? (
          <div className="text-center py-16 text-slate-400">Loading board…</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-16 text-slate-400">No clients</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-6xl mx-auto">
            <BoardColumn
              title="Active"
              count={active.length}
              accent="emerald"
              icon={<Play size={11} strokeWidth={2.5} fill="currentColor" />}
            >
              {active.length === 0 ? (
                <ColumnEmpty>All clients paused. Click → on an inactive card to activate.</ColumnEmpty>
              ) : (
                active.map((c, i) => (
                  <KanbanCard
                    key={c.id}
                    client={c}
                    stats={statsByClient.get(c.id)}
                    index={i}
                    onEdit={() => setEditing(c)}
                    onToggle={() => toggleActive.mutate({ id: c.id, active: false })}
                    togglePending={toggleActive.isPending}
                    onBackfill={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })}
                    backfillPending={backfill.isPending}
                    onDelete={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}
                    removePending={remove.isPending}
                    direction="right"
                  />
                ))
              )}
            </BoardColumn>

            <BoardColumn
              title="Inactive"
              count={inactive.length}
              accent="slate"
              icon={<Pause size={11} strokeWidth={2.5} fill="currentColor" />}
            >
              {inactive.length === 0 ? (
                <ColumnEmpty>No paused clients. Everything's flowing.</ColumnEmpty>
              ) : (
                inactive.map((c, i) => (
                  <KanbanCard
                    key={c.id}
                    client={c}
                    stats={statsByClient.get(c.id)}
                    index={i}
                    onEdit={() => setEditing(c)}
                    onToggle={() => toggleActive.mutate({ id: c.id, active: true })}
                    togglePending={toggleActive.isPending}
                    onBackfill={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })}
                    backfillPending={backfill.isPending}
                    onDelete={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}
                    removePending={remove.isPending}
                    direction="left"
                  />
                ))
              )}
            </BoardColumn>
          </div>
        )}
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

function BoardColumn({ title, count, accent, icon, children }: { title: string; count: number; accent: 'emerald' | 'slate'; icon: React.ReactNode; children: React.ReactNode }) {
  const accentBg = accent === 'emerald' ? 'bg-emerald-50' : 'bg-slate-200/60'
  const accentText = accent === 'emerald' ? 'text-emerald-700' : 'text-slate-500'
  return (
    <div className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-sm flex flex-col min-h-[400px]">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
        <div className={`inline-flex items-center gap-1.5 ${accentText}`}>
          {icon}
          <span className="text-[11.5px] font-extrabold uppercase tracking-[0.14em]">{title}</span>
          <span className={`ml-1.5 px-1.5 py-0.5 rounded-full ${accentBg} text-[10px] font-mono tabular-nums`}>{count}</span>
        </div>
      </div>
      <div className="p-3 flex-1 space-y-2 overflow-y-auto">{children}</div>
    </div>
  )
}

function ColumnEmpty({ children }: { children: React.ReactNode }) {
  return <div className="text-center text-[11.5px] text-slate-400 italic py-12 px-4">{children}</div>
}

function KanbanCard({ client, stats, index, onEdit, onToggle, togglePending, onBackfill, backfillPending, onDelete, removePending, direction }: any) {
  const dirArrow = direction === 'right' ? <ArrowRight size={11} /> : <ArrowLeft size={11} />
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: direction === 'right' ? 40 : -40 }}
      transition={{ duration: 0.3, delay: Math.min(index, 10) * 0.03 }}
      className="group bg-slate-50 hover:bg-white rounded-xl p-3 ring-1 ring-slate-200/80 hover:ring-teal-400/50 hover:shadow-md transition-all cursor-pointer"
      onClick={onEdit}
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-bold text-slate-900 truncate">{client.name}</div>
          <div className="text-[10.5px] text-slate-500 truncate font-mono mt-0.5">
            {client.storeIds.length ? client.storeIds.join(' · ') : 'no stores'}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          disabled={togglePending}
          title={direction === 'right' ? 'Move to Inactive' : 'Move to Active'}
          className="w-6 h-6 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-teal-700 hover:bg-teal-50 transition opacity-0 group-hover:opacity-100"
        >
          {dirArrow}
        </button>
      </div>
      {stats ? (
        <div className="mt-2.5 flex items-center gap-3 text-[10.5px] font-mono tabular-nums">
          <span className="text-amber-600">{stats.awaiting} <span className="text-slate-400 font-sans normal-case">awaiting</span></span>
          <span className="text-emerald-600">{stats.shipped} <span className="text-slate-400 font-sans">shipped</span></span>
          <span className="ml-auto text-slate-500">{stats.total} total</span>
        </div>
      ) : null}
    </motion.div>
  )
}
