import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X, ArrowDown, ArrowUp, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Card, Field } from './ui/Card';
import { Skeleton } from './ui/Skeleton';

type Item = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  stockQty: number;
  reorderLevel: number;
  weightOz: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type LedgerRow = {
  id: number;
  inventoryId: number;
  type: string;
  qty: number;
  orderId: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
};

type MovementResponse = { inventory: Item; ledger: LedgerRow };

function formatDate(v: string) {
  return new Date(v).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function InventoryDrawer() {
  const { id: idParam } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = Number(idParam);

  const close = () => navigate('/inventory');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item = useQuery({
    queryKey: ['inventory', id],
    queryFn: () => api.get<Item>(`/inventory/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });

  const ledger = useQuery({
    queryKey: ['inventory-ledger', id],
    queryFn: () => api.get<{ data: LedgerRow[] }>(`/inventory/${id}/ledger`),
    enabled: Number.isFinite(id) && id > 0,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    queryClient.invalidateQueries({ queryKey: ['inventory-stats'] });
    queryClient.invalidateQueries({ queryKey: ['inventory', id] });
    queryClient.invalidateQueries({ queryKey: ['inventory-ledger', id] });
  };

  const receive = useMutation({
    mutationFn: (body: { qty: number; note?: string }) =>
      api.post<MovementResponse>(`/inventory/${id}/receive`, body),
    onSuccess: invalidate,
  });

  const adjust = useMutation({
    mutationFn: (body: { qty: number; note?: string }) =>
      api.post<MovementResponse>(`/inventory/${id}/adjust`, body),
    onSuccess: invalidate,
  });

  const updateItem = useMutation({
    mutationFn: (body: Partial<Item>) => api.patch<Item>(`/inventory/${id}`, body),
    onSuccess: invalidate,
  });

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-black/35" onClick={close} aria-label="Close" />
      <aside className="w-drawer max-w-full bg-white shadow-drawer-l flex flex-col">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-surface-2">
          <Button variant="ghost" size="xs" onClick={close} aria-label="Back">
            <ArrowLeft size={14} />
          </Button>
          <div className="flex-1">
            <div className="text-[13px] font-bold text-ink leading-tight font-mono">
              {item.data?.sku ?? '—'}
            </div>
            {item.data?.name && (
              <div className="text-tiny text-ink-3 truncate">{item.data.name}</div>
            )}
          </div>
          <Button variant="ghost" size="xs" onClick={close} aria-label="Close">
            <X size={14} />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 bg-page space-y-3">
          {item.isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          )}
          {item.isError && (
            <div className="text-center text-danger py-10">
              {(item.error as Error).message}
            </div>
          )}
          {item.data && (
            <>
              <SummaryCard item={item.data} onSave={updateItem.mutate} updating={updateItem.isPending} />

              <MovementCard
                title="Receive stock"
                hint="Record inbound units — increases stock."
                icon={<ArrowDown size={12} />}
                submitLabel="Receive"
                variant="green"
                minQty={1}
                onSubmit={(body) => receive.mutate(body)}
                pending={receive.isPending}
                error={receive.error ? (receive.error as Error).message : null}
              />

              <MovementCard
                title="Adjust stock"
                hint="Correct a count, record damage/loss. Positive adds, negative removes."
                icon={<ArrowUp size={12} />}
                submitLabel="Adjust"
                variant="outline"
                allowNegative
                onSubmit={(body) => adjust.mutate(body)}
                pending={adjust.isPending}
                error={adjust.error ? (adjust.error as Error).message : null}
              />

              <Card title={`Ledger (${ledger.data?.data.length ?? 0})`}>
                {ledger.isLoading && (
                  <div className="text-ink-3 text-sm2">Loading…</div>
                )}
                {ledger.data?.data.length ? (
                  <div className="divide-y divide-line -mx-3.5">
                    {ledger.data.data.map((row) => (
                      <div key={row.id} className="px-3.5 py-2 flex items-center gap-3">
                        <div
                          className={`w-16 text-right font-mono font-bold ${
                            row.qty >= 0 ? 'text-ok-dark' : 'text-danger'
                          }`}
                        >
                          {row.qty > 0 ? '+' : ''}
                          {row.qty}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm2 text-ink uppercase font-semibold tracking-wide">
                            {row.type}
                          </div>
                          <div className="text-tiny text-ink-3">
                            {formatDate(row.createdAt)}
                            {row.createdBy && <> · {row.createdBy}</>}
                          </div>
                          {row.note && (
                            <div className="text-tiny text-ink-2 mt-0.5">
                              {row.note}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : !ledger.isLoading ? (
                  <div className="text-ink-3 text-sm2">No activity yet.</div>
                ) : null}
              </Card>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function SummaryCard({
  item,
  onSave,
  updating,
}: {
  item: Item;
  onSave: (body: Partial<Item>) => void;
  updating: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name ?? '');
  const [reorder, setReorder] = useState(String(item.reorderLevel));

  return (
    <Card
      title="Summary"
      actions={
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-ink-3 hover:text-ink"
          title={editing ? 'Cancel' : 'Edit'}
        >
          <Pencil size={12} />
        </button>
      }
    >
      {!editing ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" value={item.name ?? null} />
          <Field
            label="Current stock"
            value={
              <span
                className={`font-mono font-bold ${
                  item.stockQty <= 0
                    ? 'text-danger'
                    : item.stockQty <= item.reorderLevel
                      ? 'text-warn'
                      : 'text-ok-dark'
                }`}
              >
                {item.stockQty}
              </span>
            }
          />
          <Field label="Reorder at" value={item.reorderLevel} mono />
          <Field
            label="Weight"
            value={item.weightOz ? `${item.weightOz.toFixed(1)} oz` : null}
            mono
          />
          <Field
            label="Dims (L×W×H)"
            value={
              item.length && item.width && item.height
                ? `${item.length}×${item.width}×${item.height} in`
                : null
            }
            mono
          />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave({
              name: name || null,
              reorderLevel: Number(reorder) || 0,
            });
            setEditing(false);
          }}
          className="space-y-3"
        >
          <div>
            <label className="section-label block mb-1">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="section-label block mb-1">Reorder at</label>
            <Input
              type="number"
              min={0}
              value={reorder}
              onChange={(e) => setReorder(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={updating}>
              {updating ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function MovementCard({
  title,
  hint,
  icon,
  submitLabel,
  variant,
  minQty,
  allowNegative,
  onSubmit,
  pending,
  error,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  submitLabel: string;
  variant: 'green' | 'outline' | 'primary';
  minQty?: number;
  allowNegative?: boolean;
  onSubmit: (body: { qty: number; note?: string }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number(qty);
    if (!Number.isFinite(n) || n === 0) return;
    if (!allowNegative && n < 0) return;
    if (minQty !== undefined && n < minQty) return;
    onSubmit({ qty: n, note: note || undefined });
    setQty('');
    setNote('');
  };

  return (
    <Card title={title}>
      <form onSubmit={submit} className="space-y-2.5">
        <div className="text-tiny text-ink-3">{hint}</div>
        <div className="grid grid-cols-[100px_1fr] gap-2">
          <Input
            type="number"
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder={allowNegative ? '±qty' : 'qty'}
            required
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note"
          />
        </div>
        {error && <div className="text-danger text-tiny">{error}</div>}
        <Button type="submit" variant={variant} size="sm" disabled={pending}>
          {icon}
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </form>
    </Card>
  );
}
