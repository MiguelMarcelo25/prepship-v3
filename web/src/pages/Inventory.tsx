import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Pencil,
  RefreshCw,
  Search as SearchIcon,
  Package as PackageIcon,
  Download,
} from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { Skeleton } from '../components/ui/Skeleton';
import { api, qs, type Paginated } from '../lib/api';
import {
  SortableHeader,
  nextSortState,
  sortRows,
  type SortState,
} from '../components/SortableTable';

const InventoryDrawer = lazy(() => import('../components/InventoryDrawer'));
const NewInventoryModal = lazy(() => import('../components/NewInventoryModal'));

type Item = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  imageUrl: string | null;
  stockQty: number;
  reorderLevel: number;
  weightOz: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  active: boolean;
  updatedAt: string;
};

type Client = { id: number; name: string };
type InventoryPageSortKey = 'sku' | 'name' | 'weight' | 'dims' | 'cuFt' | 'stock' | 'min' | 'status';

function formatWeight(oz: number | null) {
  if (oz === null || oz <= 0) return '—';
  const lb = Math.floor(oz / 16);
  const remain = Math.round((oz - lb * 16) * 10) / 10;
  if (lb === 0) return `${remain} oz`;
  if (remain === 0) return `${lb} lb`;
  return `${lb} lb ${remain} oz`;
}

function formatDims(l: number | null, w: number | null, h: number | null) {
  if (!l || !w || !h) return '—';
  const fmt = (n: number) => (Number.isInteger(n) ? `${n}` : `${n}`);
  return `${fmt(l)}×${fmt(w)}×${fmt(h)}`;
}

function cuFtPerUnit(l: number | null, w: number | null, h: number | null) {
  if (!l || !w || !h) return null;
  return (l * w * h) / 1728;
}

function StockCell({ qty, reorder }: { qty: number; reorder: number }) {
  if (qty <= 0) return <span className="text-danger">{qty}</span>;
  if (qty <= reorder) return <span className="text-warn">{qty}</span>;
  return <span className="text-ok">{qty}</span>;
}

function StatusPill({ qty, reorder }: { qty: number; reorder: number }) {
  if (qty <= 0)
    return (
      <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-danger-bg text-[#991b1b]">
        OUT
      </span>
    );
  if (qty <= reorder)
    return (
      <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-warn-bg text-[#92400e]">
        LOW
      </span>
    );
  return <span className="text-2xs text-ink-3">OK</span>;
}

export default function Inventory() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [clientFilter, setClientFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [sortState, setSortState] = useState<SortState<InventoryPageSortKey>>(null);
  const pageSize = 200;
  const openId = id ? Number(id) : null;

  const queryString = useMemo(
    () =>
      qs({
        page,
        pageSize,
        search: search || undefined,
        lowStock: lowStock || undefined,
        clientId: clientFilter || undefined,
      }),
    [page, search, lowStock, clientFilter]
  );

  const items = useQuery({
    queryKey: ['inventory', queryString],
    queryFn: () => api.get<Paginated<Item>>(`/inventory${queryString}`),
  });

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
    staleTime: 60_000,
  });

  const syncProducts = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>('/inventory/sync-products', {}),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      alert(r.message);
    },
    onError: (e) => alert(`Sync failed: ${(e as Error).message}`),
  });

  const importFromOrders = useMutation({
    mutationFn: () =>
      api.post<{ message: string }>('/inventory/import-from-orders', {}),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      alert(r.message);
    },
    onError: (e) => alert(`Import failed: ${(e as Error).message}`),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };

  const rows = items.data?.data ?? [];
  const clientsById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of clients.data ?? []) m.set(c.id, c.name);
    return m;
  }, [clients.data]);

  // Group by client name (or "Unassigned")
  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of rows) {
      const key = it.clientId
        ? clientsById.get(it.clientId) ?? `Client #${it.clientId}`
        : 'Unassigned';
      const arr = map.get(key) ?? [];
      arr.push(it);
      map.set(key, arr);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([clientName, clientItems]) => [
        clientName,
        sortRows(
          clientItems,
          sortState,
          (item, key) => {
            switch (key) {
              case 'sku':
                return item.sku;
              case 'name':
                return item.name;
              case 'weight':
                return item.weightOz;
              case 'dims':
                return (item.length ?? 0) * (item.width ?? 0) * (item.height ?? 0);
              case 'cuFt':
                return cuFtPerUnit(item.length, item.width, item.height);
              case 'stock':
                return item.stockQty;
              case 'min':
                return item.reorderLevel;
              case 'status':
                return item.stockQty <= 0 ? 0 : item.stockQty <= item.reorderLevel ? 1 : 2;
              default:
                return '';
            }
          },
          (item) => item.sku
        ),
      ] as [string, Item[]]);
  }, [rows, clientsById, sortState]);

  return (
    <>
      <Topbar
        title="📦 Inventory"
        right={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={importFromOrders.isPending}
              onClick={() => importFromOrders.mutate()}
              title="Find SKUs in your synced orders that aren't in Inventory yet"
            >
              <Download size={12} />
              {importFromOrders.isPending ? 'Importing…' : 'Import SKUs from Orders'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={syncProducts.isPending}
              onClick={() => syncProducts.mutate()}
              title="Pull product catalog (incl. dims) from ShipStation"
            >
              <RefreshCw
                size={12}
                className={syncProducts.isPending ? 'animate-spin' : ''}
              />
              {syncProducts.isPending ? 'Syncing…' : 'Import Dims from SS'}
            </Button>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw size={12} />
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus size={12} />
              New item
            </Button>
          </>
        }
      />

      {/* Filter bar */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 bg-white border-b border-line">
        <div className="w-[260px]">
          <Input
            leading={<SearchIcon size={13} />}
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder="Filter SKU or name…"
          />
        </div>
        <Select
          value={clientFilter}
          onChange={(e) => {
            setPage(1);
            setClientFilter(e.target.value);
          }}
        >
          <option value="">All Clients</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-1.5 text-sm2 text-ink-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(e) => {
              setPage(1);
              setLowStock(e.target.checked);
            }}
            className="accent-brand"
          />
          Low/Out only
        </label>
      </div>

      {/* Grouped table */}
      <div className="flex-1 min-h-0 overflow-auto bg-page p-4 space-y-4">
        {items.isLoading && (
          <div className="p-3 space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {!items.isLoading && rows.length === 0 && (
          <div className="text-center text-ink-3 py-16">
            <div className="text-4xl mb-2">📭</div>
            <div className="font-semibold text-ink-2">No SKUs found</div>
            <div className="text-xs mt-1">
              Use <strong>Import SKUs from Orders</strong> or
              <strong> Import Dims from SS</strong> to populate, or click New item.
            </div>
          </div>
        )}

        {!items.isLoading &&
          grouped.map(([clientName, items]) => (
            <div key={clientName}>
              <div className="text-[11px] font-bold uppercase tracking-[0.5px] text-ink-3 mb-1.5">
                {clientName}
              </div>
              <div className="bg-surface border border-line rounded-card overflow-hidden">
                <table className="w-full text-sm2 border-collapse min-w-[1100px]">
                  <thead>
                    <tr className="bg-surface-2 border-b border-line">
                      <SortableHeader sortKey="sku" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="w-[140px] text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">SKU</SortableHeader>
                      <Th className="w-[44px]"></Th>
                      <SortableHeader sortKey="name" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Name</SortableHeader>
                      <SortableHeader sortKey="weight" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[110px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Weight</SortableHeader>
                      <SortableHeader sortKey="dims" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="center" className="text-center w-[110px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Dims (LxWxH)</SortableHeader>
                      <SortableHeader sortKey="cuFt" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="center" className="text-center w-[90px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Cu Ft/Unit</SortableHeader>
                      <SortableHeader sortKey="stock" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="center" className="text-center w-[80px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Stock</SortableHeader>
                      <SortableHeader sortKey="min" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="center" className="text-center w-[60px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Min</SortableHeader>
                      <SortableHeader sortKey="status" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="center" className="text-center w-[70px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Status</SortableHeader>
                      <Th className="text-right w-[70px]"></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr
                        key={it.id}
                        className={`cursor-pointer border-b border-line last:border-b-0 transition-colors ${
                          openId === it.id ? '!bg-brand-bg' : 'hover:bg-surface-2'
                        }`}
                        onClick={() => navigate(`/inventory/${it.id}`)}
                      >
                        <Td>
                          <span className="font-mono text-[11.5px] text-brand">
                            {it.sku}
                          </span>
                        </Td>
                        <Td className="!py-1">
                          <div className="w-10 h-10 rounded border border-line bg-surface-3 flex items-center justify-center overflow-hidden">
                            {it.imageUrl ? (
                              <img
                                src={it.imageUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <PackageIcon size={14} className="text-ink-3" />
                            )}
                          </div>
                        </Td>
                        <Td
                          className="text-[12px] text-ink truncate max-w-[300px]"
                          title={it.name ?? ''}
                        >
                          {it.name ?? <span className="text-ink-3">—</span>}
                        </Td>
                        <Td className="text-right text-[11.5px] text-ink-2">
                          {formatWeight(it.weightOz)}
                        </Td>
                        <Td className="text-center text-[11.5px] text-ink-2 font-mono">
                          {formatDims(it.length, it.width, it.height)}
                        </Td>
                        <Td className="text-center text-[11px] text-ink-3">
                          {(() => {
                            const v = cuFtPerUnit(
                              it.length,
                              it.width,
                              it.height
                            );
                            return v === null ? '—' : v.toFixed(3);
                          })()}
                        </Td>
                        <Td className="text-center font-bold text-[13px]">
                          <StockCell
                            qty={it.stockQty}
                            reorder={it.reorderLevel}
                          />
                        </Td>
                        <Td className="text-center text-[12px] text-ink-3">
                          {it.reorderLevel}
                        </Td>
                        <Td className="text-center">
                          <StatusPill
                            qty={it.stockQty}
                            reorder={it.reorderLevel}
                          />
                        </Td>
                        <Td className="text-right whitespace-nowrap">
                          <div
                            className="inline-flex items-center gap-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              onClick={() => navigate(`/inventory/${it.id}`)}
                              className="text-ink-3 hover:text-brand p-1"
                              title="Edit SKU details"
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => navigate(`/inventory/${it.id}`)}
                              className="text-brand hover:text-brand-dark p-1 font-bold"
                              title="Add / Remove Stock"
                            >
                              <Plus size={13} />
                            </button>
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
      </div>

      {openId !== null && (
        <Suspense fallback={null}>
          <InventoryDrawer />
        </Suspense>
      )}

      {creating && (
        <Suspense fallback={null}>
          <NewInventoryModal onClose={() => setCreating(false)} />
        </Suspense>
      )}
    </>
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
      className={`text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-2 py-[5px] align-middle ${className}`} title={title}>
      {children}
    </td>
  );
}
