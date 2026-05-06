import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Skeleton } from './ui/Skeleton';

type PkgLite = {
  id: number;
  name: string;
};

type LedgerRow = {
  id: number;
  packageId: number;
  changeType: string;
  qtyDelta: number;
  balanceAfter: number;
  note: string | null;
  unitCost: string | null;
  userId: string | null;
  createdAt: string;
};

// CA-time delegation per boss directive 2026-05-07. Package ledger
// uses createdAt (true UTC).
import { formatCaShort } from '../lib/ca-time';

function formatTimestamp(iso: string) {
  return formatCaShort(iso);
}

function changeTypeBadge(type: string) {
  const lower = type.toLowerCase();
  const style =
    lower === 'receive'
      ? 'bg-green-100 text-green-800'
      : lower === 'adjust'
        ? 'bg-amber-100 text-amber-800'
        : lower === 'consume'
          ? 'bg-blue-100 text-blue-800'
          : 'bg-surface-2 text-ink-2';
  return (
    <span
      className={`text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${style}`}
    >
      {type}
    </span>
  );
}

export default function PackageLedgerDrawer({
  pkg,
  onClose,
}: {
  pkg: PkgLite;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const ledger = useQuery({
    queryKey: ['package-ledger', pkg.id],
    queryFn: () =>
      api.get<{ data: LedgerRow[] }>(`/packages/${pkg.id}/ledger?limit=200`),
    enabled: Number.isFinite(pkg.id) && pkg.id > 0,
  });

  const rows = ledger.data?.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div
        className="flex-1 bg-black/35"
        onClick={onClose}
        aria-label="Close"
      />
      <aside className="w-drawer max-w-full bg-white shadow-drawer-l flex flex-col">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-surface-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={onClose}
            aria-label="Back"
          >
            <ArrowLeft size={14} />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold text-ink leading-tight truncate">
              {pkg.name}
            </div>
            <div className="text-tiny text-ink-3">Package history</div>
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-page">
          {ledger.isLoading && (
            <div className="p-3.5 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}

          {ledger.isError && (
            <div className="p-6 text-center text-danger text-sm2">
              {(ledger.error as Error).message}
            </div>
          )}

          {!ledger.isLoading && !ledger.isError && rows.length === 0 && (
            <div className="p-10 text-center text-ink-3">
              <div className="text-3xl mb-2">📒</div>
              <div className="text-sm2 font-semibold text-ink-2">
                No activity yet
              </div>
              <div className="text-tiny mt-1">
                Receive or adjust stock to start the ledger.
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <div className="divide-y divide-line bg-white">
              {rows.map((row) => {
                const signed = row.qtyDelta > 0 ? `+${row.qtyDelta}` : String(row.qtyDelta);
                const qtyColor =
                  row.qtyDelta > 0
                    ? 'text-ok-dark'
                    : row.qtyDelta < 0
                      ? 'text-danger'
                      : 'text-ink-2';
                return (
                  <div
                    key={row.id}
                    className="px-3.5 py-2.5 flex items-start gap-3"
                  >
                    <div className="w-20 shrink-0 text-right">
                      <div
                        className={`font-mono font-bold text-[13px] ${qtyColor}`}
                      >
                        {signed}
                      </div>
                      <div className="text-tiny text-ink-3 font-mono">
                        = {row.balanceAfter}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {changeTypeBadge(row.changeType)}
                        <span className="text-tiny text-ink-3">
                          {formatTimestamp(row.createdAt)}
                        </span>
                      </div>
                      {row.note && (
                        <div className="text-sm2 text-ink mt-1 break-words">
                          {row.note}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
