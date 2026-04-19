import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Download,
  Package as PackageIcon,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { StatusBadge, ClientBadge } from '../components/ui/Badge';
import { SkeletonRow } from '../components/ui/Skeleton';
import { api, qs, type Paginated } from '../lib/api';

const OrderDrawer = lazy(() => import('../components/OrderDrawer'));

type OrderItem = {
  orderItemId?: number;
  sku?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
};

type RawShipTo = {
  street1?: string;
  street2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  residential?: boolean | null;
};

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
  shipToPostalCode: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  weightOz: number | null;
  orderTotal: string;
  items: OrderItem[];
  raw?: { shipTo?: RawShipTo; [key: string]: unknown };
  overrides?: {
    bestRateJson?: { shipping_amount?: { amount?: number } } | null;
  } | null;
};

const statusLabels: Record<string, string> = {
  awaiting_shipment: 'Awaiting Shipment',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
  on_hold: 'On Hold',
  awaiting_payment: 'Awaiting Payment',
};

const dateRanges = [
  { id: '7d', label: 'Last 7 Days', days: 7 },
  { id: '30d', label: 'Last 30 Days', days: 30 },
  { id: '90d', label: 'Last 90 Days', days: 90 },
  { id: 'all', label: 'All time', days: 3650 },
] as const;

function formatDate(v: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatWeight(oz: number | null) {
  if (oz === null || oz <= 0) return '—';
  const lb = Math.floor(oz / 16);
  const remain = Math.round((oz - lb * 16) * 10) / 10;
  if (lb === 0) return `${remain} oz`;
  if (remain === 0) return `${lb} lb`;
  return `${lb} lb ${remain} oz`;
}

function totalQty(items: OrderItem[]) {
  return items.reduce((s, i) => s + (i.quantity ?? 0), 0);
}

function isoStartDaysAgo(days: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default function Orders() {
  const { status = 'awaiting_shipment', orderId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const clientIdParam = searchParams.get('clientId');
  const clientIdFilter = clientIdParam ? Number(clientIdParam) : undefined;
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rangeId, setRangeId] = useState<typeof dateRanges[number]['id']>('30d');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const pageSize = 50;
  const openId = orderId ? Number(orderId) : null;

  const clientName = useQuery({
    queryKey: ['client-name', clientIdFilter],
    queryFn: () =>
      api.get<{ id: number; name: string }>(`/clients/${clientIdFilter}`),
    enabled: clientIdFilter !== undefined,
    staleTime: 60_000,
  });

  const title = statusLabels[status] ?? 'Orders';

  const dateFromIso = useMemo(() => {
    const r = dateRanges.find((x) => x.id === rangeId)!;
    return isoStartDaysAgo(r.days);
  }, [rangeId]);

  const queryString = useMemo(
    () =>
      qs({
        page,
        pageSize,
        status,
        clientId: clientIdFilter,
        search: search || undefined,
        dateFrom: dateFromIso,
      }),
    [page, status, clientIdFilter, search, dateFromIso]
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['orders', queryString],
    queryFn: () => api.get<Paginated<Order>>(`/orders${queryString}`),
  });

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ id: number; name: string }[]>('/clients'),
    staleTime: 60_000,
  });
  const clientsById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of clients.data ?? []) m.set(c.id, c.name);
    return m;
  }, [clients.data]);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      if (prev.size === rows.length) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  };

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
            placeholder="Search orders, SKUs, names…"
          />
        </div>
        <Select
          value={rangeId}
          onChange={(e) => {
            setPage(1);
            setRangeId(e.target.value as typeof dateRanges[number]['id']);
          }}
        >
          {dateRanges.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </Select>
        {clientIdFilter !== undefined && (
          <button
            type="button"
            onClick={() => {
              setPage(1);
              setSearchParams({});
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-brand-bg text-brand text-tiny font-semibold border border-brand/30 hover:bg-brand-bg/80"
          >
            <span>Client:</span>
            <span className="font-bold">
              {clientName.data?.name ?? `#${clientIdFilter}`}
            </span>
            <X size={11} />
          </button>
        )}
        {selected.size > 0 && (
          <span className="text-tiny text-brand font-semibold px-2">
            {selected.size} selected
          </span>
        )}
        <div className="flex-1" />
        <Button variant="outline" size="sm">
          <Download size={12} />
          Export CSV
        </Button>
      </div>

      {/* Stats strip */}
      <div className="flex items-center gap-6 px-4 py-2 bg-surface-2 border-b border-line text-tiny">
        <Stat label="Total" value={total} />
        <Stat
          label={status === 'awaiting_shipment' ? 'Need to ship' : title}
          value={total}
          tone={status === 'awaiting_shipment' ? 'text-warn' : undefined}
        />
        <div className="text-ink-3 ml-auto">
          {dateRanges.find((r) => r.id === rangeId)?.label}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto bg-white">
        <table className="w-full text-sm2 border-collapse min-w-[1500px]">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th className="w-[36px]">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                  className="accent-brand"
                />
              </Th>
              <Th className="w-[130px]">Order Date</Th>
              <Th className="w-[140px]">Client</Th>
              <Th className="w-[160px]">Order #</Th>
              <Th className="w-[160px]">Recipient</Th>
              <Th>Item Name</Th>
              <Th className="w-[140px]">SKU</Th>
              <Th className="text-right w-[60px]">Qty</Th>
              <Th className="w-[90px]">Weight</Th>
              <Th className="w-[180px]">Ship To</Th>
              <Th className="w-[80px]">Carrier</Th>
              <Th className="text-right w-[110px]">Order Total</Th>
              <Th className="text-right w-[110px]">Best Rate</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 10 }).map((_, i) => (
                <SkeletonRow key={`sk-${i}`} cols={13} />
              ))}
            {isError && (
              <tr>
                <td colSpan={13} className="p-10 text-center text-danger">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={13} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">📦</div>
                  <div className="font-semibold text-ink-2">No orders here</div>
                </td>
              </tr>
            )}
            {rows.map((o, i) => {
              const items = o.items ?? [];
              const firstItem = items[0];
              const moreCount = items.length - 1;
              const qty = totalQty(items);
              const isMulti = items.length > 1;
              const cityLine = [o.shipToCity, o.shipToState, o.shipToPostalCode]
                .filter(Boolean)
                .join(', ');
              const country = o.raw?.shipTo?.country;
              const bestRate = o.overrides?.bestRateJson?.shipping_amount?.amount;
              const isOpen = openId === o.id;
              const isSelected = selected.has(o.id);
              return (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${status}/${o.id}`)}
                  className={`cursor-pointer border-b border-line transition-colors ${
                    i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                  } ${isOpen ? '!bg-brand-bg' : ''} ${
                    isSelected ? '!bg-blue-50' : ''
                  } hover:!bg-brand-bg`}
                >
                  <Td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(o.id)}
                      className="accent-brand"
                    />
                  </Td>
                  <Td className="text-ink-2 whitespace-nowrap text-tiny">
                    {formatDate(o.orderDate)}
                  </Td>
                  <Td>
                    {o.clientId !== null && clientsById.has(o.clientId) ? (
                      <ClientBadge name={clientsById.get(o.clientId)!} />
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="font-bold text-brand">{o.orderNumber}</div>
                    <div className="mt-0.5">
                      <StatusBadge status={o.orderStatus} />
                    </div>
                  </Td>
                  <Td className="text-ink truncate max-w-[160px]">
                    {o.shipToName ?? '—'}
                  </Td>
                  <Td className="min-w-0">
                    <div className="flex items-start gap-2">
                      <div className="w-7 h-7 rounded border border-line bg-surface-2 shrink-0 flex items-center justify-center overflow-hidden">
                        {firstItem?.imageUrl ? (
                          <img
                            src={firstItem.imageUrl}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <PackageIcon size={12} className="text-ink-3" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className="text-sm2 text-ink truncate"
                          title={firstItem?.name ?? ''}
                        >
                          {firstItem?.name ?? '—'}
                        </div>
                        {moreCount > 0 && (
                          <div className="text-tiny text-ink-3">
                            +{moreCount} more
                          </div>
                        )}
                      </div>
                    </div>
                  </Td>
                  <Td className="font-mono text-tiny text-ink-2">
                    {firstItem?.sku ?? '—'}
                    {moreCount > 0 && (
                      <div className="text-ink-3">+{moreCount}</div>
                    )}
                  </Td>
                  <Td className="text-right">
                    {isMulti ? (
                      <span className="inline-block px-1.5 py-0.5 border border-danger rounded text-danger font-mono font-bold">
                        {qty}
                      </span>
                    ) : (
                      <span className="font-mono">{qty || 1}</span>
                    )}
                  </Td>
                  <Td className="font-mono text-ink-2 whitespace-nowrap">
                    {formatWeight(o.weightOz)}
                  </Td>
                  <Td className="text-tiny leading-tight">
                    <div className="text-ink truncate" title={cityLine}>
                      {cityLine || '—'}
                    </div>
                    {country && country !== 'US' && (
                      <div className="text-ink-3">{country}</div>
                    )}
                  </Td>
                  <Td className="uppercase text-tiny font-semibold text-ink-2">
                    {o.carrierCode ?? '—'}
                  </Td>
                  <Td className="text-right font-mono">${o.orderTotal}</Td>
                  <Td className="text-right font-mono">
                    {bestRate ? (
                      <span className="text-ok-dark font-bold">
                        ${bestRate.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                </tr>
              );
            })}
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

      {openId !== null && (
        <Suspense fallback={null}>
          <OrderDrawer />
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
      <div className={`text-[15px] font-extrabold leading-tight ${tone}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.5px] text-ink-3">
        {label}
      </div>
    </div>
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
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <td
      onClick={onClick}
      className={`px-2 py-[5px] align-top ${className}`}
    >
      {children}
    </td>
  );
}
