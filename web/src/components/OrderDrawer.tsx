import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, X, Package as PackageIcon } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Card, Field } from './ui/Card';
import { StatusBadge } from './ui/Badge';

type ItemOption = { name?: string; value?: string };

type OrderItem = {
  orderItemId?: number;
  lineItemKey?: string | null;
  sku?: string | null;
  name?: string | null;
  imageUrl?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  warehouseLocation?: string | null;
  options?: ItemOption[] | null;
};

type Shipment = {
  id: number;
  trackingNumber: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  shipDate: string | null;
  labelUrl: string | null;
  labelCost: string | null;
  voided: boolean;
};

type OrderDetail = {
  id: number;
  externalOrderId: string | null;
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
  shippingAmount: string;
  items: OrderItem[];
  raw: {
    shipTo?: {
      name?: string;
      company?: string | null;
      street1?: string;
      street2?: string | null;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
      phone?: string | null;
    };
    [key: string]: unknown;
  };
  overrides: {
    residential: boolean | null;
    notes: string | null;
    trackingNumber: string | null;
    selectedPackageId: string | null;
  } | null;
  shipments: Shipment[];
};

function formatDate(v: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function OrderDrawer() {
  const { status, orderId } = useParams();
  const navigate = useNavigate();
  const id = Number(orderId);

  const close = () => navigate(`/orders/${status ?? 'awaiting_shipment'}`);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex-1 bg-black/35"
        onClick={close}
        aria-label="Close"
      />
      <aside className="w-drawer max-w-full bg-white shadow-drawer-l flex flex-col">
        {/* Topbar */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-line bg-surface-2">
          <Button variant="ghost" size="xs" onClick={close} aria-label="Back">
            <ArrowLeft size={14} />
          </Button>
          <div className="flex-1">
            <div className="text-[13px] font-bold text-ink leading-tight">
              Order #{data?.orderNumber ?? '—'}
            </div>
            {data?.storeId !== undefined && data?.storeId !== null && (
              <div className="text-tiny text-ink-3">Store {data.storeId}</div>
            )}
          </div>
          {data && <StatusBadge status={data.orderStatus} />}
          <Button
            variant="ghost"
            size="xs"
            onClick={close}
            aria-label="Close"
            className="ml-1"
          >
            <X size={14} />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3.5 bg-page space-y-3">
          {isLoading && <div className="text-center text-ink-3 py-10">Loading…</div>}
          {isError && (
            <div className="text-center text-danger py-10">
              {(error as Error).message}
            </div>
          )}
          {data && (
            <>
              {/* Summary */}
              <Card title="Summary">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Order date" value={formatDate(data.orderDate)} />
                  <Field
                    label="Total"
                    value={`$${data.orderTotal}`}
                    mono
                  />
                  <Field
                    label="Weight"
                    value={data.weightOz ? `${data.weightOz.toFixed(1)} oz` : null}
                    mono
                  />
                  <Field
                    label="Shipping"
                    value={`$${data.shippingAmount}`}
                    mono
                  />
                  <Field
                    label="Carrier (requested)"
                    value={data.carrierCode?.toUpperCase() ?? null}
                  />
                  <Field
                    label="Service (requested)"
                    value={data.serviceCode ?? null}
                  />
                </div>
              </Card>

              {/* Items */}
              <Card title={`Items (${data.items?.length ?? 0})`}>
                {data.items?.length ? (
                  <div className="divide-y divide-line -mx-3.5">
                    {data.items.map((it, idx) => (
                      <div
                        key={it.orderItemId ?? it.lineItemKey ?? idx}
                        className="flex items-start gap-3 px-3.5 py-2.5"
                      >
                        <div className="w-10 h-10 rounded border border-line bg-surface-2 shrink-0 flex items-center justify-center overflow-hidden">
                          {it.imageUrl ? (
                            <img
                              src={it.imageUrl}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <PackageIcon size={16} className="text-ink-3" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm2 text-ink truncate" title={it.name ?? ''}>
                            {it.name ?? 'Unnamed item'}
                          </div>
                          <div className="flex items-center gap-2 text-tiny text-ink-3 mt-0.5">
                            {it.sku && <span className="font-mono">{it.sku}</span>}
                            {it.warehouseLocation && (
                              <span className="text-ink-2">
                                · {it.warehouseLocation}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm2 font-semibold text-ink">
                            {it.quantity ?? 0}×
                          </div>
                          {it.unitPrice !== null && it.unitPrice !== undefined && (
                            <div className="text-tiny font-mono text-ink-3">
                              ${it.unitPrice.toFixed(2)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-ink-3 text-sm2">No items.</div>
                )}
              </Card>

              {/* Recipient */}
              <Card title="Recipient">
                <div className="space-y-1 text-sm2 text-ink">
                  <div className="font-semibold">
                    {data.shipToName ?? data.raw?.shipTo?.name ?? '—'}
                  </div>
                  {data.raw?.shipTo?.company && (
                    <div className="text-ink-2">{data.raw.shipTo.company}</div>
                  )}
                  {data.raw?.shipTo?.street1 && <div>{data.raw.shipTo.street1}</div>}
                  {data.raw?.shipTo?.street2 && <div>{data.raw.shipTo.street2}</div>}
                  <div>
                    {[
                      data.shipToCity ?? data.raw?.shipTo?.city,
                      data.shipToState ?? data.raw?.shipTo?.state,
                      data.shipToPostalCode ?? data.raw?.shipTo?.postalCode,
                    ]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </div>
                  {(data.raw?.shipTo?.country ?? 'US') !== 'US' && (
                    <div className="text-ink-2">{data.raw?.shipTo?.country}</div>
                  )}
                  {data.customerEmail && (
                    <div className="text-ink-2 font-mono pt-1">
                      {data.customerEmail}
                    </div>
                  )}
                  {data.raw?.shipTo?.phone && (
                    <div className="text-ink-2 font-mono">{data.raw.shipTo.phone}</div>
                  )}
                </div>
              </Card>

              {/* Shipments */}
              <Card title={`Shipments (${data.shipments.length})`}>
                {data.shipments.length ? (
                  <div className="divide-y divide-line -mx-3.5">
                    {data.shipments.map((s) => (
                      <div
                        key={s.id}
                        className={`px-3.5 py-2.5 ${s.voided ? 'opacity-60' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <div className="text-sm2 font-semibold text-ink">
                            {(s.carrierCode ?? 'carrier').toUpperCase()} —{' '}
                            {s.serviceCode ?? 'service'}
                          </div>
                          {s.voided && (
                            <span className="text-2xs font-bold text-danger">
                              VOIDED
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-tiny text-ink-3 mt-1">
                          {s.trackingNumber && (
                            <span className="font-mono">{s.trackingNumber}</span>
                          )}
                          {s.shipDate && <span>{formatDate(s.shipDate)}</span>}
                          {s.labelCost && (
                            <span className="font-mono">${s.labelCost}</span>
                          )}
                        </div>
                        {s.labelUrl && (
                          <a
                            href={s.labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 inline-block text-brand text-tiny font-semibold hover:underline"
                          >
                            Download label →
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-ink-3 text-sm2">No shipments yet.</div>
                )}
              </Card>
            </>
          )}
        </div>

        {/* Footer action (placeholder — Create Label flow lands next) */}
        <div className="px-3.5 py-3 border-t border-line bg-white">
          <Button
            variant="green"
            size="md"
            className="w-full"
            disabled
            title="Create Label flow lands in the next step"
          >
            Create Label
          </Button>
        </div>
      </aside>
    </div>
  );
}
