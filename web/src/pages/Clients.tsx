import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Wand2, RefreshCw, Users, Power } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

// Clients page is mounted INSIDE Home.tsx's app shell (sidebar +
// topbar) — see Home.tsx displayView === 'clients' and the routing
// comment in App.tsx. We deliberately don't render `<Topbar>` from
// this file anymore; Home's topbar already provides the app chrome.
// The Sync stores + New client buttons live in a page sub-header
// just above the cards, similar to other in-shell pages.

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

export default function Clients() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['clients', 'admin'],
    queryFn: () => api.get<Client[]>('/clients?includeInactive=true'),
  });

  const stats = useQuery({
    queryKey: ['clients-order-stats', 'admin'],
    queryFn: () => api.get<{ data: ClientStats[] }>('/clients/order-stats?includeInactive=true'),
  });
  const statsByClient = new Map<number, ClientStats>(
    (stats.data?.data ?? []).map((s) => [s.clientId, s])
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
      if (previous) {
        queryClient.setQueryData(['clients', 'admin'], previous);
      }
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

  return (
    <div id="view-clients" className="view-content !p-0 !overflow-y-auto flex flex-col">
      {/* Sub-header inside the page — sits below Home's topbar and
       * gives the page its own title row plus the Sync / New-client
       * actions. Same visual treatment as Home's topbar (white bg,
       * border-b, h matches Home's h-14) so the two stack as a
       * cohesive multi-level header instead of looking redundant. */}
      <div className="flex items-center gap-3 px-5 h-14 bg-surface border-b border-line flex-shrink-0">
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-brand to-brand-dark flex items-center justify-center shadow-sm ring-1 ring-brand/30 flex-shrink-0">
          <Users size={16} strokeWidth={2.25} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-extrabold text-ink font-display tracking-tight m-0 leading-none">
            Clients
          </h2>
          <p className="text-[11px] text-ink-3 mt-1 leading-none">
            Brands &amp; stores · per-tenant billing &amp; ShipStation isolation
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
          title="Pull stores from ShipStation as clients"
        >
          <RefreshCw
            size={12}
            className={sync.isPending ? 'animate-spin' : ''}
          />
          {sync.isPending ? 'Syncing…' : 'Sync stores'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreating(true)}
        >
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
            <div className="text-xs mt-1">
              Add your first client. Clients are needed for per-tenant billing
              and ShipStation account isolation.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((c) => (
              <div
                key={c.id}
                className="bg-white rounded-card border border-line shadow-sm p-3.5 flex flex-col gap-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-bold text-ink truncate">{c.name}</div>
                  <button
                    type="button"
                    aria-pressed={c.active}
                    disabled={toggleActive.isPending}
                    aria-label={`${c.active ? 'Deactivate' : 'Activate'} ${c.name}`}
                    title={c.active ? 'Deactivate client' : 'Activate client'}
                    onClick={() => toggleActive.mutate({ id: c.id, active: !c.active })}
                    className={`inline-flex items-center gap-2 rounded-full shrink-0 ring-1 px-1.5 py-1 pr-2.5 text-[10px] font-extrabold uppercase transition shadow-sm ${
                      c.active
                        ? 'bg-ok-bg text-ok-dark ring-ok/25 hover:bg-ok-bg/80'
                        : 'bg-surface-3 text-ink-3 ring-line hover:text-ink-2 hover:bg-surface-2'
                    } disabled:opacity-60 disabled:cursor-wait`}
                  >
                    <span
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                        c.active ? 'bg-ok' : 'bg-line-2'
                      }`}
                    >
                      <span
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-sm transition ${
                          c.active ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      >
                        <Power
                          size={9}
                          strokeWidth={2.6}
                          className={c.active ? 'text-ok-dark' : 'text-ink-3'}
                        />
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
                      <span
                        key={sid}
                        className="text-tiny font-mono px-1.5 py-0.5 rounded bg-surface-3 text-ink-2"
                      >
                        {sid}
                      </span>
                    ))
                  ) : (
                    <span className="text-tiny text-ink-3 italic">
                      none linked
                    </span>
                  )}
                </div>

                {(() => {
                  const s = statsByClient.get(c.id);
                  if (!s)
                    return (
                      <div className="text-tiny text-ink-3 italic">
                        No orders assigned
                      </div>
                    );
                  return (
                    <div className="flex items-center gap-1.5 flex-wrap text-tiny">
                      <CountPill
                        label="Awaiting"
                        value={s.awaiting}
                        bg="bg-warn-bg"
                        text="text-[#92400e]"
                      />
                      <CountPill
                        label="Shipped"
                        value={s.shipped}
                        bg="bg-ok-bg"
                        text="text-ok-dark"
                      />
                      <CountPill
                        label="Cancelled"
                        value={s.cancelled}
                        bg="bg-danger-bg"
                        text="text-[#991b1b]"
                      />
                      {s.onHold > 0 && (
                        <CountPill
                          label="On hold"
                          value={s.onHold}
                          bg="bg-surface-3"
                          text="text-ink-2"
                        />
                      )}
                      <span className="text-ink-3 ml-auto">
                        {s.total.toLocaleString()} total
                      </span>
                    </div>
                  );
                })()}

                <div className="flex items-center gap-1 pt-1 border-t border-line flex-wrap">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil size={11} />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!c.storeIds.length || backfill.isPending}
                    title={
                      !c.storeIds.length
                        ? 'Add at least one storeId first'
                        : 'Assign matching unassigned orders to this client'
                    }
                    onClick={() => {
                      backfill.mutate(
                        { id: c.id, overwrite: false },
                        {
                          onSuccess: (res) =>
                            alert(res.message ?? `Assigned ${res.updated} orders`),
                          onError: (err) =>
                            alert(`Backfill failed: ${(err as Error).message}`),
                        }
                      );
                    }}
                  >
                    <Wand2 size={11} />
                    Backfill
                  </Button>
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      if (
                        confirm(
                          `Delete client "${c.name}"? This also deletes their billing config and line items.`
                        )
                      ) {
                        remove.mutate(c.id);
                      }
                    }}
                    disabled={remove.isPending}
                    className="text-ink-3 hover:!text-danger"
                  >
                    <Trash2 size={11} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(creating || editing) && (
        <Suspense fallback={null}>
          <ClientModal
            existing={editing}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

function CountPill({
  label,
  value,
  bg,
  text,
}: {
  label: string;
  value: number;
  bg: string;
  text: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${bg} ${text} font-semibold`}
      title={label}
    >
      <span className="font-mono">{value.toLocaleString()}</span>
      <span className="opacity-70">{label.toLowerCase()}</span>
    </span>
  );
}
