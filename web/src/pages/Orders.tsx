import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Search as SearchIcon } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/Badge';
import { api, qs, type Paginated } from '../lib/api';

type Order = {
  id: number;
  orderNumber: string;
  orderStatus: string;
  orderDate: string | null;
  storeId: number | null;
  clientId: number | null;
  customerEmail: string | null;
  shipToName: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  weightOz: number | null;
  orderTotal: string;
  carrierCode: string | null;
  serviceCode: string | null;
};

const statusLabels: Record<string, string> = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
  on_hold: 'On Hold',
  awaiting_payment: 'Awaiting Payment',
};

function formatDate(v: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function Orders() {
  const { status = 'awaiting_shipment' } = useParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const title = statusLabels[status] ?? 'Orders';

  const queryString = useMemo(
    () =>
      qs({
        page,
        pageSize,
        status,
        search: search || undefined,
      }),
    [page, status, search]
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['orders', queryString],
    queryFn: () => api.get<Paginated<Order>>(`/orders${queryString}`),
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;

  return (
    <>
      <Topbar title={title} />

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
            placeholder="Search order #, recipient, email…"
          />
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm">
          <Download size={12} />
          Export CSV
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-white">
        <table className="w-full text-sm2 border-collapse min-w-[800px]">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th>Order #</Th>
              <Th>Date</Th>
              <Th>Status</Th>
              <Th>Recipient</Th>
              <Th>City, State</Th>
              <Th className="text-right">Weight</Th>
              <Th className="text-right">Total</Th>
              <Th>Carrier</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="p-10 text-center text-ink-3">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={8} className="p-10 text-center text-danger">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">📦</div>
                  <div className="font-semibold text-ink-2">No orders here</div>
                  <div className="text-xs mt-1">
                    Once ShipStation sync is wired up, orders will land here.
                  </div>
                </td>
              </tr>
            )}
            {rows.map((o, i) => (
              <tr
                key={o.id}
                className={`cursor-pointer border-b border-line transition-colors ${
                  i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                } hover:!bg-brand-bg`}
              >
                <Td className="font-bold text-brand">{o.orderNumber}</Td>
                <Td className="text-ink-2">{formatDate(o.orderDate)}</Td>
                <Td>
                  <StatusBadge status={o.orderStatus} />
                </Td>
                <Td>{o.shipToName ?? '—'}</Td>
                <Td className="text-ink-2">
                  {[o.shipToCity, o.shipToState].filter(Boolean).join(', ') || '—'}
                </Td>
                <Td className="text-right font-mono">
                  {o.weightOz ? `${o.weightOz.toFixed(1)} oz` : '—'}
                </Td>
                <Td className="text-right font-mono">${o.orderTotal}</Td>
                <Td className="text-ink-2 uppercase text-tiny">
                  {o.carrierCode ?? '—'}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-t border-line text-tiny text-ink-3">
        <div>
          {total} order{total === 1 ? '' : 's'} — page {page} of {totalPages}
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
    </>
  );
}

function Th({
  children,
  className = '',
}: {
  children: React.ReactNode;
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-2 py-[5px] align-middle ${className}`}>{children}</td>;
}
