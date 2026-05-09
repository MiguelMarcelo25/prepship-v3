import { useMemo, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ClipboardList, Download, RefreshCw } from 'lucide-react';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { api, qs } from '../lib/api';
import {
  SortableHeader,
  nextSortState,
  sortRows,
  type SortState,
} from '../components/SortableTable';

type ShipmentRow = {
  id: number;
  orderId: number | null;
  orderNumber: string | null;
  clientId: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  weightOz: number | null;
  labelCost: string | null;
};

type ManifestResult = {
  data: ShipmentRow[];
  generatedAt: string;
  count: number;
};

type ManifestSortKey = 'date' | 'tracking' | 'carrier' | 'service' | 'order' | 'weight' | 'cost';

function todayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function todayEndIso() {
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

function rowToCsvCell(v: unknown) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: ShipmentRow[]) {
  const header = [
    'Ship date',
    'Tracking',
    'Carrier',
    'Service',
    'Order #',
    'Weight (oz)',
    'Cost ($)',
  ];
  const body = rows.map((r) =>
    [
      r.shipDate ? new Date(r.shipDate).toISOString().slice(0, 10) : '',
      r.trackingNumber ?? '',
      (r.carrierCode ?? '').toUpperCase(),
      r.serviceCode ?? '',
      r.orderNumber ?? (r.orderId ?? ''),
      r.weightOz ?? '',
      r.labelCost ?? '',
    ]
      .map(rowToCsvCell)
      .join(',')
  );
  return [header.join(','), ...body].join('\n');
}

export default function Manifest() {
  const [dateFrom, setDateFrom] = useState(toDateInput(todayStartIso()));
  const [dateTo, setDateTo] = useState(toDateInput(todayEndIso()));
  const [carrier, setCarrier] = useState('');
  const [sortState, setSortState] = useState<SortState<ManifestSortKey>>(null);

  const queryString = useMemo(
    () =>
      qs({
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
        carrierCode: carrier.trim() || undefined,
      }),
    [dateFrom, dateTo, carrier]
  );

  const fetchManifest = useMutation({
    mutationFn: () => api.get<ManifestResult>(`/manifests/generate${queryString}`),
  });

  const rows = fetchManifest.data?.data ?? [];
  const sortedRows = useMemo(
    () =>
      sortRows(
        rows,
        sortState,
        (row, key) => {
          switch (key) {
            case 'date':
              return row.shipDate ? new Date(row.shipDate) : null;
            case 'tracking':
              return row.trackingNumber;
            case 'carrier':
              return row.carrierCode;
            case 'service':
              return row.serviceCode;
            case 'order':
              return row.orderNumber ?? row.orderId;
            case 'weight':
              return row.weightOz;
            case 'cost':
              return Number(row.labelCost ?? 0);
            default:
              return '';
          }
        },
        (row) => row.id
      ),
    [rows, sortState]
  );

  const totalCost = rows.reduce((sum, r) => sum + Number(r.labelCost ?? 0), 0);

  const downloadCsv = () => {
    if (!rows.length) return;
    const csv = rowsToCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = dateFrom === dateTo ? dateFrom : `${dateFrom}_to_${dateTo}`;
    const cc = carrier.trim() ? `_${carrier.trim().toUpperCase()}` : '';
    a.download = `manifest_${stamp}${cc}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Topbar title="Manifest" />
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        <Card title="Build manifest">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              fetchManifest.mutate();
            }}
            className="flex items-end gap-3 flex-wrap"
          >
            <div>
              <label className="section-label block mb-1">From</label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="section-label block mb-1">To</label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="section-label block mb-1">Carrier code</label>
              <Input
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="usps, ups, fedex, … (optional)"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={fetchManifest.isPending}
            >
              {fetchManifest.isPending ? (
                <>
                  <RefreshCw size={12} className="animate-spin" />
                  Loading…
                </>
              ) : (
                <>
                  <ClipboardList size={12} />
                  Build
                </>
              )}
            </Button>
            <Button
              type="button"
              variant="green"
              size="md"
              disabled={!rows.length}
              onClick={downloadCsv}
            >
              <Download size={12} />
              Download CSV
            </Button>
          </form>
          {fetchManifest.isError && (
            <div className="mt-2 text-danger text-tiny">
              {(fetchManifest.error as Error).message}
            </div>
          )}
        </Card>

        {fetchManifest.data && (
          <Card
            title={`Shipments (${rows.length})`}
            actions={
              <span className="text-tiny text-ink-2 font-mono">
                Total: <span className="font-bold">${totalCost.toFixed(2)}</span>
              </span>
            }
            bodyClassName=""
          >
            {rows.length === 0 ? (
              <div className="p-6 text-center text-ink-3 text-sm2">
                No shipments in this range / carrier filter.
              </div>
            ) : (
              <table className="w-full text-sm2 border-collapse">
                <thead className="bg-surface-2">
                  <tr>
                    <SortableHeader sortKey="date" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Ship date</SortableHeader>
                    <SortableHeader sortKey="tracking" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Tracking</SortableHeader>
                    <SortableHeader sortKey="carrier" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Carrier</SortableHeader>
                    <SortableHeader sortKey="service" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Service</SortableHeader>
                    <SortableHeader sortKey="order" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} className="text-left px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Order #</SortableHeader>
                    <SortableHeader sortKey="weight" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Weight</SortableHeader>
                    <SortableHeader sortKey="cost" sortState={sortState} onSort={(key) => setSortState((current) => nextSortState(current, key))} align="right" className="text-right px-3 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap">Cost</SortableHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r, i) => (
                    <tr
                      key={r.id}
                      className={`border-b border-line ${i % 2 === 1 ? 'bg-surface-2' : 'bg-white'}`}
                    >
                      <Td className="text-ink-2">
                        {r.shipDate
                          ? new Date(r.shipDate).toLocaleDateString()
                          : '—'}
                      </Td>
                      <Td className="font-mono">{r.trackingNumber ?? '—'}</Td>
                      <Td className="uppercase font-semibold">
                        {r.carrierCode ?? '—'}
                      </Td>
                      <Td>{r.serviceCode ?? '—'}</Td>
                      <Td className="font-bold text-brand">
                        {r.orderNumber ?? r.orderId ?? '—'}
                      </Td>
                      <Td className="text-right font-mono text-ink-2">
                        {r.weightOz ? `${r.weightOz.toFixed(1)} oz` : '—'}
                      </Td>
                      <Td className="text-right font-mono">
                        {r.labelCost ? `$${r.labelCost}` : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>
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
