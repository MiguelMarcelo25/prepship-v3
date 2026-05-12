// Variant 05 — Minimal List. Whitespace-as-design. Single column,
// tight horizontal rows, near-monochrome palette. Inspired by
// Notion / Are.na list views — let the data breathe.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Wand2, RefreshCw } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV05_Minimal() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill } = useClientsData()

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-white">
      <header className="flex items-center justify-between gap-6 px-12 pt-12 pb-8 flex-shrink-0">
        <div>
          <div className="text-[10px] tracking-[0.4em] uppercase text-neutral-400 mb-3">Clients · {clients.length}</div>
          <h1 className="text-[28px] font-medium tracking-tight text-neutral-900 m-0">Roster</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="text-[12px] text-neutral-500 hover:text-neutral-900 px-3 py-1.5 transition">
            {sync.isPending ? 'Syncing…' : 'Sync'}
          </button>
          <button type="button" onClick={() => navigate('/settings/store')} className="text-[12px] text-neutral-900 hover:bg-neutral-100 px-3 py-1.5 transition border border-neutral-300 hover:border-neutral-900">
            + Add
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-12 pb-12">
        {isLoading ? (
          <div className="text-center text-neutral-400 py-16">…</div>
        ) : clients.length === 0 ? (
          <div className="text-center text-neutral-400 py-16 italic">Empty.</div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {clients.map((c) => {
              const s = statsByClient.get(c.id)
              return (
                <li key={c.id} className="group flex items-center gap-6 py-5 hover:bg-neutral-50/60 -mx-4 px-4 transition-colors" style={{ opacity: c.active ? 1 : 0.45 }}>
                  {/* Active dot — minimalist signal */}
                  <button
                    type="button"
                    onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                    disabled={toggleActive.isPending}
                    title={c.active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
                    className={`w-2 h-2 rounded-full flex-shrink-0 transition ${c.active ? 'bg-neutral-900' : 'bg-neutral-300 hover:bg-neutral-500'}`}
                  />
                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-medium text-neutral-900 truncate">{c.name}</div>
                    <div className="text-[11px] text-neutral-400 mt-0.5 truncate font-mono">
                      {c.storeIds.length ? c.storeIds.join(' · ') : 'no stores'}
                      {c.contactName ? ` — ${c.contactName}` : ''}
                    </div>
                  </div>
                  {/* Three big numbers */}
                  <div className="hidden sm:flex items-baseline gap-6 text-right flex-shrink-0">
                    <Stat n={s?.awaiting ?? 0} label="awaiting" />
                    <Stat n={s?.shipped ?? 0} label="shipped" />
                    <Stat n={s?.total ?? 0} label="total" emphasis />
                  </div>
                  {/* Actions — invisible until hover */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <MiniBtn onClick={() => setEditing(c)} title="Edit"><Pencil size={12} /></MiniBtn>
                    <MiniBtn disabled={!c.storeIds.length || backfill.isPending} onClick={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })} title="Backfill"><Wand2 size={12} /></MiniBtn>
                    <MiniBtn onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }} disabled={remove.isPending} title="Delete"><Trash2 size={12} /></MiniBtn>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {editing ? (
        <Suspense fallback={null}>
          <ClientModal existing={editing} onClose={() => setEditing(null)} />
        </Suspense>
      ) : null}
    </div>
  )
}

function Stat({ n, label, emphasis }: { n: number; label: string; emphasis?: boolean }) {
  return (
    <div className="text-right">
      <div className={`tabular-nums font-medium ${emphasis ? 'text-[18px] text-neutral-900' : 'text-[14px] text-neutral-600'}`}>{n.toLocaleString()}</div>
      <div className="text-[9px] tracking-[0.2em] uppercase text-neutral-400 mt-0.5">{label}</div>
    </div>
  )
}

function MiniBtn({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className="w-7 h-7 inline-flex items-center justify-center text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 transition disabled:opacity-30">
      {children}
    </button>
  )
}
