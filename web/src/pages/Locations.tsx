import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Pencil, Trash2, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

const LocationModal = lazy(() => import('../components/LocationModal'));

type Location = {
  id: number;
  name: string;
  company: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  active: boolean;
};

export default function Locations() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Location | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api.get<Location[]>('/locations'),
  });

  const setDefault = useMutation({
    mutationFn: (id: number) => api.post<Location>(`/locations/${id}/default`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['locations'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/locations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['locations'] }),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ inserted: number; updated: number; message: string }>(
        '/locations/sync',
        {}
      ),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['locations'] });
      alert(r.message);
    },
    onError: (err) => alert(`Sync failed: ${(err as Error).message}`),
  });

  const rows = data ?? [];

  return (
    <>
      <Topbar
        title="📍 Ship-From Locations"
        right={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              title="Pull warehouses from ShipStation"
            >
              <RefreshCw
                size={12}
                className={sync.isPending ? 'animate-spin' : ''}
              />
              {sync.isPending ? 'Syncing…' : 'Sync from ShipStation'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
              New location
            </Button>
          </>
        }
      />

      <div className="px-4 pt-2 text-tiny text-ink-3">
        Add warehouses, 3PL centers, or drop-ship addresses. The ★ default is
        used for all new labels.
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 bg-page">
        {isLoading ? (
          <div className="text-center text-ink-3 py-10">Loading locations…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">📍</div>
            <div className="font-semibold text-ink-2">
              No locations yet. Add one above.
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {rows.map((loc) => {
              const addressParts = [
                loc.company,
                loc.street1,
                loc.street2,
                loc.city && loc.state
                  ? `${loc.city}, ${loc.state} ${loc.postalCode ?? ''}`.trim()
                  : '',
              ].filter(Boolean);
              return (
                <div
                  key={loc.id}
                  className="bg-surface border border-line rounded-card px-4 py-3.5 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-[13px] text-ink">
                        {loc.name}
                      </span>
                      {loc.isDefault && (
                        <span className="bg-brand text-white text-[10px] font-bold px-[7px] py-px rounded-full">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-2">
                      {addressParts.join(' · ')}
                    </div>
                    {loc.phone && (
                      <div className="text-[11.5px] text-ink-3 mt-0.5">
                        {loc.phone}
                      </div>
                    )}
                  </div>
                  <div className="flex items-start gap-1 shrink-0">
                    {!loc.isDefault && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setDefault.mutate(loc.id)}
                        disabled={setDefault.isPending}
                        title="Mark as default ship-from"
                      >
                        <Star size={11} />
                        Default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setEditing(loc)}
                    >
                      <Pencil size={11} />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete location "${loc.name}"? This can't be undone.`
                          )
                        ) {
                          remove.mutate(loc.id);
                        }
                      }}
                      disabled={remove.isPending}
                      className="text-ink-3 hover:!text-danger"
                    >
                      <Trash2 size={11} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(creating || editing) && (
        <Suspense fallback={null}>
          <LocationModal
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
