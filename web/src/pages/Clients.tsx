import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

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

export default function Clients() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/clients/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });

  const rows = data ?? [];

  return (
    <>
      <Topbar
        title="Clients"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} />
            New client
          </Button>
        }
      />

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
                  <span
                    className={`text-2xs font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                      c.active
                        ? 'bg-ok-bg text-ok-dark'
                        : 'bg-surface-3 text-ink-3'
                    }`}
                  >
                    {c.active ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>

                <div className="text-tiny text-ink-2 space-y-0.5">
                  {c.contactName && <div>{c.contactName}</div>}
                  {c.email && <div className="font-mono">{c.email}</div>}
                  {c.phone && <div>{c.phone}</div>}
                </div>

                <div className="text-tiny text-ink-3">
                  {c.storeIds.length} linked store
                  {c.storeIds.length === 1 ? '' : 's'}
                </div>

                <div className="flex items-center gap-1 pt-1 border-t border-line">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil size={11} />
                    Edit
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
    </>
  );
}
