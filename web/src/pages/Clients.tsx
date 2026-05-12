import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plus,
  Pencil,
  Trash2,
  Wand2,
  RefreshCw,
  Search,
  Users,
  Building2,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

// ──────────────────────────────────────────────────────────────────
// Clients page — "Editorial Operator Portfolio" redesign 2026-05-12
//
// The previous design was a generic 3-column CRUD card grid. This
// rebuild treats the page as the operator's brand portfolio — each
// client is rendered like a profile feature, not a database row.
//
// Aesthetic anchors:
//   - Warm cream background (#fbf8f3) with a faint grain overlay so
//     the page feels like a thick paper portfolio, not a SaaS card
//   - Deterministic monogram colors hashed from client name — same
//     client always wears the same color across reloads, so the
//     operator builds spatial recognition
//   - Big numbers as visual anchors (aggregate stats strip + per-
//     card order counts) — fulfillment is a numbers business; lead
//     with the numbers
//   - Asymmetric page header with an editorial tagline + actions
//     cluster, sitting above an aggregate-stats strip
//   - Subtle motion: stagger-fade cascade on mount (40ms/card),
//     hover lifts -2px with intensified accent ring
//   - System font stack only (boss directive 2026-05-08 forbids
//     custom webfonts) — character comes from composition + scale
//     + spacing, not font choice
//
// Mounted INSIDE Home.tsx's shell (sidebar + topbar) — see
// displayView === 'clients' in Home and the lazy import there.
// ──────────────────────────────────────────────────────────────────

const ClientModal = lazy(() => import('../components/ClientModal'));

type Client = {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  storeIds: number[];
};

type ClientStats = {
  clientId: number;
  total: number;
  awaiting: number;
  shipped: number;
  cancelled: number;
  onHold: number;
  other: number;
};

type BackfillResult = { updated: number; message?: string };

// 8-color monogram palette. djb2-style hash maps client name → index
// so the same brand always carries the same color regardless of
// alphabetical position or sort order. These are paired so the
// monogram circle (richer hue) and the card-tint glow (paler hue)
// share the same color family — visual coherence per client.
const MONOGRAM_PALETTE = [
  { ring: '#0d9488', tint: 'rgba(13, 148, 136, 0.06)' },   // teal
  { ring: '#7c3aed', tint: 'rgba(124, 58, 237, 0.06)' },   // violet
  { ring: '#dc2626', tint: 'rgba(220, 38, 38, 0.05)' },    // rose
  { ring: '#d97706', tint: 'rgba(217, 119, 6, 0.06)' },    // amber
  { ring: '#0284c7', tint: 'rgba(2, 132, 199, 0.06)' },    // sky
  { ring: '#16a34a', tint: 'rgba(22, 163, 74, 0.06)' },    // emerald
  { ring: '#db2777', tint: 'rgba(219, 39, 119, 0.06)' },   // pink
  { ring: '#475569', tint: 'rgba(71, 85, 105, 0.06)' },    // slate
] as const;

function monogramFor(name: string) {
  // djb2 hash — fast, stable, no external deps. Modulo palette length.
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % MONOGRAM_PALETTE.length;
  // First two non-space, non-punct uppercase chars — gives "DR" for
  // "DR Prepper", "WS" for "Walmart Store", "EB" for "eBay - DJC".
  // Falls back to first 1-2 letters if no good initials available.
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  let initials = '';
  // .charAt(0) returns '' on out-of-bounds (vs [0] which is
  // `string | undefined` under noUncheckedIndexedAccess) — keeps
  // the type narrow without `!` everywhere.
  if (cleaned.length >= 2) initials = (cleaned[0]!.charAt(0) + cleaned[1]!.charAt(0)).toUpperCase();
  else if (cleaned[0]) initials = cleaned[0].slice(0, 2).toUpperCase();
  else initials = '??';
  return { ...MONOGRAM_PALETTE[idx]!, initials };
}

export default function Clients() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // `editing` is the only modal trigger now — the "+ New client"
  // button navigates to /settings/store (where store integrations
  // are configured) instead of opening an in-page create form.
  // The modal is reused for the per-row Edit action.
  const [editing, setEditing] = useState<Client | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['clients', 'admin'],
    queryFn: () => api.get<Client[]>('/clients?includeInactive=true'),
  });

  const stats = useQuery({
    queryKey: ['clients-order-stats', 'admin'],
    queryFn: () => api.get<{ data: ClientStats[] }>('/clients/order-stats?includeInactive=true'),
  });
  const statsByClient = useMemo(
    () => new Map<number, ClientStats>((stats.data?.data ?? []).map((s) => [s.clientId, s])),
    [stats.data]
  );

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/clients/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients', 'admin'] });
    },
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      api.patch<Client>(`/clients/${id}`, { active }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['clients', 'admin'] });
      const previous = queryClient.getQueryData<Client[]>(['clients', 'admin']);
      queryClient.setQueryData<Client[]>(['clients', 'admin'], (current) =>
        current?.map((client) => (client.id === id ? { ...client, active } : client))
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      const previous = (context as { previous?: Client[] } | undefined)?.previous;
      if (previous) queryClient.setQueryData(['clients', 'admin'], previous);
      alert(`Active toggle failed: ${(err as Error).message}`);
    },
    onSuccess: (client) => {
      window.dispatchEvent(
        new CustomEvent('prepship:client-active-changed', {
          detail: { clientId: client.id, active: client.active },
        })
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['clients', 'admin'] });
      queryClient.invalidateQueries({ queryKey: ['clients-order-stats'] });
      queryClient.invalidateQueries({ queryKey: ['clients-order-stats', 'admin'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
      queryClient.invalidateQueries({ queryKey: ['v2-hooks:clients'] });
      queryClient.invalidateQueries({ queryKey: ['v2-hooks:orders'] });
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['billing-config'] });
      queryClient.invalidateQueries({ queryKey: ['billing-summary'] });
      queryClient.invalidateQueries({ queryKey: ['analysis-sku-breakdown'] });
      queryClient.invalidateQueries({ queryKey: ['analysis-sku-daily'] });
    },
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ inserted: number; updated: number; message: string }>(
        '/clients/sync-stores',
        {}
      ),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      alert(r.message);
    },
    onError: (err) => alert(`Sync failed: ${(err as Error).message}`),
  });

  const backfill = useMutation({
    mutationFn: (args: { id: number; overwrite: boolean }) =>
      api.post<BackfillResult>(
        `/clients/${args.id}/backfill-orders${args.overwrite ? '?overwrite=true' : ''}`,
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
    },
  });

  const rows = data ?? [];

  // Aggregate KPIs for the hero strip. Computed once from the rows
  // + stats map; cheap enough to not memoize aggressively.
  const kpis = useMemo(() => {
    const totalClients = rows.length;
    const activeClients = rows.filter((c) => c.active).length;
    let awaiting = 0;
    let shipped = 0;
    for (const c of rows) {
      const s = statsByClient.get(c.id);
      if (!s) continue;
      awaiting += s.awaiting;
      shipped += s.shipped;
    }
    return { totalClients, activeClients, awaiting, shipped };
  }, [rows, statsByClient]);

  // Filter + search applied to the rendered grid (not the KPIs, so
  // the strip always shows true totals regardless of filter state).
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((c) => {
      if (statusFilter === 'active' && !c.active) return false;
      if (statusFilter === 'inactive' && c.active) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.contactName ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        c.storeIds.some((id) => String(id).includes(q))
      );
    });
  }, [rows, search, statusFilter]);

  return (
    <div
      id="view-clients"
      className="view-content !p-0 !overflow-y-auto flex flex-col"
      style={{
        // Warm cream paper background with a faint twin-radial mesh
        // for atmosphere. The radials are deliberately off-center
        // and unequally sized to break the "centered SaaS gradient"
        // cliché — feels like a portfolio cover, not a dashboard.
        background:
          'radial-gradient(circle at 12% 8%, rgba(3, 169, 244, 0.06), transparent 45%), radial-gradient(circle at 88% 92%, rgba(217, 119, 6, 0.05), transparent 55%), #fbf8f3',
      }}
    >
      {/* Faint grain overlay — SVG noise filter rendered as a tiled
          inline data-URL. Adds the "paper texture" without an image
          request. pointer-events:none so it never intercepts clicks. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-multiply"
        style={{
          backgroundImage:
            'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'><filter id=\'n\'><feTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'3\' stitchTiles=\'stitch\'/></filter><rect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/></svg>")',
          backgroundSize: '120px 120px',
        }}
      />

      {/* ─── EDITORIAL HEADER ───────────────────────────────────
          Asymmetric: left column is a stacked editorial title
          (label / display / paragraph), right column is the action
          cluster. The horizontal rule underneath spans the full
          width and acts as a magazine-style under-bar. */}
      <header className="relative flex-shrink-0 px-8 pt-9 pb-6">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex-1 min-w-0 max-w-2xl">
            <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.22em] font-bold text-ink-3 mb-3">
              <span className="inline-block h-px w-7 bg-ink-3" />
              <span>PrepShip · Brand Roster</span>
            </div>
            <h1 className="text-[44px] sm:text-[52px] leading-[0.95] tracking-[-0.035em] font-extrabold text-ink m-0 font-display">
              Your <span className="italic font-semibold text-brand">clients</span>,
              <br />
              at a glance.
            </h1>
            <p className="mt-4 text-[13.5px] leading-relaxed text-ink-2 max-w-xl">
              Every brand whose orders flow through PrepShip. Each card carries the
              client's live order load, store integrations, and the on/off switch
              that gates whether their orders sync.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              title="Pull stores from ShipStation as clients"
            >
              <RefreshCw size={12} className={sync.isPending ? 'animate-spin' : ''} />
              {sync.isPending ? 'Syncing…' : 'Sync from ShipStation'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => navigate('/settings/store')}
              title="Create a new client by adding a store integration"
            >
              <Plus size={12} />
              New client
            </Button>
          </div>
        </div>

        {/* Aggregate KPI strip — runs below the title, separated by
            a hairline. Numbers are the visual anchor; labels live
            quietly above in small uppercase. Vertical dividers
            structure the row magazine-style. */}
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-0 border-t border-line/80 pt-6">
          <KpiCell
            label="Total clients"
            value={kpis.totalClients}
            sublabel={
              kpis.activeClients === kpis.totalClients
                ? 'all active'
                : `${kpis.activeClients} active`
            }
          />
          <KpiCell
            label="Active brands"
            value={kpis.activeClients}
            sublabel={
              kpis.totalClients === 0
                ? '—'
                : `${Math.round((kpis.activeClients / kpis.totalClients) * 100)}% of roster`
            }
            divider
          />
          <KpiCell
            label="Awaiting"
            value={kpis.awaiting}
            sublabel="across all clients"
            divider
            valueTone="warn"
          />
          <KpiCell
            label="Shipped"
            value={kpis.shipped}
            sublabel="lifetime"
            divider
            valueTone="ok"
          />
        </div>
      </header>

      {/* ─── FILTER ROW ─────────────────────────────────────────
          Search input + status filter chips. Sits in its own
          horizontal strip with a top/bottom hairline so it reads
          as a tools-row, not part of the header. */}
      <div className="relative flex-shrink-0 px-8 py-3 border-y border-line/70 bg-white/60 backdrop-blur-sm flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
            strokeWidth={2.25}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients, contacts, store IDs…"
            className="w-full h-9 pl-9 pr-3 rounded-full ring-1 ring-line/80 bg-white/90 text-[13px] text-ink placeholder:text-ink-3 focus:ring-2 focus:ring-brand/40 focus:outline-none transition-shadow"
          />
        </div>
        <div className="inline-flex items-center gap-1 p-0.5 rounded-full bg-surface-2 ring-1 ring-line/60">
          {(['all', 'active', 'inactive'] as const).map((f) => {
            const isActive = statusFilter === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition ${
                  isActive
                    ? 'bg-ink text-white shadow-sm'
                    : 'text-ink-2 hover:text-ink hover:bg-white/60'
                }`}
              >
                {f}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-ink-3 ml-auto tabular-nums">
          {filteredRows.length === rows.length
            ? `${rows.length} total`
            : `${filteredRows.length} of ${rows.length}`}
        </div>
      </div>

      {/* ─── BODY — CARD GRID ───────────────────────────────────
          Each card is a refined editorial profile, not a CRUD row.
          Stagger-fade entrance with 40ms cascade. */}
      <div className="relative flex-1 min-h-0 overflow-auto px-8 py-6">
        {isLoading ? (
          <LoadingState />
        ) : filteredRows.length === 0 ? (
          <EmptyState
            isFiltered={rows.length > 0}
            onClearFilter={() => {
              setSearch('');
              setStatusFilter('all');
            }}
            onCreate={() => navigate('/settings/store')}
          />
        ) : (
          <motion.div
            // Stable layout container — Framer Motion auto-animates
            // children entering/leaving (e.g. when search filters).
            layout
            className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
          >
            <AnimatePresence mode="popLayout">
              {filteredRows.map((c, idx) => (
                <ClientCard
                  key={c.id}
                  client={c}
                  index={idx}
                  stats={statsByClient.get(c.id)}
                  onEdit={() => setEditing(c)}
                  onToggleActive={() =>
                    toggleActive.mutate({ id: c.id, active: !c.active })
                  }
                  togglePending={toggleActive.isPending}
                  onBackfill={() =>
                    backfill.mutate(
                      { id: c.id, overwrite: false },
                      {
                        onSuccess: (res) =>
                          alert(res.message ?? `Assigned ${res.updated} orders`),
                        onError: (err) =>
                          alert(`Backfill failed: ${(err as Error).message}`),
                      }
                    )
                  }
                  backfillPending={backfill.isPending}
                  onDelete={() => {
                    if (
                      confirm(
                        `Delete client "${c.name}"? This also deletes their billing config and line items.`
                      )
                    ) {
                      remove.mutate(c.id);
                    }
                  }}
                  removePending={remove.isPending}
                />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {editing ? (
        <Suspense fallback={null}>
          <ClientModal
            existing={editing}
            onClose={() => setEditing(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// KPI cell for the aggregate strip. Big number, small label.
// `divider` adds a left-edge vertical hairline to structure the row
// magazine-style. `valueTone` tints the number for warn/ok contexts.
// ──────────────────────────────────────────────────────────────────
function KpiCell({
  label,
  value,
  sublabel,
  divider,
  valueTone,
}: {
  label: string;
  value: number;
  sublabel?: string;
  divider?: boolean;
  valueTone?: 'warn' | 'ok';
}) {
  const valueColor =
    valueTone === 'warn' ? 'text-[#92400e]' : valueTone === 'ok' ? 'text-ok-dark' : 'text-ink';
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={`px-5 ${divider ? 'border-l border-line/60' : ''}`}
    >
      <div className="text-[10.5px] uppercase tracking-[0.18em] font-bold text-ink-3 mb-2">
        {label}
      </div>
      <div className={`text-[34px] leading-none font-extrabold tabular-nums tracking-[-0.02em] ${valueColor} font-display`}>
        {value.toLocaleString()}
      </div>
      {sublabel ? (
        <div className="mt-1.5 text-[11px] text-ink-3 italic">{sublabel}</div>
      ) : null}
    </motion.div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Individual client card. The visual centerpiece of the page.
// Monogram color is deterministic by client name; same brand always
// gets the same color so the operator builds spatial recognition.
// ──────────────────────────────────────────────────────────────────
function ClientCard({
  client,
  index,
  stats,
  onEdit,
  onToggleActive,
  togglePending,
  onBackfill,
  backfillPending,
  onDelete,
  removePending,
}: {
  client: Client;
  index: number;
  stats: ClientStats | undefined;
  onEdit: () => void;
  onToggleActive: () => void;
  togglePending: boolean;
  onBackfill: () => void;
  backfillPending: boolean;
  onDelete: () => void;
  removePending: boolean;
}) {
  const m = monogramFor(client.name);
  const total = stats?.total ?? 0;
  const segments = stats
    ? [
        { key: 'awaiting' as const, count: stats.awaiting, color: '#d97706', label: 'Awaiting' },
        { key: 'shipped' as const, count: stats.shipped, color: '#16a34a', label: 'Shipped' },
        { key: 'cancelled' as const, count: stats.cancelled, color: '#dc2626', label: 'Cancelled' },
        { key: 'onHold' as const, count: stats.onHold, color: '#64748b', label: 'On hold' },
      ].filter((s) => s.count > 0)
    : [];
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        duration: 0.4,
        delay: Math.min(index, 18) * 0.04,
        ease: [0.22, 1, 0.36, 1],
      }}
      whileHover={{ y: -2 }}
      className="group relative rounded-2xl bg-white/95 backdrop-blur-sm ring-1 ring-line/70 hover:ring-line shadow-[0_1px_3px_rgba(15,23,42,0.04),0_4px_12px_-6px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_28px_-8px_rgba(15,23,42,0.16)] transition-all duration-200 overflow-hidden"
      style={{
        // Brand-tinted radial glow at the top edge — picks up the
        // monogram color so each card gets its own ambient hue.
        backgroundImage: `radial-gradient(circle at 8% 0%, ${m.tint}, transparent 55%)`,
        opacity: client.active ? 1 : 0.7,
      }}
    >
      {/* Inactive state ribbon — diagonal mark across the top-right
          corner so muted clients are visually obvious without
          shouting. Only renders when inactive. */}
      {!client.active ? (
        <div
          aria-hidden
          className="absolute top-3 -right-8 rotate-45 bg-ink-3/15 text-ink-3 text-[9px] font-extrabold uppercase tracking-[0.2em] px-10 py-0.5 select-none"
        >
          Inactive
        </div>
      ) : null}

      <div className="p-5">
        {/* TOP ROW: monogram + name + active toggle */}
        <div className="flex items-start gap-3.5">
          <div
            className="flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-white text-[14px] font-extrabold tracking-tight font-display shadow-md"
            style={{
              background: `linear-gradient(135deg, ${m.ring}, ${shadeColor(m.ring, -15)})`,
              boxShadow: `0 2px 8px -2px ${m.ring}40, inset 0 1px 0 rgba(255,255,255,0.18)`,
            }}
            aria-hidden
          >
            {m.initials}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[18px] font-extrabold tracking-[-0.018em] text-ink leading-tight truncate font-display m-0">
              {client.name}
            </h3>
            <div className="mt-0.5 text-[11px] text-ink-3 truncate">
              {client.contactName || 'No contact set'}
            </div>
          </div>
          <button
            type="button"
            aria-pressed={client.active}
            disabled={togglePending}
            aria-label={`${client.active ? 'Deactivate' : 'Activate'} ${client.name}`}
            title={client.active ? 'Deactivate client' : 'Activate client'}
            onClick={onToggleActive}
            className={`group/toggle inline-flex items-center gap-1.5 rounded-full px-2 py-1 ring-1 transition-all ${
              client.active
                ? 'bg-ok-bg text-ok-dark ring-ok/25 hover:ring-ok/50'
                : 'bg-surface-2 text-ink-3 ring-line hover:text-ink-2'
            } disabled:opacity-60 disabled:cursor-wait`}
          >
            <span
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition ${
                client.active ? 'bg-ok' : 'bg-line-2'
              }`}
            >
              <span
                className={`absolute h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
                  client.active ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
            <span className="text-[9.5px] font-extrabold uppercase tracking-wider">
              {client.active ? 'Active' : 'Inactive'}
            </span>
          </button>
        </div>

        {/* CONTACT META — only renders rows that have data, so cards
            with sparse info don't show a column of "—" placeholders. */}
        {(client.email || client.phone) ? (
          <div className="mt-3 pl-[60px] text-[11.5px] text-ink-2 space-y-0.5 truncate">
            {client.email ? <div className="font-mono truncate">{client.email}</div> : null}
            {client.phone ? <div className="font-mono truncate">{client.phone}</div> : null}
          </div>
        ) : null}

        {/* STORE CHIPS — small mono chips with a Building2 icon prefix.
            Wraps freely; clients with many stores extend the card. */}
        <div className="mt-4 flex items-center gap-1.5 flex-wrap pl-[60px]">
          <Building2 size={11} strokeWidth={2.5} className="text-ink-3 flex-shrink-0" />
          {client.storeIds.length > 0 ? (
            client.storeIds.map((sid) => (
              <span
                key={sid}
                className="font-mono text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-surface-2 text-ink-2 ring-1 ring-line/70"
                title={`ShipStation store ID ${sid}`}
              >
                {sid}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-ink-3 italic">no stores linked</span>
          )}
        </div>

        {/* ORDER STATS — visual centerpiece. Horizontal stacked bar
            with proportional segments, labels below in small mono.
            Operators see imbalance at a glance: lots of orange means
            "awaiting load piling up." Replaces the previous CountPill
            row which read as info-dense but undifferentiated. */}
        <div className="mt-5 pt-4 border-t border-line/60">
          {total === 0 ? (
            <div className="text-[11.5px] text-ink-3 italic">No orders assigned yet</div>
          ) : (
            <>
              <div className="flex items-center justify-between text-[10.5px] uppercase tracking-[0.14em] font-bold text-ink-3 mb-2">
                <span>Order load</span>
                <span className="font-mono text-ink-2 tabular-nums normal-case tracking-normal">
                  {total.toLocaleString()} total
                </span>
              </div>
              <div className="h-2 rounded-full bg-surface-2 overflow-hidden flex">
                {segments.map((s) => (
                  <motion.div
                    key={s.key}
                    initial={{ width: 0 }}
                    animate={{ width: `${(s.count / total) * 100}%` }}
                    transition={{ duration: 0.6, delay: 0.1 + index * 0.02, ease: [0.22, 1, 0.36, 1] }}
                    className="h-full"
                    style={{ background: s.color }}
                    title={`${s.label}: ${s.count.toLocaleString()}`}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-center gap-3 flex-wrap text-[10.5px]">
                {segments.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5 text-ink-2 font-mono tabular-nums">
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: s.color }}
                      aria-hidden
                    />
                    <span>
                      {s.count.toLocaleString()}{' '}
                      <span className="text-ink-3 font-sans normal-case">
                        {s.label.toLowerCase()}
                      </span>
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ACTIONS — quiet by default, reveal on hover. Bottom-anchored
            so cards stay aligned regardless of contact/store density. */}
        <div className="mt-4 pt-3 border-t border-line/60 flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-bold text-ink-2 hover:text-brand hover:bg-brand/8 transition"
          >
            <Pencil size={11} strokeWidth={2.25} />
            Edit
          </button>
          <button
            type="button"
            disabled={!client.storeIds.length || backfillPending}
            onClick={onBackfill}
            title={
              !client.storeIds.length
                ? 'Add at least one storeId first'
                : 'Assign matching unassigned orders to this client'
            }
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-bold text-ink-2 hover:text-brand hover:bg-brand/8 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <Wand2 size={11} strokeWidth={2.25} />
            Backfill
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onDelete}
            disabled={removePending}
            title={`Delete ${client.name}`}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-3 hover:text-danger hover:bg-danger/8 disabled:opacity-40 transition"
          >
            <Trash2 size={11} strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </motion.article>
  );
}

// ──────────────────────────────────────────────────────────────────
// Loading skeleton — six placeholder cards with shimmer animation.
// Matches the real card's overall shape so the layout doesn't
// reflow when data arrives.
// ──────────────────────────────────────────────────────────────────
function LoadingState() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl bg-white/80 ring-1 ring-line/70 p-5 animate-pulse"
          style={{ animationDelay: `${i * 60}ms` }}
        >
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-surface-2" />
            <div className="flex-1 space-y-1.5">
              <div className="h-4 w-2/3 rounded bg-surface-2" />
              <div className="h-3 w-1/2 rounded bg-surface-2" />
            </div>
          </div>
          <div className="mt-5 h-2 rounded-full bg-surface-2" />
          <div className="mt-4 flex gap-2">
            <div className="h-7 w-16 rounded bg-surface-2" />
            <div className="h-7 w-20 rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Empty state — two flavors: "no clients yet" and "filter returned
// nothing." Different copy + different CTA per flavor.
// ──────────────────────────────────────────────────────────────────
function EmptyState({
  isFiltered,
  onClearFilter,
  onCreate,
}: {
  isFiltered: boolean;
  onClearFilter: () => void;
  onCreate: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="max-w-md mx-auto text-center py-20"
    >
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white ring-1 ring-line shadow-sm mb-4">
        <Users size={28} strokeWidth={1.75} className="text-ink-3" />
      </div>
      <h3 className="text-[22px] font-extrabold text-ink font-display tracking-[-0.02em] m-0">
        {isFiltered ? 'No matches' : 'No clients yet'}
      </h3>
      <p className="mt-2 text-[13px] text-ink-2 leading-relaxed">
        {isFiltered
          ? 'Try a different search term or status filter, or clear the filter to see your full roster.'
          : 'Each brand whose orders flow through PrepShip is a client. Add your first one to start configuring marketplace store integrations.'}
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        {isFiltered ? (
          <Button variant="outline" size="sm" onClick={onClearFilter}>
            Clear filters
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onCreate}>
            <Plus size={12} />
            Add your first client
          </Button>
        )}
      </div>
    </motion.div>
  );
}

// Lighten/darken a hex color by a percentage. Used for the monogram
// gradient — produces a darker shade for the gradient's bottom-right
// stop so each monogram has subtle depth without per-color tuning.
function shadeColor(hex: string, percent: number) {
  const m = hex.replace('#', '').match(/.{1,2}/g);
  if (!m || m.length < 3) return hex;
  const [r, g, b] = m.slice(0, 3).map((c) => parseInt(c, 16));
  const adjust = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel + (channel * percent) / 100)));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(adjust(r!))}${toHex(adjust(g!))}${toHex(adjust(b!))}`;
}
