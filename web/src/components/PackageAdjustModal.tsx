import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type PkgLite = {
  id: number;
  name: string;
  stockQty: number;
};

type LedgerEntry = {
  id: number;
  packageId: number;
  changeType: string;
  qtyDelta: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
};

type AdjustResponse = {
  data: {
    package: { id: number; stockQty: number };
    ledgerEntry: LedgerEntry;
  };
};

export default function PackageAdjustModal({
  pkg,
  onClose,
}: {
  pkg: PkgLite;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [qtyDelta, setQtyDelta] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const parsed = Number(qtyDelta);
  const parsedValid =
    qtyDelta.trim() !== '' && Number.isInteger(parsed) && parsed !== 0;
  const newBalance = parsedValid ? pkg.stockQty + parsed : pkg.stockQty;

  const mutation = useMutation({
    mutationFn: (body: { qtyDelta: number; note?: string }) =>
      api.post<AdjustResponse>(`/packages/${pkg.id}/adjust`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      queryClient.invalidateQueries({ queryKey: ['package-ledger', pkg.id] });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!parsedValid) return;
    const trimmedNote = note.trim();
    mutation.mutate({
      qtyDelta: parsed,
      note: trimmedNote ? trimmedNote.slice(0, 500) : undefined,
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
          <div className="flex-1">
            <div className="text-[14px] font-bold text-ink">Adjust stock</div>
            <div className="text-tiny text-ink-3 truncate">{pkg.name}</div>
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
          <div className="grid grid-cols-2 gap-3 bg-surface-2 rounded px-3 py-2 text-sm2">
            <div>
              <div className="text-tiny text-ink-3 uppercase tracking-wide">
                Current stock
              </div>
              <div className="font-mono font-bold text-ink">{pkg.stockQty}</div>
            </div>
            <div>
              <div className="text-tiny text-ink-3 uppercase tracking-wide">
                New balance
              </div>
              <div
                className={`font-mono font-bold ${
                  !parsedValid
                    ? 'text-ink-3'
                    : newBalance < 0
                      ? 'text-danger'
                      : newBalance <= 0
                        ? 'text-warn'
                        : 'text-ok-dark'
                }`}
              >
                {parsedValid
                  ? `${newBalance} (${parsed > 0 ? '+' : ''}${parsed})`
                  : '—'}
              </div>
            </div>
          </div>

          <div>
            <label className="section-label block mb-1">
              Qty delta <span className="text-danger">*</span>
              <span className="text-ink-3 font-normal ml-1">
                (±, integer, not 0)
              </span>
            </label>
            <Input
              type="number"
              step={1}
              value={qtyDelta}
              onChange={(e) => setQtyDelta(e.target.value)}
              placeholder="e.g. -3 or 5"
              autoFocus
              required
            />
          </div>

          <div>
            <label className="section-label block mb-1">
              Note
              <span className="text-ink-3 font-normal ml-1">(optional)</span>
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Reason or reference"
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
              disabled={mutation.isPending || !parsedValid}
            >
              {mutation.isPending ? 'Saving…' : 'Save adjustment'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
