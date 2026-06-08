// 3-column Rate Browser modal — ported from v2 public/js/rate-browser.js + the
// #rateBrowserModal HTML block in index.html. v2 parity is visual: same colors,
// same column widths, same badge behavior. Data plumbing uses v4's adapter
// (apiClient.fetchRates translates v2 payload shape to v4 server-side).
//
// Layout: Configure (220px) | Carriers (190px) | Rates (flex).
// Rate fetching: asks the v4 adapter for all scoped carrier IDs in one request.
// The server still performs ShipStation's one-carrier estimate calls behind the
// adapter, but does them in parallel so the modal is not blocked account by
// account.
//
// Keep the file under ~600 lines. If/when block-list logic or per-client
// service unblocking is wired, extract v2's isBlockedRate into a helper
// module rather than fattening this component.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { apiClient } from '../lib/v2-apiClient';
import { CALIFORNIA_TZ } from '../lib/ca-time';
import { useMarkups, type Markup } from '../contexts/MarkupsContext';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  evaluateShippingServiceEligibility,
  isHugrabShippingContext,
} from '../../../src/lib/shipping-service-eligibility';
// Shared carrier badge — official UPS/USPS SVG logos with fallback
// pills for FedEx/etc. Replaces the local carrier-class switch below.
import CarrierBadge from './CarrierBadge';
// PS-083: the scoped-carrier cache lives in its own module so Settings can
// invalidate it after an assign/unassign (see clearScopedCarrierAccountsCache).
import {
  getScopedCarrierAccounts,
  hasScopedCarrierAccounts,
  setScopedCarrierAccounts,
} from './rate-browser-carrier-cache';

// ── Types (structural, minimal — mirrors what OrdersView actually passes) ────
export type RbLocationDto = {
  locationId: number;
  name: string;
  company?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
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
  carrierCode?: string | null;
  code: string;
  nickname?: string | null;
  accountNumber?: string | null;
  name?: string | null;
  _label?: string | null;
  source?: string | null;
  sourceClientName?: string | null;
  directCarrierAccountId?: number | null;
};

export type RbOrderSummaryDto = {
  orderId: number;
  orderNumber?: string | null;
  externalOrderId?: string | null;
  external_order_id?: string | null;
  storeId?: number | null;
  clientId?: number | null;
  clientName?: string | null;
  bestRate?: Record<string, unknown> | null;
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
  confirmation?: RateConfirmation;
  insuranceProvider?: string;
  insuredValue?: number | null;
  weight?: { lb: number; oz: number };
  dims?: { length: number; width: number; height: number };
};

type RateConfirmation =
  | 'none'
  | 'delivery'
  | 'signature'
  | 'adult_signature'
  | 'direct_signature';

// POLICY (DJ, 2026-06-04, superseding the earlier same-day always-on rule):
// Delivery Confirmation now DEFAULTS TO 'None'. 'None' is a selectable option and
// is the default, so a PrepShip UPS Ground rate matches ShipStation's
// no-confirmation quote out of the box (UPS charges for delivery confirmation on
// Ground but bundles it free on air services). The operator can still opt INTO
// Delivery / Signature / Adult / Direct Signature per order. The backend already
// treats 'none' as "send no confirmation" (rates.ts normalizeRateConfirmation
// returns undefined for 'none'), and the UPS connector only maps explicit
// signature confirmations to accessorial codes (ups-direct-accessorial-guard).
const CONFIRMATION_OPTIONS: Array<{ value: RateConfirmation; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'signature', label: 'Signature' },
  { value: 'adult_signature', label: 'Adult Signature' },
  { value: 'direct_signature', label: 'Direct Signature' },
];

function normalizeConfirmationForRates(value?: string | null): RateConfirmation {
  const normalized = String(value ?? '').trim().toLowerCase();
  return CONFIRMATION_OPTIONS.some((option) => option.value === normalized)
    ? (normalized as RateConfirmation)
    : 'none';
}

export type RateBrowserModalProps = {
  open: boolean;
  order: RbOrderSummaryDto | null;
  locations: RbLocationDto[];
  packages: RbPackageDto[];
  shippingAccounts: RbCarrierAccountDto[];
  initialDims?: { length?: number; width?: number; height?: number };
  initialWeight?: { lb?: number; oz?: number };
  initialConfirmation?: string;
  initialInsurance?: string;
  initialInsuranceValue?: string | number | null;
  testMode?: boolean;
  onClose: () => void;
  onApplyRate: (rate: RbAppliedRate) => void;
  onBestRateResolved?: (rate: RbAppliedRate) => void;
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

type DirectCarrierRateError = {
  shippingProviderId?: number | string | null;
  provider?: string | null;
  label?: string | null;
  message?: string | null;
};

type CarrierRateStatus = 'cached' | 'loading' | 'live' | 'unavailable' | 'error';

type RateBrowseInfo = {
  source: 'cache' | 'live' | 'mixed' | null;
  cacheAgeMs?: number;
};

type BrowseRateOptions = {
  cachedOnly?: boolean;
  forceLive?: boolean;
};

function formatCacheAge(ms: number | undefined): string | null {
  if (!Number.isFinite(ms ?? NaN)) return null;
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function RateLoadingSpinner({ text = 'Fetching rates…' }: { text?: string }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      <Loader2 size={14} strokeWidth={2.5} className="animate-spin" aria-hidden />
      <span>{text}</span>
    </span>
  );
}

function carrierAccountScopeKey(order: RbOrderSummaryDto | null): string {
  return [
    order?.clientId != null ? `client:${order.clientId}` : 'client:none',
    order?.storeId != null ? `store:${order.storeId}` : 'store:none',
  ].join('|');
}

// ── v2 constants ports (trimmed to what the row renderer needs) ──────────────
const CARRIER_NAMES: Record<string, string> = {
  prepship_test: 'PrepShip Test',
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
  amazon_shipping: 'Amazon',
  ebay_shipping: 'eBay',
  ehub: 'eHub',
  easypost: 'EasyPost',
  shipp: 'Shipp',
  globegistics: 'Globegistics',
  walmart: 'Walmart',
  walmart_shipping: 'Walmart',
};

const DIRECT_PROVIDER_LABELS: Record<string, string> = {
  amazon_shipping: 'Amazon Shipping',
  ebay_shipping: 'eBay Shipping',
  ehub: 'eHub',
  easypost: 'EasyPost',
  shipp: 'Shipp',
  fedex: 'FedEx Direct',
  simulator: 'Simulator',
  stamps_com: 'Stamps.com Direct',
  ups: 'UPS Direct',
  usps: 'USPS Direct',
  walmart: 'Walmart',
  walmart_shipping: 'Walmart Shipping',
};

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function toDisplayLabel(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && !value.trim().startsWith('se-')
    ? value.trim()
    : null;
}

function isGenericAccountLabel(
  value: string,
  account: Partial<RbCarrierAccountDto> | null | undefined
): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  const generic = account?.code ? CARRIER_NAMES[account.code] : null;
  const candidates = [
    generic,
    account?.code,
    account?.carrierCode,
    account?.name,
  ]
    .map((candidate) => toDisplayLabel(candidate)?.toLowerCase())
    .filter(Boolean);
  return candidates.includes(normalized);
}

function providerLabelForAccount(account: Partial<RbCarrierAccountDto> | null | undefined): string | null {
  const key = normalizeProviderKey(account?.code || account?.carrierCode);
  return CARRIER_NAMES[key] ?? DIRECT_PROVIDER_LABELS[key] ?? null;
}

function isOpaqueAccountIdentifierLabel(
  value: string,
  account: Partial<RbCarrierAccountDto> | null | undefined
): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!providerLabelForAccount(account)) return false;

  const sourceKey = normalizeProviderKey(
    (account as any)?.sourceTable ||
    account?.source ||
    account?.sourceClientName
  );
  const isDirectAccount =
    account?.directCarrierAccountId != null ||
    sourceKey.includes('carrier_accounts') ||
    sourceKey.includes('direct_carrier_accounts');
  if (!isDirectAccount) return false;

  const accountNumber = toDisplayLabel(account?.accountNumber);
  const isAccountNumberLabel = accountNumber != null && trimmed === accountNumber;
  const looksLikeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed);
  const looksLikeLongToken = /^(?:cid:)?[a-z0-9_-]{12,}$/i.test(trimmed);
  return looksLikeUuid || (isAccountNumberLabel && looksLikeLongToken);
}

function formatAccountDisplay(
  account: Partial<RbCarrierAccountDto> | null | undefined,
  fallback = 'Account'
): string {
  const labels = [
    toDisplayLabel(account?.nickname),
    toDisplayLabel(account?._label),
    toDisplayLabel(account?.accountNumber),
    toDisplayLabel(account?.name),
  ].filter(Boolean) as string[];
  const preferred = labels.find(
    (label) => !isGenericAccountLabel(label, account) && !isOpaqueAccountIdentifierLabel(label, account)
  );
  return preferred ?? providerLabelForAccount(account) ?? labels[0] ?? fallback;
}

const SERVICE_NAMES: Record<string, string> = {
  test_mock_service: 'Test Mock Service',
  prepship_test_standard: 'PrepShip Test Standard',
  prepship_test_economy: 'PrepShip Test Economy',
  prepship_test_priority: 'PrepShip Test Priority',
  prepship_test_express: 'PrepShip Test Express',
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
  ups_surepost: 'UPS Ground Saver',
  ups_surepost_1_lb_or_greater: 'UPS Ground Saver (1 lb+)',
  ups_surepost_less_than_1_lb: 'UPS Ground Saver (<1 lb)',
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

// Rate-row carrier badge — the prominent mark next to the price.
// Now delegates to the shared <CarrierBadge> component so UPS/USPS/
// FedEx render as official SVG logos (matching every other badge
// surface in the app). The special-case `prepship_test` mark stays
// inline because it's a PrepShip-internal indicator, not a real
// carrier — falls outside the carrier-logo dispatcher.
function carrierBadgeLarge(code: string | null | undefined): ReactNode {
  if (code === 'prepship_test') {
    return (
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: '#0f766e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.35)',
        }}
      >
        <img src="/prepship-test-logo.svg" alt="" style={{ width: 34, height: 34, display: 'block' }} />
      </div>
    );
  }
  // md size matches the rate-row's prominence — same scale as the
  // New Order modal's rate preview pane. Single source of truth for
  // carrier branding across the app.
  return <CarrierBadge code={code ?? ''} size="md" />;
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
        timeZone: CALIFORNIA_TZ,
      });
      const timeStr = d.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: CALIFORNIA_TZ,
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

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function getModalRateSourceLabel(
  rate: RateRow,
  accounts: RbCarrierAccountDto[]
): string {
  const pid = toFiniteNumber(rate.shippingProviderId);
  const account = pid != null
    ? accounts.find((candidate) => candidate.shippingProviderId === pid)
    : null;
  const raw = rate.raw ?? {};
  const providerKey =
    normalizeProviderKey(account?.code) ||
    normalizeProviderKey(raw.provider) ||
    normalizeProviderKey(raw.source) ||
    normalizeProviderKey(rate.carrierCode);
  const sourceKey =
    normalizeProviderKey(account?.source) ||
    normalizeProviderKey(account?.sourceClientName) ||
    normalizeProviderKey(raw.source);
  const isDirect =
    (pid != null && pid >= 10_000_000) ||
    sourceKey === 'carrier_accounts' ||
    sourceKey === 'direct_carrier_accounts';

  if (isDirect) return DIRECT_PROVIDER_LABELS[providerKey] ?? 'Direct Carrier';
  return 'ShipStation';
}

function buildOrderBestRateSeed(
  order: RbOrderSummaryDto | null,
  shippingAccounts: RbCarrierAccountDto[]
): RateRow | null {
  const bestRate = order?.bestRate;
  if (!bestRate) return null;

  const raw = (bestRate.raw && typeof bestRate.raw === 'object'
    ? bestRate.raw
    : bestRate) as Record<string, unknown>;
  const shippingAmount =
    raw.shipping_amount && typeof raw.shipping_amount === 'object'
      ? (raw.shipping_amount as Record<string, unknown>)
      : undefined;
  const otherAmount =
    raw.other_amount && typeof raw.other_amount === 'object'
      ? (raw.other_amount as Record<string, unknown>)
      : undefined;
  const shipmentCost =
    toFiniteNumber(bestRate.shipmentCost) ??
    toFiniteNumber(raw.shipmentCost) ??
    toFiniteNumber(shippingAmount?.amount) ??
    toFiniteNumber(raw.cost) ??
    toFiniteNumber(bestRate.amount) ??
    0;
  const otherCost =
    toFiniteNumber(bestRate.otherCost) ??
    toFiniteNumber(raw.otherCost) ??
    toFiniteNumber(otherAmount?.amount) ??
    0;
  const shippingProviderId =
    toFiniteNumber(bestRate.shippingProviderId) ??
    toFiniteNumber(raw.shippingProviderId) ??
    toFiniteNumber(raw.carrier_id);
  const carrierCode =
    toOptionalString(bestRate.carrierCode) ??
    toOptionalString(raw.carrierCode) ??
    toOptionalString(raw.carrier_code) ??
    '';
  const serviceCode =
    toOptionalString(bestRate.serviceCode) ??
    toOptionalString(raw.serviceCode) ??
    toOptionalString(raw.service_code) ??
    '';

  if (!shippingProviderId || !carrierCode || !serviceCode || shipmentCost + otherCost <= 0) {
    return null;
  }

  const account = shippingAccounts.find((acct) => acct.shippingProviderId === shippingProviderId);
  return {
    carrierCode,
    serviceCode,
    serviceName:
      toOptionalString(bestRate.serviceName) ??
      toOptionalString(raw.serviceName) ??
      toOptionalString(raw.service_type) ??
      SERVICE_NAMES[serviceCode] ??
      serviceCode,
    carrierNickname:
      toOptionalString(bestRate.carrierNickname) ??
      toOptionalString(raw.carrierNickname) ??
      toOptionalString(raw.carrier_nickname) ??
      (formatAccountDisplay(account, '') || null),
    shippingProviderId,
    shipmentCost,
    otherCost,
    amount: shipmentCost + otherCost,
    raw: bestRate,
  };
}

const TEST_MOCK_SERVICE_TEMPLATES: Record<
  string,
  Array<{ code: string; name: string; base: number; spread: number; perLb: number; days: string }>
> = {
  prepship_test: [
    { code: 'prepship_test_economy', name: 'PrepShip Test Economy', base: 4.65, spread: 2.75, perLb: 0.72, days: '3-6 days' },
    { code: 'prepship_test_standard', name: 'PrepShip Test Standard', base: 7.25, spread: 3.8, perLb: 0.96, days: '2-4 days' },
    { code: 'prepship_test_priority', name: 'PrepShip Test Priority', base: 13.9, spread: 6.75, perLb: 1.28, days: '1-3 days' },
  ],
  stamps_com: [
    { code: 'usps_ground_advantage', name: 'USPS Ground Advantage', base: 4.45, spread: 2.5, perLb: 0.72, days: '2-5 days' },
    { code: 'usps_priority_mail', name: 'USPS Priority Mail', base: 7.85, spread: 3.4, perLb: 0.94, days: '1-3 days' },
    { code: 'usps_priority_mail_express', name: 'USPS Priority Mail Express', base: 27.4, spread: 9.5, perLb: 1.55, days: '1 day' },
  ],
  ups: [
    { code: 'ups_ground', name: 'UPS Ground', base: 8.65, spread: 4.25, perLb: 1.05, days: '2-5 days' },
    { code: 'ups_3_day_select', name: 'UPS 3 Day Select', base: 14.8, spread: 6.5, perLb: 1.28, days: '3 days' },
    { code: 'ups_2nd_day_air', name: 'UPS 2nd Day Air', base: 20.95, spread: 8.2, perLb: 1.62, days: '2 days' },
  ],
  ups_walleted: [
    { code: 'ups_ground_saver', name: 'UPS Ground Saver', base: 7.55, spread: 3.95, perLb: 0.86, days: '3-6 days' },
    { code: 'ups_surepost', name: 'UPS Ground Saver', base: 6.95, spread: 3.1, perLb: 0.78, days: '2-7 days' },
    { code: 'ups_next_day_air_saver', name: 'UPS Next Day Air Saver', base: 31.5, spread: 10.2, perLb: 1.9, days: '1 day' },
  ],
  fedex: [
    { code: 'fedex_ground', name: 'FedEx Ground', base: 8.95, spread: 4.1, perLb: 1.08, days: '2-5 days' },
    { code: 'fedex_2day', name: 'FedEx 2Day', base: 21.35, spread: 8.4, perLb: 1.55, days: '2 days' },
    { code: 'fedex_standard_overnight', name: 'FedEx Standard Overnight', base: 33.75, spread: 12.5, perLb: 2.1, days: '1 day' },
  ],
  fedex_walleted: [
    { code: 'fedex_home_delivery', name: 'FedEx Home Delivery', base: 9.25, spread: 4.2, perLb: 1.02, days: '2-5 days' },
    { code: 'fedex_express_saver', name: 'FedEx Express Saver', base: 17.65, spread: 6.8, perLb: 1.35, days: '3 days' },
    { code: 'fedex_priority_overnight', name: 'FedEx Priority Overnight', base: 38.4, spread: 13.2, perLb: 2.2, days: '1 day' },
  ],
};

function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function roundMoney(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function buildTestMockRateSeeds(
  shippingAccounts: RbCarrierAccountDto[],
  context: {
    orderId?: number | null;
    weightOz?: number;
    dims?: { length?: number; width?: number; height?: number };
  } = {}
): RateRow[] {
  const weightLb = Math.max(0.25, (context.weightOz ?? 0) / 16);
  const dims = context.dims ?? {};
  const cubicInches = Math.max(0, (dims.length ?? 0) * (dims.width ?? 0) * (dims.height ?? 0));
  const dimFactor = Math.min(18, cubicInches / 1728) * 1.15;
  const seedBase = `${context.orderId ?? 'test'}:${context.weightOz ?? 0}:${dims.length ?? 0}x${dims.width ?? 0}x${dims.height ?? 0}`;

  return shippingAccounts.flatMap((account, accountIndex) => {
    const templates = TEST_MOCK_SERVICE_TEMPLATES[account.code] ?? TEST_MOCK_SERVICE_TEMPLATES.prepship_test ?? [];
    return templates.map((template, templateIndex) => {
      const jitter = seededUnit(`${seedBase}:${account.shippingProviderId}:${template.code}`);
      const surchargeSeed = seededUnit(`${seedBase}:fuel:${account.shippingProviderId}:${templateIndex}`);
      const shipmentCost = roundMoney(template.base + template.spread * jitter + weightLb * template.perLb + dimFactor);
      const otherCost = roundMoney(surchargeSeed > 0.72 ? 0.55 + surchargeSeed * 1.45 : 0);
      return {
        carrierCode: account.code || 'test',
        serviceCode: template.code,
        serviceName: template.name,
        carrierNickname: formatAccountDisplay(account, `Test Carrier ${accountIndex + 1}`),
        shippingProviderId: account.shippingProviderId,
        shipmentCost,
        otherCost,
        amount: shipmentCost + otherCost,
        raw: {
          testRate: true,
          mocked: true,
          carrierCode: account.code || 'test',
          serviceCode: template.code,
          serviceName: template.name,
          deliveryDays: template.days,
          delivery_days: Number.parseInt(template.days, 10) || null,
          rate_details: otherCost > 0
            ? [{ rate_detail_type: 'fuel_surcharge', carrier_description: 'Mock fuel surcharge', amount: { amount: otherCost } }]
            : [],
        },
      };
    });
  });
}

function rateRowTextKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function rateRowMoneyKey(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

function rateRowDedupeKey(rate: RateRow): string {
  const raw = rate.raw ?? {};
  const rawOriginalShipping = Number(raw?.original_amount?.amount);
  const shipmentCost = Number.isFinite(rawOriginalShipping)
    ? rawOriginalShipping
    : Number(rate.shipmentCost) || 0;
  return [
    rateRowTextKey(rate.shippingProviderId ?? raw?.carrier_id),
    rateRowTextKey(rate.carrierCode ?? raw?.carrier_code),
    rateRowTextKey(rate.serviceCode ?? raw?.service_code ?? rate.serviceName ?? raw?.service_type),
    rateRowMoneyKey(shipmentCost),
    rateRowMoneyKey(rate.otherCost ?? raw?.other_amount?.amount),
    rateRowMoneyKey(raw?.confirmation_amount?.amount),
    rateRowMoneyKey(raw?.insurance_amount?.amount),
    rateRowTextKey((rate as any).estimatedDelivery ?? raw?.estimated_delivery_date ?? (rate as any).deliveryDays ?? raw?.delivery_days),
  ].join('|');
}

function dedupeRateRows(rates: RateRow[]): RateRow[] {
  const byKey = new Map<string, RateRow>();
  for (const rate of rates) {
    const key = rateRowDedupeKey(rate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rate);
      continue;
    }
    if (!existing.raw?.rate_id && rate.raw?.rate_id) {
      byKey.set(key, rate);
    }
  }
  return [...byKey.values()];
}

function groupRatesByProviderId(rates: RateRow[]): Record<string, RateRow[]> {
  return rates.reduce<Record<string, RateRow[]>>((acc, rate) => {
    if (rate.shippingProviderId == null) return acc;
    const key = String(rate.shippingProviderId);
    const bucket = (acc[key] ??= []);
    if (!bucket.some((existing) => rateRowDedupeKey(existing) === rateRowDedupeKey(rate))) {
      bucket.push(rate);
    }
    return acc;
  }, {});
}

function rbMarkupKeyFromCarrierId(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^se-(\d+)$/i);
  return match?.[1] ?? (/^\d+$/.test(text) ? text : null);
}

function rbMarkupForRate(markups: Record<string, Markup>, rate: RateRow): Markup | null {
  const raw = rate.raw ?? {};
  const candidateKeys = [
    rate.shippingProviderId,
    raw?.shippingProviderId,
    rbMarkupKeyFromCarrierId(raw?.carrier_id),
    raw?.carrier_id,
    rate.carrierCode,
    raw?.carrier_code,
  ];

  for (const candidate of candidateKeys) {
    const key = String(candidate ?? '').trim();
    if (!key) continue;
    const markup = markups[key];
    if (markup) return markup;
  }
  return null;
}

function rateBaseTotal(rate: RateRow): number {
  const rawOriginalShipping = Number(rate.raw?.original_amount?.amount);
  const shipmentCost = Number.isFinite(rawOriginalShipping)
    ? rawOriginalShipping
    : Number(rate.shipmentCost) || 0;
  return shipmentCost + (Number(rate.otherCost) || 0);
}

function rateDisplayTotal(rate: RateRow, markups: Record<string, Markup>): number {
  const base = rateBaseTotal(rate);
  const markup = rbMarkupForRate(markups, rate);
  if (!markup?.value) return base;
  return markup.type === 'pct' || markup.type === 'percent'
    ? base * (1 + markup.value / 100)
    : base + markup.value;
}

function priceDisplay(
  rawCost: number,
  markedCost: number,
  opts: { mainColor?: string; mainSize?: string } = {}
): ReactNode {
  const mainSize = opts.mainSize ?? '13px';
  const mainColor = opts.mainColor ?? 'var(--green)';
  const markupCost = Math.max(0, markedCost - rawCost);
  const hasMarkup = markupCost >= 0.005;
  const show = markedCost > 0.005 || rawCost > 0.005;
  if (!show) {
    return <span style={{ color: 'var(--text3)', fontSize: mainSize }}>N/A</span>;
  }
  return (
    <div
      style={{ lineHeight: 1.3 }}
      title={
        hasMarkup
          ? `Label Cost $${markedCost.toFixed(2)} | Base $${rawCost.toFixed(2)} + Markup $${markupCost.toFixed(2)}`
          : undefined
      }
    >
      <strong style={{ color: mainColor, fontSize: mainSize }}>
        ${markedCost.toFixed(2)}
      </strong>
      {hasMarkup ? (
        <div style={{ fontSize: 10, color: '#111827', whiteSpace: 'nowrap', fontWeight: 600 }}>
          ${rawCost.toFixed(2)}
        </div>
      ) : null}
    </div>
  );
}

// PS-108 display helper: pretty-print the insurance provider key the backend
// stamps onto each enriched rate (lowercased, e.g. 'parcelguard'). Display-only —
// the premium itself is computed and owned by the backend
// (services/shipping-workflow/insurance-cost.ts) and merely surfaced here.
function formatInsuranceProviderLabel(provider?: string | null): string {
  const normalized = String(provider ?? '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
  if (normalized === 'parcelguard') return 'ParcelGuard';
  if (normalized === 'shipsurance') return 'Shipsurance';
  if (normalized === 'carrier') return 'Carrier';
  return provider && provider.trim() ? provider.trim() : 'Insured';
}

// v2's isBlockedRate uses a per-store service-unblock list the server
// maintains. Stubbed to never-blocked per task spec — safe default until the
// per-client block list ports.
function rateBlockedReason(
  rate: RateRow,
  order: RbOrderSummaryDto | null,
  shippingOptions?: { insuranceProvider?: string | null; insuredValue?: number | string | null },
): string | null {
  const raw = rate.raw && typeof rate.raw === 'object' ? rate.raw as Record<string, unknown> : {};
  const eligibility = evaluateShippingServiceEligibility(
    {
      clientId: order?.clientId ?? null,
      clientName: order?.clientName ?? null,
      storeId: order?.storeId ?? null,
    },
    {
      provider: typeof raw.provider === 'string' ? raw.provider : null,
      carrierCode: rate.carrierCode ?? (typeof raw.carrier_code === 'string' ? raw.carrier_code : null),
      carrierName: typeof raw.carrier_name === 'string' ? raw.carrier_name : null,
      serviceCode: rate.serviceCode ?? (typeof raw.service_code === 'string' ? raw.service_code : null),
      serviceName: rate.serviceName ?? (typeof raw.service_type === 'string' ? raw.service_type : null),
      serviceType: typeof raw.service_type === 'string' ? raw.service_type : null,
    },
    shippingOptions,
  );
  return eligibility.allowed ? null : eligibility.reason ?? HUGRAB_GROUND_SAVER_BLOCK_REASON;
}

function isBlockedRate(
  rate: RateRow,
  order: RbOrderSummaryDto | null,
  shippingOptions?: { insuranceProvider?: string | null; insuredValue?: number | string | null },
): boolean {
  return rateBlockedReason(rate, order, shippingOptions) != null;
}

export default function RateBrowserModal({
  open,
  order,
  locations,
  packages,
  shippingAccounts,
  initialDims,
  initialWeight,
  initialConfirmation,
  initialInsurance,
  initialInsuranceValue,
  testMode = false,
  onClose,
  onApplyRate,
  onBestRateResolved,
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
  const [confirmation, setConfirmation] = useState<RateConfirmation>('none');
  const [insuranceProvider, setInsuranceProvider] = useState('none');
  const [insuredValue, setInsuredValue] = useState('');
  const [svcClass, setSvcClass] = useState<'' | 'ground' | 'express'>('');

  // ── Rates state ────────────────────────────────────────────────────────────
  const [ratesByPid, setRatesByPid] = useState<Record<string, RateRow[]>>({});
  const [rateErrorsByPid, setRateErrorsByPid] = useState<Record<string, string>>({});
  const [carrierStatusByPid, setCarrierStatusByPid] = useState<Record<string, CarrierRateStatus>>({});
  const [rateBrowseInfo, setRateBrowseInfo] = useState<RateBrowseInfo>({ source: null });
  // Per-carrier resolution metadata from the direct-carrier path. Used to
  // render the "rates came from X" hint under Walmart / Amazon / eBay
  // shipping panels so operators can tell whether the quote came from
  // their actual order or a fallback path.
  const [rateMetaByPid, setRateMetaByPid] = useState<Record<string, Record<string, unknown>>>({});
  const [pendingPids, setPendingPids] = useState<Set<number>>(new Set());
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'carriers'>('all');
  const [hideUnavail, setHideUnavail] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [scopedShippingAccounts, setScopedShippingAccounts] = useState<RbCarrierAccountDto[]>([]);
  const [scopedAccountsLoading, setScopedAccountsLoading] = useState(false);
  const [scopedAccountsError, setScopedAccountsError] = useState<string | null>(null);
  const browseSequenceRef = useRef(0);

  const rateShippingAccounts = useMemo(
    () => (testMode ? shippingAccounts : scopedShippingAccounts),
    [testMode, shippingAccounts, scopedShippingAccounts]
  );
  const rateAccountsReady = testMode || rateShippingAccounts.length > 0;
  const hugrabGroundSaverBlocked = useMemo(
    () =>
      isHugrabShippingContext({
        clientId: order?.clientId ?? null,
        clientName: order?.clientName ?? null,
        storeId: order?.storeId ?? null,
      }),
    [order?.clientId, order?.clientName, order?.storeId],
  );

  useEffect(() => {
    if (!open) {
      setScopedShippingAccounts([]);
      setScopedAccountsLoading(false);
      setScopedAccountsError(null);
      return;
    }
    if (testMode) {
      setScopedShippingAccounts(shippingAccounts);
      setScopedAccountsLoading(false);
      setScopedAccountsError(null);
      return;
    }

    let cancelled = false;
    const scopeKey = carrierAccountScopeKey(order);
    const hasCachedScope = hasScopedCarrierAccounts(scopeKey);
    const cached = getScopedCarrierAccounts(scopeKey) ?? [];
    setScopedShippingAccounts(cached);
    setScopedAccountsLoading(!hasCachedScope);
    setScopedAccountsError(null);

    void apiClient
      .fetchCarriersForStore(order?.storeId ?? null, order?.clientId ?? null)
      .then((res) => {
        if (cancelled) return;
        const carriers = Array.isArray(res?.carriers) ? res.carriers : [];
        setScopedCarrierAccounts(scopeKey, carriers);
        setScopedShippingAccounts(carriers);
      })
      .catch((err) => {
        if (cancelled) return;
        if (!hasCachedScope) {
          setScopedShippingAccounts([]);
          setScopedAccountsError(err instanceof Error ? err.message : 'Unable to load carrier accounts');
        }
      })
      .finally(() => {
        if (!cancelled) setScopedAccountsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, testMode, order?.storeId, order?.clientId]);

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
    setConfirmation(normalizeConfirmationForRates(initialConfirmation));
    setInsuranceProvider(initialInsurance ?? 'none');
    setInsuredValue(initialInsuranceValue != null ? String(initialInsuranceValue) : '');
    setSvcClass('');
    setViewMode('all');
    const initialTotalOz =
      initialWeight && ((initialWeight.lb ?? 0) > 0 || (initialWeight.oz ?? 0) > 0)
        ? (initialWeight.lb ?? 0) * 16 + (initialWeight.oz ?? 0)
        : order?.weight?.value ?? 0;
    const seededTestRates = testMode
      ? buildTestMockRateSeeds(rateShippingAccounts, {
          orderId: order?.orderId,
          weightOz: initialTotalOz,
          dims: { length: panelLen || savedLen || 0, width: panelWid || savedWid || 0, height: panelHgt || savedHgt || 0 },
        })
      : [];
    const seededBestRate = testMode
      ? [...seededTestRates].sort((a, b) => a.shipmentCost + a.otherCost - (b.shipmentCost + b.otherCost))[0] ?? null
      : buildOrderBestRateSeed(order, rateShippingAccounts);
    setSelectedPid(
      typeof seededBestRate?.shippingProviderId === 'number'
        ? seededBestRate.shippingProviderId
        : null
    );
    setRatesByPid(
      testMode
        ? groupRatesByProviderId(seededTestRates)
        : seededBestRate?.shippingProviderId != null
          ? { [String(seededBestRate.shippingProviderId)]: [seededBestRate] }
          : {}
    );
    setRateErrorsByPid({});
    setCarrierStatusByPid({});
    setRateBrowseInfo({ source: seededBestRate ? 'cache' : null });
    setRateMetaByPid({});
    // `locations` is intentionally not in deps — it doesn't change per-order
    // and we only want to re-hydrate when the modal opens or the order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.orderId, testMode, rateShippingAccounts.length]);

  // Derived
  const lbNum = parseFloat(wtLb) || 0;
  const ozNum = parseFloat(wtOz) || 0;
  const lenNum = parseFloat(lenStr) || 0;
  const widNum = parseFloat(widStr) || 0;
  const hgtNum = parseFloat(hgtStr) || 0;
  const hasWeight = lbNum > 0 || ozNum > 0;
  const hasDims = lenNum > 0 && widNum > 0 && hgtNum > 0;
  const hasAnyRateRows = Object.values(ratesByPid).some((rates) => rates.length > 0);
  const hasCarrierStatus = Object.keys(carrierStatusByPid).length > 0;
  const anyFetched = hasAnyRateRows || hasCarrierStatus;
  const currentRateShippingOptions = {
    insuranceProvider,
    insuredValue: Number(insuredValue) > 0 ? Number(insuredValue) : null,
  };

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Try the cache on open when weight + dims are already valid. Live carrier
  // fanout stays explicit so opening the modal never waits on every carrier.
  // Guard with a ref so we only fire once per open, not on every form edit.
  const autoFetchedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) {
      autoFetchedRef.current = null;
      return;
    }
    const orderId = order?.orderId ?? 0;
    if (autoFetchedRef.current === orderId) return;
    if (!hasWeight || !hasDims || !zip || zip.length < 5) return;
    if (!rateAccountsReady) return;
    autoFetchedRef.current = orderId;
    void (async () => {
      await browseRates(undefined, { cachedOnly: true });
      if (autoFetchedRef.current !== orderId) return;
      await browseRates(undefined, { forceLive: true });
    })();
    // browseRates is stable across renders via function declaration;
    // intentionally not listed as a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.orderId, hasWeight, hasDims, zip, rateAccountsReady]);

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

  // Fetch all scoped carrier accounts in one UI request. The backend still calls
  // ShipStation per carrier, but it does that work in parallel and returns one
  // grouped result set for the modal.
  async function browseRates(
    confirmationOverride?: RateConfirmation,
    options: BrowseRateOptions = {}
  ): Promise<void> {
    if (!zip || zip.length < 5 || !hasWeight || !hasDims) return;
    if (!testMode && !rateShippingAccounts.length) return;

    const requestSeq = browseSequenceRef.current + 1;
    browseSequenceRef.current = requestSeq;
    const totalOz = lbNum * 16 + ozNum;
    const rateConfirmation = normalizeConfirmationForRates(confirmationOverride ?? confirmation);
    const normalizedInsuranceProvider = insuranceProvider !== 'none' && Number(insuredValue) > 0
      ? insuranceProvider
      : 'none';
    const normalizedInsuredValue = normalizedInsuranceProvider !== 'none'
      ? Math.round(Number(insuredValue) * 100) / 100
      : null;
    setBrowsing(true);
    const seededTestRates = testMode
      ? buildTestMockRateSeeds(rateShippingAccounts, {
          orderId: order?.orderId,
          weightOz: totalOz,
          dims: { length: lenNum, width: widNum, height: hgtNum },
        })
      : [];
    const seededBestRate = testMode
      ? [...seededTestRates].sort((a, b) => a.shipmentCost + a.otherCost - (b.shipmentCost + b.otherCost))[0] ?? null
      : buildOrderBestRateSeed(order, rateShippingAccounts);
    const seededPid =
      typeof seededBestRate?.shippingProviderId === 'number'
        ? seededBestRate.shippingProviderId
        : null;
    setRatesByPid(
      testMode
        ? groupRatesByProviderId(seededTestRates)
        : seededBestRate && seededPid != null
          ? { [String(seededPid)]: [seededBestRate] }
          : {}
    );
    setRateErrorsByPid({});
    setRateMetaByPid({});
    if (seededPid != null) {
      setSelectedPid((current) => current ?? seededPid);
    }
    setPendingPids(
      options.cachedOnly
        ? new Set()
        : new Set(rateShippingAccounts.map((a) => a.shippingProviderId))
    );
    let liveFetchedRates: RateRow[] = [];

    // Persist dims for this order (fire-and-forget) so re-open sees them.
    if (order?.orderId) {
      void apiClient.saveOrderDims(order.orderId, {
        l: lenNum,
        w: widNum,
        h: hgtNum,
      });
    }

    if (testMode) {
      if (seededBestRate) {
        setRatesByPid(groupRatesByProviderId(seededTestRates));
        setSelectedPid(seededPid);
        const applied = toAppliedRate(seededBestRate);
        if (applied && onBestRateResolved) onBestRateResolved(applied);
      }
      setPendingPids(new Set());
      setBrowsing(false);
      return;
    }

    try {
      const selectedLocation = locations.find((l) => String(l.locationId) === locationId);
      const shipFrom = selectedLocation
        ? {
            name: selectedLocation.company || selectedLocation.name,
            addressLine1: selectedLocation.street1,
            addressLine2: selectedLocation.street2,
            city: selectedLocation.city,
            state: selectedLocation.state,
            postalCode: selectedLocation.postalCode,
            country: selectedLocation.country || 'US',
            phone: selectedLocation.phone,
          }
        : undefined;
      const accountByPid = new Map(
        rateShippingAccounts.map((acct) => [acct.shippingProviderId, acct])
      );
      const accountByCarrierId = new Map(
        rateShippingAccounts
          .filter((acct) => typeof acct.carrierId === 'string' && acct.carrierId.length > 0)
          .map((acct) => [acct.carrierId as string, acct])
      );
      const carrierIds = [...new Set([...accountByCarrierId.keys()])];
      const preferredAccount =
        (selectedPid != null ? accountByPid.get(selectedPid) : null) ??
        (seededPid != null ? accountByPid.get(seededPid) : null) ??
        rateShippingAccounts[0];
      const browseResult = await apiClient.browseRates({
        fromPostalCode: selectedLocation?.postalCode?.slice(0, 5) ?? undefined,
        toPostalCode: zip,
        toCountry: 'US',
        shipFrom,
        weight: { value: totalOz, units: 'ounces' },
        dimensions: {
          units: 'inches',
          length: lenNum,
          width: widNum,
          height: hgtNum,
        },
        residential: true,
        carrierIds: carrierIds.length ? carrierIds : undefined,
        preferredCarrierId: preferredAccount?.carrierId ?? undefined,
        storeId: toFiniteNumber(order?.storeId) ?? undefined,
        clientId: toFiniteNumber(order?.clientId) ?? undefined,
        clientName: toOptionalString(order?.clientName) ?? undefined,
        confirmation: rateConfirmation,
        insuranceProvider: normalizedInsuranceProvider,
        insuredValue: normalizedInsuredValue,
        orderId: toFiniteNumber(order?.orderId ?? (order as Record<string, unknown> | null)?.id) ?? undefined,
        orderNumber:
          toOptionalString(order?.orderNumber) ??
          toOptionalString((order as Record<string, unknown> | null)?.order_number) ??
          undefined,
        externalOrderId:
          toOptionalString(order?.externalOrderId) ??
          toOptionalString(order?.external_order_id) ??
          toOptionalString(order?.orderNumber) ??
          undefined,
        cachedOnly: options.cachedOnly === true,
        forceLive: options.forceLive === true,
        forceRefresh: options.forceLive === true,
      });
      if (browseSequenceRef.current !== requestSeq) return;
      const raw = (Array.isArray(browseResult)
        ? browseResult
        : Array.isArray(browseResult?.rates)
          ? browseResult.rates
          : []) as RateRow[];

      const directErrors = Array.isArray((browseResult as any)?.directCarrierErrors)
        ? ((browseResult as any).directCarrierErrors as DirectCarrierRateError[])
        : [];
      const nextErrorsByPid: Record<string, string> = {};
      for (const err of directErrors) {
        const pid = toFiniteNumber(err.shippingProviderId);
        const message = toOptionalString(err.message);
        if (pid != null && message) nextErrorsByPid[String(pid)] = message;
      }
      setRateErrorsByPid(nextErrorsByPid);
      setRateBrowseInfo({
        source:
          browseResult?.source === 'cache' || browseResult?.source === 'live' || browseResult?.source === 'mixed'
            ? browseResult.source
            : browseResult?.cached
              ? 'cache'
              : raw.length
                ? 'live'
                : null,
        cacheAgeMs: typeof browseResult?.cacheAgeMs === 'number' ? browseResult.cacheAgeMs : undefined,
      });

      // Fix 3 (2026-05-12): capture per-carrier resolution meta so the
      // rate panel can render the "rates came from X" hint. Walmart in
      // particular benefits — operators can tell at a glance whether
      // their quote came from the order's own Walmart purchaseOrderId
      // (`'body.externalOrderId'` / `'store_orders lookup'`), from an
      // on-demand Marketplace API lookup (`'walmart_marketplace_api'`),
      // or from the settings-demo fallback path.
      const directMetas = Array.isArray((browseResult as any)?.directCarrierMetas)
        ? ((browseResult as any).directCarrierMetas as Array<{ shippingProviderId?: number; meta: Record<string, unknown> }>)
        : [];
      const nextMetaByPid: Record<string, Record<string, unknown>> = {};
      for (const m of directMetas) {
        const pid = toFiniteNumber(m.shippingProviderId);
        if (pid != null && m.meta && typeof m.meta === 'object') {
          nextMetaByPid[String(pid)] = m.meta;
        }
      }
      setRateMetaByPid(nextMetaByPid);
      const nextStatusByPid: Record<string, CarrierRateStatus> = {};
      const carrierStatuses = Array.isArray(browseResult?.carrierStatuses)
        ? browseResult.carrierStatuses as Array<{ carrierId?: string; status?: CarrierRateStatus; error?: string }>
        : [];
      for (const status of carrierStatuses) {
        if (!status.carrierId) continue;
        const account = accountByCarrierId.get(status.carrierId);
        if (account) {
          const key = String(account.shippingProviderId);
          nextStatusByPid[key] = status.status ?? 'unavailable';
          if (status.error) nextErrorsByPid[key] = status.error;
        }
      }

      liveFetchedRates = dedupeRateRows(
        (raw ?? [])
          .map((r) => {
            const pid =
              typeof r.shippingProviderId === 'number'
                ? r.shippingProviderId
                : Number(r.shippingProviderId);
            const rawCarrierId = typeof r.raw?.carrier_id === 'string' ? r.raw.carrier_id : null;
            const account =
              (Number.isFinite(pid) ? accountByPid.get(pid) : undefined) ??
              (rawCarrierId ? accountByCarrierId.get(rawCarrierId) : undefined);
            return {
              ...r,
              shippingProviderId: account?.shippingProviderId ?? r.shippingProviderId,
              carrierNickname: r.carrierNickname ?? formatAccountDisplay(account, ''),
            };
          })
          .filter((r) => {
            const pid =
              typeof r.shippingProviderId === 'number'
                ? r.shippingProviderId
                : Number(r.shippingProviderId);
            return Number.isFinite(pid) && accountByPid.has(pid);
          })
      ).sort((a, b) => (a.shipmentCost + a.otherCost) - (b.shipmentCost + b.otherCost));

      const grouped = groupRatesByProviderId(liveFetchedRates);
      const nextRatesByPid: Record<string, RateRow[]> = {};
      for (const acct of rateShippingAccounts) {
        const key = String(acct.shippingProviderId);
        const accountRates = grouped[key] ?? [];
        if (accountRates.length > 0) {
          nextRatesByPid[key] = accountRates;
          nextStatusByPid[key] = browseResult?.cached ? 'cached' : 'live';
        } else if (options.cachedOnly) {
          nextStatusByPid[key] ??= 'loading';
        } else {
          nextRatesByPid[key] = [];
          nextStatusByPid[key] ??= 'unavailable';
        }
      }
      if (seededBestRate && seededPid != null && !nextRatesByPid[String(seededPid)]?.length) {
        nextRatesByPid[String(seededPid)] = [seededBestRate];
        nextStatusByPid[String(seededPid)] ??= 'cached';
      }
      for (const [pid, message] of Object.entries(nextErrorsByPid)) {
        if (message) nextStatusByPid[pid] = 'error';
      }
      setCarrierStatusByPid(nextStatusByPid);
      setRatesByPid(nextRatesByPid);
    } catch {
      if (browseSequenceRef.current !== requestSeq) return;
      setRateErrorsByPid({});
      setCarrierStatusByPid({});
      setRateBrowseInfo({ source: seededBestRate ? 'cache' : null });
      setRateMetaByPid({});
      setRatesByPid(
        seededBestRate && seededPid != null
          ? { [String(seededPid)]: [seededBestRate] }
          : {}
      );
    } finally {
      setPendingPids(new Set());
    }

    if (onBestRateResolved && (liveFetchedRates.length || seededBestRate)) {
      // Choose the lowest only after every carrier account has finished.
      // If ShipStation returns no live rates, fall back to the table's
      // already-saved best rate so the modal stays consistent with the row.
      const ratesToRank = liveFetchedRates.length ? liveFetchedRates : [seededBestRate!];
      const available = filterBySvcClass(ratesToRank).filter((r) => !isBlockedRate(r, order, currentRateShippingOptions));
      const best = available.sort((a, b) => rateDisplayTotal(a, markups) - rateDisplayTotal(b, markups))[0];
      const applied = best ? toAppliedRate(best) : null;
      if (applied) {
        setSelectedPid(applied.shippingProviderId);
        onBestRateResolved(applied);
      }
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
          n.includes('economy') ||
          n.includes('standard') ||
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
    const seenPids = new Set<string>();
    for (const acct of rateShippingAccounts) {
      seenPids.add(String(acct.shippingProviderId));
      const rates = ratesByPid[String(acct.shippingProviderId)] ?? [];
      for (const r of rates) {
        out.push({
          ...r,
          shippingProviderId: r.shippingProviderId ?? acct.shippingProviderId,
          carrierNickname: r.carrierNickname ?? formatAccountDisplay(acct, ''),
        });
      }
    }
    for (const [pid, rates] of Object.entries(ratesByPid)) {
      if (seenPids.has(pid)) continue;
      out.push(...rates);
    }
    return dedupeRateRows(filterBySvcClass(out))
      .sort((a, b) => rateDisplayTotal(a, markups) - rateDisplayTotal(b, markups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesByPid, rateShippingAccounts, svcClass, markups]);

  const totalCarriersAvailable = useMemo(
    () =>
      rateShippingAccounts.filter(
        (c) => (ratesByPid[String(c.shippingProviderId)] ?? []).length > 0
      ).length,
    [rateShippingAccounts, ratesByPid]
  );
  const totalCarriersChecked = useMemo(
    () =>
      rateShippingAccounts.filter((c) => {
        const key = String(c.shippingProviderId);
        const status = carrierStatusByPid[key];
        return (
          (ratesByPid[key] ?? []).length > 0 ||
          status === 'cached' ||
          status === 'live' ||
          status === 'unavailable' ||
          status === 'error'
        );
      }).length,
    [carrierStatusByPid, rateShippingAccounts, ratesByPid]
  );
  const totalCarriersLoading = useMemo(
    () =>
      rateShippingAccounts.filter((c) => {
        const key = String(c.shippingProviderId);
        return pendingPids.has(c.shippingProviderId) || carrierStatusByPid[key] === 'loading';
      }).length,
    [carrierStatusByPid, pendingPids, rateShippingAccounts]
  );
  const carrierDisplayCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of rateShippingAccounts) {
      const label = formatAccountDisplay(account);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [rateShippingAccounts]);

  function formatSidebarAccountDisplay(account: RbCarrierAccountDto): string {
    const label = formatAccountDisplay(account);
    if ((carrierDisplayCounts.get(label) ?? 0) <= 1) return label;
    const suffix = account.carrierId ?? account.directCarrierAccountId ?? account.shippingProviderId;
    return `${label} · ${suffix}`;
  }

  function handleRateClick(r: RateRow): void {
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    if (!Number.isFinite(pid) || !r.serviceCode) return;
    if (!testMode && order?.orderId) {
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
      confirmation: normalizeConfirmationForRates(confirmation),
      insuranceProvider,
      insuredValue: Number(insuredValue) > 0 ? Number(insuredValue) : null,
      weight: { lb: lbNum, oz: ozNum },
      dims: { length: lenNum, width: widNum, height: hgtNum },
    });
    onClose();
  }

  function toAppliedRate(r: RateRow): RbAppliedRate | null {
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    if (!Number.isFinite(pid) || !r.serviceCode) return null;
    return {
      carrierCode: r.carrierCode,
      serviceCode: r.serviceCode,
      serviceName: r.serviceName,
      shippingProviderId: pid,
      shipmentCost: r.shipmentCost,
      otherCost: r.otherCost,
      carrierNickname: r.carrierNickname ?? undefined,
      confirmation: normalizeConfirmationForRates(confirmation),
      insuranceProvider,
      insuredValue: Number(insuredValue) > 0 ? Number(insuredValue) : null,
      weight: { lb: lbNum, oz: ozNum },
      dims: { length: lenNum, width: widNum, height: hgtNum },
    };
  }

  if (!open) return null;

  // ── Sub-renderers ──────────────────────────────────────────────────────────

  function renderRateRow(r: RateRow, index: number, showCarrier: boolean, isRecommended: boolean): ReactNode {
    const blockedReason = rateBlockedReason(r, order, currentRateShippingOptions);
    const blocked = blockedReason != null;
    const base = rateBaseTotal(r);
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    const marked = rateDisplayTotal(r, markups);
    const svcName =
      r.serviceName ||
      SERVICE_NAMES[r.serviceCode] ||
      (r.serviceCode || '').replace(/_/g, ' ') ||
      '—';
    const acctName = formatCarrierDisplay(r);
    const eta = formatEta(r);
    const primaryText = showCarrier ? acctName : svcName;
    const secondaryText = showCarrier ? svcName : '';
    const sourceText = getModalRateSourceLabel(r, rateShippingAccounts);

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
        title={blocked ? blockedReason ?? 'Not available for current client' : undefined}
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
          {blockedReason ? (
            <div style={{ fontSize: 10.5, color: 'var(--red)', lineHeight: 1.4, marginTop: 2 }}>
              {blockedReason}
            </div>
          ) : null}
          <div style={{ fontSize: 10.5, color: 'var(--text3)', lineHeight: 1.4 }}>
            Rate Source: {sourceText}
          </div>
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
          {(() => {
            // PS-108: surface the per-rate insurance breakdown the backend already
            // resolved (insuranceCost meta / insurance_amount). Display-only — the
            // premium is owned by the backend and never recomputed here. The amount
            // is already included in the row total (otherCost), so this line is a
            // breakdown of what the price already contains.
            const meta = r.raw?.insuranceCost as
              | {
                  insuranceProvider?: string;
                  insuredValue?: number;
                  amount?: number | null;
                  confirmed?: boolean;
                  unresolved?: boolean;
                }
              | undefined;
            const unresolved =
              r.raw?.insuranceCostUnresolved === true || meta?.unresolved === true;
            const provider = formatInsuranceProviderLabel(meta?.insuranceProvider);

            // Insured rate whose premium could not be proven — warn instead of price.
            if (unresolved) {
              return (
                <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 2, lineHeight: 1.4 }}>
                  Insurance: {provider} — premium unresolved (re-rate before selecting)
                </div>
              );
            }

            const amount =
              typeof meta?.amount === 'number'
                ? meta.amount
                : typeof r.raw?.insurance_amount?.amount === 'number'
                  ? (r.raw.insurance_amount.amount as number)
                  : null;
            // No insurance on this rate -> no indicator.
            if (amount == null || amount <= 0) return null;

            return (
              <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 2, lineHeight: 1.4 }}>
                Insurance incl. +${amount.toFixed(2)}
              </div>
            );
          })()}
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
          <div style={{ textAlign: 'right', minWidth: 145 }}>
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
    if (browsing && !hasAnyRateRows) {
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
          }}
        >
          <RateLoadingSpinner />
          <div style={{ marginTop: 8 }}>Checking carriers...</div>
        </div>
      );
    }
    if (!anyFetched) {
      // Once auto-fetch is armed, the button is redundant — show a status
      // that reflects what the modal is doing.
      const missing =
        !hasWeight && !hasDims
          ? 'weight and dims'
          : !hasWeight
            ? 'weight'
            : !hasDims
              ? 'dims (L × W × H)'
              : !zip || zip.length < 5
                ? 'a 5-digit ZIP'
                : null;
      return (
        <div
          style={{
            color: 'var(--text3)',
            fontSize: 12.5,
            textAlign: 'center',
            marginTop: 80,
            lineHeight: 1.8,
          }}
        >
          {browsing ? (
            <RateLoadingSpinner />
          ) : missing ? (
            <>
              📏
              <br />
              Enter {missing} to fetch rates
            </>
          ) : (
            <>
              No live rates loaded yet
              <br />
              Click Browse Rates to refresh carrier quotes.
            </>
          )}
        </div>
      );
    }

    if (viewMode === 'all') return renderAllRatesView();
    return renderCarrierView();
  }

  function renderAllRatesView(): ReactNode {
    const displayed = hideUnavail
      ? combinedAll.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions))
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

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r, order, currentRateShippingOptions));
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
    const acct = rateShippingAccounts.find((c) => c.shippingProviderId === selectedPid);
    const carrierError = rateErrorsByPid[String(selectedPid)];
    const carrierMeta = rateMetaByPid[String(selectedPid)] ?? null;
    // Resolution-source hint for direct carriers (Walmart / Amazon / eBay
    // shipping). The backend sets `purchaseOrderSource` to one of:
    //   'body.purchaseOrderId' / 'body.externalOrderId' → quote scoped to
    //     the operator's actual order.
    //   'store_orders lookup' → matched the order via the marketplace
    //     pull table — also scoped correctly.
    //   'walmart_marketplace_api' → Fix 4 path: backend asked Walmart to
    //     translate the customer order number to a purchaseOrderId on
    //     the fly. Best-effort and slightly slower, but accurate.
    //   'store_orders fallback (settings demo)' → DEMO-ONLY: the quote
    //     is for an UNRELATED Walmart order. Operators must know this.
    const purchaseOrderSource = carrierMeta && typeof carrierMeta.purchaseOrderSource === 'string'
      ? (carrierMeta.purchaseOrderSource as string)
      : null;
    const sourceLabel = (() => {
      if (!purchaseOrderSource || purchaseOrderSource === 'none') return null;
      if (purchaseOrderSource === 'body.purchaseOrderId') return { text: 'Scoped to this order (purchaseOrderId)', danger: false };
      if (purchaseOrderSource === 'body.externalOrderId') return { text: 'Scoped to this order', danger: false };
      if (purchaseOrderSource === 'store_orders lookup') return { text: 'Scoped via Walmart Marketplace pull', danger: false };
      if (purchaseOrderSource === 'walmart_marketplace_api') return { text: 'Resolved on-the-fly via Walmart Marketplace API', danger: false };
      if (purchaseOrderSource.includes('settings demo')) return { text: 'DEMO RATES — borrowed from an unrelated Walmart order', danger: true };
      return { text: `Source: ${purchaseOrderSource}`, danger: false };
    })();
    const all = ratesByPid[String(selectedPid)] ?? [];
    const filtered = filterBySvcClass(all);
    const displayed = hideUnavail
      ? filtered.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions))
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
          No rates available for <b>{formatAccountDisplay(acct, 'this account')}</b>
          {carrierError ? (
            <div
              style={{
                maxWidth: 520,
                margin: '10px auto 0',
                color: 'var(--red)',
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {carrierError}
            </div>
          ) : null}
          {sourceLabel ? (
            <div
              style={{
                maxWidth: 520,
                margin: '8px auto 0',
                color: sourceLabel.danger ? 'var(--red)' : 'var(--text3)',
                fontSize: 10.5,
                fontStyle: 'italic',
                lineHeight: 1.4,
              }}
              title="purchaseOrderSource from the backend rate response"
            >
              {sourceLabel.text}
            </div>
          ) : null}
        </div>
      );
    }

    const firstOk = displayed.findIndex((r) => !isBlockedRate(r, order, currentRateShippingOptions));
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
              {formatAccountDisplay(acct)}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{countLabel}</span>
          </div>
          {sourceLabel ? (
            <div
              style={{
                marginTop: 4,
                color: sourceLabel.danger ? 'var(--red)' : 'var(--text3)',
                fontSize: 10.5,
                fontStyle: sourceLabel.danger ? 'normal' : 'italic',
                fontWeight: sourceLabel.danger ? 700 : 400,
                lineHeight: 1.4,
              }}
              title="purchaseOrderSource from the backend rate response"
            >
              {sourceLabel.text}
            </div>
          ) : null}
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
          width: 1280,
          maxWidth: '97vw',
          height: 730,
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

        {hugrabGroundSaverBlocked ? (
          <div
            style={{
              padding: '8px 18px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--red)',
              fontSize: 11.5,
              fontWeight: 700,
              lineHeight: 1.4,
            }}
          >
            {HUGRAB_GROUND_SAVER_BLOCK_REASON}
          </div>
        ) : null}

        {/* Body: 3 columns */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* LEFT: Configure */}
          <div
            style={{
              width: 280,
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
                gap: 10,
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
                      color: 'var(--text3)',
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    Defaults to None
                  </span>
                </div>
                <select
                  value={confirmation}
                  onChange={(e) => {
                    const next = normalizeConfirmationForRates(e.target.value);
                    setConfirmation(next);
                    if (anyFetched && !browsing) void browseRates(next, { forceLive: true });
                  }}
                  className="ship-select"
                  style={{ width: '100%', marginBottom: 10 }}
                >
                  {CONFIRMATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>

                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>
                  Insurance
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                  <select
                    value={insuranceProvider}
                    onChange={(e) => {
                      setInsuranceProvider(e.target.value);
                      if (anyFetched && !browsing) void browseRates(confirmation, { forceLive: true });
                    }}
                    className="ship-select"
                    style={{ flex: 1 }}
                  >
                    <option value="none">None</option>
                    <option value="carrier">Carrier</option>
                    <option value="parcelguard">Parcel Guard</option>
                    <option value="shipsurance">Shipsurance</option>
                  </select>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={insuredValue}
                    onChange={(e) => {
                      setInsuredValue(e.target.value);
                      if (anyFetched && !browsing) void browseRates(confirmation, { forceLive: true });
                    }}
                    className="ship-input"
                    placeholder="$0"
                    style={{ width: 70, display: insuranceProvider !== 'none' ? 'block' : 'none' }}
                  />
                </div>

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
                onClick={() => void browseRates(undefined, { forceLive: true })}
                disabled={
                  browsing ||
                  !hasWeight ||
                  !hasDims ||
                  !zip ||
                  zip.length < 5 ||
                  (!testMode && !rateShippingAccounts.length)
                }
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  fontSize: 13,
                  padding: 9,
                }}
              >
                {browsing ? 'Fetching...' : anyFetched ? 'Refresh Live Rates' : 'Browse Rates'}
              </button>
            </div>
          </div>

          {/* MIDDLE: Carrier accounts */}
          <div
            style={{
              width: 260,
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
            {!testMode && scopedAccountsLoading && rateShippingAccounts.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 11, color: 'var(--text3)' }}>
                Loading accounts...
              </div>
            ) : null}
            {!testMode && !scopedAccountsLoading && rateShippingAccounts.length === 0 ? (
              <div style={{ padding: '12px', fontSize: 11, color: 'var(--text3)' }}>
                {scopedAccountsError || 'No carrier accounts for this order'}
              </div>
            ) : null}
            {rateShippingAccounts.map((c) => {
              const isSel = c.shippingProviderId === selectedPid;
              const rates = ratesByPid[String(c.shippingProviderId)];
              const carrierError = rateErrorsByPid[String(c.shippingProviderId)];
              const carrierStatus = carrierStatusByPid[String(c.shippingProviderId)];
              const count =
                rates != null
                  ? hideUnavail
                    ? rates.filter((r) => !isBlockedRate(r, order, currentRateShippingOptions)).length
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
                  {c.code === 'prepship_test' ? (
                    <span
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 6,
                        background: '#0f766e',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <img src="/prepship-test-logo.svg" alt="" style={{ width: 20, height: 20, display: 'block' }} />
                    </span>
                  ) : (
                    <CarrierBadge code={c.code ?? ''} size="sm" />
                  )}
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      flex: 1,
                      minWidth: 0,
                      // PS: show the full carrier/account nickname (no ellipsis
                      // clamp); long names wrap within the wider column.
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      lineHeight: 1.25,
                    }}
                  >
                    {formatSidebarAccountDisplay(c)}
                  </span>
                  {carrierError ? (
                    <span
                      title={carrierError}
                      style={{
                        background: isSel ? 'rgba(255,255,255,.3)' : 'var(--red)',
                        color: '#fff',
                        borderRadius: 10,
                        padding: '1px 7px',
                        fontSize: 10,
                        fontWeight: 800,
                        minWidth: 22,
                        textAlign: 'center',
                      }}
                    >
                      !
                    </span>
                  ) : count != null ? (
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
                      {pending ? (
                        <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-label="Fetching rates" />
                      ) : carrierStatus === 'unavailable' ? (
                        '—'
                      ) : carrierStatus === 'cached' ? (
                        'C'
                      ) : carrierStatus === 'live' ? (
                        'L'
                      ) : (
                        '…'
                      )}
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
                  ? totalCarriersLoading > 0 || browsing
                    ? `Checking carriers...${totalCarriersAvailable > 0 ? ` ${totalCarriersAvailable} with rates` : ''}`
                    : `${totalCarriersChecked} of ${rateShippingAccounts.length} carriers checked · ${totalCarriersAvailable} with rates`
                  : ''}
                {rateBrowseInfo.source === 'cache'
                  ? ` | cached ${formatCacheAge(rateBrowseInfo.cacheAgeMs) ?? ''}`.trimEnd()
                  : rateBrowseInfo.source === 'live'
                    ? ' | live'
                    : rateBrowseInfo.source === 'mixed'
                      ? ' | cached + live'
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
