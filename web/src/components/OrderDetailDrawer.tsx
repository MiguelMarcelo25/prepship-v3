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
  cost?: number | string | null;
  labelCost?: number | string | null;
  shipmentCost?: number | null;
  otherCost?: number | string | null;
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
  canonicalOrder?: {
    shipping?: {
      labelCost?: number | string | null;
    };
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
  displayStatus?: string;
  presentation?: 'drawer' | 'modal';
  closeLabel?: string;
  closeTitle?: string;
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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fmtOptionalMoney(n: number | null | undefined): string {
  return n == null ? '—' : fmtMoney(n);
}

function getShipmentLabelCost(shipment: Shipment | null | undefined): number | null {
  if (!shipment) return null;

  const labelCost = toNumber(shipment.labelCost);
  if (labelCost != null) return labelCost;

  const cost = toNumber(shipment.cost);
  const otherCost = toNumber(shipment.otherCost) ?? 0;
  if (cost != null) return cost + otherCost;

  const shipmentCost = toNumber(shipment.shipmentCost);
  return shipmentCost != null ? shipmentCost + otherCost : null;
}

function getShipmentBaseCost(shipment: Shipment | null | undefined): number | null {
  if (!shipment) return null;

  const shipmentCost = toNumber(shipment.shipmentCost);
  if (shipmentCost != null) return shipmentCost;

  return toNumber(shipment.cost);
}

function getLabelCostBreakdown(
  shipment: Shipment | null | undefined,
  labelCost: number | null | undefined,
) {
  const baseCost = getShipmentBaseCost(shipment);
  const markupCost =
    labelCost != null && baseCost != null
      ? Math.max(0, labelCost - baseCost)
      : null;

  return { labelCost: labelCost ?? null, baseCost, markupCost };
}

function LabelCostStack({ breakdown }: { breakdown: ReturnType<typeof getLabelCostBreakdown> }) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ fontWeight: 700, color: 'var(--green, #15803d)' }}>
        {fmtOptionalMoney(breakdown.labelCost)}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text)', fontWeight: 600 }}>
        Base {fmtOptionalMoney(breakdown.baseCost)} + Markup {fmtOptionalMoney(breakdown.markupCost)}
      </div>
    </div>
  );
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

function splitWeight(oz: number | null | undefined) {
  const total = Number(oz ?? 0);
  if (!Number.isFinite(total) || total <= 0) return { lb: '', oz: '' };
  return {
    lb: String(Math.floor(total / 16)),
    oz: String(Math.round(total % 16)),
  };
}

function textValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function formatCode(value: unknown): string {
  const text = textValue(value);
  if (!text) return '-';
  return text
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getPanelAddressBlock(shipTo: ShipTo): string {
  const lines: string[] = [];
  if (shipTo.company) lines.push(shipTo.company);
  if (shipTo.street1) lines.push(shipTo.street1);
  if (shipTo.street2) lines.push(shipTo.street2);
  if (shipTo.street3) lines.push(shipTo.street3);
  const cityLine = [shipTo.city, shipTo.state, shipTo.postalCode]
    .filter(Boolean)
    .join(', ');
  if (cityLine) lines.push(cityLine);
  if (shipTo.country && shipTo.country !== 'US') lines.push(shipTo.country);
  return lines.join('\n');
}

function PanelReadOnlyField({ value }: { value: React.ReactNode }) {
  return (
    <div className="ship-input" style={{ minHeight: 29, display: 'flex', alignItems: 'center' }}>
      {value || '-'}
    </div>
  );
}

function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ship-field-row">
      <span className="ship-field-label">{label}</span>
      <div className="ship-field-value">{children}</div>
    </div>
  );
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
  displayStatus,
  presentation = 'drawer',
  closeLabel = '✕',
  closeTitle = 'Close',
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
  const effectiveStatus = displayStatus ?? raw.orderStatus;
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
  const labelCost =
    getShipmentLabelCost(liveShipment) ??
    toNumber(raw.canonicalOrder?.shipping?.labelCost);
  const labelBreakdown = getLabelCostBreakdown(liveShipment, labelCost);
  const isShipped = (effectiveStatus ?? '').toLowerCase() === 'shipped';
  const isModal = presentation === 'modal';
  const closeIsTextButton = closeLabel !== '✕';

  if (isModal) {
    const shipmentRecord = (liveShipment ?? {}) as any;
    const rawRecord = raw as any;
    const canonicalShipping = (rawRecord.canonicalOrder?.shipping ?? {}) as Record<string, unknown>;
    const selectedRate = (rawRecord.selectedRate ?? rawRecord.bestRate ?? canonicalShipping.selectedRate ?? {}) as Record<string, unknown>;
    const modalWeightOz =
      toNumber(shipmentRecord.weightOz) ??
      toNumber(rawRecord.weightOz) ??
      toNumber(raw.weight?.value);
    const modalWeight = splitWeight(modalWeightOz);
    const modalDims = {
      length: toNumber(shipmentRecord.dimsL) ?? toNumber(raw.dimensions?.length),
      width: toNumber(shipmentRecord.dimsW) ?? toNumber(raw.dimensions?.width),
      height: toNumber(shipmentRecord.dimsH) ?? toNumber(raw.dimensions?.height),
    };
    const carrierCode = textValue(
      shipmentRecord.carrierCode,
      selectedRate.carrierCode,
      selectedRate.carrier_code,
      raw.carrierCode,
    );
    const serviceCode = textValue(
      shipmentRecord.serviceCode,
      selectedRate.serviceCode,
      selectedRate.service_code,
      raw.serviceCode,
    );
    const accountLabel = textValue(
      shipmentRecord.providerAccountNickname,
      selectedRate.providerAccountNickname,
      selectedRate.carrierNickname,
      selectedRate.carrier_nickname,
      canonicalShipping.accountNickname,
      canonicalShipping.providerAccountNickname,
      carrierCode,
    );
    const requestedService = textValue(
      rawRecord.requestedShippingService,
      rawRecord.requestedService,
      serviceCode,
      carrierCode,
      'Standard',
    );
    const packageText = textValue(
      shipmentRecord.selectedPackageId,
      raw.packageCode,
      rawRecord.packageCode,
    );
    const confirmationText = textValue(raw.confirmation, rawRecord.confirmation, 'delivery');
    const tracking = textValue(shipmentRecord.trackingNumber, rawRecord.trackingNumber);
    const shipFrom = textValue(
      rawRecord.shipFrom?.name,
      rawRecord.shipFrom?.company,
      raw.advancedOptions?.warehouseId ? `Warehouse ${raw.advancedOptions.warehouseId}` : null,
    );
    const rateAmount =
      labelCost ??
      toNumber(selectedRate.cost) ??
      toNumber(selectedRate.amount) ??
      toNumber(raw.shippingAmount);
    const rateDetail = [accountLabel, serviceCode ? formatCode(serviceCode) : null]
      .filter(Boolean)
      .join(' - ');
    const addressBlock = getPanelAddressBlock(shipTo);
    const soldTo = textValue(rawRecord.customerUsername, shipTo.name);

    return (
      <>
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,.45)',
            zIndex: 1400,
          }}
        />
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Order details ${raw.orderNumber ?? orderId}`}
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            width: 'min(430px, calc(100vw - 24px))',
            height: 'min(860px, calc(100vh - 36px))',
            transform: 'translate(-50%, -50%)',
            borderRadius: 8,
            background: 'var(--surface)',
            zIndex: 1401,
            boxShadow: '0 18px 54px rgba(15,23,42,.28)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div className="panel-topbar">
            <div className="panel-ordnum">
              {raw.orderNumber ?? `#${orderId}`}
            </div>
            <StatusBadge status={effectiveStatus} />
            <button className="panel-topbar-btn" type="button" onClick={onClose} title={closeTitle}>
              {closeLabel}
            </button>
          </div>

          <div className="panel-body">
            {loading ? <div className="loading">Loading full order detail...</div> : null}
            {error ? (
              <div className="error" style={{ padding: 24 }}>Error loading order: {error}</div>
            ) : (
              <>
                <div className="panel-section" id="sec-shipping">
                  <div className="panel-section-header">
                    <span className="panel-section-arrow">▶</span>
                    <span className="panel-section-title">Shipping</span>
                    <div className="panel-section-icons">
                      <span className="panel-section-icon" title="Settings">⚙</span>
                      <span className="panel-section-icon" title="Grid">⊞</span>
                    </div>
                  </div>

                  <div className="ship-req">
                    Requested: <span className="ship-req-link">{formatCode(requestedService)}</span>
                  </div>

                  <div className="panel-section-body">
                    <PanelField label="Ship From">
                      <PanelReadOnlyField value={shipFrom} />
                    </PanelField>
                    <PanelField label="Ship Acct">
                      <PanelReadOnlyField value={accountLabel} />
                    </PanelField>
                    <PanelField label="Service">
                      <PanelReadOnlyField value={formatCode(serviceCode)} />
                    </PanelField>
                    <PanelField label="Weight">
                      <input className="ship-input ship-input-sm" value={modalWeight.lb} readOnly />
                      <span className="ship-input-unit">lb</span>
                      <input className="ship-input ship-input-sm" value={modalWeight.oz} readOnly />
                      <span className="ship-input-unit">oz</span>
                    </PanelField>
                    <PanelField label="Size">
                      <input className="ship-input ship-input-sm" value={modalDims.length ?? ''} readOnly />
                      <span className="ship-input-unit">L</span>
                      <input className="ship-input ship-input-sm" value={modalDims.width ?? ''} readOnly />
                      <span className="ship-input-unit">W</span>
                      <input className="ship-input ship-input-sm" value={modalDims.height ?? ''} readOnly />
                      <span className="ship-input-unit">H (in)</span>
                    </PanelField>
                    <PanelField label="Package">
                      <PanelReadOnlyField value={packageText} />
                    </PanelField>
                    {modalDims.length && modalDims.width && modalDims.height ? (
                      <div
                        id="p-package-dims"
                        style={{
                          padding: '0 0 6px 98px',
                          fontSize: 10,
                          fontWeight: 600,
                          color: 'var(--green,#16a34a)',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {`${modalDims.length} x ${modalDims.width} x ${modalDims.height} in`}
                      </div>
                    ) : null}
                    <PanelField label="Confirmation">
                      <PanelReadOnlyField value={formatCode(confirmationText)} />
                    </PanelField>
                    <PanelField label="Insurance">
                      <PanelReadOnlyField value={insureHtml} />
                    </PanelField>
                    <div className="ship-rate-row">
                      <span style={{ fontSize: 11.5, color: 'var(--text2)', fontWeight: 500, width: 90, flexShrink: 0 }}>Rate</span>
                      <span className="ship-rate-val" id="panel-rate-val">
                        <span className="ship-rate-price">{fmtOptionalMoney(rateAmount)}</span>
                        <span className="ship-rate-detail">{rateDetail || formatCode(carrierCode)}</span>
                      </span>
                    </div>
                  </div>
                </div>

                {tracking ? (
                  <div className="delivery-row" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Tracking:</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>
                      {tracking}
                    </span>
                  </div>
                ) : null}
                <div className="delivery-row">
                  {liveShipment?.shipDate ? `Shipped: ${fmtDate(liveShipment.shipDate)}` : 'Delivery: -'}
                </div>

                <div className="panel-section" id="sec-items">
                  <div className="panel-section-header">
                    <span className="panel-section-arrow">▶</span>
                    <span className="panel-section-title">Items</span>
                    <div className="panel-section-icons">
                      <span className="panel-section-icon">★</span>
                      <span className="panel-section-icon">⊞</span>
                    </div>
                  </div>
                  <div className="panel-section-body">
                    {items.length === 0 ? (
                      <div style={{ paddingTop: 12, color: 'var(--text3)', fontSize: 11.5 }}>No items found for this order.</div>
                    ) : null}
                    {items.map((item, index) => (
                      <div key={`${item.sku ?? 'unknown'}-${index}`} className="item-row">
                        <div className="item-img">
                          {item.imageUrl ? (
                            <img src={item.imageUrl} alt={item.name ?? ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <span>Box</span>
                          )}
                        </div>
                        <div className="item-info">
                          <div className="item-name">{item.name ?? 'Unknown Item'}</div>
                          <div className="item-sku">SKU: {item.sku ?? '-'}</div>
                          <div className="item-price-row">
                            {fmtMoney(item.unitPrice)} x {item.quantity ?? 1} = <strong>{fmtMoney((item.unitPrice ?? 0) * (item.quantity ?? 1))}</strong>
                          </div>
                        </div>
                        <div className="item-qty">{item.quantity ?? 1}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel-section" id="sec-recipient">
                  <div className="panel-section-header">
                    <span className="panel-section-arrow">▶</span>
                    <span className="panel-section-title">Recipient</span>
                    <div className="panel-section-icons">
                      <span className="panel-section-icon">⊞</span>
                    </div>
                  </div>
                  <div className="panel-section-body">
                    <div className="recip-header">
                      <span className="recip-title">Ship To</span>
                    </div>
                    <div className="recip-name">{shipTo.name ?? '-'}</div>
                    <div className="recip-addr">{addressBlock || '-'}</div>
                    {shipTo.phone ? <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3 }}>{shipTo.phone}</div> : null}
                    {raw.customerEmail ? <div style={{ fontSize: 11.5, color: 'var(--text2)', marginTop: 3, wordBreak: 'break-all' }}>{raw.customerEmail}</div> : null}
                    <div id="panel-addr-type" style={{ fontSize: 11, color: 'var(--text3)', marginTop: 5, marginBottom: 2 }}>
                      {rawRecord.residential ? 'Residential' : 'Commercial'}
                    </div>
                    <div className="recip-validated">
                      {shipTo.addressVerified && shipTo.addressVerified !== 'Not Validated' ? 'Address Validated' : 'Address Not Validated'}
                    </div>
                    <div className="recip-tax">
                      Tax Information: <span style={{ color: 'var(--text3)' }}>0 Tax IDs added</span>
                    </div>
                    <div className="recip-sold" style={{ marginTop: 7, paddingTop: 7, borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text3)', marginBottom: 4 }}>Sold To</div>
                      <div className="recip-sold-name">{soldTo ?? '-'}</div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </>
    );
  }

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
      {/* Detail surface */}
      <div
        style={{
          position: 'fixed',
          top: isModal ? '50%' : 0,
          right: isModal ? 'auto' : 0,
          bottom: isModal ? 'auto' : 0,
          left: isModal ? '50%' : 'auto',
          width: isModal ? 'min(780px, calc(100vw - 32px))' : 'min(720px, 95vw)',
          height: isModal ? 'min(820px, calc(100vh - 48px))' : undefined,
          maxHeight: isModal ? 'calc(100vh - 48px)' : undefined,
          transform: isModal ? 'translate(-50%, -50%)' : undefined,
          borderRadius: isModal ? 10 : 0,
          background: 'var(--background, #f6f7fb)',
          zIndex: 1401,
          boxShadow: isModal ? '0 18px 54px rgba(15,23,42,.28)' : '-8px 0 32px rgba(0,0,0,.18)',
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
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 28,
              background: closeIsTextButton ? 'var(--surface2)' : 'none',
              border: closeIsTextButton ? '1px solid var(--border2)' : 'none',
              borderRadius: closeIsTextButton ? 6 : 0,
              fontSize: closeIsTextButton ? 12 : 20,
              fontWeight: closeIsTextButton ? 700 : 400,
              color: 'var(--text2)',
              cursor: 'pointer',
              padding: closeIsTextButton ? '5px 10px' : '0 4px',
              lineHeight: 1,
            }}
            title={closeTitle}
          >
            {closeLabel}
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
          <StatusBadge status={effectiveStatus} />
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
                      {isShipped ? (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                            <span style={{ color: 'var(--text2)' }}>Label Cost</span>
                            <span style={{ fontWeight: 700, color: 'var(--green, #15803d)' }}>
                              {fmtOptionalMoney(labelBreakdown.labelCost)}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11 }}>
                            <span style={{ color: 'var(--text2)' }}>Base Cost</span>
                            <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                              {fmtOptionalMoney(labelBreakdown.baseCost)}
                            </span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 11 }}>
                            <span style={{ color: 'var(--text2)' }}>Markup</span>
                            <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                              {fmtOptionalMoney(labelBreakdown.markupCost)}
                            </span>
                          </div>
                        </>
                      ) : null}
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
                <Field label="Status" value={<StatusBadge status={effectiveStatus} />} />
                {isShipped ? (
                  <Field
                    label="Label Cost"
                    value={
                      <LabelCostStack breakdown={labelBreakdown} />
                    }
                  />
                ) : null}
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

              {effectiveStatus === 'awaiting_shipment' ? (
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
