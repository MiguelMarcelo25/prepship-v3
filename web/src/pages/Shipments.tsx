import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Topbar from '../components/Topbar';
import { Button } from '../components/ui/Button';
import { api, qs, type Paginated } from '../lib/api';

type Shipment = {
  id: number;
  orderId: number | null;
  orderNumber: string | null;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipDate: string | null;
  labelCost: string | null;
  voided: boolean;
};

export default function Shipments() {
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const { data, isLoading } = useQuery({
    queryKey: ['shipments', page],
    queryFn: () => api.get<Paginated<Shipment>>(`/shipments${qs({ page, pageSize })}`),
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 1;

  return (
    <>
      <Topbar title="Shipments" />
      <div className="flex-1 min-h-0 overflow-auto bg-white">
        <table className="w-full text-sm2 border-collapse min-w-[800px]">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              {['Shipment', 'Order', 'Tracking', 'Carrier', 'Service', 'Ship date', 'Cost', 'Voided'].map(
                (h) => (
                  <th
                    key={h}
                    className="text-left px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.4px] text-ink-3 border-b-2 border-line bg-surface-2 whitespace-nowrap"
                  >
                    {h}
                  </th>
                )
              )}
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
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-16 text-center text-ink-3">
                  <div className="text-4xl mb-2">🚚</div>
                  <div className="font-semibold text-ink-2">No shipments yet</div>
                </td>
              </tr>
            )}
            {rows.map((s, i) => (
              <tr
                key={s.id}
                className={`border-b border-line ${
                  i % 2 === 1 ? 'bg-surface-2' : 'bg-white'
                } hover:!bg-brand-bg`}
              >
                <td className="px-2 py-[5px] font-mono text-ink-2">#{s.id}</td>
                <td className="px-2 py-[5px] font-bold text-brand">{s.orderNumber ?? '—'}</td>
                <td className="px-2 py-[5px] font-mono">{s.trackingNumber ?? '—'}</td>
                <td className="px-2 py-[5px] uppercase text-tiny">{s.carrierCode ?? '—'}</td>
                <td className="px-2 py-[5px]">{s.serviceCode ?? '—'}</td>
                <td className="px-2 py-[5px] text-ink-2">
                  {s.shipDate ? new Date(s.shipDate).toLocaleDateString() : '—'}
                </td>
                <td className="px-2 py-[5px] font-mono text-right">
                  {s.labelCost ? `$${s.labelCost}` : '—'}
                </td>
                <td className="px-2 py-[5px]">{s.voided ? 'Yes' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-t border-line text-tiny text-ink-3">
        <div>
          {total} shipment{total === 1 ? '' : 's'} — page {page} of {totalPages}
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="xs" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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
