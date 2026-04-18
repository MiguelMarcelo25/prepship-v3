import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

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
  const { data, isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
  });
  const rows = data ?? [];

  return (
    <>
      <Topbar
        title="Clients"
        right={
          <Button variant="primary" size="sm">
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
            <div className="text-xs mt-1">Add your first client to get started.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {rows.map((c) => (
              <div
                key={c.id}
                className="bg-white rounded-card border border-line p-3.5 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="font-bold text-ink">{c.name}</div>
                  <span
                    className={`text-2xs font-bold px-1.5 py-0.5 rounded-full ${
                      c.active ? 'bg-ok-bg text-ok-dark' : 'bg-surface-3 text-ink-3'
                    }`}
                  >
                    {c.active ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                <div className="mt-2 space-y-1 text-tiny text-ink-2">
                  {c.contactName && <div>{c.contactName}</div>}
                  {c.email && <div className="font-mono">{c.email}</div>}
                  {c.phone && <div>{c.phone}</div>}
                </div>
                <div className="mt-2.5 flex items-center gap-1.5 text-tiny text-ink-3">
                  <span>{c.storeIds.length}</span>
                  <span>linked store{c.storeIds.length === 1 ? '' : 's'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
