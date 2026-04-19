import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Package as PackageIcon, Printer } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { api, qs } from '../lib/api';

type SkuRow = {
  client_id: number | null;
  client_name: string | null;
  sku: string;
  name: string | null;
  image_url: string | null;
  total_qty: number;
  order_count: number;
};

type PicklistResponse = {
  skus: SkuRow[];
  totalSkus: number;
  totalUnits: number;
};

const STATUS_OPTIONS = [
  { value: 'awaiting_shipment', label: 'Awaiting Shipment' },
  { value: 'on_hold', label: 'On Hold' },
];

export default function Picklist() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? 'awaiting_shipment';
  const clientIdParam = searchParams.get('clientId');
  const clientId = clientIdParam ? Number(clientIdParam) : undefined;

  const [printedAt] = useState(() => new Date());

  const queryString = useMemo(
    () => qs({ status, clientId }),
    [status, clientId]
  );

  const { data, isLoading } = useQuery({
    queryKey: ['picklist', queryString],
    queryFn: () => api.get<PicklistResponse>(`/orders/picklist${queryString}`),
  });

  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ id: number; name: string }[]>('/clients'),
    staleTime: 60_000,
  });

  // Group rows by client for display
  const grouped = useMemo(() => {
    const map = new Map<string, SkuRow[]>();
    for (const r of data?.skus ?? []) {
      const key = r.client_name ?? 'Unassigned';
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  return (
    <div className="h-full w-full flex flex-col bg-white print:bg-white">
      {/* Toolbar — hidden on print */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-surface-2 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft size={12} />
          Back
        </Button>
        <div className="font-bold text-ink">Picklist</div>
        <div className="flex-1" />
        <Select
          value={status}
          onChange={(e) => {
            const next = new URLSearchParams(searchParams);
            next.set('status', e.target.value);
            setSearchParams(next);
          }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          value={clientId ?? ''}
          onChange={(e) => {
            const next = new URLSearchParams(searchParams);
            if (e.target.value) next.set('clientId', e.target.value);
            else next.delete('clientId');
            setSearchParams(next);
          }}
        >
          <option value="">All Clients</option>
          {(clients.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button variant="primary" size="sm" onClick={() => window.print()}>
          <Printer size={12} />
          Print
        </Button>
      </div>

      {/* Print-friendly content */}
      <div className="flex-1 min-h-0 overflow-auto p-6 print:p-0">
        <div className="max-w-[1100px] mx-auto">
          <div className="flex items-baseline justify-between mb-4 print:mb-3">
            <div>
              <div className="text-[20px] font-extrabold text-ink leading-tight">
                Pick List
              </div>
              <div className="text-tiny text-ink-3">
                {STATUS_OPTIONS.find((s) => s.value === status)?.label}
                {clientId &&
                  clients.data &&
                  ` · ${clients.data.find((c) => c.id === clientId)?.name ?? `Client #${clientId}`}`}{' '}
                · {printedAt.toLocaleString()}
              </div>
            </div>
            {data && (
              <div className="text-right">
                <div className="text-[20px] font-extrabold text-brand">
                  {data.totalSkus} SKUs · {data.totalUnits.toLocaleString()} units
                </div>
              </div>
            )}
          </div>

          {isLoading && (
            <div className="text-center text-ink-3 py-10">Loading…</div>
          )}

          {!isLoading && grouped.length === 0 && (
            <div className="text-center text-ink-3 py-16">
              <div className="text-4xl mb-2">📋</div>
              <div className="font-semibold text-ink-2">Nothing to pick</div>
            </div>
          )}

          {grouped.map(([clientName, rows]) => {
            const clientUnits = rows.reduce((s, r) => s + r.total_qty, 0);
            return (
              <div key={clientName} className="mb-6 print:mb-4 break-inside-avoid">
                <div className="flex items-baseline justify-between border-b-2 border-ink py-1 mb-2">
                  <div className="text-[14px] font-bold uppercase tracking-[0.4px] text-ink">
                    {clientName}
                  </div>
                  <div className="text-tiny font-mono text-ink-2">
                    {rows.length} SKUs · {clientUnits} units
                  </div>
                </div>
                <table className="w-full text-sm2 border-collapse">
                  <thead>
                    <tr className="bg-surface-2 print:bg-white print:border-b print:border-line-2">
                      <Th className="w-[42px]"></Th>
                      <Th className="w-[160px]">SKU</Th>
                      <Th>Item</Th>
                      <Th className="text-right w-[80px]">Qty</Th>
                      <Th className="text-right w-[80px]">Orders</Th>
                      <Th className="w-[60px]">Picked</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={`${r.client_id}-${r.sku}`}
                        className={`border-b border-line ${
                          i % 2 === 1 ? 'bg-surface-2 print:bg-white' : 'bg-white'
                        }`}
                      >
                        <td className="px-2 py-2">
                          <div className="w-8 h-8 rounded border border-line bg-surface-2 print:bg-white flex items-center justify-center overflow-hidden">
                            {r.image_url ? (
                              <img
                                src={r.image_url}
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
                          {r.sku}
                        </td>
                        <td className="px-2 py-2 text-ink truncate max-w-[400px]" title={r.name ?? ''}>
                          {r.name ?? '—'}
                        </td>
                        <td className="px-2 py-2 text-right font-mono font-bold text-[15px]">
                          {r.total_qty}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-ink-2">
                          {r.order_count}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className="inline-block w-5 h-5 border-2 border-ink-3 rounded" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
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
      className={`text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  );
}
