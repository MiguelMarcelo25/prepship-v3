// Variant 07 — Magazine Mosaic. Uneven tile grid with one hero
// tile (the most-active client) + asymmetric supporting tiles in a
// CSS Grid masonry-ish layout. Warm cream + tomato accents.
// @ts-nocheck
import { lazy, Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Star, Building2 } from 'lucide-react'
import { useClientsData, type Client } from './useClientsData'

const ClientModal = lazy(() => import('../../components/ClientModal'))

export default function ClientsV07_Mosaic() {
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Client | null>(null)
  const { clients, statsByClient, isLoading, sync, remove, toggleActive, backfill } = useClientsData()

  // Hero = client with highest total order count. Falls back to
  // first client if no stats yet.
  const hero = useMemo(() => {
    if (!clients.length) return null
    return [...clients].sort((a, b) => (statsByClient.get(b.id)?.total ?? 0) - (statsByClient.get(a.id)?.total ?? 0))[0]!
  }, [clients, statsByClient])
  const supporting = clients.filter((c) => c.id !== hero?.id)

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col" style={{ background: '#fef7e7' }}>
      <header className="flex-shrink-0 px-8 pt-8 pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.32em] text-rose-600 font-extrabold mb-2">Issue No. 01 · Brand Roster</div>
          <h1 className="text-[44px] leading-[0.95] font-extrabold tracking-[-0.03em] m-0" style={{ color: '#1f1f1f' }}>
            The <span className="italic font-semibold text-rose-600">Clients</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()} className="text-[12px] font-bold text-stone-700 hover:text-stone-900 underline underline-offset-4 decoration-stone-400 hover:decoration-rose-600 px-2 py-1">
            {sync.isPending ? 'Syncing…' : 'Sync stores'}
          </button>
          <button type="button" onClick={() => navigate('/settings/store')} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-[12px] font-bold transition">
            <Plus size={12} />
            New client
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-8 pt-2">
        {isLoading ? (
          <div className="text-center py-16 text-stone-400">Loading the issue…</div>
        ) : !hero ? (
          <div className="text-center py-16 text-stone-400 italic">No stories yet. Add a client to begin.</div>
        ) : (
          <div className="grid grid-cols-12 gap-3 auto-rows-[120px]">
            {/* HERO — spans 8 cols × 3 rows */}
            <motion.article
              key={hero.id}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="col-span-12 lg:col-span-8 row-span-3 relative rounded-2xl p-7 bg-gradient-to-br from-rose-600 to-orange-500 text-white overflow-hidden cursor-pointer group"
              onClick={() => setEditing(hero)}
            >
              <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-white/10 blur-2xl" />
              <div className="relative">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] font-extrabold text-white/80 mb-3">
                  <Star size={11} strokeWidth={2.5} fill="currentColor" />
                  Featured · top performer
                </div>
                <h2 className="text-[42px] font-extrabold tracking-[-0.025em] leading-[0.95] m-0 truncate">{hero.name}</h2>
                <div className="mt-3 text-[14px] text-white/85">{hero.contactName || '—'}</div>
                <div className="mt-6 flex items-baseline gap-8">
                  <BigStat label="Total orders" value={statsByClient.get(hero.id)?.total ?? 0} />
                  <BigStat label="Awaiting" value={statsByClient.get(hero.id)?.awaiting ?? 0} />
                  <BigStat label="Shipped" value={statsByClient.get(hero.id)?.shipped ?? 0} />
                </div>
              </div>
            </motion.article>

            {/* SUPPORTING tiles — varying sizes for editorial rhythm */}
            {supporting.map((c, i) => {
              const s = statsByClient.get(c.id)
              const sizeIndex = i % 4
              const sizeCls =
                sizeIndex === 0 ? 'col-span-12 sm:col-span-6 lg:col-span-4 row-span-3' :
                sizeIndex === 1 ? 'col-span-6 lg:col-span-4 row-span-2' :
                sizeIndex === 2 ? 'col-span-6 lg:col-span-4 row-span-2' :
                'col-span-12 lg:col-span-8 row-span-2'
              return (
                <motion.article
                  key={c.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: 0.05 + Math.min(i, 12) * 0.035, ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ y: -2 }}
                  className={`${sizeCls} relative rounded-2xl p-5 bg-white ring-1 ring-stone-200 hover:ring-stone-300 hover:shadow-lg transition-all cursor-pointer overflow-hidden`}
                  onClick={() => setEditing(c)}
                  style={{ opacity: c.active ? 1 : 0.6 }}
                >
                  <div className="absolute top-3 right-3 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleActive.mutate({ id: c.id, active: !c.active }) }}
                      disabled={toggleActive.isPending}
                      className={`inline-block w-2 h-2 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-stone-300'} hover:scale-150 transition-transform`}
                      title={c.active ? 'Active' : 'Inactive'}
                    />
                  </div>
                  <h3 className="text-[18px] sm:text-[22px] font-extrabold tracking-tight m-0 truncate" style={{ color: '#1f1f1f' }}>{c.name}</h3>
                  <div className="mt-1 text-[11px] text-stone-500 flex items-center gap-1">
                    <Building2 size={10} />
                    {c.storeIds.length} {c.storeIds.length === 1 ? 'store' : 'stores'}
                  </div>
                  <div className="mt-3 flex items-baseline gap-4 text-[11px]">
                    <span><span className="font-bold text-stone-900 tabular-nums">{s?.awaiting ?? 0}</span> <span className="text-amber-600">awaiting</span></span>
                    <span><span className="font-bold text-stone-900 tabular-nums">{s?.shipped ?? 0}</span> <span className="text-emerald-600">shipped</span></span>
                  </div>
                  <div className="absolute bottom-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.name}"?`)) remove.mutate(c.id) }}
                      disabled={remove.isPending}
                      title="Delete"
                      className="w-6 h-6 inline-flex items-center justify-center rounded text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition"
                    >
                      <Trash2 size={11} />
                    </button>
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
    </div>
  )
}

function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[36px] font-extrabold leading-none tabular-nums tracking-tight">{value.toLocaleString()}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.2em] font-bold text-white/70">{label}</div>
    </div>
  )
}
