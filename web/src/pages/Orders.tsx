import { createContext, lazy, Suspense, useContext, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar,
  ClipboardList,
  Download,
  Package as PackageIcon,
  Printer,
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
const BatchLabelModal = lazy(() => import('../components/BatchLabelModal'));
const PrintQueueDrawer = lazy(() => import('../components/PrintQueueDrawer'));
import OrdersTopbarActions from '../components/OrdersTopbarActions';
import type { ColumnDef } from '../components/ColumnsPopover';

const COLUMN_DEFS: ColumnDef[] = [
  { id: 'orderDate', label: 'Order Date' },
  { id: 'client', label: 'Client' },
  { id: 'recipient', label: 'Recipient' },
  { id: 'itemName', label: 'Item Name' },
  { id: 'sku', label: 'SKU' },
  { id: 'qty', label: 'Qty' },
  { id: 'weight', label: 'Weight' },
  { id: 'shipTo', label: 'Ship To' },
  { id: 'carrier', label: 'Carrier' },
  { id: 'shippingAccount', label: 'Shipping Account' },
  { id: 'orderTotal', label: 'Order Total' },
  { id: 'bestRate', label: 'Best Rate' },
  { id: 'shipMargin', label: 'Ship Margin' },
  { id: 'tracking', label: 'Tracking #' },
  { id: 'age', label: 'Age' },
  { id: 'labelCreated', label: 'Label Created' },
];

const DEFAULT_VISIBLE = new Set([
  'orderDate',
  'client',
  'recipient',
  'itemName',
  'sku',
  'qty',
  'weight',
  'shipTo',
  'carrier',
  'orderTotal',
  'bestRate',
]);

const COLUMNS_KEY = 'prepship_orders_columns';

type Density = 'xs' | 'sm' | 'md' | 'lg';
const DENSITY_LEVELS: Density[] = ['xs', 'sm', 'md', 'lg'];
const DENSITY_LABEL: Record<Density, string> = {
  xs: 'XS',
  sm: 'S',
  md: 'M',
  lg: 'L',
};
const TH_DENSITY: Record<Density, string> = {
  xs: 'px-1.5 py-0.5 text-[9px]',
  sm: 'px-2 py-1 text-[10px]',
  md: 'px-2 py-1.5 text-[10.5px]',
  lg: 'px-3 py-2 text-[11.5px]',
};
const TD_DENSITY: Record<Density, string> = {
  xs: 'px-1.5 py-[2px] text-[10.5px]',
  sm: 'px-2 py-[3px] text-[11px]',
  md: 'px-2 py-[5px] text-[12px]',
  lg: 'px-3 py-[8px] text-[13.5px]',
};
const DENSITY_KEY = 'prepship_orders_density';

function loadDensity(): Density {
  const v = localStorage.getItem(DENSITY_KEY);
  return DENSITY_LEVELS.includes(v as Density) ? (v as Density) : 'md';
}

const DensityContext = createContext<Density>('md');

type Widths = Record<string, number>;

const DEFAULT_WIDTHS: Widths = {
  select: 36,
  orderNumber: 160,
  orderDate: 130,
  client: 140,
  recipient: 160,
  itemName: 240,
  sku: 140,
  qty: 60,
  weight: 90,
  shipTo: 180,
  carrier: 80,
  shippingAccount: 140,
  orderTotal: 110,
  bestRate: 110,
  shipMargin: 100,
  tracking: 160,
  age: 80,
  labelCreated: 130,
};

const COLUMN_ORDER = [
  'select',
  'orderNumber',
  'orderDate',
  'client',
  'recipient',
  'itemName',
  'sku',
  'qty',
  'weight',
  'shipTo',
  'carrier',
  'shippingAccount',
  'orderTotal',
  'bestRate',
  'shipMargin',
  'tracking',
  'age',
  'labelCreated',
] as const;

const WIDTHS_KEY = 'prepship_orders_widths';

function loadWidths(): Widths {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (!raw) return { ...DEFAULT_WIDTHS };
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      return { ...DEFAULT_WIDTHS, ...obj };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_WIDTHS };
}

type WidthsCtx = {
  widths: Widths;
  startResize: (id: string, e: React.MouseEvent) => void;
};
const WidthsContext = createContext<WidthsCtx | null>(null);

function loadVisible(): Set<string> {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (!raw) return new Set(DEFAULT_VISIBLE);
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
  } catch {
    /* ignore */
  }
  return new Set(DEFAULT_VISIBLE);
}

function saveVisible(set: Set<string>) {
  localStorage.setItem(COLUMNS_KEY, JSON.stringify([...set]));
}

function formatRangeWindow(rangeId: string, dateFromIso: string): string {
  if (rangeId === 'all') return 'All time';
  const start = new Date(dateFromIso);
  const end = new Date();
  const fmt = (d: Date) =>
    d
      .toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        hour12: true,
        timeZoneName: 'short',
      })
      .replace(' AM', 'am')
      .replace(' PM', 'pm');
  return `${fmt(start)} → ${fmt(end)}`;
}

function ageStr(iso: string | null) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h`;
  const m = Math.floor(ms / 60000);
  return `${m}m`;
}

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
  const [batchOpen, setBatchOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Set<string>>(() =>
    loadVisible()
  );
  const [density, setDensity] = useState<Density>(() => loadDensity());
  const [widths, setWidths] = useState<Widths>(() => loadWidths());

  const startResize = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[id] ?? DEFAULT_WIDTHS[id] ?? 100;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const next = Math.max(40, Math.round(startW + dx));
      setWidths((prev) => ({ ...prev, [id]: next }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidths((prev) => {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(prev));
        return prev;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const widthsCtxValue = useMemo<WidthsCtx>(
    () => ({ widths, startResize }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [widths]
  );

  const activeColumnIds = useMemo(
    () =>
      COLUMN_ORDER.filter(
        (id) => id === 'select' || id === 'orderNumber' || visibleColumns.has(id)
      ),
    [visibleColumns]
  );

  const totalTableWidth = useMemo(
    () => activeColumnIds.reduce((sum, id) => sum + (widths[id] ?? DEFAULT_WIDTHS[id] ?? 100), 0),
    [activeColumnIds, widths]
  );

  const cycleDensity = () => {
    setDensity((prev) => {
      const idx = DENSITY_LEVELS.indexOf(prev);
      const next = DENSITY_LEVELS[(idx + 1) % DENSITY_LEVELS.length]!;
      localStorage.setItem(DENSITY_KEY, next);
      return next;
    });
  };

  const toggleColumn = (id: string) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVisible(next);
      return next;
    });
  };

  const visCount = COLUMN_DEFS.filter((c) => visibleColumns.has(c.id)).length + 1; // +1 for checkbox col
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

  // Counts for the progress bar — total in window + shipped in window,
  // independent of the current status filter.
  const totalInWindowQs = useMemo(
    () =>
      qs({
        pageSize: 1,
        clientId: clientIdFilter,
        dateFrom: dateFromIso,
      }),
    [clientIdFilter, dateFromIso]
  );
  const shippedInWindowQs = useMemo(
    () =>
      qs({
        pageSize: 1,
        status: 'shipped',
        clientId: clientIdFilter,
        dateFrom: dateFromIso,
      }),
    [clientIdFilter, dateFromIso]
  );
  const totalInWindow = useQuery({
    queryKey: ['orders-total-window', totalInWindowQs],
    queryFn: () =>
      api.get<Paginated<unknown>>(`/orders${totalInWindowQs}`),
    staleTime: 30_000,
  });
  const shippedInWindow = useQuery({
    queryKey: ['orders-shipped-window', shippedInWindowQs],
    queryFn: () =>
      api.get<Paginated<unknown>>(`/orders${shippedInWindowQs}`),
    staleTime: 30_000,
  });
  const totalWindowCount =
    totalInWindow.data?.pagination.total ?? 0;
  const shippedWindowCount =
    shippedInWindow.data?.pagination.total ?? 0;
  const shippedPct =
    totalWindowCount > 0
      ? Math.round((shippedWindowCount / totalWindowCount) * 100)
      : 0;

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
      <Topbar
        title={title}
        right={
          <OrdersTopbarActions
            onOpenQueue={() => setQueueOpen(true)}
            columns={COLUMN_DEFS}
            visibleColumns={visibleColumns}
            onToggleColumn={toggleColumn}
            density={DENSITY_LABEL[density]}
            onCycleDensity={cycleDensity}
          />
        }
      />

      {/* Filter bar */}
      <div className="flex items-center flex-wrap gap-3 px-4 py-2 bg-white border-b border-line">
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
        <Select value="" onChange={() => {}}>
          <option value="">All SKUs</option>
        </Select>
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
        <button
          type="button"
          onClick={toggleAll}
          className="text-[12px] font-semibold text-ink-2 hover:text-ink"
        >
          Select All
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink-2 hover:text-ink"
        >
          <ClipboardList size={12} />
          SKU Sort
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink-2 hover:text-ink"
        >
          <Download size={12} />
          Export CSV
        </button>
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
          <>
            <span className="text-tiny text-brand font-semibold px-2">
              {selected.size} selected
            </span>
            <Button
              variant="green"
              size="sm"
              onClick={() => setBatchOpen(true)}
            >
              <Printer size={12} />
              Buy {selected.size} labels
            </Button>
          </>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            const url = `/picklist?status=${status}${
              clientIdFilter ? `&clientId=${clientIdFilter}` : ''
            }`;
            window.open(url, '_blank');
          }}
          className="inline-flex items-center gap-1 px-2 py-[5px] rounded-btn border border-line-2 bg-white text-ink-2 hover:bg-surface-2 hover:text-ink text-[12px] font-semibold"
        >
          <ClipboardList size={12} />
          Picklist
        </button>
      </div>

      {/* Stats strip */}
      <div className="flex items-center flex-nowrap gap-5 px-4 py-1.5 bg-surface-2 border-b border-line text-tiny whitespace-nowrap overflow-x-auto">
        <div className="inline-flex items-center gap-1.5 text-ink-2 shrink-0">
          <Calendar size={12} className="text-brand" />
          <span className="font-semibold">
            {formatRangeWindow(rangeId, dateFromIso)}
          </span>
          {rangeId !== 'all' && (
            <span className="text-ink-3">(shifts at 6 PM)</span>
          )}
        </div>

        <div className="w-px h-7 bg-line shrink-0" />

        <Stat
          icon="📦"
          value={total.toLocaleString()}
          valueClass="text-ink"
          label="Total Orders"
        />

        <Stat
          icon="🚚"
          value={(status === 'awaiting_shipment' ? total : 0).toLocaleString()}
          valueClass="text-orange-500"
          label="Need to Ship"
        />

        <Stat
          icon="🔔"
          value="0"
          valueClass="text-amber-500"
          label="Upcoming"
        />

        <div className="flex-1 flex items-center gap-2 ml-auto min-w-[240px] max-w-[460px] shrink-0">
          <span className="text-orange-600 font-semibold whitespace-nowrap">
            {shippedWindowCount.toLocaleString()} of{' '}
            {totalWindowCount.toLocaleString()} shipped
          </span>
          <div className="flex-1 h-1 bg-surface-3 rounded overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all"
              style={{ width: `${shippedPct}%` }}
            />
          </div>
          <span className="text-orange-600 font-semibold whitespace-nowrap">
            {shippedPct}%
          </span>
        </div>
      </div>

      {/* Table + right panel */}
      <DensityContext.Provider value={density}>
      <WidthsContext.Provider value={widthsCtxValue}>
      <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-h-0 overflow-auto bg-white min-w-0">
        <table className="text-sm2 border-collapse table-fixed" style={{ width: totalTableWidth }}>
          <colgroup>
            {activeColumnIds.map((id) => (
              <col key={id} style={{ width: widths[id] }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              <Th>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                  className="accent-brand"
                />
              </Th>
              <Th id="orderNumber">Order #</Th>
              {visibleColumns.has('orderDate') && <Th id="orderDate">Order Date</Th>}
              {visibleColumns.has('client') && <Th id="client">Client</Th>}
              {visibleColumns.has('recipient') && <Th id="recipient">Recipient</Th>}
              {visibleColumns.has('itemName') && <Th id="itemName">Item Name</Th>}
              {visibleColumns.has('sku') && <Th id="sku">SKU</Th>}
              {visibleColumns.has('qty') && <Th id="qty" className="text-right">Qty</Th>}
              {visibleColumns.has('weight') && <Th id="weight">Weight</Th>}
              {visibleColumns.has('shipTo') && <Th id="shipTo">Ship To</Th>}
              {visibleColumns.has('carrier') && <Th id="carrier">Carrier</Th>}
              {visibleColumns.has('shippingAccount') && (
                <Th id="shippingAccount">Shipping Account</Th>
              )}
              {visibleColumns.has('orderTotal') && (
                <Th id="orderTotal" className="text-right">Order Total</Th>
              )}
              {visibleColumns.has('bestRate') && (
                <Th id="bestRate" className="text-right">Best Rate</Th>
              )}
              {visibleColumns.has('shipMargin') && (
                <Th id="shipMargin" className="text-right">Ship Margin</Th>
              )}
              {visibleColumns.has('tracking') && (
                <Th id="tracking">Tracking #</Th>
              )}
              {visibleColumns.has('age') && <Th id="age">Age</Th>}
              {visibleColumns.has('labelCreated') && (
                <Th id="labelCreated">Label Created</Th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 10 }).map((_, i) => (
                <SkeletonRow key={`sk-${i}`} cols={visCount} />
              ))}
            {isError && (
              <tr>
                <td colSpan={visCount} className="p-10 text-center text-danger">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={visCount} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">📦</div>
                  <div className="font-semibold text-ink-2">No orders here</div>
                </td>
              </tr>
            )}
            {rows.map((o, i) => {
              const items = o.items ?? [];
              const firstItem = items[0];
              const qty = totalQty(items);
              const isMulti = items.length > 1;
              const cityLine = [o.shipToCity, o.shipToState, o.shipToPostalCode]
                .filter(Boolean)
                .join(', ');
              const country = o.raw?.shipTo?.country;
              const bestRate = o.overrides?.bestRateJson?.shipping_amount?.amount;
              const isOpen = openId === o.id;
              const isSelected = selected.has(o.id);
              const visibleItems = items.slice(0, 5);
              const overflowItems = items.length - visibleItems.length;
              return (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${status}/${o.id}`)}
                  className={`cursor-pointer border-b border-line transition-colors relative ${
                    i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                  } ${isOpen ? '!bg-warn-bg' : ''} ${
                    isSelected ? '!bg-brand-bg' : ''
                  } hover:!bg-warn-bg/60`}
                  style={
                    isOpen
                      ? {
                          boxShadow: 'inset 3px 0 0 #d97706',
                        }
                      : undefined
                  }
                >
                  <Td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(o.id)}
                      className="accent-brand"
                    />
                  </Td>
                  <Td>
                    <div className="font-bold text-brand">{o.orderNumber}</div>
                    <div className="mt-0.5">
                      <StatusBadge status={o.orderStatus} />
                    </div>
                  </Td>
                  {visibleColumns.has('orderDate') && (
                    <Td className="text-ink-2 whitespace-nowrap text-tiny">
                      {formatDate(o.orderDate)}
                    </Td>
                  )}
                  {visibleColumns.has('client') && (
                    <Td>
                      {o.clientId !== null && clientsById.has(o.clientId) ? (
                        <ClientBadge name={clientsById.get(o.clientId)!} />
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('recipient') && (
                    <Td className="text-ink truncate max-w-[160px]">
                      {o.shipToName ?? '—'}
                    </Td>
                  )}
                  {visibleColumns.has('itemName') && (
                    <Td className="min-w-0">
                      {isMulti ? (
                        <div className="flex flex-col gap-[3px]">
                          {visibleItems.map((it, idx) => (
                            <div
                              key={idx}
                              className="flex items-center gap-1.5 min-w-0"
                            >
                              <div className="w-[22px] h-[22px] rounded border border-line bg-surface-2 shrink-0 flex items-center justify-center overflow-hidden">
                                {it.imageUrl ? (
                                  <img
                                    src={it.imageUrl}
                                    alt=""
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                ) : (
                                  <PackageIcon
                                    size={10}
                                    className="text-ink-3"
                                  />
                                )}
                              </div>
                              <span
                                className="text-[11.5px] text-ink truncate flex-1 min-w-0"
                                title={it.name ?? it.sku ?? ''}
                              >
                                {it.name ?? it.sku ?? '—'}
                              </span>
                              {(it.quantity ?? 1) > 1 && (
                                <span className="bg-brand-bg text-brand text-[9.5px] font-bold px-1 py-0 rounded shrink-0">
                                  ×{it.quantity}
                                </span>
                              )}
                            </div>
                          ))}
                          {overflowItems > 0 && (
                            <div className="text-[10.5px] text-ink-3 pl-[27px]">
                              +{overflowItems} more
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="w-7 h-7 rounded border border-line bg-surface-2 shrink-0 flex items-center justify-center overflow-hidden">
                            {firstItem?.imageUrl ? (
                              <img
                                src={firstItem.imageUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <PackageIcon
                                size={12}
                                className="text-ink-3"
                              />
                            )}
                          </div>
                          <span
                            className="text-[12px] text-ink truncate flex-1 min-w-0"
                            title={firstItem?.name ?? ''}
                          >
                            {firstItem?.name ?? '—'}
                          </span>
                        </div>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('sku') && (
                    <Td className="font-mono text-tiny text-ink-2">
                      {isMulti ? (
                        <div className="flex flex-col gap-[3px]">
                          {visibleItems.map((it, idx) => (
                            <div
                              key={idx}
                              className="h-[22px] flex items-center text-[11px] truncate"
                            >
                              {it.sku ?? (
                                <span className="text-ink-4">—</span>
                              )}
                            </div>
                          ))}
                          {overflowItems > 0 && <div className="h-[14px]" />}
                        </div>
                      ) : (
                        firstItem?.sku ?? '—'
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('qty') && (
                    <Td className="text-right">
                      {isMulti ? (
                        <span className="inline-block px-1.5 py-0.5 border border-danger rounded text-danger font-mono font-bold">
                          {qty}
                        </span>
                      ) : (
                        <span className="font-mono">{qty || 1}</span>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('weight') && (
                    <Td className="font-mono text-ink-2 whitespace-nowrap">
                      {formatWeight(o.weightOz)}
                    </Td>
                  )}
                  {visibleColumns.has('shipTo') && (
                    <Td className="text-tiny leading-tight">
                      <div className="text-ink truncate" title={cityLine}>
                        {cityLine || '—'}
                      </div>
                      {country && country !== 'US' && (
                        <div className="text-ink-3">{country}</div>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('carrier') && (
                    <Td className="uppercase text-tiny font-semibold text-ink-2">
                      {o.carrierCode ?? '—'}
                    </Td>
                  )}
                  {visibleColumns.has('shippingAccount') && (
                    <Td className="text-tiny text-ink-2">
                      {o.serviceCode ?? <span className="text-ink-3">—</span>}
                    </Td>
                  )}
                  {visibleColumns.has('orderTotal') && (
                    <Td className="text-right font-mono">${o.orderTotal}</Td>
                  )}
                  {visibleColumns.has('bestRate') && (
                    <Td className="text-right font-mono">
                      {bestRate ? (
                        <span className="text-ok-dark font-bold">
                          ${bestRate.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('shipMargin') && (
                    <Td className="text-right font-mono">
                      {bestRate && Number(o.orderTotal) ? (
                        <span
                          className={
                            Number(o.orderTotal) - bestRate > 0
                              ? 'text-ok-dark'
                              : 'text-danger'
                          }
                        >
                          ${(Number(o.orderTotal) - bestRate).toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </Td>
                  )}
                  {visibleColumns.has('tracking') && (
                    <Td className="font-mono text-tiny text-ink-2">
                      <span className="text-ink-3">—</span>
                    </Td>
                  )}
                  {visibleColumns.has('age') && (
                    <Td className="text-tiny text-ink-2 font-mono">
                      {ageStr(o.orderDate)}
                    </Td>
                  )}
                  {visibleColumns.has('labelCreated') && (
                    <Td className="text-tiny text-ink-2 whitespace-nowrap">
                      <span className="text-ink-3">—</span>
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Right panel — always visible on desktop */}
      <aside className="w-panel shrink-0 border-l border-line bg-white hidden md:block">
        {openId === null && <EmptyOrderPanel />}
      </aside>
      </div>
      </WidthsContext.Provider>
      </DensityContext.Provider>

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

      {batchOpen && (
        <Suspense fallback={null}>
          <BatchLabelModal
            orderIds={Array.from(selected)}
            onClose={() => {
              setBatchOpen(false);
              setSelected(new Set());
            }}
          />
        </Suspense>
      )}

      {queueOpen && (
        <Suspense fallback={null}>
          <PrintQueueDrawer onClose={() => setQueueOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

function EmptyOrderPanel() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-5 py-10 text-center text-ink-3">
      <div className="text-[36px] mb-3.5 opacity-50">📋</div>
      <div className="text-[13px] font-semibold text-ink-2 mb-2">
        No order selected
      </div>
      <div className="text-[12px] leading-relaxed mb-5">
        Click any row to view details
      </div>
      <div
        className="text-left text-[11px] leading-[2] text-ink-4 border-t border-line pt-3.5 w-full"
        style={{ maxWidth: 180 }}
      >
        <div>
          <kbd className="bg-surface-3 border border-line-2 rounded text-[10px] px-[5px] py-px mr-1.5">
            ↑↓
          </kbd>
          Navigate rows
        </div>
        <div>
          <kbd className="bg-surface-3 border border-line-2 rounded text-[10px] px-[5px] py-px mr-1.5">
            Enter
          </kbd>
          Select / deselect
        </div>
        <div>
          <kbd className="bg-surface-3 border border-line-2 rounded text-[10px] px-[5px] py-px mr-1.5">
            Esc
          </kbd>
          Deselect &amp; close
        </div>
        <div>
          <kbd className="bg-surface-3 border border-line-2 rounded text-[10px] px-[5px] py-px mr-1.5">
            ⌘C
          </kbd>
          Copy order #
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  value,
  valueClass,
  label,
}: {
  icon: string;
  value: string;
  valueClass: string;
  label: string;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 shrink-0">
      <span className="text-[22px] leading-none">{icon}</span>
      <div className="flex flex-col leading-tight">
        <span className={`text-[15px] font-extrabold leading-none ${valueClass}`}>
          {value}
        </span>
        <span className="text-[10.5px] text-ink-3 mt-0.5">{label}</span>
      </div>
    </div>
  );
}

function Th({
  id,
  children,
  className = '',
}: {
  id?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const density = useContext(DensityContext);
  const widthsCtx = useContext(WidthsContext);
  return (
    <th
      className={`relative text-left ${TH_DENSITY[density]} font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap ${className}`}
    >
      <div className="overflow-hidden truncate pr-2">{children}</div>
      {id && widthsCtx && (
        <div
          onMouseDown={(e) => widthsCtx.startResize(id, e)}
          onClick={(e) => e.stopPropagation()}
          className="group absolute top-0 right-0 h-full w-4 cursor-col-resize select-none flex items-center justify-center z-20"
          style={{ touchAction: 'none', pointerEvents: 'auto' }}
          title="Drag to resize column"
        >
          <div className="h-full w-[2px] bg-line-2 group-hover:bg-brand group-active:bg-brand transition-colors" />
        </div>
      )}
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
  const density = useContext(DensityContext);
  return (
    <td
      onClick={onClick}
      className={`align-top overflow-hidden ${TD_DENSITY[density]} ${className}`}
    >
      {children}
    </td>
  );
}
