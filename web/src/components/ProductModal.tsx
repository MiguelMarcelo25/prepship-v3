import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type Product = {
  id: number;
  sku: string | null;
  name: string | null;
  imageUrl: string | null;
  weightOz: number;
  length: number;
  width: number;
  height: number;
  defaultPackageCode: string | null;
};

function numOrNull(v: string) {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function ProductModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing: Product | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [sku, setSku] = useState(existing?.sku ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl ?? '');
  const [weightOz, setWeightOz] = useState(existing ? String(existing.weightOz) : '');
  const [length, setLength] = useState(existing ? String(existing.length) : '');
  const [width, setWidth] = useState(existing ? String(existing.width) : '');
  const [height, setHeight] = useState(existing ? String(existing.height) : '');
  const [defaultPackageCode, setDefaultPackageCode] = useState(
    existing?.defaultPackageCode ?? ''
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: Partial<Product>) =>
      isEdit
        ? api.patch<Product>(`/products/${existing!.id}`, body)
        : api.post<Product>('/products', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sku.trim()) return;
    mutation.mutate({
      sku: sku.trim(),
      name: name.trim() || null,
      imageUrl: imageUrl.trim() || null,
      weightOz: numOrNull(weightOz) ?? 0,
      length: numOrNull(length) ?? 0,
      width: numOrNull(width) ?? 0,
      height: numOrNull(height) ?? 0,
      defaultPackageCode: defaultPackageCode.trim() || null,
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
        className="w-[480px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1 text-[14px] font-bold text-ink">
            {isEdit ? `Edit ${existing!.sku}` : 'New product'}
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
              disabled={isEdit}
            />
          </div>

          <div>
            <label className="section-label block mb-1">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <label className="section-label block mb-1">Image URL</label>
            <Input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>

          <div>
            <label className="section-label block mb-1">Weight (oz)</label>
            <Input
              type="number"
              step="0.1"
              min={0}
              value={weightOz}
              onChange={(e) => setWeightOz(e.target.value)}
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

          <div>
            <label className="section-label block mb-1">
              Default package code
            </label>
            <Input
              value={defaultPackageCode}
              onChange={(e) => setDefaultPackageCode(e.target.value)}
              placeholder="package, large_flat_rate_box, etc."
            />
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
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
