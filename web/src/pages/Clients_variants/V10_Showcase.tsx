// Variant 10 — Showcase Hero. Each client gets a large feature
// card with massive stat numbers. 2-col grid (1 on mobile). The
// emphasis is on revenue/volume — fulfillment dashboard for
// agency owners. Cream + violet accent palette.
// @ts-nocheck
import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Activity, Building2, TrendingUp } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV10_Showcase() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill, confirmActiveToggleDialog } = useClientsData()

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col" style={{ background: '#fffbeb' }}>
      <header className="flex-shrink-0 px-8 pt-9 pb-6 border-b border-amber-200/60">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-[0.35em] font-extrabold text-violet-600 mb-2">Brand Showcase</div>
            <h1 className="text-[40px] sm:text-[48px] leading-none tracking-[-0.025em] font-extrabold m-0" style={{ color: '#1e1b4b' }}>
              Your client roster.
            </h1>
            <p className="mt-3 text-[13px] text-amber-900/70 max-w-lg">Every brand, headlined. The bigger the number, the bigger the relationship.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-white hover:bg-amber-50 ring-1 ring-amber-300 text-amber-900 text-[12px] font-bold transition">
              <RefreshCw size={11} className={sync.isPending ? 'animate-spin' : ''} />
              {sync.isPending ? 'Syncing…' : 'Sync stores'}
            </button>
            <button type="button" onClick={() => navigate('/settings/store')} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-violet-600 hover:bg-violet-700 text-white text-[12px] font-bold transition shadow-md shadow-violet-600/20">
              <Plus size={12} />
              New client
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-8 py-7">
        {isLoading ? (
          <div className="text-center py-16 text-amber-900/40">Loading showcase…</div>
        ) : clients.length === 0 ? (
          <div className="text-center py-16 text-amber-900/40 italic">No clients to showcase yet.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-7xl mx-auto">
            {clients.map((c, i) => {
              const s = statsByClient.get(c.id)
              const total = s?.total ?? 0
              const ratio = total === 0 ? 0 : (s?.shipped ?? 0) / total
              const progressPct = Math.round(ratio * 100)
              return (
                <motion.article
                  key={c.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: Math.min(i, 10) * 0.05, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ y: -3 }}
                  className="relative bg-white rounded-3xl ring-1 ring-amber-200/80 hover:ring-violet-300 shadow-[0_4px_24px_-8px_rgba(124,58,237,0.08)] hover:shadow-[0_8px_36px_-12px_rgba(124,58,237,0.25)] transition-all duration-300 p-7 overflow-hidden cursor-pointer group"
                  style={{ opacity: c.active ? 1 : 0.55 }}
                  onClick={() => setEditing(c)}
                >
                  {/* Hero monogram band — violet wash at the top edge */}
                  <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-violet-500 via-amber-400 to-violet-500" />

                  {/* Header row */}
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Building2 size={13} className="text-violet-600 flex-shrink-0" />
                      <div className="text-[10px] uppercase tracking-[0.22em] font-extrabold text-violet-700">{c.storeIds.length} store{c.storeIds.length === 1 ? '' : 's'}</div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleActive.mutate({ id: c.id, active: !c.active }) }}
                      disabled={toggleActive.isPending}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ring-1 text-[10px] font-extrabold uppercase tracking-wider transition ${c.active ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 ring-slate-300 hover:bg-slate-200'}`}
                    >
                      <Activity size={9} strokeWidth={2.5} />
                      {c.active ? 'Live' : 'Paused'}
                    </button>
                  </div>

                  {/* Brand name — XL display */}
                  <h2 className="text-[32px] sm:text-[38px] font-extrabold tracking-[-0.025em] leading-[0.98] truncate m-0" style={{ color: '#1e1b4b' }}>
                    {c.name}
                  </h2>
                  {c.contactName ? <div className="mt-1 text-[12.5px] text-amber-900/60">{c.contactName}</div> : null}

                  {/* HERO STAT ROW — three big numbers */}
                  <div className="mt-7 grid grid-cols-3 gap-5">
                    <ShowcaseStat label="Total" value={total} color="text-violet-700" />
                    <ShowcaseStat label="Awaiting" value={s?.awaiting ?? 0} color="text-amber-600" />
                    <ShowcaseStat label="Shipped" value={s?.shipped ?? 0} color="text-emerald-600" />
                  </div>

                  {/* Fulfillment progress ring expressed as a horizontal bar */}
                  {total > 0 ? (
                    <div className="mt-5 pt-5 border-t border-amber-100">
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] font-bold text-amber-900/60 mb-2">
                        <span><TrendingUp size={10} className="inline mr-1" />Fulfillment rate</span>
                        <span className="font-mono text-[12px] tabular-nums text-emerald-700 normal-case tracking-normal">{progressPct}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-amber-100 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${progressPct}%` }}
                          transition={{ duration: 0.9, delay: 0.2 + i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                          className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400"
                        />
                      </div>
                    </div>
                  ) : null}

                  {/* Hover-revealed action row */}
                  <div className="mt-5 pt-4 border-t border-amber-100 flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
                    <ShowcaseBtn onClick={(e) => { e.stopPropagation(); setEditing(c) }}><Pencil size={11} />Edit profile</ShowcaseBtn>
                    <ShowcaseBtn disabled={!c.storeIds.length || backfill.isPending} onClick={(e) => { e.stopPropagation(); backfill.mutate({ id: c.id, overwrite: false }, { onSuccess: (r) => alert(r.message ?? `Assigned ${r.updated}`), onError: (e) => alert(`Backfill failed: ${(e as Error).message}`) }) }}><Wand2 size={11} />Backfill orders</ShowcaseBtn>
                    <div className="flex-1" />
                    <ShowcaseBtn tone="danger" disabled={remove.isPending} onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}><Trash2 size={11} /></ShowcaseBtn>
                  </div>
                </motion.article>
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

function ShowcaseStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className={`text-[36px] sm:text-[42px] font-extrabold leading-none tabular-nums tracking-[-0.02em] ${value > 0 ? color : 'text-amber-900/25'}`}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 text-[10px] uppercase tracking-[0.18em] font-bold text-amber-900/55">{label}</div>
    </div>
  )
}

function ShowcaseBtn({ children, onClick, disabled, tone }: { children: React.ReactNode; onClick: (e: any) => void; disabled?: boolean; tone?: 'danger' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[11px] font-bold transition ${tone === 'danger' ? 'text-rose-500 hover:text-rose-600 hover:bg-rose-50' : 'text-amber-900/80 hover:text-violet-700 hover:bg-violet-50'} disabled:opacity-30 disabled:cursor-not-allowed`}>
      {children}
    </button>
  )
}
