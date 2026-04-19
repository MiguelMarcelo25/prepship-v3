import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  X,
  Package as PackageIcon,
  RefreshCw,
  Check,
  Printer,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from './ui/Button';
import { Card, Field } from './ui/Card';
import { StatusBadge } from './ui/Badge';
import { Skeleton } from './ui/Skeleton';

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

type Rate = {
  rate_id: string;
  carrier_code: string;
  carrier_nickname?: string;
  service_type: string;
  service_code: string;
  shipping_amount: { amount: number; currency: string };
  delivery_days?: number | null;
  estimated_delivery_date?: string | null;
};

type RatesResult = {
  rates: Rate[];
  bestRate: Rate | null;
  cached: boolean;
  cacheKey: string;
  fetchedAt: string;
};

type RatesInput = {
  weightOz: number;
  toZip: string;
  toCountry?: string;
  toState?: string;
  toCity?: string;
  toAddress?: string;
  toName?: string;
  residential?: boolean;
  forceRefresh?: boolean;
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

function buildRatesInput(data: OrderDetail): RatesInput | { error: string } {
  if (!data.weightOz) return { error: 'Order weight is not set.' };
  if (!data.shipToPostalCode && !data.raw?.shipTo?.postalCode)
    return { error: 'Recipient postal code is missing.' };

  return {
    weightOz: data.weightOz,
    toZip: (data.shipToPostalCode ?? data.raw?.shipTo?.postalCode)!,
    toCountry: data.raw?.shipTo?.country,
    toState: data.shipToState ?? data.raw?.shipTo?.state,
    toCity: data.shipToCity ?? data.raw?.shipTo?.city,
    toAddress: data.raw?.shipTo?.street1,
    toName: data.shipToName ?? data.raw?.shipTo?.name,
    residential: data.overrides?.residential ?? undefined,
  };
}

export default function OrderDrawer() {
  const { status, orderId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = Number(orderId);
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);

  const close = () => navigate(`/orders/${status ?? 'awaiting_shipment'}`);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    data,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });

  const ratesMutation = useMutation({
    mutationFn: (input: RatesInput) => api.post<RatesResult>('/rates', input),
  });

  const purchaseMutation = useMutation({
    mutationFn: (rateId: string) =>
      api.post<Shipment>('/labels', {
        mode: 'from_rate',
        rateId,
        orderId: id,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['orders-count'] });
      setSelectedRateId(null);
      ratesMutation.reset();
    },
  });

  const sendToQueue = useMutation({
    mutationFn: (shipment: Shipment) => {
      const firstItem = data?.items?.[0];
      return api.post<{ queue_entry_id: string; already_queued: boolean }>(
        '/print-queue/add',
        {
          client_id: data?.clientId ?? 0,
          order_id: String(data?.id ?? ''),
          order_number: data?.orderNumber ?? null,
          label_url: shipment.labelUrl,
          sku_group_id: firstItem?.sku ?? `order-${data?.id}`,
          primary_sku: firstItem?.sku ?? null,
          item_description: firstItem?.name ?? null,
          order_qty: firstItem?.quantity ?? 1,
        }
      );
    },
    onSuccess: (r) => {
      alert(r.already_queued ? 'Already in queue' : 'Sent to print queue');
    },
    onError: (e) => alert(`Queue add failed: ${(e as Error).message}`),
  });

  const canBuyLabel =
    data && data.orderStatus === 'awaiting_shipment' && data.shipments.length === 0;

  const onFetchRates = (forceRefresh = false) => {
    if (!data) return;
    const input = buildRatesInput(data);
    if ('error' in input) return;
    ratesMutation.mutate({ ...input, forceRefresh });
  };

  const sortedRates = (ratesMutation.data?.rates ?? [])
    .slice()
    .sort((a, b) => a.shipping_amount.amount - b.shipping_amount.amount);
  const selectedRate = sortedRates.find((r) => r.rate_id === selectedRateId) ?? null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
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
          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )}
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
                  <Field label="Total" value={`$${data.orderTotal}`} mono />
                  <Field
                    label="Weight"
                    value={data.weightOz ? `${data.weightOz.toFixed(1)} oz` : null}
                    mono
                  />
                  <Field label="Shipping" value={`$${data.shippingAmount}`} mono />
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
                          <div
                            className="text-sm2 text-ink truncate"
                            title={it.name ?? ''}
                          >
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
                    <div className="text-ink-2 font-mono pt-1">{data.customerEmail}</div>
                  )}
                  {data.raw?.shipTo?.phone && (
                    <div className="text-ink-2 font-mono">{data.raw.shipTo.phone}</div>
                  )}
                </div>
              </Card>

              {/* Rates (only while order is still awaitable) */}
              {canBuyLabel && (
                <Card
                  title="Shipping rates"
                  actions={
                    ratesMutation.data && (
                      <button
                        type="button"
                        onClick={() => onFetchRates(true)}
                        disabled={ratesMutation.isPending}
                        className="text-ink-3 hover:text-ink disabled:opacity-50"
                        title="Refresh rates"
                      >
                        <RefreshCw
                          size={12}
                          className={ratesMutation.isPending ? 'animate-spin' : ''}
                        />
                      </button>
                    )
                  }
                  bodyClassName={ratesMutation.data ? '' : 'p-3.5'}
                >
                  {!ratesMutation.data && !ratesMutation.isPending && (
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm2 text-ink-2">
                        Live quote from ShipStation carriers.
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onFetchRates()}
                      >
                        Fetch rates
                      </Button>
                    </div>
                  )}

                  {ratesMutation.isPending && !ratesMutation.data && (
                    <div className="text-center text-ink-3 text-sm2 py-4">
                      Fetching live rates…
                    </div>
                  )}

                  {ratesMutation.isError && (
                    <div className="text-danger text-sm2 py-1">
                      {(ratesMutation.error as Error).message}
                    </div>
                  )}

                  {ratesMutation.data && (
                    <>
                      <div className="divide-y divide-line">
                        {sortedRates.map((rate) => {
                          const isSelected = selectedRateId === rate.rate_id;
                          return (
                            <button
                              key={rate.rate_id}
                              type="button"
                              onClick={() => setSelectedRateId(rate.rate_id)}
                              className={`w-full text-left px-3.5 py-2.5 border-l-[3px] transition-colors ${
                                isSelected
                                  ? 'bg-brand-bg border-brand'
                                  : 'border-transparent hover:bg-surface-2'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                                    isSelected
                                      ? 'bg-brand border-brand'
                                      : 'border-line-2'
                                  }`}
                                >
                                  {isSelected && (
                                    <Check size={10} className="text-white" />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm2 font-semibold text-ink">
                                    {rate.carrier_code.toUpperCase()} —{' '}
                                    {rate.service_type}
                                  </div>
                                  <div className="text-tiny text-ink-3 mt-0.5">
                                    {rate.delivery_days
                                      ? `~${rate.delivery_days} transit day${rate.delivery_days === 1 ? '' : 's'}`
                                      : 'Transit time varies'}
                                  </div>
                                </div>
                                <div className="text-sm2 font-bold font-mono shrink-0">
                                  ${rate.shipping_amount.amount.toFixed(2)}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                        {sortedRates.length === 0 && (
                          <div className="px-3.5 py-4 text-ink-3 text-sm2 text-center">
                            No rates returned for this shipment.
                          </div>
                        )}
                      </div>

                      <div className="px-3.5 py-2.5 border-t border-line bg-surface-2 flex items-center gap-2">
                        <div className="text-tiny text-ink-3 flex-1">
                          {ratesMutation.data.cached ? 'From cache' : 'Live'} ·{' '}
                          {sortedRates.length} rate
                          {sortedRates.length === 1 ? '' : 's'}
                        </div>
                        <Button
                          variant="green"
                          size="sm"
                          disabled={
                            !selectedRateId || purchaseMutation.isPending
                          }
                          onClick={() => {
                            if (!selectedRateId) return;
                            purchaseMutation.mutate(selectedRateId);
                          }}
                        >
                          {purchaseMutation.isPending
                            ? 'Purchasing…'
                            : selectedRate
                              ? `Buy label — $${selectedRate.shipping_amount.amount.toFixed(2)}`
                              : 'Select a rate'}
                        </Button>
                      </div>

                      {purchaseMutation.isError && (
                        <div className="px-3.5 py-2 text-danger text-sm2 border-t border-line">
                          {(purchaseMutation.error as Error).message}
                        </div>
                      )}
                    </>
                  )}
                </Card>
              )}

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
                          <div className="mt-1.5 flex items-center gap-3 text-tiny font-semibold">
                            <a
                              href={s.labelUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-brand hover:underline"
                            >
                              Download label →
                            </a>
                            {!s.voided && data?.clientId && (
                              <button
                                type="button"
                                onClick={() => sendToQueue.mutate(s)}
                                disabled={sendToQueue.isPending}
                                className="inline-flex items-center gap-1 text-ok-dark hover:underline disabled:opacity-50"
                              >
                                <Printer size={11} />
                                Send to queue
                              </button>
                            )}
                          </div>
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
      </aside>
    </div>
  );
}
