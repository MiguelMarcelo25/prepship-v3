import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

type Pkg = {
  id: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  stockQty: number;
  reorderLevel: number;
  isDefault: boolean;
};

export default function Packages() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['packages'],
    queryFn: () => api.get<Pkg[]>('/packages'),
  });
  const rows = data ?? [];

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ inserted: number; skipped: number; message: string }>(
        '/packages/sync',
        {}
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      alert(result.message);
    },
    onError: (err) => alert(`Sync failed: ${(err as Error).message}`),
  });

  return (
    <>
      <Topbar
        title="Packages"
        right={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
              title="Pull carrier-default packages from ShipStation"
            >
              <RefreshCw
                size={12}
                className={sync.isPending ? 'animate-spin' : ''}
              />
              {sync.isPending ? 'Syncing…' : 'Sync from ShipStation'}
            </Button>
            <Button variant="primary" size="sm">
              <Plus size={12} />
              New package
            </Button>
          </>
        }
      />
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {isLoading ? (
          <div className="text-center text-ink-3 py-10">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">📐</div>
            <div className="font-semibold text-ink-2">No packages yet</div>
            <div className="text-xs mt-1">Add your first shipping package template.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((p) => (
              <div
                key={p.id}
                className="bg-white rounded-card border border-line p-3.5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-bold text-ink">{p.name}</div>
                    <div className="text-tiny text-ink-3 uppercase mt-0.5">{p.type}</div>
                  </div>
                  {p.isDefault && (
                    <span className="text-2xs font-bold px-1.5 py-0.5 rounded-full bg-brand text-white">
                      DEFAULT
                    </span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-tiny text-ink-2">
                  <div>
                    <div className="section-label">Dimensions</div>
                    <div className="font-mono">
                      {p.length}×{p.width}×{p.height} in
                    </div>
                  </div>
                  <div>
                    <div className="section-label">Tare</div>
                    <div className="font-mono">{p.tareWeightOz.toFixed(1)} oz</div>
                  </div>
                  <div>
                    <div className="section-label">Stock</div>
                    <div className="font-mono">{p.stockQty}</div>
                  </div>
                  <div>
                    <div className="section-label">Reorder at</div>
                    <div className="font-mono">{p.reorderLevel}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
