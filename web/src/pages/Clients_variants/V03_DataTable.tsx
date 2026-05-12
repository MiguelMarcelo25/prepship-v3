// Variant 03 — Data Table. Operator-tool maximalism. No cards.
// One row per client, every column visible. Sortable, scannable,
// dense. Inspired by Bloomberg-terminal density + Linear table.
// @ts-nocheck
import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Users, ArrowUpDown } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

type SortKey = 'name' | 'active' | 'stores' | 'total' | 'awaiting' | 'shipped'

export default function ClientsV03_DataTable() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('total')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill } = useClientsData()

  const sortedRows = useMemo(() => {
    const out = [...clients]
    out.sort((a, b) => {
      const sA = statsByClient.get(a.id)
      const sB = statsByClient.get(b.id)
      let cmp = 0
      switch (sortKey) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'active': cmp = Number(a.active) - Number(b.active); break
        case 'stores': cmp = a.storeIds.length - b.storeIds.length; break
        case 'total': cmp = (sA?.total ?? 0) - (sB?.total ?? 0); break
        case 'awaiting': cmp = (sA?.awaiting ?? 0) - (sB?.awaiting ?? 0); break
        case 'shipped': cmp = (sA?.shipped ?? 0) - (sB?.shipped ?? 0); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [clients, statsByClient, sortKey, sortDir])

  const handleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir('desc') }
  }

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-[#fafafa]">
      {/* Compact terminal-style toolbar */}
      <div className="flex items-center gap-3 px-4 h-11 bg-white border-b border-line flex-shrink-0">
        <div className="flex items-center gap-2">
          <Users size={14} strokeWidth={2.25} className="text-ink-2" />
          <span className="text-[12.5px] font-extrabold text-ink tracking-tight">Clients</span>
          <span className="font-mono text-[10.5px] text-ink-3 ml-1">{clients.length} rows</span>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw size={11} className={sync.isPending ? 'animate-spin' : ''} />
          {sync.isPending ? 'Syncing' : 'Sync'}
        </Button>
        <Button variant="primary" size="sm" onClick={() => navigate('/settings/store')}>
          <Plus size={11} />
          New
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12.5px] font-mono">
          <thead className="bg-[#f1f5f9] sticky top-0 z-10">
            <tr className="border-b-2 border-line">
              <TH onClick={() => handleSort('active')} active={sortKey === 'active'} dir={sortDir} className="w-12 text-center">●</TH>
              <TH onClick={() => handleSort('name')} active={sortKey === 'name'} dir={sortDir}>Client</TH>
              <TH onClick={() => handleSort('stores')} active={sortKey === 'stores'} dir={sortDir} className="w-32">Stores</TH>
              <TH onClick={() => handleSort('total')} active={sortKey === 'total'} dir={sortDir} className="w-20 text-right">Total</TH>
              <TH onClick={() => handleSort('awaiting')} active={sortKey === 'awaiting'} dir={sortDir} className="w-24 text-right">Awaiting</TH>
              <TH onClick={() => handleSort('shipped')} active={sortKey === 'shipped'} dir={sortDir} className="w-24 text-right">Shipped</TH>
              <th className="w-20 text-right px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-3">Cancel</th>
              <th className="w-32 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-3 text-left">Contact</th>
              <th className="w-24 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="text-center py-12 text-ink-3">Loading…</td></tr>
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={9} className="text-center py-12 text-ink-3">No clients</td></tr>
            ) : sortedRows.map((c, i) => {
              const s = statsByClient.get(c.id)
              return (
                <tr
                  key={c.id}
                  className={`border-b border-line/60 hover:bg-sky-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-[#fcfcfc]'}`}
                >
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                      disabled={toggleActive.isPending}
                      title={c.active ? 'Active' : 'Inactive'}
                      className={`inline-block w-2.5 h-2.5 rounded-full ${c.active ? 'bg-emerald-500 ring-2 ring-emerald-500/30' : 'bg-slate-300 ring-2 ring-slate-300/30'} hover:scale-125 transition-transform`}
                    />
                  </td>
                  <td className="px-3 py-2 font-sans font-bold text-ink truncate max-w-[260px]" title={c.name}>{c.name}</td>
                  <td className="px-3 py-2 text-ink-2 truncate" title={c.storeIds.join(', ')}>
                    {c.storeIds.length ? c.storeIds.join(', ') : <span className="text-ink-3 italic">—</span>}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${(s?.total ?? 0) > 0 ? 'text-ink' : 'text-ink-3'}`}>{(s?.total ?? 0).toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${(s?.awaiting ?? 0) > 0 ? 'text-amber-700 font-semibold' : 'text-ink-3'}`}>{(s?.awaiting ?? 0).toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${(s?.shipped ?? 0) > 0 ? 'text-emerald-700' : 'text-ink-3'}`}>{(s?.shipped ?? 0).toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${(s?.cancelled ?? 0) > 0 ? 'text-rose-700' : 'text-ink-3'}`}>{(s?.cancelled ?? 0).toLocaleString()}</td>
                  <td className="px-3 py-2 text-ink-2 truncate" title={c.email ?? ''}>{c.contactName || c.email || <span className="text-ink-3 italic">—</span>}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-0.5 justify-end">
                      <IconBtn title="Edit" onClick={() => setEditing(c)}><Pencil size={11} /></IconBtn>
                      <IconBtn title="Backfill" disabled={!c.storeIds.length || backfill.isPending} onClick={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (res) => alert(res.message ?? `Assigned ${res.updated}`), onError: (err) => alert(`Backfill failed: ${(err as Error).message}`) })}><Wand2 size={11} /></IconBtn>
                      <IconBtn title="Delete" tone="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}><Trash2 size={11} /></IconBtn>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {editing ? (
        <Suspense fallback={null}>
          <ClientModal existing={editing} onClose={() => setEditing(null)} />
        </Suspense>
      ) : null}
    </div>
  )
}

function TH({ children, className = '', onClick, active, dir }: { children: React.ReactNode; className?: string; onClick: () => void; active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <th onClick={onClick} className={`cursor-pointer select-none px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-left transition-colors hover:bg-[#e2e8f0] ${active ? 'text-sky-700' : 'text-ink-3'} ${className}`}>
      <span className="inline-flex items-center gap-1">
        {children}
        <ArrowUpDown size={9} className={active ? `${dir === 'asc' ? 'rotate-180' : ''} transition-transform` : 'opacity-30'} />
      </span>
    </th>
  )
}

function IconBtn({ children, onClick, title, disabled, tone }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; tone?: 'danger' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`w-6 h-6 inline-flex items-center justify-center rounded text-ink-3 hover:bg-line/60 hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed transition ${tone === 'danger' ? 'hover:text-rose-600 hover:bg-rose-50' : ''}`}>
      {children}
    </button>
  )
}
