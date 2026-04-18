import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Pencil, Trash2 } from 'lucide-react';
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

  const rows = data ?? [];

  return (
    <>
      <Topbar
        title="Locations"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} />
            New location
          </Button>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {isLoading ? (
          <div className="text-center text-ink-3 py-10">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">📍</div>
            <div className="font-semibold text-ink-2">No locations yet</div>
            <div className="text-xs mt-1">
              Add a warehouse address. One marked as default is used as the
              ship-from for every label.
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((loc) => (
              <div
                key={loc.id}
                className={`bg-white rounded-card border shadow-sm p-3.5 flex flex-col gap-2.5 ${
                  loc.isDefault
                    ? 'border-brand ring-1 ring-brand/30'
                    : 'border-line'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-ink truncate">{loc.name}</div>
                    {loc.company && (
                      <div className="text-tiny text-ink-3 truncate">
                        {loc.company}
                      </div>
                    )}
                  </div>
                  {loc.isDefault && (
                    <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-brand text-white shrink-0">
                      DEFAULT
                    </span>
                  )}
                </div>

                <div className="text-tiny text-ink-2 leading-relaxed font-mono">
                  {loc.street1 && <div>{loc.street1}</div>}
                  {loc.street2 && <div>{loc.street2}</div>}
                  <div>
                    {[loc.city, loc.state, loc.postalCode]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </div>
                  {loc.country !== 'US' && (
                    <div className="text-ink-3">{loc.country}</div>
                  )}
                  {loc.phone && <div className="pt-1">{loc.phone}</div>}
                </div>

                <div className="flex items-center gap-1 pt-1 border-t border-line">
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
                  <div className="flex-1" />
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
            ))}
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
