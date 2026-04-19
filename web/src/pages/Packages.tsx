import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';

const PackageModal = lazy(() => import('../components/PackageModal'));

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
  const f = (n: number) => (Number.isInteger(n) ? `${n}` : `${n}`);
  return `${f(p.length)}×${f(p.width)}×${f(p.height)}`;
}

export default function Packages() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Pkg | null>(null);
  const [creating, setCreating] = useState(false);

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
        title="Package Library"
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

      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading && (
          <div className="text-center text-ink-3 py-10">Loading…</div>
        )}

        {!isLoading && lowStock.length > 0 && (
          <div className="px-4 py-2.5 bg-warn-bg border-b border-warn-border text-tiny text-[#92400e] leading-relaxed">
            <div className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="text-warn shrink-0 mt-px" />
              <div>
                <span className="font-bold">Low stock: </span>
                {lowStock.map((p, i) => (
                  <span key={p.id}>
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="hover:underline font-mono"
                    >
                      {dimsLabel(p)}
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
            <div className="font-semibold text-ink-2">No packages yet</div>
            <div className="text-xs mt-1">
              Click <strong>Sync from ShipStation</strong> for carrier defaults,
              or <strong>Add Custom</strong> for your own.
            </div>
          </div>
        )}

        {customPackages.length > 0 && (
          <PackageSection
            title="Custom packages"
            rows={customPackages}
            onEdit={setEditing}
            onDelete={(id) => {
              if (confirm('Delete this package?')) remove.mutate(id);
            }}
            onReorderChange={(id, n) =>
              updateReorder.mutate({ id, reorderLevel: n })
            }
          />
        )}

        {ssPackages.length > 0 && (
          <PackageSection
            title="ShipStation carrier defaults"
            rows={ssPackages}
            onEdit={setEditing}
            onDelete={(id) => {
              if (confirm('Delete this package?')) remove.mutate(id);
            }}
            onReorderChange={(id, n) =>
              updateReorder.mutate({ id, reorderLevel: n })
            }
          />
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
    </>
  );
}

function PackageSection({
  title,
  rows,
  onEdit,
  onDelete,
  onReorderChange,
}: {
  title: string;
  rows: Pkg[];
  onEdit: (p: Pkg) => void;
  onDelete: (id: number) => void;
  onReorderChange: (id: number, n: number) => void;
}) {
  return (
    <div>
      <div className="px-4 pt-4 pb-1 text-[11.5px] font-bold uppercase tracking-[0.6px] text-ink-3">
        {title}{' '}
        <span className="text-ink-3 font-normal">({rows.length})</span>
      </div>
      <table className="w-full text-sm2 border-collapse">
        <thead className="bg-surface-2 sticky top-0 z-10">
          <tr>
            <Th>Package</Th>
            <Th className="text-right w-[80px]">Stock</Th>
            <Th className="text-right w-[100px]">Reorder</Th>
            <Th className="text-right w-[80px]">Cost</Th>
            <Th className="w-[100px]"></Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <PackageRow
              key={p.id}
              row={p}
              alt={i % 2 === 1}
              onEdit={onEdit}
              onDelete={onDelete}
              onReorderChange={onReorderChange}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PackageRow({
  row,
  alt,
  onEdit,
  onDelete,
  onReorderChange,
}: {
  row: Pkg;
  alt: boolean;
  onEdit: (p: Pkg) => void;
  onDelete: (id: number) => void;
  onReorderChange: (id: number, n: number) => void;
}) {
  const [reorder, setReorder] = useState(String(row.reorderLevel));
  const stockTone =
    row.stockQty <= 0
      ? 'text-danger font-bold'
      : row.stockQty <= row.reorderLevel
        ? 'text-warn font-semibold'
        : 'text-ink';

  return (
    <tr className={`border-b border-line ${alt ? 'bg-surface-2' : 'bg-white'}`}>
      <Td>
        <div className="font-mono font-semibold text-brand">{dimsLabel(row)}</div>
        {row.name && row.name !== dimsLabel(row) && (
          <div className="text-tiny text-ink-3 mt-0.5">{row.name}</div>
        )}
        {row.carrierCode && (
          <div className="text-tiny text-ink-3 mt-0.5 uppercase">
            {row.carrierCode} · {row.packageCode}
          </div>
        )}
      </Td>
      <Td className={`text-right font-mono ${stockTone}`}>{row.stockQty}</Td>
      <Td className="text-right">
        <Input
          type="number"
          min={0}
          value={reorder}
          onChange={(e) => setReorder(e.target.value)}
          onBlur={() => {
            const n = Number(reorder);
            if (Number.isFinite(n) && n !== row.reorderLevel) {
              onReorderChange(row.id, n);
            }
          }}
          className="!py-[3px] !px-1.5 text-right text-[12px] w-16 ml-auto"
        />
      </Td>
      <Td className="text-right font-mono text-ink-2">
        {row.unitCost ? `$${row.unitCost}` : '—'}
      </Td>
      <Td>
        <div className="flex items-center justify-end gap-1">
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
        </div>
      </Td>
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
      className={`text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}
