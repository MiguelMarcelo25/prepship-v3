// @ts-nocheck
/**
 * Order Detail Drawer — v2 parity port from apps/web/public/js/order-detail.js.
 * Opens when the user clicks an order number link in the orders table. Shows
 * a wider (600px) two-column drawer with Shipment Details, Items, Shipment
 * History, Configure Shipment (read-only summary), and Actions.
 *
 * Separate from the side panel — this is a READ-ONLY info view; the side
 * panel remains the workspace for weight/dim/label editing.
 */

import { useEffect, useState } from 'react';
import { apiClient, TEST_CLIENT_IDS } from '../lib/v2-apiClient';

type ShipTo = {
  name?: string;
  company?: string | null;
  street1?: string;
  street2?: string | null;
  street3?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string | null;
  addressVerified?: string | null;
};

type OrderItem = {
  sku?: string | null;
  name?: string | null;
  quantity?: number;
  unitPrice?: number;
  imageUrl?: string | null;
  options?: Array<{ name?: string; value?: string }>;
};

type Shipment = {
  shipmentId?: number;
  carrierCode?: string | null;
  serviceCode?: string | null;
  trackingNumber?: string | null;
  shipmentCost?: number | null;
  otherCost?: number | null;
  shipDate?: string | null;
  voided?: boolean;
  source?: string | null;
};

type OrderFull = {
  orderId?: number;
  orderNumber?: string;
  orderStatus?: string;
  orderDate?: string;
  paymentDate?: string;
  shipByDate?: string;
  deliverByDate?: string;
  holdUntilDate?: string;
  orderTotal?: number;
  amountPaid?: number;
  shippingAmount?: number;
  taxAmount?: number;
  customerEmail?: string;
  customerNotes?: string;
  internalNotes?: string;
  gift?: boolean;
  giftMessage?: string;
  shipTo?: ShipTo;
  items?: OrderItem[];
  weight?: { value?: number; units?: string };
  dimensions?: { length?: number; width?: number; height?: number; units?: string };
  advancedOptions?: {
    warehouseId?: number;
    source?: string;
    billToAccount?: string;
    nonMachinable?: boolean;
    saturdayDelivery?: boolean;
    containsAlcohol?: boolean;
    customField1?: string;
    customField2?: string;
    customField3?: string;
  };
  serviceCode?: string;
  carrierCode?: string;
  packageCode?: string;
  confirmation?: string;
  insuranceOptions?: {
    insureShipment?: boolean;
    insuredValue?: number;
  };
};

type OrderFullResponse = {
  raw?: OrderFull;
  shipments?: Shipment[];
  local?: any;
  [k: string]: any;
};

export type OrderDetailDrawerProps = {
  orderId: number | null;
  onClose: () => void;
};

const CARRIER_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
};

function fmtMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : '$0.00';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtWeight(oz: number | null | undefined): string {
  const total = Number(oz ?? 0);
  if (!total) return '—';
  const lb = Math.floor(total / 16);
  const ozPart = Math.round(total % 16);
  if (lb === 0) return `${ozPart} oz`;
  if (ozPart === 0) return `${lb} lb`;
  return `${lb} lb ${ozPart} oz`;
}

function StatusBadge({ status }: { status?: string }) {
  const s = (status ?? 'unknown').toLowerCase();
  const color =
    s === 'awaiting_shipment'
      ? { bg: '#e0f2fe', fg: '#0369a1' }
      : s === 'shipped'
        ? { bg: '#dcfce7', fg: '#15803d' }
        : s === 'cancelled'
          ? { bg: '#fee2e2', fg: '#b91c1c' }
          : { bg: '#fef3c7', fg: '#a16207' };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '.5px',
        background: color.bg,
        color: color.fg,
        padding: '3px 8px',
        borderRadius: 4,
      }}
    >
      {s.replace(/_/g, ' ')}
    </span>
  );
}

function Card({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 14,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--text)',
          marginBottom: 10,
          textTransform: 'uppercase',
          letterSpacing: '.3px',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          color: 'var(--text3)',
          letterSpacing: '.3px',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

export default function OrderDetailDrawer({
  orderId,
  onClose,
}: OrderDetailDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<OrderFullResponse | null>(null);

  useEffect(() => {
    if (orderId == null) {
      setPayload(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPayload(null);
    apiClient
      .fetchOrderFull(orderId)
      .then((res: any) => {
        if (cancelled) return;
        setPayload(res ?? null);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message ?? 'Failed to load order');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  useEffect(() => {
    if (orderId == null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [orderId, onClose]);

  if (orderId == null) return null;

  const raw: OrderFull = (payload?.raw ?? payload ?? {}) as OrderFull;
  const shipTo: ShipTo = raw.shipTo ?? {};
  const items: OrderItem[] = (raw.items ?? []).filter(
    (it) => (it as any)?.adjustment !== true
  );
  const shipments: Shipment[] = payload?.shipments ?? [];

  const orderTotal = Number(raw.orderTotal ?? 0);
  const shippingAmount = Number(raw.shippingAmount ?? 0);
  const taxAmount = Number(raw.taxAmount ?? 0);
  const amountPaid = Number(raw.amountPaid ?? orderTotal);
  const productTotal = Math.max(0, orderTotal - shippingAmount - taxAmount);

  const addrLines: string[] = [];
  if (shipTo.company) addrLines.push(shipTo.company);
  if (shipTo.street1) addrLines.push(shipTo.street1);
  if (shipTo.street2) addrLines.push(shipTo.street2);
  if (shipTo.street3) addrLines.push(shipTo.street3);
  const cityLine = [shipTo.city, shipTo.state, shipTo.postalCode]
    .filter(Boolean)
    .join(', ');
  if (cityLine) addrLines.push(cityLine);
  if (shipTo.country && shipTo.country !== 'US') addrLines.push(shipTo.country);

  const verified = shipTo.addressVerified;
  const isValid =
    verified === 'Address validated successfully' || verified === 'Verified';
  const addrBadge = isValid ? '✓ Address Validated' : `⚠ ${verified || 'Not Validated'}`;

  const weightDisplay = fmtWeight(raw.weight?.value);
  const dims = raw.dimensions;
  const dimsDisplay =
    dims?.length && dims?.width && dims?.height
      ? `${dims.length} × ${dims.width} × ${dims.height} ${dims.units || 'inches'}`
      : '—';

  const insureHtml = raw.insuranceOptions?.insureShipment
    ? `Insured — ${fmtMoney(raw.insuranceOptions.insuredValue)}`
    : 'None';

  const liveShipment = shipments.find((s) => !s.voided) ?? shipments[0];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15,23,42,.45)',
          zIndex: 1400,
        }}
      />
      {/* Drawer */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(720px, 95vw)',
          background: 'var(--background, #f6f7fb)',
          zIndex: 1401,
          boxShadow: '-8px 0 32px rgba(0,0,0,.18)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 18px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 20,
              color: 'var(--text2)',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
          <strong style={{ fontSize: 15 }}>
            #{raw.orderNumber ?? orderId}
          </strong>
          {typeof raw.clientId === 'number' &&
          TEST_CLIENT_IDS.has(raw.clientId) ? (
            <span
              title="Sandbox / testing order — no real postage, billing, or inventory impact"
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                color: '#fff',
                background: '#d97706',
                borderRadius: 4,
              }}
            >
              TEST ORDER — DO NOT SHIP
            </span>
          ) : null}
          <StatusBadge status={raw.orderStatus} />
          {loading ? (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>
              Loading…
            </span>
          ) : null}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
          {error ? (
            <div style={{ color: 'var(--red)', textAlign: 'center', padding: 60 }}>
              Error loading order: {error}
            </div>
          ) : (
            <>
              <Card
                title={
                  <>
                    📦 Shipment Details
                  </>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text3)',
                        letterSpacing: '.3px',
                        marginBottom: 4,
                      }}
                    >
                      Ship To
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: 3 }}>
                      {shipTo.name ?? '—'}
                    </div>
                    <div
                      style={{
                        whiteSpace: 'pre-line',
                        color: 'var(--text2)',
                        fontSize: 12,
                        lineHeight: 1.45,
                      }}
                    >
                      {addrLines.join('\n') || '—'}
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        color: isValid ? 'var(--green, #16a34a)' : 'var(--text3)',
                      }}
                    >
                      {addrBadge}
                    </div>
                    {shipTo.phone ? (
                      <div style={{ marginTop: 8 }}>
                        <Field label="Phone" value={shipTo.phone} />
                      </div>
                    ) : null}
                    {raw.customerEmail ? (
                      <Field
                        label="Email"
                        value={
                          <span style={{ wordBreak: 'break-all' }}>
                            {raw.customerEmail}
                          </span>
                        }
                      />
                    ) : null}
                    {raw.gift ? (
                      <div
                        style={{
                          marginTop: 8,
                          padding: '4px 10px',
                          background: '#fef3c7',
                          color: '#a16207',
                          borderRadius: 4,
                          fontSize: 11,
                          display: 'inline-block',
                          fontWeight: 600,
                        }}
                      >
                        🎁 Gift Order
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--text3)',
                        letterSpacing: '.3px',
                        marginBottom: 8,
                      }}
                    >
                      Cost Summary
                    </div>
                    <div style={{ fontSize: 12.5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: 'var(--text2)' }}>Product Total</span>
                        <span>{fmtMoney(productTotal)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: 'var(--text2)' }}>Shipping</span>
                        <span>{fmtMoney(shippingAmount)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: 'var(--text2)' }}>Tax</span>
                        <span>{fmtMoney(taxAmount)}</span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontWeight: 700,
                          marginTop: 4,
                          paddingTop: 4,
                          borderTop: '1px solid var(--border)',
                        }}
                      >
                        <span>Total Paid</span>
                        <span>{fmtMoney(amountPaid)}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 14 }}>
                  <Field label="Order Date" value={fmtDate(raw.orderDate)} />
                  <Field label="Date Paid" value={fmtDate(raw.paymentDate ?? raw.orderDate)} />
                  {raw.shipByDate ? (
                    <Field
                      label="Ship By"
                      value={
                        <span style={{ color: '#b45309', fontWeight: 600 }}>
                          {fmtDate(raw.shipByDate)}
                        </span>
                      }
                    />
                  ) : (
                    <div />
                  )}
                </div>
              </Card>

              <Card title={`🛒 Items (${items.length})`}>
                {items.length === 0 ? (
                  <div style={{ color: 'var(--text3)', fontSize: 12 }}>
                    No items found.
                  </div>
                ) : (
                  items.map((it, i) => (
                    <div
                      key={`${it.sku ?? 'it'}-${i}`}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '8px 0',
                        borderBottom:
                          i === items.length - 1 ? 'none' : '1px solid var(--border)',
                        alignItems: 'flex-start',
                      }}
                    >
                      <div
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 6,
                          background: 'var(--surface2, #f8fafc)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          overflow: 'hidden',
                        }}
                      >
                        {it.imageUrl ? (
                          <img
                            src={it.imageUrl}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          '📦'
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {it.name ?? '—'}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--text3)',
                            fontFamily: 'monospace',
                            marginTop: 2,
                          }}
                        >
                          SKU: {it.sku ?? '—'}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--text2)', marginTop: 3 }}>
                          {fmtMoney(it.unitPrice)} × {it.quantity ?? 1} ={' '}
                          <strong>
                            {fmtMoney((it.unitPrice ?? 0) * (it.quantity ?? 1))}
                          </strong>
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: 'var(--text)',
                          flexShrink: 0,
                        }}
                      >
                        {it.quantity ?? 1}
                      </div>
                    </div>
                  ))
                )}
              </Card>

              {(raw.customerNotes || raw.internalNotes) && (
                <Card title="📝 Notes">
                  {raw.customerNotes ? (
                    <Field
                      label="Customer Notes"
                      value={
                        <div
                          style={{
                            whiteSpace: 'pre-wrap',
                            fontStyle: 'italic',
                            color: 'var(--text2)',
                          }}
                        >
                          {raw.customerNotes}
                        </div>
                      }
                    />
                  ) : null}
                  {raw.internalNotes ? (
                    <Field
                      label="Internal Notes"
                      value={
                        <div
                          style={{
                            whiteSpace: 'pre-wrap',
                            color: '#b45309',
                          }}
                        >
                          {raw.internalNotes}
                        </div>
                      }
                    />
                  ) : null}
                </Card>
              )}

              <Card title="🚚 Configure Shipment">
                <Field label="Status" value={<StatusBadge status={raw.orderStatus} />} />
                {liveShipment ? (
                  <>
                    <Field
                      label="Shipped Carrier"
                      value={
                        CARRIER_NAMES[liveShipment.carrierCode ?? ''] ??
                        (liveShipment.carrierCode ?? '').toUpperCase() ??
                        '—'
                      }
                    />
                    <Field
                      label="Shipped Service"
                      value={(liveShipment.serviceCode ?? '').replace(/_/g, ' ') || '—'}
                    />
                    <Field
                      label="Label Cost"
                      value={
                        <span style={{ fontWeight: 700, color: 'var(--green, #15803d)' }}>
                          {fmtMoney(
                            (liveShipment.shipmentCost ?? 0) +
                              (liveShipment.otherCost ?? 0)
                          )}
                        </span>
                      }
                    />
                    {liveShipment.trackingNumber ? (
                      <Field
                        label="Tracking #"
                        value={
                          <span
                            style={{
                              color: 'var(--ss-blue)',
                              cursor: 'pointer',
                              fontFamily: 'monospace',
                              fontSize: 12,
                            }}
                            onClick={() =>
                              navigator.clipboard?.writeText(
                                liveShipment.trackingNumber ?? ''
                              )
                            }
                            title="Click to copy"
                          >
                            {liveShipment.trackingNumber}
                          </span>
                        }
                      />
                    ) : null}
                    {liveShipment.shipDate ? (
                      <Field label="Ship Date" value={fmtDate(liveShipment.shipDate)} />
                    ) : null}
                    <div
                      style={{
                        borderBottom: '1px solid var(--border)',
                        margin: '10px 0',
                      }}
                    />
                  </>
                ) : null}
                <Field
                  label="Requested Service"
                  value={(raw.serviceCode ?? '').replace(/_/g, ' ') || '—'}
                />
                <Field label="Weight" value={weightDisplay} />
                <Field label="Dimensions" value={dimsDisplay} />
                <Field label="Package" value={raw.packageCode ?? '—'} />
                <Field label="Confirmation" value={raw.confirmation ?? '—'} />
                <Field label="Insurance" value={insureHtml} />
              </Card>

              {raw.advancedOptions?.source ||
              raw.advancedOptions?.nonMachinable ||
              raw.advancedOptions?.saturdayDelivery ||
              raw.advancedOptions?.containsAlcohol ? (
                <Card title="⚙ Other Shipping Options">
                  {raw.advancedOptions?.source ? (
                    <Field label="Source" value={raw.advancedOptions.source} />
                  ) : null}
                  {raw.advancedOptions?.billToAccount ? (
                    <Field
                      label="Shipping Account"
                      value={raw.advancedOptions.billToAccount}
                    />
                  ) : null}
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text2)' }}>
                    <div>
                      {raw.advancedOptions?.nonMachinable ? '✓' : '☐'} Non-machinable
                    </div>
                    <div>
                      {raw.advancedOptions?.saturdayDelivery ? '✓' : '☐'} Saturday
                      Delivery
                    </div>
                    <div>
                      {raw.advancedOptions?.containsAlcohol ? '✓' : '☐'} Contains
                      Alcohol
                    </div>
                  </div>
                </Card>
              ) : null}

              {raw.orderStatus === 'awaiting_shipment' ? (
                <Card title="⚡ Actions">
                  <a
                    className="btn btn-outline"
                    href={`https://ship.shipstation.com/orders/${raw.orderId ?? orderId}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      textDecoration: 'none',
                      padding: 8,
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      color: 'var(--text)',
                      fontSize: 13,
                    }}
                  >
                    ↗ Open in ShipStation
                  </a>
                </Card>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
