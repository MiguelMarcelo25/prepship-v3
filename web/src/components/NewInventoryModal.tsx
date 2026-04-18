import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type NewItemBody = {
  sku: string;
  name?: string;
  clientId?: number | null;
  stockQty?: number;
  reorderLevel?: number;
  weightOz?: number | null;
  length?: number | null;
  width?: number | null;
  height?: number | null;
};

type Item = { id: number; sku: string };

function numOrNull(v: string) {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOrDefault(v: string, fallback: number) {
  if (v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function NewInventoryModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [stockQty, setStockQty] = useState('0');
  const [reorderLevel, setReorderLevel] = useState('0');
  const [weightOz, setWeightOz] = useState('');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: NewItemBody) => api.post<Item>('/inventory', body),
    onSuccess: (item) => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventory-stats'] });
      onClose();
      navigate(`/inventory/${item.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sku.trim()) return;
    mutation.mutate({
      sku: sku.trim(),
      name: name.trim() || undefined,
      stockQty: numOrDefault(stockQty, 0),
      reorderLevel: numOrDefault(reorderLevel, 0),
      weightOz: numOrNull(weightOz),
      length: numOrNull(length),
      width: numOrNull(width),
      height: numOrNull(height),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[440px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1 text-[14px] font-bold text-ink">
            New inventory item
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <form onSubmit={submit} className="px-5 py-4 space-y-3">
          <div>
            <label className="section-label block mb-1">
              SKU <span className="text-danger">*</span>
            </label>
            <Input
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="DRP-001"
              required
              autoFocus
            />
          </div>

          <div>
            <label className="section-label block mb-1">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional display name"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="section-label block mb-1">Initial stock</label>
              <Input
                type="number"
                min={0}
                value={stockQty}
                onChange={(e) => setStockQty(e.target.value)}
              />
            </div>
            <div>
              <label className="section-label block mb-1">Reorder at</label>
              <Input
                type="number"
                min={0}
                value={reorderLevel}
                onChange={(e) => setReorderLevel(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="section-label block mb-1">Weight (oz)</label>
            <Input
              type="number"
              step="0.1"
              min={0}
              value={weightOz}
              onChange={(e) => setWeightOz(e.target.value)}
              placeholder="e.g. 16"
            />
          </div>

          <div>
            <label className="section-label block mb-1">
              Dimensions (inches)
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={length}
                onChange={(e) => setLength(e.target.value)}
                placeholder="L"
              />
              <Input
                type="number"
                step="0.1"
                min={0}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                placeholder="W"
              />
              <Input
                type="number"
                step="0.1"
                min={0}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                placeholder="H"
              />
            </div>
          </div>

          {mutation.isError && (
            <div className="text-danger text-tiny py-1">
              {(mutation.error as Error).message}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={mutation.isPending || !sku.trim()}
            >
              {mutation.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
