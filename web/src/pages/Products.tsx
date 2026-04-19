import { lazy, Suspense, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Pencil,
  Plus,
  Search as SearchIcon,
  Trash2,
  Package as PackageIcon,
} from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { SkeletonRow } from '../components/ui/Skeleton';
import { api, qs, type Paginated } from '../lib/api';

const ProductModal = lazy(() => import('../components/ProductModal'));

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
  updatedAt: string;
};

function formatWeight(oz: number) {
  if (!oz || oz <= 0) return '—';
  const lb = Math.floor(oz / 16);
  const remain = Math.round((oz - lb * 16) * 10) / 10;
  if (lb === 0) return `${remain} oz`;
  if (remain === 0) return `${lb} lb`;
  return `${lb} lb ${remain} oz`;
}

function formatDims(l: number, w: number, h: number) {
  if (!l || !w || !h) return '—';
  return `${l}×${w}×${h}`;
}

export default function Products() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const pageSize = 100;

  const queryString = useMemo(
    () => qs({ page, pageSize, search: search || undefined }),
    [page, search]
  );

  const { data, isLoading } = useQuery({
    queryKey: ['products', queryString],
    queryFn: () => api.get<Paginated<Product>>(`/products${queryString}`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/products/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['products'] }),
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;

  return (
    <>
      <Topbar
        title="Products"
        right={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} />
            New product
          </Button>
        }
      />

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
            placeholder="Filter SKU or name…"
          />
        </div>
        <div className="flex-1" />
        <div className="text-tiny text-ink-3">
          {total} product{total === 1 ? '' : 's'}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-white">
        <table className="w-full text-sm2 border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th className="w-[44px]"></Th>
              <Th className="w-[160px]">SKU</Th>
              <Th>Name</Th>
              <Th className="w-[110px]">Weight</Th>
              <Th className="w-[110px]">Dims (L×W×H)</Th>
              <Th className="w-[180px]">Default package</Th>
              <Th className="w-[80px]"></Th>
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 8 }).map((_, i) => (
                <SkeletonRow key={`sk-${i}`} cols={7} />
              ))}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">📦</div>
                  <div className="font-semibold text-ink-2">No products</div>
                  <div className="text-xs mt-1">
                    Add SKU defaults — used by orders and inventory as the
                    source of truth for weight and dimensions.
                  </div>
                </td>
              </tr>
            )}
            {rows.map((p, i) => (
              <tr
                key={p.id}
                className={`border-b border-line ${
                  i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                } hover:!bg-brand-bg`}
              >
                <td className="px-2 py-2">
                  <div className="w-8 h-8 rounded border border-line bg-surface-2 flex items-center justify-center overflow-hidden">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <PackageIcon size={14} className="text-ink-3" />
                    )}
                  </div>
                </td>
                <td className="px-2 py-2 font-mono font-semibold text-brand">
                  {p.sku ?? '—'}
                </td>
                <td className="px-2 py-2 text-ink truncate max-w-[420px]" title={p.name ?? ''}>
                  {p.name ?? '—'}
                </td>
                <td className="px-2 py-2 font-mono text-ink-2">
                  {formatWeight(p.weightOz)}
                </td>
                <td className="px-2 py-2 font-mono text-ink-2">
                  {formatDims(p.length, p.width, p.height)}
                </td>
                <td className="px-2 py-2 font-mono text-tiny text-ink-2">
                  {p.defaultPackageCode ?? '—'}
                </td>
                <td className="px-2 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(p)}
                      className="text-ink-3 hover:text-brand p-1"
                      title="Edit"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete product ${p.sku}?`)) {
                          remove.mutate(p.id);
                        }
                      }}
                      className="text-ink-3 hover:text-danger p-1"
                      title="Delete"
                      disabled={remove.isPending}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-t border-line text-tiny text-ink-3">
        <div>
          page {page} of {totalPages}
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

      {(creating || editing) && (
        <Suspense fallback={null}>
          <ProductModal
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
