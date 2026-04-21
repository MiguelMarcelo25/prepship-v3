import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PackagePlus, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api } from '../lib/api';

const PackageModal = lazy(() => import('../components/PackageModal'));
const PackageReceiveModal = lazy(() => import('../components/PackageReceiveModal'));
const PackageAdjustModal = lazy(
  () => import('../components/PackageAdjustModal')
);
const PackageLedgerDrawer = lazy(
  () => import('../components/PackageLedgerDrawer')
);

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
  source: string;
};

function dimsLabel(p: Pkg) {
  if (p.length > 0 && p.width > 0 && p.height > 0) {
    return `${p.length}×${p.width}×${p.height}"`;
  }
  return '—';
}

function stockTone(qty: number, lvl: number): string {
  if (qty <= 0) return 'text-danger';
  if (qty <= lvl) return 'text-warn';
  return 'text-ok';
}

export default function Packages() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Pkg | null>(null);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<Pkg | null>(null);
  const [adjusting, setAdjusting] = useState<Pkg | null>(null);
  const [viewingLedger, setViewingLedger] = useState<Pkg | null>(null);

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
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      alert(r.message);
    },
    onError: (e) => alert(`Sync failed: ${(e as Error).message}`),
  });

  const updateReorder = useMutation({
    mutationFn: ({ id, reorderLevel }: { id: number; reorderLevel: number }) =>
      api.patch<Pkg>(`/packages/${id}`, { reorderLevel }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['packages'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/packages/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['packages'] }),
  });

  const lowStock = useMemo(
    () => rows.filter((p) => p.stockQty <= p.reorderLevel),
    [rows]
  );

  const customPackages = useMemo(
    () => rows.filter((p) => p.source !== 'shipstation'),
    [rows]
  );
  const ssPackages = useMemo(
    () => rows.filter((p) => p.source === 'shipstation'),
    [rows]
  );

  return (
    <>
      <Topbar
        title="📐 Package Library"
        right={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              <RefreshCw
                size={12}
                className={sync.isPending ? 'animate-spin' : ''}
              />
              {sync.isPending ? 'Syncing…' : 'Sync from ShipStation'}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
              Add Custom
            </Button>
          </>
        }
      />

      <div className="px-4 pt-2 text-tiny text-ink-3">
        Define reusable package types. Select in the right panel when shipping.
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3 bg-page">
        {isLoading && (
          <div className="text-center text-ink-3 py-10">Loading…</div>
        )}

        {!isLoading && lowStock.length > 0 && (
          <div className="rounded-card border border-warn-border bg-warn-bg px-3.5 py-2.5 text-tiny text-[#92400e]">
            <div className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="text-warn shrink-0 mt-px" />
              <div>
                <span className="font-bold">Low stock: </span>
                {lowStock.map((p, i) => (
                  <span key={p.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="hover:underline font-semibold"
                    >
                      {p.name}
                    </button>
                    <span className="text-ink-3"> ({p.stockQty} left)</span>
                    {i < lowStock.length - 1 && (
                      <span className="text-ink-3">, </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">📐</div>
            <div className="font-semibold text-ink-2">
              No packages yet. Add one or sync from ShipStation.
            </div>
          </div>
        )}

        {customPackages.length > 0 && (
          <PackageSection
            title="Custom Packages"
            rows={customPackages}
            onEdit={setEditing}
            onReceive={setReceiving}
            onAdjust={setAdjusting}
            onHistory={setViewingLedger}
            onDelete={(id) => {
              if (confirm('Delete this package?')) remove.mutate(id);
            }}
            onReorderChange={(id, n) =>
              updateReorder.mutate({ id, reorderLevel: n })
            }
          />
        )}

        {ssPackages.length > 0 && (
          <CarrierPackageSection title="ShipStation Carrier Defaults" rows={ssPackages} />
        )}
      </div>

      {(creating || editing) && (
        <Suspense fallback={null}>
          <PackageModal
            existing={editing}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        </Suspense>
      )}

      {receiving && (
        <Suspense fallback={null}>
          <PackageReceiveModal
            pkg={receiving}
            onClose={() => setReceiving(null)}
          />
        </Suspense>
      )}

      {adjusting && (
        <Suspense fallback={null}>
          <PackageAdjustModal
            pkg={adjusting}
            onClose={() => setAdjusting(null)}
          />
        </Suspense>
      )}

      {viewingLedger && (
        <Suspense fallback={null}>
          <PackageLedgerDrawer
            pkg={viewingLedger}
            onClose={() => setViewingLedger(null)}
          />
        </Suspense>
      )}
    </>
  );
}

function PackageSection({
  title,
  rows,
  onEdit,
  onReceive,
  onAdjust,
  onHistory,
  onDelete,
  onReorderChange,
}: {
  title: string;
  rows: Pkg[];
  onEdit: (p: Pkg) => void;
  onReceive: (p: Pkg) => void;
  onAdjust: (p: Pkg) => void;
  onHistory: (p: Pkg) => void;
  onDelete: (id: number) => void;
  onReorderChange: (id: number, n: number) => void;
}) {
  return (
    <div className="bg-surface border border-line rounded-card overflow-hidden">
      <div className="bg-surface-2 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b border-line">
        {title}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 border-b border-line">
            <Th className="text-left max-w-[280px]">Package</Th>
            <Th className="text-center w-[60px]">Stock</Th>
            <Th className="text-center w-[75px]">Reorder</Th>
            <Th className="text-right w-[70px]">Cost</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <PackageRow
              key={p.id}
              row={p}
              onEdit={onEdit}
              onReceive={onReceive}
              onAdjust={onAdjust}
              onHistory={onHistory}
              onDelete={onDelete}
              onReorderChange={onReorderChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CarrierPackageSection({
  title,
  rows,
}: {
  title: string;
  rows: Pkg[];
}) {
  return (
    <div className="bg-surface border border-line rounded-card overflow-hidden">
      <div className="bg-surface-2 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b border-line">
        {title}
      </div>
      {rows.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-3 px-3.5 py-2.5 border-b border-line last:border-b-0"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm2 font-semibold text-ink truncate">
              {p.name}
            </div>
            <div className="text-tiny text-ink-3 mt-0.5">{dimsLabel(p)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PackageRow({
  row,
  onEdit,
  onReceive,
  onAdjust,
  onHistory,
  onDelete,
  onReorderChange,
}: {
  row: Pkg;
  onEdit: (p: Pkg) => void;
  onReceive: (p: Pkg) => void;
  onAdjust: (p: Pkg) => void;
  onHistory: (p: Pkg) => void;
  onDelete: (id: number) => void;
  onReorderChange: (id: number, n: number) => void;
}) {
  const [reorder, setReorder] = useState(String(row.reorderLevel));
  const tone = stockTone(row.stockQty, row.reorderLevel);
  const tare = row.tareWeightOz > 0 ? `${row.tareWeightOz} oz` : '';
  const cost =
    row.unitCost != null ? `$${parseFloat(row.unitCost).toFixed(3)}` : '—';

  return (
    <tr className="border-b border-line last:border-b-0">
      <td className="px-2.5 py-1.5 max-w-[280px] overflow-hidden">
        <button
          type="button"
          onClick={() => onEdit(row)}
          className="block text-left text-[12px] font-semibold text-ink underline decoration-line hover:decoration-brand"
        >
          {row.name}
        </button>
        <div className="text-[10.5px] text-ink-3 mt-px">
          {dimsLabel(row)}
          {tare && ` · ${tare}`}
        </div>
      </td>
      <td
        className={`px-2 py-1.5 text-center font-bold text-[13px] ${tone}`}
      >
        {row.stockQty}
      </td>
      <td className="px-2 py-1.5 text-center">
        <input
          type="number"
          min={0}
          step={1}
          value={reorder}
          onChange={(e) => setReorder(e.target.value)}
          onBlur={() => {
            const n = Number(reorder);
            if (Number.isFinite(n) && n !== row.reorderLevel) {
              onReorderChange(row.id, n);
            }
          }}
          className="w-[50px] px-1 py-[3px] border border-line-2 rounded bg-surface-2 text-ink text-[11px] text-center focus:outline-none focus:border-brand"
          title="Reorder Level"
        />
      </td>
      <td className="px-2 py-1.5 text-right text-[11.5px] text-ink-2 font-mono">
        {cost}
      </td>
      <td className="px-1.5 py-1.5 text-right whitespace-nowrap">
        <button
          type="button"
          onClick={() => onReceive(row)}
          className="text-ink-3 hover:text-ok p-1"
          title="Receive stock"
        >
          <PackagePlus size={12} />
        </button>
        <button
          type="button"
          onClick={() => onAdjust(row)}
          className="text-ink-3 hover:text-warn p-1 text-[12px] font-bold leading-none"
          title="Adjust stock"
          aria-label="Adjust stock"
        >
          ±
        </button>
        <button
          type="button"
          onClick={() => onHistory(row)}
          className="text-ink-3 hover:text-brand p-1 text-[12px] leading-none"
          title="History"
          aria-label="Package history"
        >
          📒
        </button>
        <button
          type="button"
          onClick={() => onEdit(row)}
          className="text-ink-3 hover:text-brand p-1"
          title="Edit"
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(row.id)}
          className="text-ink-3 hover:text-danger p-1"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </td>
    </tr>
  );
}

function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.3px] text-ink-3 ${className}`}
    >
      {children}
    </th>
  );
}
