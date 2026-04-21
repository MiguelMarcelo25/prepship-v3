import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type Pkg = {
  id: number;
  name: string;
  stockQty: number;
  unitCost: string | null;
};

type ReceiveResponse = {
  data: {
    package: { id: number; stockQty: number; unitCost: string | null };
    ledgerEntry: { id: number; balanceAfter: number };
  };
};

export default function PackageReceiveModal({
  pkg,
  onClose,
}: {
  pkg: Pkg;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState(pkg.unitCost ?? '');
  const [note, setNote] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: (body: { qty: number; unitCost?: number; note?: string }) =>
      api.post<ReceiveResponse>(`/packages/${pkg.id}/receive`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      onClose();
    },
  });

  const qtyNum = Number.parseInt(qty, 10);
  const qtyValid = Number.isFinite(qtyNum) && qtyNum > 0;
  const costNum = unitCost.trim() === '' ? undefined : Number(unitCost);
  const costValid = costNum === undefined || (Number.isFinite(costNum) && costNum >= 0);
  const canSubmit = qtyValid && costValid && !mutation.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate({
      qty: qtyNum,
      unitCost: costNum,
      note: note.trim() ? note.trim().slice(0, 500) : undefined,
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
        className="w-[420px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <div className="flex-1">
            <div className="text-[14px] font-bold text-ink">📥 Receive stock</div>
            <div className="text-tiny text-ink-3 mt-0.5 truncate">{pkg.name}</div>
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
              Quantity <span className="text-danger">*</span>
            </label>
            <Input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              required
              autoFocus
            />
            <div className="text-tiny text-ink-3 mt-1">
              Current stock: <span className="font-semibold text-ink-2">{pkg.stockQty}</span>
              {qtyValid && (
                <> · after receive: <span className="font-semibold text-ok">{pkg.stockQty + qtyNum}</span></>
              )}
            </div>
          </div>

          <div>
            <label className="section-label block mb-1">
              Unit cost ($) <span className="text-ink-3 font-normal">(optional — updates package unit cost)</span>
            </label>
            <Input
              type="number"
              step="0.001"
              min={0}
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0.000"
            />
          </div>

          <div>
            <label className="section-label block mb-1">
              Note <span className="text-ink-3 font-normal">(optional)</span>
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="PO #, supplier, etc."
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
              disabled={!canSubmit}
            >
              {mutation.isPending ? 'Receiving…' : 'Receive'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
