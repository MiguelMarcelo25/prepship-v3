// Variant 04 — Dark Glass. Slate-950 canvas with frosted-glass
// cards, brand-blue glow, neon-style status dots. Operator console
// at night feel.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Users, Building2, Activity, ShoppingCart } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV04_DarkGlass() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill, confirmActiveToggleDialog } = useClientsData()

  return (
    <div
      id="view-clients"
      className="view-content !p-0 !overflow-y-auto flex flex-col relative"
      style={{
        background:
          'radial-gradient(ellipse at top, rgba(3,169,244,0.12), transparent 50%), radial-gradient(ellipse at bottom, rgba(124,58,237,0.08), transparent 60%), #0b1220',
      }}
    >
      {/* Subtle grid overlay — gives the dark background a "command deck" feel */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />

      <header className="relative flex-shrink-0 px-7 pt-7 pb-5 flex items-end justify-between gap-6 flex-wrap border-b border-white/5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] font-bold text-sky-400/80 mb-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]" />
            <span>Live · client roster</span>
          </div>
          <h1 className="text-[36px] leading-none tracking-[-0.025em] font-extrabold text-slate-100 m-0 font-display">
            Clients
          </h1>
          <p className="mt-2 text-[12.5px] text-slate-400 font-mono">{clients.length} brands · {clients.filter(c => c.active).length} active</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white/5 hover:bg-white/10 ring-1 ring-white/10 text-slate-200 text-[12px] font-semibold backdrop-blur disabled:opacity-50">
            <RefreshCw size={12} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? 'Syncing…' : 'Sync stores'}
          </button>
          <button type="button" onClick={() => navigate('/settings/store')} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-gradient-to-r from-sky-500 to-sky-600 hover:from-sky-400 hover:to-sky-500 text-white text-[12px] font-bold shadow-[0_0_20px_rgba(3,169,244,0.4)] transition-all">
            <Plus size={12} />
            New client
          </button>
        </div>
      </header>

      <div className="relative flex-1 min-h-0 overflow-auto px-7 py-6">
        {isLoading ? (
          <div className="text-center text-slate-400 py-12">Loading…</div>
        ) : clients.length === 0 ? (
          <div className="text-center text-slate-400 py-20">
            <Users size={32} className="mx-auto mb-3 opacity-40" />
            <div className="font-semibold text-slate-300">No clients yet</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
            {clients.map((c, idx) => {
              const s = statsByClient.get(c.id)
              return (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: Math.min(idx, 14) * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ y: -3 }}
                  className="group relative rounded-xl bg-white/[0.04] backdrop-blur-xl ring-1 ring-white/10 hover:ring-sky-400/40 hover:bg-white/[0.06] transition-all duration-200 p-4 overflow-hidden"
                  style={{ opacity: c.active ? 1 : 0.55 }}
                >
                  {/* Active-status corner accent (neon dot) */}
                  <div className="absolute top-3 right-3 inline-flex items-center gap-1.5">
                    <span className={`relative inline-block w-2 h-2 rounded-full ${c.active ? 'bg-emerald-400' : 'bg-slate-500'}`}>
                      {c.active ? <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-60" /> : null}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                      disabled={toggleActive.isPending}
                      className={`text-[9.5px] font-bold uppercase tracking-wider ${c.active ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'} transition`}
                    >
                      {c.active ? 'Live' : 'Paused'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <Activity size={11} className="text-sky-400" />
                    <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-slate-500">Client</span>
                  </div>
                  <h3 className="text-[18px] font-extrabold tracking-tight text-slate-100 truncate font-display m-0">{c.name}</h3>
                  {c.contactName ? <div className="mt-0.5 text-[11px] text-slate-400 truncate">{c.contactName}</div> : null}

                  {/* Stores ribbon */}
                  <div className="mt-3.5 flex items-center gap-1 flex-wrap">
                    <Building2 size={11} className="text-slate-500" />
                    {c.storeIds.length ? c.storeIds.map((sid) => (
                      <span key={sid} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-sky-400/10 text-sky-300 ring-1 ring-sky-400/20">{sid}</span>
                    )) : <span className="text-[11px] text-slate-500 italic">unlinked</span>}
                  </div>

                  {/* Big stat row */}
                  <div className="mt-4 pt-3 border-t border-white/5 grid grid-cols-3 gap-2">
                    <StatCell label="Awaiting" value={s?.awaiting ?? 0} tone="warn" />
                    <StatCell label="Shipped" value={s?.shipped ?? 0} tone="ok" />
                    <StatCell label="Cancelled" value={s?.cancelled ?? 0} tone="danger" />
                  </div>

                  <div className="mt-3 pt-3 border-t border-white/5 flex items-center gap-0.5">
                    <DarkBtn onClick={() => setEditing(c)}><Pencil size={11} />Edit</DarkBtn>
                    <DarkBtn disabled={!c.storeIds.length || backfill.isPending} onClick={() => backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) })}><Wand2 size={11} />Backfill</DarkBtn>
                    <div className="flex-1" />
                    <DarkBtn tone="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}><Trash2 size={11} /></DarkBtn>
                  </div>
                </motion.div>
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

      {confirmActiveToggleDialog}
    </div>
  )
}

function StatCell({ label, value, tone }: { label: string; value: number; tone: 'warn' | 'ok' | 'danger' }) {
  const colorMap = { warn: 'text-amber-400', ok: 'text-emerald-400', danger: 'text-rose-400' }
  return (
    <div className="text-center">
      <div className={`text-[20px] font-extrabold tabular-nums leading-none font-display ${value > 0 ? colorMap[tone] : 'text-slate-600'}`}>{value.toLocaleString()}</div>
      <div className="mt-1 text-[9px] uppercase tracking-[0.14em] font-bold text-slate-500">{label}</div>
    </div>
  )
}

function DarkBtn({ children, onClick, disabled, tone }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; tone?: 'danger' }) {
  const danger = tone === 'danger'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10.5px] font-bold transition ${danger ? 'text-rose-400 hover:bg-rose-500/10' : 'text-slate-300 hover:text-sky-300 hover:bg-sky-400/10'} disabled:opacity-30 disabled:cursor-not-allowed`}>
      {children}
    </button>
  )
}
