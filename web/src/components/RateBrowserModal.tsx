// 3-column Rate Browser modal — ported from v2 public/js/rate-browser.js + the
// #rateBrowserModal HTML block in index.html. v2 parity is visual: same colors,
// same column widths, same badge behavior. Data plumbing uses v4's adapter
// (apiClient.fetchRates translates v2 payload shape to v4 server-side).
//
// Layout: Configure (220px) | Carriers (190px) | Rates (flex).
// Rate fetching: iterates shippingAccounts sequentially with a 200ms spacing
// to mirror v2's rate-limit-friendly loop; partition by shippingProviderId
// so the carrier-count badges fill in progressively.
//
// Keep the file under ~600 lines. If/when block-list logic or per-client
// service unblocking is wired, extract v2's isBlockedRate into a helper
// module rather than fattening this component.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiClient } from '../lib/v2-apiClient';
import { useMarkups, type Markup } from '../contexts/MarkupsContext';

// ── Types (structural, minimal — mirrors what OrdersView actually passes) ────
export type RbLocationDto = {
  locationId: number;
  name: string;
  isDefault?: boolean;
};

export type RbPackageDto = {
  packageId: number;
  name: string;
  length?: number | null;
  width?: number | null;
  height?: number | null;
  source?: string | null; // 'custom' | 'ss_carrier' | 'shipstation'
  carrierCode?: string | null;
};

export type RbCarrierAccountDto = {
  shippingProviderId: number;
  carrierId?: string | null;
  code: string;
  nickname?: string | null;
  accountNumber?: string | null;
  name?: string | null;
  _label?: string | null;
};

export type RbOrderSummaryDto = {
  orderId: number;
  weight?: { value?: number } | null;
  rateDims?: { length?: number | null; width?: number | null; height?: number | null } | null;
  shipTo?: { postalCode?: string | null; company?: string | null } | null;
  residential?: boolean | null;
  sourceResidential?: boolean | null;
};

export type RbAppliedRate = {
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  shippingProviderId: number;
  shipmentCost: number;
  otherCost: number;
  carrierNickname?: string;
  weight?: { lb: number; oz: number };
  dims?: { length: number; width: number; height: number };
};

export type RateBrowserModalProps = {
  open: boolean;
  order: RbOrderSummaryDto | null;
  locations: RbLocationDto[];
  packages: RbPackageDto[];
  shippingAccounts: RbCarrierAccountDto[];
  initialDims?: { length?: number; width?: number; height?: number };
  initialWeight?: { lb?: number; oz?: number };
  onClose: () => void;
  onApplyRate: (rate: RbAppliedRate) => void;
};

type RateRow = {
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  carrierNickname?: string | null;
  shippingProviderId: number | string | null;
  shipmentCost: number;
  otherCost: number;
  amount: number;
  raw?: any;
};

// ── v2 constants ports (trimmed to what the row renderer needs) ──────────────
const CARRIER_NAMES: Record<string, string> = {
  stamps_com: 'USPS',
  ups: 'UPS',
  ups_walleted: 'UPS',
  fedex: 'FedEx',
  fedex_walleted: 'FedEx',
  dhl_express: 'DHL',
  asendia_us: 'Asendia',
  ontrac: 'OnTrac',
  lasership: 'LaserShip',
  amazon_swa: 'Amazon',
  globegistics: 'Globegistics',
};

const SERVICE_NAMES: Record<string, string> = {
  // USPS
  usps_priority_mail: 'Priority Mail',
  usps_priority_mail_express: 'Priority Express',
  usps_first_class_mail: 'First Class',
  usps_ground_advantage: 'Ground Advantage',
  usps_media_mail: 'Media Mail',
  usps_library_mail: 'Library Mail',
  usps_parcel_select: 'Parcel Select',
  // UPS
  ups_ground: 'UPS Ground',
  ups_ground_saver: 'UPS Ground Saver',
  ups_surepost: 'UPS SurePost',
  ups_surepost_1_lb_or_greater: 'UPS SurePost (≥1 lb)',
  ups_surepost_less_than_1_lb: 'UPS SurePost (<1 lb)',
  ups_3_day_select: 'UPS 3 Day Select',
  ups_2nd_day_air: 'UPS 2nd Day Air',
  ups_2nd_day_air_am: 'UPS 2nd Day Air AM',
  ups_next_day_air_saver: 'UPS Next Day Air Saver',
  ups_next_day_air: 'UPS Next Day Air',
  ups_next_day_air_early_am: 'UPS Next Day Air Early AM',
  ups_worldwide_express: 'UPS Worldwide Express',
  // FedEx
  fedex_ground: 'FedEx Ground',
  fedex_home_delivery: 'FedEx Home Delivery',
  fedex_2day: 'FedEx 2Day',
  fedex_2day_am: 'FedEx 2Day AM',
  fedex_2_day: 'FedEx 2Day',
  fedex_express_saver: 'FedEx Express Saver',
  fedex_priority_overnight: 'FedEx Priority Overnight',
  fedex_standard_overnight: 'FedEx Standard Overnight',
  fedex_first_overnight: 'FedEx First Overnight',
};

// 40×40 colored badge from v2's rbCarrierLogo. Kept inline instead of using
// the existing <span class="carrier-badge"> pattern because the rate row
// wants a bold solid-color badge, not the subtle inline chip.
function carrierBadgeLarge(code: string | null | undefined): ReactNode {
  const styles: Record<string, { bg: string; fg: string }> = {
    ups: { bg: '#351c15', fg: '#ffb500' },
    ups_walleted: { bg: '#351c15', fg: '#ffb500' },
    stamps_com: { bg: '#215eb6', fg: '#fff' },
    fedex: { bg: '#4d148c', fg: '#ff6200' },
    fedex_walleted: { bg: '#4d148c', fg: '#ff6200' },
  };
  const labels: Record<string, string> = {
    ups: 'UPS',
    ups_walleted: 'UPS',
    stamps_com: 'USPS',
    fedex: 'FedEx',
    fedex_walleted: 'FedEx',
  };
  const cc = code || '';
  const s = styles[cc] ?? { bg: 'var(--border2)', fg: 'var(--text2)' };
  const l = labels[cc] ?? (cc || '?').toUpperCase().slice(0, 4);
  return (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 6,
        background: s.bg,
        color: s.fg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 900,
        fontSize: 10,
        flexShrink: 0,
        letterSpacing: '-0.3px',
      }}
    >
      {l}
    </div>
  );
}

function formatCarrierDisplay(rate: {
  carrierNickname?: string | null;
  _label?: string | null;
  carrierCode?: string | null;
}, fallback = 'Unknown'): string {
  if (!rate) return fallback;
  if (rate.carrierNickname && !String(rate.carrierNickname).startsWith('se-')) {
    return String(rate.carrierNickname);
  }
  if (rate._label && !String(rate._label).startsWith('se-')) {
    return String(rate._label);
  }
  const generic = rate.carrierCode ? CARRIER_NAMES[rate.carrierCode] : undefined;
  if (generic) return generic;
  return fallback;
}

function formatEta(r: RateRow): string {
  const iso = (r as any).estimatedDelivery ?? r.raw?.estimated_delivery_date;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      const dayStr = d.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'numeric',
        day: 'numeric',
      });
      const timeStr = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      return `${dayStr} By ${timeStr}`;
    }
  }
  const days = (r as any).deliveryDays ?? r.raw?.delivery_days;
  if (typeof days === 'number' && days > 0) {
    return `${days} Day${days > 1 ? 's' : ''}`;
  }
  return '—';
}

function applyRbMarkupFn(
  markups: Record<string, Markup>,
  pidOrCc: number | string | null,
  base: number
): number {
  if (pidOrCc == null) return base;
  const m = markups[String(pidOrCc)];
  if (!m || !m.value) return base;
  return m.type === 'pct' || m.type === 'percent'
    ? base * (1 + m.value / 100)
    : base + m.value;
}

function priceDisplay(
  rawCost: number,
  markedCost: number,
  opts: { mainColor?: string; mainSize?: string } = {}
): ReactNode {
  const mainSize = opts.mainSize ?? '13px';
  const mainColor = opts.mainColor ?? 'var(--green)';
  const hasMarkup = markedCost > rawCost + 0.005;
  const show = markedCost > 0.005 || rawCost > 0.005;
  if (!show) {
    return <span style={{ color: 'var(--text3)', fontSize: mainSize }}>N/A</span>;
  }
  return (
    <div style={{ lineHeight: 1.3 }}>
      <strong style={{ color: mainColor, fontSize: mainSize }}>
        ${(hasMarkup ? markedCost : rawCost).toFixed(2)}
      </strong>
      {hasMarkup && (
        <div style={{ fontSize: 10, color: 'var(--text3)' }}>
          ${rawCost.toFixed(2)} cost
        </div>
      )}
    </div>
  );
}

// v2's isBlockedRate uses a per-store service-unblock list the server
// maintains. Stubbed to never-blocked per task spec — safe default until the
// per-client block list ports.
function isBlockedRate(_rate: RateRow): boolean {
  return false;
}

export default function RateBrowserModal({
  open,
  order,
  locations,
  packages,
  shippingAccounts,
  initialDims,
  initialWeight,
  onClose,
  onApplyRate,
}: RateBrowserModalProps) {
  const { markups } = useMarkups();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [zip, setZip] = useState('');
  const [locationId, setLocationId] = useState('');
  const [wtLb, setWtLb] = useState('0');
  const [wtOz, setWtOz] = useState('0');
  const [packageId, setPackageId] = useState('');
  const [lenStr, setLen] = useState('0');
  const [widStr, setWid] = useState('0');
  const [hgtStr, setHgt] = useState('0');
  const [signature, setSignature] = useState<'none' | 'signature' | 'adult_signature'>('none');
  const [svcClass, setSvcClass] = useState<'' | 'ground' | 'express'>('');

  // ── Rates state ────────────────────────────────────────────────────────────
  const [ratesByPid, setRatesByPid] = useState<Record<string, RateRow[]>>({});
  const [pendingPids, setPendingPids] = useState<Set<number>>(new Set());
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'carriers'>('all');
  const [hideUnavail, setHideUnavail] = useState(true);
  const [browsing, setBrowsing] = useState(false);

  // Populate form from order on open. Priority for dims: panel > saved >
  // nothing. Priority for weight: initialWeight prop > order.weight.value.
  useEffect(() => {
    if (!open) return;
    setZip(order?.shipTo?.postalCode?.slice(0, 5) ?? '');

    if (initialWeight && ((initialWeight.lb ?? 0) > 0 || (initialWeight.oz ?? 0) > 0)) {
      setWtLb(String(Math.floor(initialWeight.lb ?? 0)));
      setWtOz(String(Math.round(initialWeight.oz ?? 0)));
    } else {
      const totalOz = order?.weight?.value ?? 0;
      setWtLb(String(Math.floor(totalOz / 16)));
      setWtOz(String(Math.round(totalOz % 16)));
    }

    const panelLen = initialDims?.length ?? 0;
    const panelWid = initialDims?.width ?? 0;
    const panelHgt = initialDims?.height ?? 0;
    const savedLen = order?.rateDims?.length ?? 0;
    const savedWid = order?.rateDims?.width ?? 0;
    const savedHgt = order?.rateDims?.height ?? 0;
    setLen(String(panelLen || savedLen || 0));
    setWid(String(panelWid || savedWid || 0));
    setHgt(String(panelHgt || savedHgt || 0));

    const defaultLoc = locations.find((l) => l.isDefault) ?? locations[0];
    setLocationId(defaultLoc ? String(defaultLoc.locationId) : '');
    setPackageId('');
    setSignature('none');
    setSvcClass('');
    setViewMode('all');
    setSelectedPid(null);
    setRatesByPid({});
    // `locations` is intentionally not in deps — it doesn't change per-order
    // and we only want to re-hydrate when the modal opens or the order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.orderId]);

  // Derived
  const lbNum = parseFloat(wtLb) || 0;
  const ozNum = parseFloat(wtOz) || 0;
  const lenNum = parseFloat(lenStr) || 0;
  const widNum = parseFloat(widStr) || 0;
  const hgtNum = parseFloat(hgtStr) || 0;
  const hasWeight = lbNum > 0 || ozNum > 0;
  const hasDims = lenNum > 0 && widNum > 0 && hgtNum > 0;
  const anyFetched = Object.keys(ratesByPid).length > 0;

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Auto-select a package when dimensions match within 0.15" tolerance
  // (v2's rbUpdateBadgesAndAutoSelect).
  useEffect(() => {
    if (!open || !hasDims) return;
    const tol = 0.15;
    const match = packages.find(
      (p) =>
        typeof p.length === 'number' &&
        typeof p.width === 'number' &&
        typeof p.height === 'number' &&
        p.length > 0 &&
        Math.abs(p.length - lenNum) <= tol &&
        Math.abs(p.width - widNum) <= tol &&
        Math.abs(p.height - hgtNum) <= tol
    );
    if (match) setPackageId(String(match.packageId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lenNum, widNum, hgtNum, hasDims]);

  // Package dropdown grouping
  const packageGroups = useMemo(() => {
    const strip = (n: string) => n.replace(/^\[USPS\] |\[UPS\] |\[FedEx\] /, '');
    const custom = packages.filter(
      (p) => p.source !== 'ss_carrier' && p.source !== 'shipstation'
    );
    const carrier = packages.filter(
      (p) => p.source === 'ss_carrier' || p.source === 'shipstation'
    );
    const byCarrier: Record<string, RbPackageDto[]> = {};
    for (const p of carrier) {
      const cc = p.carrierCode ?? 'unknown';
      (byCarrier[cc] ??= []).push(p);
    }
    return { custom, byCarrier, strip };
  }, [packages]);

  function onPackageChange(id: string): void {
    setPackageId(id);
    if (!id) return;
    const pkg = packages.find((p) => String(p.packageId) === id);
    if (!pkg) return;
    if (typeof pkg.length === 'number' && pkg.length > 0) setLen(String(pkg.length));
    if (typeof pkg.width === 'number' && pkg.width > 0) setWid(String(pkg.width));
    if (typeof pkg.height === 'number' && pkg.height > 0) setHgt(String(pkg.height));
  }

  // Per-carrier fetch loop with 200ms spacing (v2 parity for rate-limit
  // friendliness). Each call returns a full rate list from the adapter;
  // we partition by shippingProviderId so the carrier-count badges fill in
  // progressively as each carrier resolves.
  async function browseRates(): Promise<void> {
    if (!zip || zip.length < 5 || !hasWeight || !hasDims) return;

    const totalOz = lbNum * 16 + ozNum;
    setBrowsing(true);
    setRatesByPid({});
    setPendingPids(new Set(shippingAccounts.map((a) => a.shippingProviderId)));

    // Persist dims for this order (fire-and-forget) so re-open sees them.
    if (order?.orderId) {
      void apiClient.saveOrderDims(order.orderId, {
        l: lenNum,
        w: widNum,
        h: hgtNum,
      });
    }

    for (const acct of shippingAccounts) {
      try {
        const raw = (await apiClient.fetchRates({
          toPostalCode: zip,
          toCountry: 'US',
          weight: { value: totalOz, units: 'ounces' },
          dimensions: {
            units: 'inches',
            length: lenNum,
            width: widNum,
            height: hgtNum,
          },
          residential: true,
          carrierIds: acct.carrierId ? [acct.carrierId] : undefined,
        })) as RateRow[];

        const list: RateRow[] = (raw ?? []).map((r) => ({
          ...r,
          shippingProviderId: r.shippingProviderId ?? acct.shippingProviderId,
          carrierNickname:
            r.carrierNickname ??
            acct._label ??
            acct.nickname ??
            acct.accountNumber ??
            acct.name ??
            null,
        }));
        list.sort(
          (a, b) =>
            (a.shipmentCost + a.otherCost) - (b.shipmentCost + b.otherCost)
        );
        setRatesByPid((prev) => ({
          ...prev,
          [String(acct.shippingProviderId)]: list,
        }));
      } catch {
        setRatesByPid((prev) => ({
          ...prev,
          [String(acct.shippingProviderId)]: [],
        }));
      }
      setPendingPids((prev) => {
        const next = new Set(prev);
        next.delete(acct.shippingProviderId);
        return next;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    setBrowsing(false);
  }

  function filterBySvcClass(rates: RateRow[]): RateRow[] {
    if (!svcClass) return rates;
    return rates.filter((r) => {
      const n = (r.serviceName || r.serviceCode || '').toLowerCase();
      if (svcClass === 'ground') {
        return (
          n.includes('ground') ||
          n.includes('surepost') ||
          n.includes('parcel') ||
          n.includes('media')
        );
      }
      return (
        n.includes('express') ||
        n.includes('priority') ||
        n.includes('2 day') ||
        n.includes('2day') ||
        n.includes('overnight') ||
        n.includes('next day') ||
        n.includes('3 day') ||
        n.includes('select')
      );
    });
  }

  const combinedAll: RateRow[] = useMemo(() => {
    const out: RateRow[] = [];
    for (const acct of shippingAccounts) {
      const rates = ratesByPid[String(acct.shippingProviderId)] ?? [];
      for (const r of rates) {
        out.push({
          ...r,
          shippingProviderId: r.shippingProviderId ?? acct.shippingProviderId,
          carrierNickname:
            r.carrierNickname ??
            acct._label ??
            acct.nickname ??
            acct.accountNumber ??
            acct.name ??
            null,
        });
      }
    }
    return filterBySvcClass(out).sort((a, b) => {
      const am = applyRbMarkupFn(
        markups,
        a.shippingProviderId,
        a.shipmentCost + a.otherCost
      );
      const bm = applyRbMarkupFn(
        markups,
        b.shippingProviderId,
        b.shipmentCost + b.otherCost
      );
      return am - bm;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesByPid, shippingAccounts, svcClass, markups]);

  const totalCarriersAvailable = useMemo(
    () =>
      shippingAccounts.filter(
        (c) => (ratesByPid[String(c.shippingProviderId)] ?? []).length > 0
      ).length,
    [shippingAccounts, ratesByPid]
  );

  function handleRateClick(r: RateRow): void {
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    if (!Number.isFinite(pid) || !r.serviceCode) return;
    if (order?.orderId) {
      void apiClient.setOrderSelectedPid(order.orderId, pid);
    }
    onApplyRate({
      carrierCode: r.carrierCode,
      serviceCode: r.serviceCode,
      serviceName: r.serviceName,
      shippingProviderId: pid,
      shipmentCost: r.shipmentCost,
      otherCost: r.otherCost,
      carrierNickname: r.carrierNickname ?? undefined,
      weight: { lb: lbNum, oz: ozNum },
      dims: { length: lenNum, width: widNum, height: hgtNum },
    });
    onClose();
  }

  if (!open) return null;

  // ── Sub-renderers ──────────────────────────────────────────────────────────

  function renderRateRow(r: RateRow, index: number, showCarrier: boolean, isRecommended: boolean): ReactNode {
    const blocked = isBlockedRate(r);
    const base = r.shipmentCost + r.otherCost;
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    const marked = applyRbMarkupFn(markups, Number.isFinite(pid) ? pid : null, base);
    const svcName =
      r.serviceName ||
      SERVICE_NAMES[r.serviceCode] ||
      (r.serviceCode || '').replace(/_/g, ' ') ||
      '—';
    const acctName = formatCarrierDisplay(r);
    const eta = formatEta(r);
    const primaryText = showCarrier ? acctName : svcName;
    const secondaryText = showCarrier ? svcName : '';

    const detailsArr: any[] = (r.raw?.rate_details ?? r.raw?.rateDetails ?? []) as any[];
    const surcharges = detailsArr.filter(
      (d) =>
        d?.rate_detail_type !== 'shipping' &&
        typeof d?.amount?.amount === 'number' &&
        d.amount.amount > 0
    );

    return (
      <div
        key={`${pid}-${r.serviceCode}-${index}`}
        onClick={blocked ? undefined : () => handleRateClick(r)}
        title={blocked ? 'Not available for current clients' : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '10px 18px',
          borderBottom: '1px solid var(--border)',
          cursor: blocked ? 'not-allowed' : 'pointer',
          opacity: blocked ? 0.45 : 1,
          transition: 'background .1s',
        }}
        onMouseEnter={(e) => {
          if (!blocked) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface2)';
        }}
        onMouseLeave={(e) => {
          if (!blocked) (e.currentTarget as HTMLDivElement).style.background = '';
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {isRecommended && !blocked && (
            <div
              style={{
                display: 'inline-block',
                background: '#1a5c29',
                color: '#fff',
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 8px',
                borderRadius: 3,
                marginBottom: 4,
                letterSpacing: '.3px',
              }}
            >
              Recommended
            </div>
          )}
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--text)',
              lineHeight: 1.3,
              textDecoration: blocked ? 'line-through' : 'none',
            }}
          >
            {primaryText}
            {blocked && (
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text3)',
                  fontWeight: 400,
                  textDecoration: 'none',
                  marginLeft: 6,
                }}
              >
                (unavailable)
              </span>
            )}
          </div>
          {secondaryText && (
            <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.4 }}>
              {secondaryText}
            </div>
          )}
          {surcharges.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2, lineHeight: 1.5 }}>
              {surcharges.map((d: any, i: number) => (
                <span key={i} style={{ marginRight: 8 }}>
                  +${(d.amount.amount as number).toFixed(2)}{' '}
                  {d.carrier_description || d.carrierDescription || ''}
                </span>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
            textDecoration: blocked ? 'line-through' : 'none',
          }}
        >
          {eta && eta !== '—' && (
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#000',
                whiteSpace: 'nowrap',
                textAlign: 'right',
                marginRight: 15,
              }}
            >
              {eta}
            </div>
          )}
          {carrierBadgeLarge(r.carrierCode)}
          <div style={{ textAlign: 'right', minWidth: 65 }}>
            {priceDisplay(base, marked, {
              mainColor: blocked ? 'var(--text3)' : 'var(--green)',
            })}
          </div>
        </div>
      </div>
    );
  }

  function renderRatesBody(): ReactNode {
    if (!hasWeight || !hasDims) {
      const missing =
        !hasWeight && !hasDims
          ? 'weight and dims'
          : !hasWeight
            ? 'weight'
            : 'dims (L × W × H)';
      return (
        <div style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text3)' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>📏</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text2)',
              marginBottom: 6,
            }}
          >
            Enter {missing} to fetch rates
          </div>
          <div style={{ fontSize: 12 }}>
            Fill in the fields on the left panel, then click Browse Rates.
          </div>
        </div>
      );
    }
    if (browsing && !anyFetched) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          ⏳ Fetching rates…
        </div>
      );
    }
    if (!anyFetched) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          Click Browse Rates to fetch rates
        </div>
      );
    }

    if (viewMode === 'all') return renderAllRatesView();
    return renderCarrierView();
  }

  function renderAllRatesView(): ReactNode {
    const displayed = hideUnavail
      ? combinedAll.filter((r) => !isBlockedRate(r))
      : combinedAll;
    const allCount = combinedAll.length;
    const hiddenCount = allCount - displayed.length;
    const countLabel =
      hideUnavail && hiddenCount > 0
        ? `${displayed.length} shown, ${hiddenCount} hidden`
        : `${allCount} total, sorted cheapest first`;

    if (!displayed.length) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          No rates available — click Browse Rates
        </div>
      );
    }

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r));
    return (
      <>
        <div
          style={{
            padding: '14px 18px 10px',
            borderBottom: '2px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              All Rates
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{countLabel}</span>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 16 }}>
          {displayed.map((r, i) => renderRateRow(r, i, true, i === firstOk))}
        </div>
      </>
    );
  }

  function renderCarrierView(): ReactNode {
    if (selectedPid == null) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          Select a carrier account
        </div>
      );
    }
    const acct = shippingAccounts.find((c) => c.shippingProviderId === selectedPid);
    const all = ratesByPid[String(selectedPid)] ?? [];
    const filtered = filterBySvcClass(all);
    const displayed = hideUnavail
      ? filtered.filter((r) => !isBlockedRate(r))
      : filtered;
    const hiddenCount = filtered.length - displayed.length;
    const countLabel =
      hideUnavail && hiddenCount > 0
        ? `${displayed.length} shown, ${hiddenCount} hidden`
        : `${filtered.length} rate${filtered.length !== 1 ? 's' : ''} available`;

    if (!all.length) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          No rates available for <b>{acct?.nickname || 'this account'}</b>
        </div>
      );
    }

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r));
    return (
      <>
        <div
          style={{
            padding: '14px 18px 10px',
            borderBottom: '2px solid var(--border)',
            background: 'var(--surface2)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {acct?._label || acct?.nickname || acct?.accountNumber || 'Account'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{countLabel}</span>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 16 }}>
          {displayed.map((r, i) => renderRateRow(r, i, false, i === firstOk))}
        </div>
      </>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rate Browser"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          borderRadius: 10,
          boxShadow: '0 8px 40px rgba(0,0,0,.3)',
          width: 980,
          maxWidth: '97vw',
          height: 650,
          maxHeight: '93vh',
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
            padding: '13px 18px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            background: 'var(--surface2)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', flex: 1 }}>
            Rate Browser
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              cursor: 'pointer',
              color: 'var(--text3)',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Body: 3 columns */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* LEFT: Configure */}
          <div
            style={{
              width: 220,
              flexShrink: 0,
              borderRight: '1px solid var(--border)',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
            }}
          >
            <div
              style={{
                padding: '14px 14px 0',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text3)',
                textTransform: 'uppercase',
                letterSpacing: '.5px',
                marginBottom: 6,
              }}
            >
              Configure Rates
            </div>

            <div
              style={{
                padding: '0 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                flex: 1,
              }}
            >
              {/* Ship From */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text)',
                    marginBottom: 6,
                  }}
                >
                  Ship From
                </div>
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="ship-select"
                  style={{ width: '100%' }}
                >
                  {locations.length === 0 && <option value="">No locations loaded</option>}
                  {locations.map((l) => (
                    <option key={l.locationId} value={l.locationId}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Ship To */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text)',
                    marginBottom: 6,
                  }}
                >
                  Ship To
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Postal Code
                </div>
                <input
                  type="text"
                  maxLength={5}
                  placeholder="90001"
                  value={zip}
                  onChange={(e) =>
                    setZip(e.target.value.replace(/\D/g, '').slice(0, 5))
                  }
                  className="ship-input"
                  style={{ width: '100%' }}
                />
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: 'var(--text2)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <span style={{ color: 'var(--green)' }}>✓</span> Residential Address
                  <span style={{ color: 'var(--text3)', fontSize: 10 }}>(always)</span>
                </div>
              </div>

              {/* Shipment Info */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--text)',
                    marginBottom: 8,
                  }}
                >
                  Shipment Information
                </div>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Weight{' '}
                  {hasWeight && (
                    <span
                      style={{
                        color: 'var(--green)',
                        fontWeight: 700,
                        fontSize: 10,
                      }}
                      title="Weight saved for this SKU"
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    marginBottom: 10,
                  }}
                >
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={wtLb}
                    onChange={(e) => setWtLb(e.target.value)}
                    className="ship-input"
                    style={{ width: 54 }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>(lb)</span>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    step={1}
                    value={wtOz}
                    onChange={(e) => setWtOz(e.target.value)}
                    className="ship-input"
                    style={{ width: 54 }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>(oz)</span>
                </div>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Package
                </div>
                <select
                  value={packageId}
                  onChange={(e) => onPackageChange(e.target.value)}
                  className="ship-select"
                  style={{ width: '100%', marginBottom: 10 }}
                >
                  <option value="">Select Package</option>
                  {packageGroups.custom.length > 0 && (
                    <optgroup label="Custom">
                      {packageGroups.custom.map((p, idx) => (
                        <option
                          key={`custom-${p.packageId ?? (p as any).id ?? p.name ?? idx}`}
                          value={p.packageId ?? (p as any).id ?? ''}
                        >
                          {packageGroups.strip(p.name)}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {Object.entries(packageGroups.byCarrier).map(([cc, pkgs]) => {
                    const labelMap: Record<string, string> = {
                      stamps_com: 'USPS',
                      ups: 'UPS',
                      fedex: 'FedEx',
                    };
                    const label = labelMap[cc] ?? cc.toUpperCase();
                    return (
                      <optgroup key={cc} label={label}>
                        {pkgs.map((p, idx) => (
                          <option
                            key={`${cc}-${p.packageId ?? (p as any).id ?? p.name ?? idx}`}
                            value={p.packageId ?? (p as any).id ?? ''}
                          >
                            {packageGroups.strip(p.name)}
                          </option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Size (L × W × H in){' '}
                  {hasDims && (
                    <span
                      style={{
                        color: 'var(--green)',
                        fontWeight: 700,
                        fontSize: 10,
                      }}
                      title="Dims saved for this SKU"
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    marginBottom: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={lenStr}
                    onChange={(e) => setLen(e.target.value)}
                    className="ship-input"
                    style={{ width: 48 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>L</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={widStr}
                    onChange={(e) => setWid(e.target.value)}
                    className="ship-input"
                    style={{ width: 48 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>W</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={hgtStr}
                    onChange={(e) => setHgt(e.target.value)}
                    className="ship-input"
                    style={{ width: 48 }}
                  />
                  <span style={{ fontSize: 10, color: 'var(--text3)' }}>H</span>
                </div>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Delivery Confirmation
                  <span
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: 'var(--green)',
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    ✓ Always Enabled
                  </span>
                </div>
                <select
                  value={signature}
                  onChange={(e) =>
                    setSignature(e.target.value as 'none' | 'signature' | 'adult_signature')
                  }
                  className="ship-select"
                  style={{ width: '100%', marginBottom: 10 }}
                >
                  <option value="none">No Signature Required</option>
                  <option value="signature">Signature Required</option>
                  <option value="adult_signature">Adult Signature Required</option>
                </select>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Service Class
                </div>
                <select
                  value={svcClass}
                  onChange={(e) => setSvcClass(e.target.value as '' | 'ground' | 'express')}
                  className="ship-select"
                  style={{ width: '100%', marginBottom: 10 }}
                >
                  <option value="">Show All</option>
                  <option value="ground">Ground / Economy</option>
                  <option value="express">Express / Priority</option>
                </select>
              </div>
            </div>

            {/* Browse button pinned to bottom */}
            <div
              style={{
                padding: '12px 14px',
                borderTop: '1px solid var(--border)',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void browseRates()}
                disabled={
                  browsing || !hasWeight || !hasDims || !zip || zip.length < 5
                }
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  fontSize: 13,
                  padding: 9,
                }}
              >
                {browsing ? 'Fetching…' : 'Browse Rates'}
              </button>
            </div>
          </div>

          {/* MIDDLE: Carrier accounts */}
          <div
            style={{
              width: 190,
              flexShrink: 0,
              borderRight: '1px solid var(--border)',
              overflowY: 'auto',
              background: 'var(--surface2)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--text3)',
                textTransform: 'uppercase',
                letterSpacing: '.5px',
                padding: '8px 12px 6px',
              }}
            >
              Carrier Accounts
            </div>
            {shippingAccounts.map((c) => {
              const isSel = c.shippingProviderId === selectedPid;
              const rates = ratesByPid[String(c.shippingProviderId)];
              const count =
                rates != null
                  ? hideUnavail
                    ? rates.filter((r) => !isBlockedRate(r)).length
                    : rates.length
                  : null;
              const pending = pendingPids.has(c.shippingProviderId);
              return (
                <div
                  key={c.shippingProviderId}
                  onClick={() => {
                    setSelectedPid(c.shippingProviderId);
                    setViewMode('carriers');
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 12px',
                    cursor: 'pointer',
                    background: isSel ? 'var(--ss-blue)' : 'transparent',
                    color: isSel ? '#fff' : 'var(--text)',
                    borderLeft: `3px solid ${isSel ? 'var(--ss-blue)' : 'transparent'}`,
                    transition: 'background .1s',
                  }}
                >
                  <span
                    className={`carrier-badge ${
                      c.code?.includes('ups')
                        ? 'carrier-ups'
                        : c.code?.includes('fedex')
                          ? 'carrier-fedex'
                          : c.code?.includes('stamps') || c.code?.includes('usps')
                            ? 'carrier-usps'
                            : 'carrier-other'
                    }`}
                    style={{ fontSize: 9.5, padding: '1px 5px' }}
                  >
                    {CARRIER_NAMES[c.code] ??
                      (c.code || '?').toUpperCase().slice(0, 4)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c._label || c.nickname || c.accountNumber || c.name}
                  </span>
                  {count != null ? (
                    <span
                      style={{
                        background: isSel ? 'rgba(255,255,255,.3)' : 'var(--ss-blue)',
                        color: '#fff',
                        borderRadius: 10,
                        padding: '1px 8px',
                        fontSize: 10,
                        fontWeight: 700,
                        minWidth: 22,
                        textAlign: 'center',
                      }}
                    >
                      {count}
                    </span>
                  ) : (
                    <span
                      style={{
                        borderRadius: 10,
                        padding: '1px 8px',
                        fontSize: 10,
                        color: isSel ? 'rgba(255,255,255,.7)' : 'var(--text3)',
                      }}
                    >
                      {pending ? '⏳' : '…'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* RIGHT: Rates */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
            }}
          >
            {/* Rates top bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 18px',
                borderBottom: '1px solid var(--border)',
                flexShrink: 0,
                background: 'var(--surface2)',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                Rates
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text3)', flex: 1 }}>
                {anyFetched
                  ? `${totalCarriersAvailable} out of ${shippingAccounts.length} carriers available`
                  : ''}
              </span>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 11.5,
                  color: 'var(--text3)',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={hideUnavail}
                  onChange={(e) => setHideUnavail(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Hide Unavailable
              </label>
              <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>View By:</span>
              <select
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as 'all' | 'carriers')}
                className="ship-select"
                style={{ width: 110, fontSize: 12 }}
              >
                <option value="carriers">Carriers</option>
                <option value="all">All Rates</option>
              </select>
            </div>

            {/* Rates content */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {renderRatesBody()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
