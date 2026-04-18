import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search as SearchIcon } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { api, qs, type Paginated } from '../lib/api';

const InventoryDrawer = lazy(() => import('../components/InventoryDrawer'));

type Item = {
  id: number;
  clientId: number | null;
  sku: string;
  name: string | null;
  stockQty: number;
  reorderLevel: number;
  weightOz: number | null;
  active: boolean;
  updatedAt: string;
};

type Stats = {
  total: number;
  low_stock: number;
  out_of_stock: number;
  total_units: number;
};

function stockTone(stockQty: number, reorderLevel: number) {
  if (stockQty <= 0) return 'text-danger font-bold';
  if (stockQty <= reorderLevel) return 'text-warn font-semibold';
  return 'text-ink';
}

export default function Inventory() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const openId = id ? Number(id) : null;

  const queryString = useMemo(
    () =>
      qs({
        page,
        pageSize,
        search: search || undefined,
        lowStock: lowStock || undefined,
      }),
    [page, search, lowStock]
  );

  const { data, isLoading } = useQuery({
    queryKey: ['inventory', queryString],
    queryFn: () => api.get<Paginated<Item>>(`/inventory${queryString}`),
  });

  const { data: stats } = useQuery({
    queryKey: ['inventory-stats'],
    queryFn: () => api.get<Stats>('/inventory/stats'),
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;

  return (
    <>
      <Topbar
        title="Inventory"
        right={
          <Button variant="primary" size="sm">
            <Plus size={12} />
            New item
          </Button>
        }
      />

      {/* Stats strip */}
      {stats && (
        <div className="flex items-center gap-6 px-4 py-2 bg-surface-2 border-b border-line text-tiny">
          <Stat label="Total SKUs" value={stats.total} />
          <Stat label="Low stock" value={stats.low_stock} tone="text-warn" />
          <Stat
            label="Out of stock"
            value={stats.out_of_stock}
            tone="text-danger"
          />
          <Stat label="Total units" value={stats.total_units} />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 bg-white border-b border-line">
        <div className="w-[280px]">
          <Input
            leading={<SearchIcon size={13} />}
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder="Search SKU or name…"
          />
        </div>
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
          Low stock only
        </label>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-white">
        <table className="w-full text-sm2 border-collapse min-w-[700px]">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th>SKU</Th>
              <Th>Name</Th>
              <Th className="text-right">Stock</Th>
              <Th className="text-right">Reorder at</Th>
              <Th className="text-right">Weight</Th>
              <Th>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="p-10 text-center text-ink-3">
                  Loading…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">📦</div>
                  <div className="font-semibold text-ink-2">No items</div>
                  <div className="text-xs mt-1">
                    Add your first SKU with the "New item" button.
                  </div>
                </td>
              </tr>
            )}
            {rows.map((it, i) => (
              <tr
                key={it.id}
                onClick={() => navigate(`/inventory/${it.id}`)}
                className={`cursor-pointer border-b border-line transition-colors ${
                  i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                } ${openId === it.id ? '!bg-brand-bg' : ''} hover:!bg-brand-bg`}
              >
                <Td className="font-mono font-semibold">{it.sku}</Td>
                <Td>{it.name ?? <span className="text-ink-3">—</span>}</Td>
                <Td
                  className={`text-right font-mono ${stockTone(it.stockQty, it.reorderLevel)}`}
                >
                  {it.stockQty}
                </Td>
                <Td className="text-right font-mono text-ink-2">
                  {it.reorderLevel}
                </Td>
                <Td className="text-right font-mono text-ink-2">
                  {it.weightOz ? `${it.weightOz.toFixed(1)} oz` : '—'}
                </Td>
                <Td className="text-ink-2 text-tiny">
                  {new Date(it.updatedAt).toLocaleDateString()}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-t border-line text-tiny text-ink-3">
        <div>
          {total} item{total === 1 ? '' : 's'} — page {page} of {totalPages}
        </div>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="xs"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Prev
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>

      {openId !== null && (
        <Suspense fallback={null}>
          <InventoryDrawer />
        </Suspense>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  tone = 'text-ink',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div>
      <div className={`text-[15px] font-extrabold ${tone}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.5px] text-ink-3">
        {label}
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-[5px] align-middle ${className}`}>{children}</td>;
}
