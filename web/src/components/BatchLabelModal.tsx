import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type ResultItem = {
  orderId: number;
  success: boolean;
  shipmentId?: number;
  trackingNumber?: string | null;
  cost?: string | null;
  error?: string;
};

type BatchResult = {
  created: ResultItem[];
  failed: ResultItem[];
  summary: { total: number; created: number; failed: number };
};

type ShipmentRow = {
  id: number;
  orderId: number | null;
  orderNumber: string | null;
  clientId: number | null;
  labelUrl: string | null;
};

type OrderItem = {
  sku?: string | null;
  name?: string | null;
  quantity?: number | null;
};

type OrderDetail = {
  id: number;
  orderNumber: string;
  clientId: number | null;
  items: OrderItem[];
};

const COMMON_SERVICES = [
  { code: 'usps_ground_advantage', label: 'USPS Ground Advantage' },
  { code: 'usps_priority_mail', label: 'USPS Priority Mail' },
  { code: 'usps_first_class_mail', label: 'USPS First Class' },
  { code: 'ups_ground', label: 'UPS Ground' },
  { code: 'ups_3_day_select', label: 'UPS 3-Day Select' },
  { code: 'fedex_ground', label: 'FedEx Ground' },
  { code: 'fedex_home_delivery', label: 'FedEx Home Delivery' },
];

export default function BatchLabelModal({
  orderIds,
  onClose,
}: {
  orderIds: number[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [serviceCode, setServiceCode] = useState(COMMON_SERVICES[0]!.code);
  const [customCode, setCustomCode] = useState('');
  const [autoQueue, setAutoQueue] = useState(true);
  const [queueStatus, setQueueStatus] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !batch.isPending) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const batch = useMutation({
    mutationFn: async () => {
      const result = await api.post<BatchResult>('/labels/create-batch', {
        orderIds,
        serviceCode: customCode.trim() || serviceCode,
      });
      if (autoQueue && result.created.length) {
        setQueueStatus(`Queueing ${result.created.length} label${result.created.length === 1 ? '' : 's'}…`);
        let queued = 0;
        for (const created of result.created) {
          try {
            const shipments = await api.get<{ data: ShipmentRow[] }>(
              `/shipments?orderId=${created.orderId}`
            );
            const shipment = shipments.data.find((s) => s.id === created.shipmentId);
            if (!shipment?.labelUrl || !shipment.clientId) continue;
            const order = await api.get<OrderDetail>(`/orders/${created.orderId}`);
            const firstItem = order.items?.[0];
            await api.post('/print-queue/add', {
              client_id: shipment.clientId,
              order_id: String(order.id),
              order_number: order.orderNumber,
              label_url: shipment.labelUrl,
              sku_group_id: firstItem?.sku ?? `order-${order.id}`,
              primary_sku: firstItem?.sku ?? null,
              item_description: firstItem?.name ?? null,
              order_qty: firstItem?.quantity ?? 1,
            });
            queued += 1;
          } catch {
            // Per-order queue failures are non-fatal — surfaced in summary.
          }
        }
        setQueueStatus(`${queued} of ${result.created.length} sent to print queue`);
      }
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
      queryClient.invalidateQueries({ queryKey: ['print-queue'] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    batch.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45"
      onClick={() => !batch.isPending && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[520px] max-w-full bg-white rounded-modal shadow-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line">
          <Printer size={14} className="text-brand" />
          <div className="flex-1 text-[14px] font-bold text-ink">
            Create labels for {orderIds.length} order
            {orderIds.length === 1 ? '' : 's'}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={batch.isPending}
            className="text-ink-3 hover:text-ink disabled:opacity-50"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {!batch.data ? (
          <form onSubmit={submit} className="px-5 py-4 space-y-3">
            <div>
              <label className="section-label block mb-1">Service</label>
              <select
                value={serviceCode}
                onChange={(e) => setServiceCode(e.target.value)}
                disabled={!!customCode}
                className="block w-full rounded-btn border border-line-2 bg-white px-2.5 py-[6px] text-sm2 text-ink"
              >
                {COMMON_SERVICES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="section-label block mb-1">
                Or custom service code
              </label>
              <Input
                value={customCode}
                onChange={(e) => setCustomCode(e.target.value)}
                placeholder="e.g. usps_priority_mail_express"
              />
            </div>

            <label className="flex items-center gap-2 text-sm2 text-ink-2 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={autoQueue}
                onChange={(e) => setAutoQueue(e.target.checked)}
                className="accent-brand"
              />
              Send labels to print queue when done
            </label>

            <div className="text-tiny text-ink-3 pt-1 leading-relaxed">
              Each order's saved weight + ship-to address is used. Concurrency
              is capped at 5 to avoid hitting ShipStation rate limits. Failed
              orders will be reported back individually so you can fix them.
            </div>

            {batch.isError && (
              <div className="text-danger text-tiny py-1">
                {(batch.error as Error).message}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={onClose}
                disabled={batch.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="green"
                size="md"
                disabled={batch.isPending}
              >
                <Printer size={12} />
                {batch.isPending
                  ? `Creating ${orderIds.length}…`
                  : `Buy ${orderIds.length} labels`}
              </Button>
            </div>
          </form>
        ) : (
          <div className="px-5 py-4 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Stat
                label="Total"
                value={batch.data.summary.total}
                tone="text-ink"
              />
              <Stat
                label="Success"
                value={batch.data.summary.created}
                tone="text-ok-dark"
              />
              <Stat
                label="Failed"
                value={batch.data.summary.failed}
                tone="text-danger"
              />
            </div>

            {queueStatus && (
              <div className="text-tiny text-ok-dark font-semibold">
                {queueStatus}
              </div>
            )}

            {batch.data.failed.length > 0 && (
              <div className="border border-danger-border bg-danger-bg rounded-btn p-3 max-h-[260px] overflow-y-auto">
                <div className="text-tiny font-bold text-[#991b1b] mb-1.5">
                  Failed orders:
                </div>
                <ul className="space-y-1 text-tiny">
                  {batch.data.failed.map((f) => (
                    <li key={f.orderId} className="text-[#991b1b]">
                      <span className="font-mono font-bold">#{f.orderId}</span>{' '}
                      — {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1" />
              <Button variant="primary" size="md" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className="text-center bg-surface-2 rounded-btn py-2">
      <div className={`text-[20px] font-extrabold ${tone}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.5px] text-ink-3 mt-0.5">
        {label}
      </div>
    </div>
  );
}
