import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Card } from '../components/ui/Card';
import { ClientBadge } from '../components/ui/Badge';
import { api, qs } from '../lib/api';
import {
  SortableHeader,
  nextSortState,
  sortRows,
  type SortState,
} from '../components/SortableTable';

type Overview = {
  ordersToday: number;
  ordersWeek: number;
  ordersMonth: number;
  shippedToday: number;
  shippedWeek: number;
  shippedMonth: number;
  shippingCostMonth: string;
};

type SkuRow = {
  sku: string;
  name: string | null;
  image_url: string | null;
  client_id: number | null;
  orders: number;
  pending: number;
  ext_shipped: number;
  std_orders: number;
  std_total: string;
  exp_orders: number;
  exp_total: string;
  total_qty: number;
  total_shipping: string;
};

type SkuBreakdown = {
  data: SkuRow[];
  totalSkus: number;
  totalOrders: number;
};

type SkuDailyResp = {
  topSkus: { sku: string; name: string | null; total_qty: number }[];
  days: Record<string, number | string>[];
};

type Client = { id: number; name: string };
type AnalysisPageSortKey =
  | 'item'
  | 'sku'
  | 'client'
  | 'orders'
  | 'pending'
  | 'extShipped'
  | 'qty'
  | 'standard'
  | 'expedited'
  | 'shipping';

const LINE_COLORS = [
  '#2a5bd7',
  '#16a34a',
  '#d97706',
  '#dc2626',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
];

function isoStartOf(daysAgo: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}
function isoEndOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 0);
  return d.toISOString();
}
function toDateInput(iso: string) {
  return iso.slice(0, 10);
}
function fromDateInputStart(ymd: string) {
  return new Date(ymd + 'T00:00:00').toISOString();
}
function fromDateInputEnd(ymd: string) {
  return new Date(ymd + 'T23:59:59').toISOString();
}
function fmtMoney(s: string | number) {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

const RANGES = [
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '180d', label: '180d', days: 180 },
  { id: '1yr', label: '1yr', days: 365 },
  { id: 'all', label: 'All', days: 3650 },
] as const;

export default function Analysis() {
  const [activeRange, setActiveRange] = useState<typeof RANGES[number]['id']>('30d');
  const [dateFrom, setDateFrom] = useState(toDateInput(isoStartOf(30)));
  const [dateTo, setDateTo] = useState(toDateInput(isoEndOfToday()));
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState<string>('');
  const [sortState, setSortState] = useState<SortState<AnalysisPageSortKey>>(null);

  const setRange = (id: typeof RANGES[number]['id']) => {
    setActiveRange(id);
    const r = RANGES.find((x) => x.id === id)!;
    setDateFrom(toDateInput(isoStartOf(r.days)));
    setDateTo(toDateInput(isoEndOfToday()));
  };

  const rangeQs = useMemo(
    () =>
      qs({
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
        clientId: clientFilter || undefined,
      }),
    [dateFrom, dateTo, clientFilter]
  );

  const overview = useQuery({
    queryKey: ['analysis-overview'],
    queryFn: () => api.get<Overview>('/analysis/overview'),
  });

  const breakdown = useQuery({
    queryKey: ['analysis-sku-breakdown', rangeQs],
    queryFn: () => api.get<SkuBreakdown>(`/analysis/sku-breakdown${rangeQs}`),
  });

  const daily = useQuery({
    queryKey: ['analysis-sku-daily', rangeQs],
    queryFn: () => api.get<SkuDailyResp>(`/analysis/sku-daily${rangeQs}`),
  });

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<Client[]>('/clients'),
    staleTime: 60_000,
  });
  const clientsById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of clients.data ?? []) m.set(c.id, c.name);
    return m;
  }, [clients.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return breakdown.data?.data ?? [];
    return (breakdown.data?.data ?? []).filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        (r.name ?? '').toLowerCase().includes(q)
    );
  }, [breakdown.data, search]);
  const sortedFiltered = useMemo(
    () =>
      sortRows(
        filtered,
        sortState,
        (row, key) => {
          switch (key) {
            case 'item':
              return row.name;
            case 'sku':
              return row.sku;
            case 'client':
              return row.client_id == null ? '' : clientsById.get(row.client_id);
            case 'orders':
              return row.orders;
            case 'pending':
              return row.pending;
            case 'extShipped':
              return row.ext_shipped;
            case 'qty':
              return row.total_qty;
            case 'standard':
              return row.std_orders;
            case 'expedited':
              return row.exp_orders;
            case 'shipping':
              return Number(row.total_shipping);
            default:
              return '';
          }
        },
        (row) => row.sku
      ),
    [clientsById, filtered, sortState]
  );

  const maxQty = Math.max(1, ...sortedFiltered.map((r) => r.total_qty));

  return (
    <>
      <Topbar title="Analysis" />
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {overview.data && (
          <div className="flex items-center gap-6 px-4 py-2 bg-surface-2 border border-line rounded-card text-tiny">
            <Stat label="Orders today" value={overview.data.ordersToday} />
            <Stat label="Orders this week" value={overview.data.ordersWeek} />
            <Stat label="Orders this month" value={overview.data.ordersMonth} />
            <Stat label="Shipped this month" value={overview.data.shippedMonth} />
            <Stat label="Shipping cost (month)" value={fmtMoney(overview.data.shippingCostMonth)} />
          </div>
        )}

        <Card
          title="SKU Analysis"
          actions={
            <span className="text-tiny text-ink-3">
              {breakdown.data
                ? `${breakdown.data.totalSkus} SKUs · ${breakdown.data.totalOrders.toLocaleString()} orders`
                : '—'}
            </span>
          }
          bodyClassName=""
        >
          {/* Filter bar */}
          <div className="flex items-center flex-wrap gap-2 px-3.5 py-2.5 border-b border-line">
            <div className="flex items-center bg-white border border-line-2 rounded-btn overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRange(r.id)}
                  className={`px-2.5 py-1 text-[11px] font-semibold border-r border-line-2 last:border-r-0 transition-colors ${
                    activeRange === r.id
                      ? 'bg-brand text-white'
                      : 'text-ink-2 hover:bg-surface-2'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setActiveRange('all');
                setDateFrom(e.target.value);
              }}
              className="!py-1 !text-[11px] !w-[130px]"
            />
            <span className="text-ink-3 text-tiny">—</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setActiveRange('all');
                setDateTo(e.target.value);
              }}
              className="!py-1 !text-[11px] !w-[130px]"
            />
            <div className="w-[220px]">
              <Input
                leading={<SearchIcon size={13} />}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU or item…"
              />
            </div>
            <Select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
            >
              <option value="">All Clients</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>

          {/* Daily units sold — top SKUs */}
          {daily.data && daily.data.topSkus.length > 0 && (
            <div className="px-3.5 pt-3 pb-2 border-b border-line">
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[11px] font-bold uppercase tracking-[0.4px] text-ink-3">
                  Daily units sold — Top SKUs
                </div>
              </div>
              <div className="h-[220px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={daily.data.days}
                    margin={{ top: 5, right: 10, left: -10, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#eef0f4" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: '#8a95a3' }}
                      tickFormatter={(d: string) => d.slice(5)}
                      axisLine={{ stroke: '#e1e4e8' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#8a95a3' }}
                      axisLine={{ stroke: '#e1e4e8' }}
                      tickLine={false}
                      width={32}
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 11,
                        border: '1px solid #e1e4e8',
                        borderRadius: 6,
                        boxShadow: '0 4px 8px rgba(0,0,0,.08)',
                      }}
                      labelStyle={{ fontWeight: 700, color: '#1a1f2e' }}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                      iconType="line"
                    />
                    {daily.data.topSkus.map((s, i) => (
                      <Line
                        key={s.sku}
                        type="monotone"
                        dataKey={s.sku}
                        stroke={LINE_COLORS[i % LINE_COLORS.length]}
                        strokeWidth={1.5}
                        dot={false}
                        activeDot={{ r: 3 }}
                        name={s.name || s.sku}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {breakdown.isLoading ? (
            <div className="p-6 text-center text-ink-3 text-sm2">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-ink-3 text-sm2">
              No SKU data in this range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm2 border-collapse min-w-[1200px]">
                <thead className="bg-surface-2">
                  <tr>
                    <SortableHeader sortKey="item" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Item Name</SortableHeader>
                    <SortableHeader sortKey="sku" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="w-[160px] text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">SKU</SortableHeader>
                    <SortableHeader sortKey="client" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="w-[150px] text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Client</SortableHeader>
                    <SortableHeader sortKey="orders" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[80px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Orders</SortableHeader>
                    <SortableHeader sortKey="pending" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[90px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Pending</SortableHeader>
                    <SortableHeader sortKey="extShipped" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[100px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Ext. Shipped</SortableHeader>
                    <SortableHeader sortKey="qty" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[160px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Total Qty</SortableHeader>
                    <SortableHeader sortKey="standard" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[120px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Std Orders</SortableHeader>
                    <SortableHeader sortKey="expedited" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[120px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Exp Orders</SortableHeader>
                    <SortableHeader sortKey="shipping" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right w-[120px] px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Total Shipping</SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.map((r, i) => (
                    <tr
                      key={`${r.sku}-${r.client_id ?? 'none'}`}
                      className={`border-b border-line ${i % 2 === 1 ? 'bg-surface-2' : 'bg-white'}`}
                    >
                      <Td>
                        <div className="flex items-center gap-2 min-w-0">
                          {r.image_url && (
                            <img
                              src={r.image_url}
                              alt=""
                              className="w-7 h-7 rounded border border-line object-cover shrink-0"
                              loading="lazy"
                            />
                          )}
                          <span className="truncate" title={r.name ?? ''}>
                            {r.name ?? '—'}
                          </span>
                        </div>
                      </Td>
                      <Td className="font-mono text-tiny text-ink-2">{r.sku}</Td>
                      <Td>
                        {r.client_id !== null && clientsById.has(r.client_id) ? (
                          <ClientBadge name={clientsById.get(r.client_id)!} />
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-right font-mono font-bold text-warn">
                        {r.orders.toLocaleString()}
                      </Td>
                      <Td className="text-right font-mono">
                        {r.pending > 0 ? (
                          <span className="text-warn">
                            {r.pending}{' '}
                            <span className="text-ink-3 text-tiny">pend</span>
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-right font-mono">
                        {r.ext_shipped > 0 ? (
                          <span className="text-ink-2">
                            {r.ext_shipped}{' '}
                            <span className="text-ink-3 text-tiny">ext</span>
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-20 h-1.5 rounded bg-surface-3 overflow-hidden">
                            <div
                              className="h-full bg-brand"
                              style={{
                                width: `${(r.total_qty / maxQty) * 100}%`,
                              }}
                            />
                          </div>
                          <span className="font-mono font-semibold w-10 text-right">
                            {r.total_qty}
                          </span>
                        </div>
                      </Td>
                      <Td className="text-right font-mono">
                        {r.std_orders > 0 ? (
                          <>
                            {r.std_orders}{' '}
                            <span className="text-ok-dark text-tiny">
                              {fmtMoney(r.std_total)}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-right font-mono">
                        {r.exp_orders > 0 ? (
                          <>
                            {r.exp_orders}{' '}
                            <span className="text-brand text-tiny">
                              {fmtMoney(r.exp_total)}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </Td>
                      <Td className="text-right font-mono font-semibold">
                        {fmtMoney(r.total_shipping)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[15px] font-extrabold text-ink leading-tight">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.5px] text-ink-3 mt-0.5">
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
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-2 py-2 align-middle ${className}`}>{children}</td>;
}
