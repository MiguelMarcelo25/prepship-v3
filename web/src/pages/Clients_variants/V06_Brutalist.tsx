// Variant 06 — Brutalist Mono. Ivory + ink. Monospace everywhere.
// Sharp 0-radius corners, hard 2px borders, no shadows, no
// gradients. Like a printed receipt or a Riso-printed zine.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Wand2, RefreshCw } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV06_Brutalist() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill } = useClientsData()

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col" style={{ background: '#f5f3ed', fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, monospace' }}>
      {/* Hard header bar — black on ivory, no rounded anything */}
      <header className="flex-shrink-0 border-b-[2px] border-black px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] tracking-[0.3em] uppercase mb-1">/clients · {String(clients.length).padStart(2, '0')} entries</div>
          <h1 className="text-[28px] font-extrabold tracking-tight m-0">CLIENT&nbsp;ROSTER</h1>
        </div>
        <div className="flex items-center gap-0">
          <BrutalBtn disabled={sync.isPending} onClick={() => sync.mutate()}>
            <RefreshCw size={11} strokeWidth={2.5} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? '...SYNC' : 'SYNC'}
          </BrutalBtn>
          <BrutalBtn primary onClick={() => navigate('/settings/store')}>
            <Plus size={11} strokeWidth={2.5} />
            NEW
          </BrutalBtn>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        {isLoading ? (
          <div className="text-center py-10 text-[12px]">[ loading... ]</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-10 text-[12px]">[ no clients on file ]</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 -ml-[2px]">
            {clients.map((c, i) => {
              const s = statsByClient.get(c.id)
              return (
                <article key={c.id} className="border-l-[2px] border-t-[2px] border-black p-4 hover:bg-black hover:text-[#f5f3ed] transition-colors group" style={{ opacity: c.active ? 1 : 0.5 }}>
                  {/* Index number + status sigil */}
                  <div className="flex items-center justify-between mb-3 text-[10px] uppercase tracking-widest">
                    <span>#{String(i + 1).padStart(3, '0')}</span>
                    <button
                      type="button"
                      onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                      disabled={toggleActive.isPending}
                      className="border-[1.5px] border-current px-1.5 py-px hover:bg-current hover:text-[#f5f3ed] group-hover:hover:bg-[#f5f3ed] group-hover:hover:text-black transition"
                    >
                      {c.active ? '● ACTIVE' : '○ INACTIVE'}
                    </button>
                  </div>
                  {/* Client name in BIG mono */}
                  <h2 className="text-[20px] font-extrabold tracking-tight leading-tight uppercase m-0 truncate" title={c.name}>{c.name}</h2>
                  {/* Meta in mono */}
                  <div className="mt-2 text-[11px] space-y-0.5 truncate">
                    {c.contactName ? <div>contact :: {c.contactName}</div> : null}
                    {c.email ? <div className="truncate">email :: {c.email}</div> : null}
                    <div>stores :: [{c.storeIds.join(', ') || '—'}]</div>
                  </div>
                  {/* Stats as ASCII-ish layout */}
                  <div className="mt-4 pt-3 border-t-[1.5px] border-current border-dashed grid grid-cols-3 gap-2 text-[11px]">
                    <BrutalStat label="AWT" value={s?.awaiting ?? 0} />
                    <BrutalStat label="SHP" value={s?.shipped ?? 0} />
                    <BrutalStat label="CNX" value={s?.cancelled ?? 0} />
                  </div>
                  {/* Actions — hard buttons */}
                  <div className="mt-3 pt-3 border-t-[1.5px] border-current border-dashed flex items-center gap-0 text-[10px]">
                    <BrutalAction onClick={() => setEditing(c)} title="Edit"><Pencil size={11} strokeWidth={2.5} />EDIT</BrutalAction>
                    <BrutalAction onClick={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })} disabled={!c.storeIds.length || backfill.isPending} title="Backfill"><Wand2 size={11} strokeWidth={2.5} />BFILL</BrutalAction>
                    <div className="flex-1" />
                    <BrutalAction onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }} disabled={remove.isPending} title="Delete"><Trash2 size={11} strokeWidth={2.5} /></BrutalAction>
                  </div>
                </article>
              )
            })}
            {/* Closing border on the right + bottom to seal the grid */}
            <div className="border-r-[2px] border-b-[2px] border-black col-span-full h-0" />
          </div>
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

function BrutalBtn({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1.5 h-9 px-3 text-[11px] font-extrabold tracking-wider uppercase border-[2px] border-black transition ${primary ? 'bg-black text-[#f5f3ed] hover:bg-[#f5f3ed] hover:text-black' : 'bg-[#f5f3ed] text-black hover:bg-black hover:text-[#f5f3ed]'} disabled:opacity-40 disabled:cursor-not-allowed -ml-[2px] first:ml-0`}>
      {children}
    </button>
  )
}

function BrutalStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-[18px] font-extrabold tabular-nums leading-none">{String(value).padStart(2, '0')}</div>
      <div className="mt-1 text-[9px] tracking-[0.18em]">{label}</div>
    </div>
  )
}

function BrutalAction({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled} className="inline-flex items-center gap-1 h-7 px-2 font-extrabold tracking-wider hover:underline disabled:opacity-30 disabled:cursor-not-allowed">
      {children}
    </button>
  )
}
