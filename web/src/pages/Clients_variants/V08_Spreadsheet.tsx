// Variant 08 — Spreadsheet. Hard 1px borders form a complete grid.
// Cell-style data layout. Subtle column shading on hover. Excel
// feel + finance-app data density.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Wand2, RefreshCw } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV08_Spreadsheet() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill, confirmActiveToggleDialog } = useClientsData()

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col bg-[#f9fafb]">
      <header className="flex-shrink-0 px-4 py-3 bg-white border-b border-gray-300 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[12px] text-gray-700">
          <span className="font-bold">Sheet1</span>
          <span className="text-gray-400">·</span>
          <span className="font-mono text-gray-500">Clients ({clients.length} rows × 7 cols)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="inline-flex items-center gap-1 h-7 px-2.5 text-[11.5px] font-semibold text-gray-700 hover:text-gray-900 hover:bg-gray-100 border border-gray-300 rounded">
            <RefreshCw size={11} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? 'Sync…' : 'Sync'}
          </button>
          <button type="button" onClick={() => navigate('/settings/store')} className="inline-flex items-center gap-1 h-7 px-2.5 text-[11.5px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 border border-emerald-700 rounded">
            <Plus size={11} />
            New
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-[12px] bg-white">
          <colgroup>
            <col style={{ width: 36 }} />
            <col style={{ width: 280 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 200 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          {/* Column header row — sticky, Excel-style */}
          <thead className="sticky top-0 z-10">
            <tr>
              {['', 'A · Client Name', 'B · Status', 'C · Stores', 'D · Total', 'E · Awaiting', 'F · Shipped', 'G · Cancelled', 'H · Actions'].map((label, i) => (
                <th key={i} className={`border border-gray-300 bg-[#f3f4f6] text-[10px] font-bold uppercase tracking-wider text-gray-600 px-2 py-1.5 ${i === 0 ? 'text-center' : 'text-left'} ${i >= 4 && i <= 7 ? 'text-right' : ''}`}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="border border-gray-300 text-center py-8 text-gray-400">Loading…</td></tr>
            ) : clients.length === 0 ? (
              <tr><td colSpan={9} className="border border-gray-300 text-center py-8 text-gray-400 italic">Empty sheet — no clients</td></tr>
            ) : clients.map((c, i) => {
              const s = statsByClient.get(c.id)
              return (
                <tr key={c.id} className="group hover:bg-emerald-50/40 transition-colors">
                  <td className="border border-gray-300 bg-[#f3f4f6] text-center text-[10px] font-mono text-gray-500 font-bold">{i + 1}</td>
                  <td className="border border-gray-300 px-2 py-1.5 font-semibold text-gray-900 truncate">{c.name}</td>
                  <td className="border border-gray-300 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                      disabled={toggleActive.isPending}
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ring-1 transition ${c.active ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100' : 'bg-gray-100 text-gray-500 ring-gray-300 hover:bg-gray-200'}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                      {c.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="border border-gray-300 px-2 py-1.5 font-mono text-[11px] text-gray-700 truncate" title={c.storeIds.join(', ')}>
                    {c.storeIds.length ? c.storeIds.join(', ') : <span className="text-gray-400 italic font-sans">—</span>}
                  </td>
                  <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono font-bold tabular-nums ${(s?.total ?? 0) > 0 ? 'text-gray-900' : 'text-gray-300'}`}>{(s?.total ?? 0).toLocaleString()}</td>
                  <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono tabular-nums ${(s?.awaiting ?? 0) > 0 ? 'text-amber-700 font-semibold bg-amber-50/30' : 'text-gray-300'}`}>{(s?.awaiting ?? 0).toLocaleString()}</td>
                  <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono tabular-nums ${(s?.shipped ?? 0) > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>{(s?.shipped ?? 0).toLocaleString()}</td>
                  <td className={`border border-gray-300 px-2 py-1.5 text-right font-mono tabular-nums ${(s?.cancelled ?? 0) > 0 ? 'text-rose-700' : 'text-gray-300'}`}>{(s?.cancelled ?? 0).toLocaleString()}</td>
                  <td className="border border-gray-300 px-1 py-0.5 text-right">
                    <div className="inline-flex items-center gap-0">
                      <SheetBtn title="Edit" onClick={() => setEditing(c)}><Pencil size={11} /></SheetBtn>
                      <SheetBtn title="Backfill" disabled={!c.storeIds.length || backfill.isPending} onClick={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })}><Wand2 size={11} /></SheetBtn>
                      <SheetBtn title="Delete" tone="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}><Trash2 size={11} /></SheetBtn>
                    </div>
                  </td>
                </tr>
              )
            })}
            {/* Filler rows — completes the spreadsheet illusion */}
            {!isLoading && clients.length > 0 && Array.from({ length: Math.max(0, 18 - clients.length) }).map((_, i) => (
              <tr key={`empty-${i}`} className="hover:bg-emerald-50/20">
                <td className="border border-gray-300 bg-[#f3f4f6] text-center text-[10px] font-mono text-gray-400">{clients.length + i + 1}</td>
                <td colSpan={8} className="border border-gray-300 px-2 py-1.5">&nbsp;</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function SheetBtn({ children, onClick, title, disabled, tone }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; tone?: 'danger' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`w-6 h-6 inline-flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-200 transition disabled:opacity-30 disabled:cursor-not-allowed ${tone === 'danger' ? 'hover:text-rose-600' : ''}`}>
      {children}
    </button>
  )
}
