import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';

type Pkg = {
  id: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  tareWeightOz: number;
  carrierCode: string | null;
  packageCode: string | null;
  stockQty: number;
  reorderLevel: number;
  unitCost: string | null;
  isDefault: boolean;
};

const PACKAGE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'box', label: 'Box' },
  { value: 'poly_mailer', label: 'Polymailer' },
  { value: 'envelope', label: 'Envelope' },
  { value: 'other', label: 'Other' },
];

function dimsLabel(l: number, w: number, h: number) {
  const f = (n: number) => (Number.isInteger(n) ? `${n}` : `${n}`);
  return `${f(l)}×${f(w)}×${f(h)}`;
}

export default function PackageModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing: Pkg | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState(existing?.type ?? 'box');
  const [length, setLength] = useState(existing ? String(existing.length) : '');
  const [width, setWidth] = useState(existing ? String(existing.width) : '');
  const [height, setHeight] = useState(existing ? String(existing.height) : '');
  const [tareWeightOz, setTareWeightOz] = useState(
    existing ? String(existing.tareWeightOz) : '0'
  );
  const [stockQty, setStockQty] = useState(
    existing ? String(existing.stockQty) : '0'
  );
  const [reorderLevel, setReorderLevel] = useState(
    existing ? String(existing.reorderLevel) : '10'
  );
  const [unitCost, setUnitCost] = useState(existing?.unitCost ?? '');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: Partial<Pkg>) =>
      isEdit
        ? api.patch<Pkg>(`/packages/${existing!.id}`, body)
        : api.post<Pkg>('/packages', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const l = Number(length);
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    mutation.mutate({
      name: name.trim() || dimsLabel(l, w, h),
      type,
      length: l,
      width: w,
      height: h,
      tareWeightOz: Number(tareWeightOz) || 0,
      stockQty: Number(stockQty) || 0,
      reorderLevel: Number(reorderLevel) || 0,
      unitCost: unitCost ? unitCost : undefined,
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
        className="w-[460px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1 text-[14px] font-bold text-ink">
            {isEdit ? `Edit ${existing!.name}` : 'Add custom package'}
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
              Name <span className="text-ink-3 font-normal">(optional, defaults to dims)</span>
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bubble Mailer Small"
            />
          </div>

          <div>
            <label className="section-label block mb-1">Type</label>
            <Select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full"
            >
              {PACKAGE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="section-label block mb-1">
              Dimensions (inches) <span className="text-danger">*</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Input
                type="number"
                step="0.1"
                min={0}
                value={length}
                onChange={(e) => setLength(e.target.value)}
                placeholder="L"
                required
                autoFocus={!isEdit}
              />
              <Input
                type="number"
                step="0.1"
                min={0}
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                placeholder="W"
                required
              />
              <Input
                type="number"
                step="0.1"
                min={0}
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                placeholder="H"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="section-label block mb-1">Tare weight (oz)</label>
              <Input
                type="number"
                step="0.1"
                min={0}
                value={tareWeightOz}
                onChange={(e) => setTareWeightOz(e.target.value)}
              />
            </div>
            <div>
              <label className="section-label block mb-1">Cost ($)</label>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
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
              disabled={mutation.isPending}
            >
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
