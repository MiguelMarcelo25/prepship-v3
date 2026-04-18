import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Topbar from '../components/Topbar';
import { Input } from '../components/ui/Input';
import { Card } from '../components/ui/Card';
import { api, qs } from '../lib/api';

type Overview = {
  ordersToday: number;
  ordersWeek: number;
  ordersMonth: number;
  shippedToday: number;
  shippedWeek: number;
  shippedMonth: number;
  shippingCostMonth: string;
};

type DailyRow = { day: string; count: number; total_cost: string };
type SkuRow = { sku: string; total_qty: number; order_count: number };

function startOfMonthIso(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}
function endOfTodayIso() {
  const e = new Date();
  e.setHours(23, 59, 59, 0);
  return e.toISOString();
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

export default function Analysis() {
  const [dateFrom, setDateFrom] = useState(toDateInput(startOfMonthIso()));
  const [dateTo, setDateTo] = useState(toDateInput(endOfTodayIso()));

  const rangeQs = useMemo(
    () =>
      qs({
        dateFrom: fromDateInputStart(dateFrom),
        dateTo: fromDateInputEnd(dateTo),
      }),
    [dateFrom, dateTo]
  );

  const overview = useQuery({
    queryKey: ['analysis-overview'],
    queryFn: () => api.get<Overview>('/analysis/overview'),
  });

  const daily = useQuery({
    queryKey: ['analysis-daily', rangeQs],
    queryFn: () => api.get<{ data: DailyRow[] }>(`/analysis/daily-shipments${rangeQs}`),
  });

  const skus = useQuery({
    queryKey: ['analysis-skus', rangeQs],
    queryFn: () =>
      api.get<{ data: SkuRow[] }>(`/analysis/top-skus${rangeQs}&limit=25`),
  });

  const maxDaily = Math.max(1, ...(daily.data?.data ?? []).map((d) => d.count));
  const maxSku = Math.max(1, ...(skus.data?.data ?? []).map((s) => s.total_qty));

  return (
    <>
      <Topbar title="Analysis" />
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        <Card title="Overview">
          {overview.isLoading ? (
            <div className="text-center text-ink-3 py-2">Loading…</div>
          ) : overview.data ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatBlock label="Orders today" value={overview.data.ordersToday} />
              <StatBlock label="Orders this week" value={overview.data.ordersWeek} />
              <StatBlock label="Orders this month" value={overview.data.ordersMonth} />
              <StatBlock label="Shipping cost (month)" value={fmtMoney(overview.data.shippingCostMonth)} />
              <StatBlock label="Shipped today" value={overview.data.shippedToday} />
              <StatBlock label="Shipped this week" value={overview.data.shippedWeek} />
              <StatBlock label="Shipped this month" value={overview.data.shippedMonth} />
            </div>
          ) : null}
        </Card>

        <Card
          title="Daily shipments"
          actions={
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="!py-1 !text-[11px]"
              />
              <span className="text-ink-3 text-tiny">→</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="!py-1 !text-[11px]"
              />
            </div>
          }
          bodyClassName=""
        >
          {daily.isLoading ? (
            <div className="p-6 text-center text-ink-3 text-sm2">Loading…</div>
          ) : !daily.data?.data.length ? (
            <div className="p-6 text-center text-ink-3 text-sm2">
              No shipments in this range.
            </div>
          ) : (
            <table className="w-full text-sm2 border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <Th className="w-[140px]">Day</Th>
                  <Th className="text-right w-[100px]">Shipments</Th>
                  <Th>Volume</Th>
                  <Th className="text-right w-[140px]">Total cost</Th>
                </tr>
              </thead>
              <tbody>
                {daily.data.data.map((d, i) => (
                  <tr
                    key={d.day}
                    className={`border-b border-line ${i % 2 === 1 ? 'bg-surface-2' : 'bg-white'}`}
                  >
                    <Td className="font-mono">{d.day}</Td>
                    <Td className="text-right font-mono font-semibold">
                      {d.count}
                    </Td>
                    <Td>
                      <div className="h-2 rounded bg-surface-3 relative overflow-hidden">
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${(d.count / maxDaily) * 100}%` }}
                        />
                      </div>
                    </Td>
                    <Td className="text-right font-mono text-ink-2">
                      {fmtMoney(d.total_cost)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Top 25 SKUs" bodyClassName="">
          {skus.isLoading ? (
            <div className="p-6 text-center text-ink-3 text-sm2">Loading…</div>
          ) : !skus.data?.data.length ? (
            <div className="p-6 text-center text-ink-3 text-sm2">
              No SKU data in this range (orders may be missing line items).
            </div>
          ) : (
            <table className="w-full text-sm2 border-collapse">
              <thead className="bg-surface-2">
                <tr>
                  <Th>SKU</Th>
                  <Th className="text-right w-[90px]">Qty</Th>
                  <Th className="text-right w-[110px]">Orders</Th>
                  <Th>Volume</Th>
                </tr>
              </thead>
              <tbody>
                {skus.data.data.map((s, i) => (
                  <tr
                    key={s.sku}
                    className={`border-b border-line ${i % 2 === 1 ? 'bg-surface-2' : 'bg-white'}`}
                  >
                    <Td className="font-mono font-semibold">{s.sku}</Td>
                    <Td className="text-right font-mono font-bold">
                      {s.total_qty}
                    </Td>
                    <Td className="text-right font-mono text-ink-2">
                      {s.order_count}
                    </Td>
                    <Td>
                      <div className="h-2 rounded bg-surface-3 relative overflow-hidden">
                        <div
                          className="h-full bg-ok"
                          style={{ width: `${(s.total_qty / maxSku) * 100}%` }}
                        />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function StatBlock({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-[20px] font-extrabold text-ink leading-tight">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-ink-3 mt-0.5">
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
