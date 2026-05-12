// Variant 01 — Original. Restoration of the pre-redesign Clients
// page so operators have an "undo" path back to the familiar layout
// they were working with before the Editorial redesign shipped.
// Plain 3-col card grid, off-the-shelf SaaS aesthetic.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Users, Power } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV01_Original() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill } = useClientsData()
  const rows = clients

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col">
      <div className="flex items-center gap-3 px-5 h-14 bg-surface border-b border-line flex-shrink-0">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-brand-dark flex items-center justify-center shadow-sm ring-1 ring-brand/30 flex-shrink-0">
          <Users size={16} strokeWidth={2.25} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-extrabold text-ink font-display tracking-tight m-0 leading-none">Clients</h2>
          <p className="text-[11px] text-ink-3 mt-1 leading-none">Brands &amp; stores · per-tenant billing &amp; ShipStation isolation</p>
        </div>
        <Button variant="outline" size="sm" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw size={12} className={sync.isPending ? 'animate-spin' : ''} />
          {sync.isPending ? 'Syncing…' : 'Sync stores'}
        </Button>
        <Button variant="primary" size="sm" onClick={() => navigate('/settings/store')}>
          <Plus size={12} />
          New client
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {isLoading ? (
          <div className="text-center text-ink-3 py-10">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">🧑‍💼</div>
            <div className="font-semibold text-ink-2">No clients yet</div>
            <div className="text-xs mt-1">Add your first client. Clients are needed for per-tenant billing and ShipStation account isolation.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((c) => {
              const s = statsByClient.get(c.id)
              return (
                <div key={c.id} className="bg-white rounded-card border border-line shadow-sm p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-bold text-ink truncate">{c.name}</div>
                    <button
                      type="button"
                      aria-pressed={c.active}
                      disabled={toggleActive.isPending}
                      onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                      className={`inline-flex items-center gap-2 rounded-full shrink-0 ring-1 px-1.5 py-1 pr-2.5 text-[10px] font-extrabold uppercase transition shadow-sm ${
                        c.active ? 'bg-ok-bg text-ok-dark ring-ok/25' : 'bg-surface-3 text-ink-3 ring-line'
                      }`}
                    >
                      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${c.active ? 'bg-ok' : 'bg-line-2'}`}>
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-sm transition ${c.active ? 'translate-x-4' : 'translate-x-0.5'}`}>
                          <Power size={9} strokeWidth={2.6} className={c.active ? 'text-ok-dark' : 'text-ink-3'} />
                        </span>
                      </span>
                      <span>{c.active ? 'ON Active' : 'OFF Inactive'}</span>
                    </button>
                  </div>
                  <div className="text-tiny text-ink-2 space-y-0.5">
                    {c.contactName && <div>{c.contactName}</div>}
                    {c.email && <div className="font-mono">{c.email}</div>}
                    {c.phone && <div>{c.phone}</div>}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-tiny text-ink-3">Stores:</span>
                    {c.storeIds.length ? (
                      c.storeIds.map((sid) => (
                        <span key={sid} className="text-tiny font-mono px-1.5 py-0.5 rounded bg-surface-3 text-ink-2">
                          {sid}
                        </span>
                      ))
                    ) : (
                      <span className="text-tiny text-ink-3 italic">none linked</span>
                    )}
                  </div>
                  {!s ? (
                    <div className="text-tiny text-ink-3 italic">No orders assigned</div>
                  ) : (
                    <div className="flex items-center gap-1.5 flex-wrap text-tiny">
                      <CountPill label="Awaiting" value={s.awaiting} bg="bg-warn-bg" text="text-[#92400e]" />
                      <CountPill label="Shipped" value={s.shipped} bg="bg-ok-bg" text="text-ok-dark" />
                      <CountPill label="Cancelled" value={s.cancelled} bg="bg-danger-bg" text="text-[#991b1b]" />
                      {s.onHold > 0 && <CountPill label="On hold" value={s.onHold} bg="bg-surface-3" text="text-ink-2" />}
                      <span className="text-ink-3 ml-auto">{s.total.toLocaleString()} total</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 pt-1 border-t border-line flex-wrap">
                    <Button variant="ghost" size="xs" onClick={() => setEditing(c)}>
                      <Pencil size={11} />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={!c.storeIds.length || backfill.isPending}
                      onClick={() =>
                        backfill.mutate(
                          { id: c.id, overwrite: false },
                          {
                            onSuccess: (res) => alert(res.message ?? `Assigned ${res.updated} orders`),
                            onError: (err) => alert(`Backfill failed: ${(err as Error).message}`),
                          },
                        )
                      }
                    >
                      <Wand2 size={11} />
                      Backfill
                    </Button>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (confirm(`Delete client "${c.name}"? This also deletes their billing config and line items.`)) {
                          remove.mutate(c.id)
                        }
                      }}
                      disabled={remove.isPending}
                      className="text-ink-3 hover:!text-danger"
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                </div>
              )
            })}
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

function CountPill({ label, value, bg, text }: { label: string; value: number; bg: string; text: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${bg} ${text} font-semibold`} title={label}>
      <span className="font-mono">{value.toLocaleString()}</span>
      <span className="opacity-70">{label.toLowerCase()}</span>
    </span>
  )
}
