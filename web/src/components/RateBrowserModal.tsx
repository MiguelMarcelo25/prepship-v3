// 3-column Rate Browser modal — ported from v2 public/js/rate-browser.js + the
// #rateBrowserModal HTML block in index.html. v2 parity is visual: same colors,
// same column widths, same badge behavior. Data plumbing uses v4's adapter
// (apiClient.fetchRates translates v2 payload shape to v4 server-side).
//
// Layout: Configure (280px) | Carriers (190px) | Rates (flex).
// Rate fetching: asks the v4 adapter for all scoped carrier IDs in one request.
// The server still performs ShipStation's one-carrier estimate calls behind the
// adapter, but does them in parallel so the modal is not blocked account by
// account.
//
// Eligibility and block-list verdicts are backend DTO facts. This component
// may render or honor those facts, but must not recreate their rules.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
// PS-276 (slice 4-UI): resi/comm header tag — reads the backend verdict off the DTO (display-only).
import { ResidentialTag, residentialTagFacts } from './ui/ResidentialTag';
import { residentialForRate } from '../lib/residential-for-rate';
import { apiClient } from '../lib/v2-apiClient';
import { CALIFORNIA_TZ } from '../lib/ca-time';
import {
  HUGRAB_GROUND_SAVER_BLOCK_REASON,
  isHugrabShippingContext,
} from '../../../src/lib/shipping-service-eligibility';
// PS-164: confirmation/insurance alias normalization is owned by src/lib/shipping-options (single
// source of truth). The modal delegates here instead of re-deriving its own alias logic.
import { normalizeConfirmation, normalizeInsurance } from '../../../src/lib/shipping-options';
// PS-197: pure classifiers for the backend-effective insurance display (effective_policy_diff vs
// matches_selection) + the per-account verdict derived from backend-stamped rate fields.
// The backend owns the policy; the modal only renders the verdicts.
import {
  classifyAccountEffectiveInsurance,
  classifyEffectiveInsuranceDisplay,
} from './Views/orders-parity';
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
// PS-135: the backend owns best-rate selection; the modal consumes its canonical winner
// (matched into the eligible set) instead of re-ranking rows client-side.
import { findCanonicalBestRate } from '../lib/rate-proof';
// PS-292: the SHIPP house-account tuple (customer_rate basis + margin) is backend-owned and rides
// the canonical bestRate (not the rows array). These pure helpers lift it onto the applied rate (so
// a manual SHIPP-row apply persists it) and onto the recommended row's two-tier display. The modal
// NEVER computes the margin — it only forwards what the backend issued.
import { houseTupleForRow, houseDisplayForRow } from '../lib/rate-browser-house-tuple';
// PS-279: the emission boundary — the modal may ONLY emit the backend canonical best; absent
// it, emit NOTHING (no FE-ranked local cheapest) and show an unresolved/retry diagnostic state.
import { decideBestRateEmission } from '../lib/rate-browser-best-emission';
import {
  rateBrowserBackendProofIsComplete,
  rateBrowserShouldHideUnavailableRate,
  rateBrowserUnavailableReason,
} from '../lib/rate-browser-availability';
import {
  rateBrowserRateCostAmount,
  sortRateRowsByBackendDisplayRank,
} from '../lib/rate-browser-money';
// PS-157: presentation-only subcomponents extracted from this file. They own no state
// and no rate/blocked/money policy — the modal passes values + callbacks down.
import RateRowItem from './RateRowItem';
import RateRowsView from './RateRowsView';
import RateBrowserCarrierSidebar from './RateBrowserCarrierSidebar';
import RateBrowserDiagnosticsPanel, {
  type RateBrowserFailureDiagnostic,
  type RateBrowserProviderDiagnostic,
  type RateBrowserTimingDiagnostics,
} from './RateBrowserDiagnosticsPanel';
import { buildPartialRateBrowseDisplayState } from './rate-browser-partial-result';
import { nextRateBrowserPendingPidsAfterPartial } from './rate-browser-pending-state';
import { rateBrowserOpenBrowseOptions } from './rate-browser-open-workflow';
import { useRateBrowseWorkflow } from '../hooks/useRateBrowseWorkflow';

const RATE_BROWSER_FIELD_LABEL = 'mb-1.5 text-xs font-bold text-ink';
const RATE_BROWSER_HINT_LABEL = 'mb-[3px] text-[11px] text-ink-3';
const RATE_BROWSER_UNIT_LABEL = 'text-[10px] text-ink-3';
const RATE_BROWSER_SAVED_MARK = 'text-[10px] font-bold text-ok';

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
  // PS-216: backend-owned HUMAN disambiguator ("USPS"/"UPS"/provider label)
  // for duplicate nicknames. Display code uses this — never provider ids.
  displayDisambiguator?: string | null;
};

export type RbOrderSummaryDto = {
  orderId: number;
  orderNumber?: string | null;
  externalOrderId?: string | null;
  external_order_id?: string | null;
  sourceProvider?: string | null;
  source_provider?: string | null;
  storeId?: number | null;
  clientId?: number | null;
  clientName?: string | null;
  bestRate?: Record<string, unknown> | null;
  weight?: { value?: number } | null;
  rateDims?: { length?: number | null; width?: number | null; height?: number | null } | null;
  shipTo?: {
    postalCode?: string | null;
    company?: string | null;
    country?: string | null;
  } | null;
  residential?: boolean | null;
  sourceResidential?: boolean | null;
  // PS-276 (slice 4-UI): the backend's resolved residential verdict for the resi/comm header tag.
  residentialClassification?: 'residential' | 'commercial' | null;
  residentialSource?: string | null;
  residentialConfidence?: string | null;
};

export type RbAppliedRate = {
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  shippingProviderId: number;
  shipmentCost: number;
  otherCost: number;
  amount?: number;
  carrierNickname?: string;
  confirmation?: RateConfirmation;
  insuranceProvider?: string;
  insuredValue?: number | null;
  insuranceCost?: unknown;
  insuranceProvenance?: unknown;
  insuranceCostUnresolved?: unknown;
  insuranceCostError?: unknown;
  insurance_amount?: unknown;
  // PS-274: backend-owned insurance-certainty fact (resolveInsuranceCertainty). Pass-through
  // only — the FE renders the chip via formatInsuranceCertaintyTag, never decides certainty.
  insuranceCertainty?: unknown;
  // PS-198: backend-issued quote proof carried through Apply so the persisted
  // best rate stays purchasable (Create Label / Print Queue validate the ref
  // server-side against the rate-quote snapshot). Pass-through only.
  rateQuoteId?: string;
  selectedRateKey?: string;
  selectionRef?: string;
  requestFingerprint?: string;
  cacheKey?: string;
  cacheCreatedAt?: string;
  cacheExpiresAt?: string;
  isComplete?: boolean;
  rateCount?: number;
  proofSource?: string;
  secondBestRate?: unknown;
  // PS-292: backend-owned SHIPP house tuple carried through Apply so a manually-selected SHIPP best
  // persists best_rate_json.nextBestNonHouseRate/houseMargin (the Awaiting row reads totalCost off it
  // to render the customer_rate-over-drp_cost two-tier). Pass-through only — lifted from the canonical
  // backend best, never recomputed from visible rows.
  nextBestNonHouseRate?: unknown;
  houseMargin?: number | null;
  raw?: unknown;
  weight?: { lb: number; oz: number };
  dims?: { length: number; width: number; height: number };
};

export type RateConfirmation =
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

// PS-164: delegate alias resolution to the canonical normalizer (single owner), then clamp to the
// modal's 5 dropdown values so the <select> never renders blank. Aliases that resolve INTO the 5
// (e.g. delivery_confirmation -> delivery) are honored; the rarer canonical-only values
// (delivery_mailed, verbal_confirmation, ...) fall back to 'none' exactly as the prior UI did.
function normalizeConfirmationForRates(value?: string | null): RateConfirmation {
  const normalized = normalizeConfirmation(value);
  return CONFIRMATION_OPTIONS.some((o) => o.value === normalized) ? (normalized as RateConfirmation) : 'none';
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

export type RateRow = {
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  carrierNickname?: string | null;
  shippingProviderId: number | string | null;
  shipmentCost: number;
  otherCost: number;
  amount: number;
  cShippingRateAmount?: number | null;
  selectedRateCost?: number | null;
  shippingMarginAmount?: number | null;
  shippingMarginPct?: number | null;
  rateSourceKind?: string | null;
  rateSourceLabel?: string | null;
  rateSourceDetail?: string | null;
  insuranceCost?: unknown;
  insuranceProvenance?: unknown;
  insuranceCostUnresolved?: unknown;
  insuranceCostError?: unknown;
  insurance_amount?: unknown;
  // PS-274: backend-owned insurance-certainty fact carried onto each rate row (display-only).
  insuranceCertainty?: unknown;
  // PS-279/PS-321: backend-owned rate BLOCK/eligibility verdict stamped by order-rate-dto. The
  // modal renders these fields and never recomputes service eligibility locally.
  eligibilityBlocked?: boolean;
  eligibilityBlockReason?: string | null;
  // PS-198: backend-issued quote proof (stamped by /rates/browse + the apiClient
  // backendProofMetadata). The modal only passes these through — never synthesizes.
  rateQuoteId?: string | null;
  selectedRateKey?: string | null;
  selectionRef?: string | null;
  requestFingerprint?: string | null;
  cacheKey?: string | null;
  cacheCreatedAt?: string | null;
  cacheExpiresAt?: string | null;
  isComplete?: boolean | null;
  proofSource?: string | null;
  secondBestRate?: unknown;
  raw?: any;
};

type ShopifyCheckoutShippingLine = {
  title?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
};

type ShopifyRateRow = {
  selectedRateKey: string;
  handle?: string | null;
  title?: string | null;
  amount: number;
  currency?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
};

type ShopifyRatesResult = {
  provider: 'shopify_shipping';
  checkoutShipping?: ShopifyCheckoutShippingLine[] | null;
  checkoutDeliveryOptions?: ShopifyRateRow[] | null;
  fulfillmentOrderId?: string | null;
  shopifyRateQuoteId?: string | null;
  rates?: ShopifyRateRow[] | null;
  labelRatesAvailable?: boolean | null;
  labelRatesMessage?: string | null;
  rateSource?: string | null;
};

type DirectCarrierRateError = {
  shippingProviderId?: number | string | null;
  provider?: string | null;
  label?: string | null;
  message?: string | null;
};

// PS-206: 'uncached' = TERMINAL "no cached coverage; this account was not
// checked in the cached-only probe — a live check is required". Distinct from
// 'loading' (a request is actually in flight) and 'unavailable' (checked,
// nothing returned). Coverage identity — never a carrier count — drives the
// modal's automatic live follow-up.
export type CarrierRateStatus = 'cached' | 'loading' | 'live' | 'unavailable' | 'error' | 'uncached';

type RateBrowseInfo = {
  source: 'cache' | 'live' | 'mixed' | null;
  cacheAgeMs?: number;
};

type BrowseRateOptions = {
  cachedOnly?: boolean;
  forceLive?: boolean;
  insuranceProviderOverride?: string;
  insuredValueOverride?: string | number | null;
  // PS-197b: also fetch the UNINSURED manual baseline (one extra read-only quote) for the
  // side-by-side ShipStation comparison. Reference only — never selectable/purchasable.
  manualEstimateCompare?: boolean;
};

function formatCacheAge(ms: number | undefined): string | null {
  if (!Number.isFinite(ms ?? NaN)) return null;
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function RateLoadingSpinner({ text = 'Fetching rates…' }: { text?: string }): JSX.Element {
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

export function formatAccountDisplay(
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

export const SERVICE_NAMES: Record<string, string> = {
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
export function carrierBadgeLarge(code: string | null | undefined): ReactNode {
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

export function formatCarrierDisplay(rate: {
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

export function formatEta(r: RateRow): string {
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

export function getModalRateSourceLabel(
  rate: RateRow,
): string {
  const raw = rate.raw ?? {};
  const label = toOptionalString(rate.rateSourceLabel) ?? toOptionalString(raw.rateSourceLabel);
  return label ?? 'Unknown source';
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
  const rawAmount = toFiniteNumber(raw.amount);
  const amount =
    toFiniteNumber(bestRate.amount) ??
    rawAmount ??
    toFiniteNumber(bestRate.totalCost) ??
    toFiniteNumber(raw.totalCost) ??
    toFiniteNumber(raw.total_cost);
  const otherCost = toFiniteNumber(bestRate.otherCost) ?? toFiniteNumber(raw.otherCost) ?? 0;
  const shipmentCostAlias =
    toFiniteNumber(bestRate.shipmentCost) ??
    toFiniteNumber(raw.shipmentCost);
  const shipmentCost = shipmentCostAlias ?? (amount != null ? Math.max(0, amount - otherCost) : null);
  const cShippingRateAmount =
    toFiniteNumber(bestRate.cShippingRateAmount) ??
    toFiniteNumber(raw.cShippingRateAmount);
  const selectedRateCost =
    toFiniteNumber(bestRate.selectedRateCost) ??
    toFiniteNumber(raw.selectedRateCost);
  const shippingMarginAmount =
    toFiniteNumber(bestRate.shippingMarginAmount) ??
    toFiniteNumber(raw.shippingMarginAmount);
  const shippingMarginPct =
    toFiniteNumber(bestRate.shippingMarginPct) ??
    toFiniteNumber(raw.shippingMarginPct);
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

  if (!shippingProviderId || !carrierCode || !serviceCode || shipmentCost == null || amount == null || amount <= 0) {
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
    amount,
    cShippingRateAmount,
    selectedRateCost,
    shippingMarginAmount,
    shippingMarginPct,
    insuranceCost: bestRate.insuranceCost ?? raw.insuranceCost,
    insuranceProvenance: bestRate.insuranceProvenance ?? raw.insuranceProvenance,
    insuranceCostUnresolved: bestRate.insuranceCostUnresolved ?? raw.insuranceCostUnresolved,
    insuranceCostError: bestRate.insuranceCostError ?? raw.insuranceCostError,
    // PS-274: pass the backend insurance-certainty fact through (display-only).
    insuranceCertainty: bestRate.insuranceCertainty ?? raw.insuranceCertainty,
    raw: bestRate,
  };
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
  const amount = toFiniteNumber(rate.amount) ?? toFiniteNumber(raw?.amount) ?? 0;
  const shipmentCost = toFiniteNumber(rate.shipmentCost) ?? toFiniteNumber(raw?.shipmentCost) ?? 0;
  const otherCost = toFiniteNumber(rate.otherCost) ?? toFiniteNumber(raw?.otherCost) ?? 0;
  return [
    rateRowTextKey(rate.shippingProviderId ?? raw?.carrier_id),
    rateRowTextKey(rate.carrierCode ?? raw?.carrier_code),
    rateRowTextKey(rate.serviceCode ?? raw?.service_code ?? rate.serviceName ?? raw?.service_type),
    rateRowMoneyKey(amount),
    rateRowMoneyKey(shipmentCost),
    rateRowMoneyKey(otherCost),
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

export function priceDisplay(
  rateCost: number,
  customerCost: number,
  opts: { mainColor?: string; mainSize?: string } = {}
): ReactNode {
  const mainSize = opts.mainSize ?? '13px';
  const mainColor = opts.mainColor ?? 'var(--green)';
  const spread = Math.max(0, customerCost - rateCost);
  const hasSeparateCost = spread >= 0.005;
  const show = customerCost > 0.005 || rateCost > 0.005;
  if (!show) {
    return <span style={{ color: 'var(--text3)', fontSize: mainSize }}>N/A</span>;
  }
  return (
    <div
      style={{ lineHeight: 1.3 }}
      title={
        hasSeparateCost
          ? `C. Shipping Rate $${customerCost.toFixed(2)} | DJR Purchase Cost $${rateCost.toFixed(2)} | Margin $${spread.toFixed(2)}`
          : undefined
      }
    >
      <strong style={{ color: mainColor, fontSize: mainSize }}>
        ${customerCost.toFixed(2)}
      </strong>
      {hasSeparateCost ? (
        <div style={{ fontSize: 10, color: '#111827', whiteSpace: 'nowrap', fontWeight: 600 }}>
          ${rateCost.toFixed(2)}
        </div>
      ) : null}
    </div>
  );
}

// PS-126: keep the EXACT postal the operator/order provides (US ZIP+4) so the backend
// can send it to ShipStation for an exact quote — no longer truncated to 5. Sanitizes
// US input to "12345" or "12345-6789"; passes international (non-numeric) through
// trimmed/uppercased. Display/capture only — the backend stays authoritative for the
// rate payload and selected-rate proof.
function sanitizePostalInput(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/[^0-9-]/.test(raw)) return raw.toUpperCase().slice(0, 10);
  const digits = raw.replace(/\D/g, '').slice(0, 9);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function normalizeDestinationCountry(value: string | null | undefined): string {
  const country = String(value ?? 'US').trim().toUpperCase();
  return country || 'US';
}

// PS-108 display helper: pretty-print the insurance provider key the backend
// stamps onto each enriched rate (lowercased, e.g. 'parcelguard'). Display-only —
// the premium itself is computed and owned by the backend
// (services/shipping-workflow/insurance-cost.ts) and merely surfaced here.
export function formatInsuranceProviderLabel(provider?: string | null): string {
  const normalized = String(provider ?? '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
  if (normalized === 'parcelguard') return 'ParcelGuard';
  if (normalized === 'shipsurance') return 'Shipsurance';
  if (normalized === 'carrier') return 'Carrier';
  return provider && provider.trim() ? provider.trim() : 'Insured';
}

// PS-274 — render-ready insurance-CERTAINTY chip derived from the backend-owned
// insuranceCertainty fact (resolveInsuranceCertainty, threaded onto the rate by the
// Shipp connector). Display-only + additive: returns null unless the backend stamped a
// certainty, so a rate without the fact renders EXACTLY as today. The backend is the
// source of truth — the FE never decides certainty, it only colors the chip. A
// Shipp-brokered UPS rate that declared a value comes through as
// 'requested_application_uncertain' and is tagged "Insurance requested (unconfirmed)" —
// it is NEVER shown as confirmed/included. The rate STAYS visible/selectable.
export type RbInsuranceCertaintyTag = {
  certainty: string;
  label: string;
  tone: 'positive' | 'caution' | 'neutral' | 'warning';
};

const RB_CERTAINTY_TONE_COLORS: Record<RbInsuranceCertaintyTag['tone'], string> = {
  positive: 'var(--green)',
  caution: 'var(--amber, #b7791f)',
  neutral: 'var(--text3)',
  warning: 'var(--red)',
};

export function rbInsuranceCertaintyTone(tone: string | null | undefined): string {
  return RB_CERTAINTY_TONE_COLORS[(tone as RbInsuranceCertaintyTag['tone'])] ?? RB_CERTAINTY_TONE_COLORS.neutral;
}

export function formatInsuranceCertaintyTag(raw: unknown): RbInsuranceCertaintyTag | null {
  if (!raw || typeof raw !== 'object') return null;
  const meta = raw as { certainty?: unknown; tagLabel?: unknown; tagTone?: unknown };
  const certainty = String(meta.certainty ?? '').trim();
  if (!certainty) return null;
  const label = typeof meta.tagLabel === 'string' && meta.tagLabel.trim()
    ? meta.tagLabel.trim()
    : certainty.replace(/_/g, ' ');
  const tone = ((): RbInsuranceCertaintyTag['tone'] => {
    const t = String(meta.tagTone ?? '');
    return t === 'positive' || t === 'caution' || t === 'neutral' || t === 'warning' ? t : 'neutral';
  })();
  return { certainty, label, tone };
}

// PS-321: unavailable rows are read from backend DTO facts only. The modal does
// not recompute service eligibility or rate-proof freshness.
function rateBlockedReason(
  rate: RateRow,
  _order: RbOrderSummaryDto | null,
  _shippingOptions?: { insuranceProvider?: string | null; insuredValue?: number | string | null },
  displayOptions: { proofFinalizing?: boolean } = {},
): string | null {
  return rateBrowserUnavailableReason(rate, displayOptions);
}

function isBackendUnavailableRate(
  rate: RateRow,
  order: RbOrderSummaryDto | null,
  shippingOptions?: { insuranceProvider?: string | null; insuredValue?: number | string | null },
): boolean {
  return rateBlockedReason(rate, order, shippingOptions) != null;
}

function shouldHideUnavailableRate(rate: RateRow): boolean {
  return rateBrowserShouldHideUnavailableRate(rate);
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
  // PS-197: the backend-EFFECTIVE insurance actually used for the quote (GetRatesResult
  // effectiveInsuranceProvider/Value/Source — e.g. the HUGRAB ParcelGuard $100 default), plus a
  // redacted request snapshot for the parity tooltip. Captured per browse; display-only.
  const [backendEffectiveInsurance, setBackendEffectiveInsurance] = useState<{
    provider: string;
    value: number | null;
    source: string | null;
    diagnostics: string;
  } | null>(null);
  // PS-197b: the on-demand UNINSURED manual baseline (ShipStation's own browser numbers).
  // Reference display only — rates carry NO proof keys, so they can never be selected/bought.
  const [manualEstimateRates, setManualEstimateRates] = useState<RateRow[] | null>(null);
  const [manualEstimateLoading, setManualEstimateLoading] = useState(false);
  const [insuredValue, setInsuredValue] = useState('');
  const [svcClass, setSvcClass] = useState<'' | 'ground' | 'express'>('');

  // ── Rates state ────────────────────────────────────────────────────────────
  const [ratesByPid, setRatesByPid] = useState<Record<string, RateRow[]>>({});
  const [rateErrorsByPid, setRateErrorsByPid] = useState<Record<string, string>>({});
  const [carrierStatusByPid, setCarrierStatusByPid] = useState<Record<string, CarrierRateStatus>>({});
  const [rateBrowseInfo, setRateBrowseInfo] = useState<RateBrowseInfo>({ source: null });
  const [carrierTimingByPid, setCarrierTimingByPid] = useState<Record<string, number>>({});
  const [rateBrowserTiming, setRateBrowserTiming] = useState<RateBrowserTimingDiagnostics | null>(null);
  const [rateBrowserFailure, setRateBrowserFailure] = useState<RateBrowserFailureDiagnostic | null>(null);
  const [shopifyRatesResult, setShopifyRatesResult] = useState<ShopifyRatesResult | null>(null);
  const [shopifyRatesLoading, setShopifyRatesLoading] = useState(false);
  const [shopifyRatesError, setShopifyRatesError] = useState<string | null>(null);
  const [shopifyRatesNotice, setShopifyRatesNotice] = useState<string | null>(null);
  // PS-279: true when the fan-out finished but the backend returned no canonical best for the
  // eligible set. The modal then emits NOTHING (never a FE-ranked local cheapest) and shows a
  // retry diagnostic so the operator re-runs the browse instead of silently persisting a wrong
  // "best". Cleared whenever a canonical best resolves or a fresh browse begins.
  const [bestRateUnresolved, setBestRateUnresolved] = useState(false);
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
  const {
    snapshot: rateWorkflowSnapshot,
    runRateBrowseWorkflow,
    reset: resetRateBrowseWorkflow,
  } = useRateBrowseWorkflow();
  // PS-292: the backend canonical bestRate from the latest browse (carries the SHIPP house tuple).
  // The apply helpers (handleRateClick/toAppliedRate) and the recommended-row renderer read it from
  // here because the rows array never carries the stamp — only bestRate does.
  const canonicalBestRef = useRef<unknown>(null);

  function finishBrowseRequest(requestSeq: number): void {
    if (browseSequenceRef.current !== requestSeq) return;
    setPendingPids(new Set());
    setBrowsing(false);
  }

  function emitBestRateResolved(applied: RbAppliedRate): void {
    try {
      onBestRateResolved?.(applied);
    } catch (error) {
      setBestRateUnresolved(true);
      console.warn(
        '[RateBrowserModal] resolved best-rate callback failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  const rateShippingAccounts = useMemo(
    () => scopedShippingAccounts,
    [scopedShippingAccounts]
  );

  // PS-197c: when the BACKEND policy owns this order's insurance (HUGRAB default), the dropdown
  // MIRRORS the selected account's effective insurance — click USPS -> ParcelGuard $100, click
  // ORION/ROCEL -> Carrier $100, and vice-versa. Safe ONLY because for policy orders the
  // dropdown value is cosmetic: the backend re-normalizes the request (resolveHugrabRequestInsurance)
  // and re-decides the per-account provider at quote/label time regardless of what the dropdown
  // says. For NON-policy orders this effect early-returns — the dropdown stays real operator
  // intent and is never auto-mutated. State-only sync (no re-browse is triggered).
  useEffect(() => {
    if (backendEffectiveInsurance?.source !== 'hugrab-default') return;
    if (selectedPid == null) return;
    const verdict = classifyAccountEffectiveInsurance(
      ratesByPid[String(selectedPid)],
      backendEffectiveInsurance.value ?? null,
    );
    if (!verdict) return;
    setInsuranceProvider(verdict.provider);
    if (backendEffectiveInsurance.value != null) {
      setInsuredValue(String(backendEffectiveInsurance.value));
    }
  }, [selectedPid, backendEffectiveInsurance, ratesByPid]);
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
    let cancelled = false;
    const scopeKey = carrierAccountScopeKey(order);
    const hasCachedScope = hasScopedCarrierAccounts(scopeKey);
    const cached = getScopedCarrierAccounts(scopeKey) ?? [];
    setScopedShippingAccounts(cached);
    setScopedAccountsLoading(!hasCachedScope);
    setScopedAccountsError(null);

    void apiClient
      .fetchCarriersForStore(order?.storeId ?? null, order?.clientId ?? null, order?.orderId ?? null)
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
  }, [open, order?.orderId, order?.storeId, order?.clientId]);

  // Populate form from order on open. Priority for dims: panel > saved >
  // nothing. Priority for weight: initialWeight prop > order.weight.value.
  useEffect(() => {
    if (!open) return;
    setZip(sanitizePostalInput(order?.shipTo?.postalCode)); // PS-126: seed exact ZIP+4 when present

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
    canonicalBestRef.current = null;
    const seededBestRate = buildOrderBestRateSeed(order, rateShippingAccounts);
    setSelectedPid(
      typeof seededBestRate?.shippingProviderId === 'number'
        ? seededBestRate.shippingProviderId
        : null
    );
    setRatesByPid(
      seededBestRate?.shippingProviderId != null
        ? { [String(seededBestRate.shippingProviderId)]: [seededBestRate] }
        : {}
    );
    setRateErrorsByPid({});
    setCarrierStatusByPid({});
    setRateBrowseInfo({ source: seededBestRate ? 'cache' : null });
    setRateMetaByPid({});
    setCarrierTimingByPid({});
    setRateBrowserTiming(null);
    setRateBrowserFailure(null);
    setShopifyRatesResult(null);
    setShopifyRatesError(null);
    setShopifyRatesNotice(null);
    // `locations` is intentionally not in deps — it doesn't change per-order
    // and we only want to re-hydrate when the modal opens or the order changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.orderId, rateShippingAccounts.length]);

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
  const rateWorkflowProgressText = useMemo(() => {
    if (!rateWorkflowSnapshot || !browsing) return null;
    const progress = rateWorkflowSnapshot.progress;
    const completed = toFiniteNumber(progress?.completed_carriers) ?? 0;
    const total = toFiniteNumber(progress?.total_carriers) ?? 0;
    const ratesCount = toFiniteNumber(progress?.rates_count) ?? 0;
    const label = rateWorkflowSnapshot.status === 'queued'
      ? 'queued'
      : rateWorkflowSnapshot.status === 'running'
        ? 'checking'
        : rateWorkflowSnapshot.status === 'partial'
          ? 'partial'
          : rateWorkflowSnapshot.status;
    return total > 0
      ? `${label} ${completed}/${total} · ${ratesCount} rates`
      : `${label} · ${ratesCount} rates`;
  }, [browsing, rateWorkflowSnapshot]);
  const rateProofFinalizing =
    browsing &&
    rateWorkflowSnapshot != null &&
    rateWorkflowSnapshot.status !== 'complete' &&
    rateWorkflowSnapshot.status !== 'error';
  const currentRateShippingOptions = {
    insuranceProvider,
    insuredValue: Number(insuredValue) > 0 ? Number(insuredValue) : null,
  };
  const isShopifyOrder = normalizeProviderKey(
    order?.sourceProvider ??
    order?.source_provider ??
    (order as Record<string, unknown> | null)?.source ??
    (order as Record<string, unknown> | null)?.marketplace
  ) === 'shopify';

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) resetRateBrowseWorkflow();
  }, [open, resetRateBrowseWorkflow]);

  // Start the live carrier workflow on open when weight + dims are valid. Opening
  // Rate Browser is explicit operator intent; Awaiting page load remains passive.
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
    void browseRates(undefined, rateBrowserOpenBrowseOptions());
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

  function selectedPackageForShopify(): RbPackageDto | null {
    return packageId ? packages.find((p) => String(p.packageId) === packageId) ?? null : null;
  }

  function shopifyRatePayload(): Record<string, unknown> | null {
    if (!order?.orderId || !hasWeight || !hasDims) return null;
    const totalOz = lbNum * 16 + ozNum;
    const pkg = selectedPackageForShopify();
    return {
      orderId: order.orderId,
      weightOz: totalOz,
      dims: { length: lenNum, width: widNum, height: hgtNum },
      dimsL: lenNum,
      dimsW: widNum,
      dimsH: hgtNum,
      packageName: pkg?.name ?? undefined,
      customPackageId: packageId ? Number(packageId) : undefined,
    };
  }

  async function browseShopifyRates(refresh = true): Promise<void> {
    if (!isShopifyOrder) return;
    const payload = shopifyRatePayload();
    if (!payload) {
      setShopifyRatesError('Weight and package dimensions are required before browsing Shopify Rates.');
      return;
    }
    setShopifyRatesLoading(true);
    setShopifyRatesError(null);
    setShopifyRatesNotice(null);
    try {
      const result = await apiClient.browseShopifyRates({ ...payload, refresh }) as ShopifyRatesResult;
      const labelRatesAvailable = result?.labelRatesAvailable === true;
      const rates = labelRatesAvailable && Array.isArray(result?.rates) ? result.rates : [];
      const labelRatesMessage = typeof result?.labelRatesMessage === 'string' ? result.labelRatesMessage : null;
      const normalized: ShopifyRatesResult = {
        provider: 'shopify_shipping',
        checkoutShipping: Array.isArray(result?.checkoutShipping) ? result.checkoutShipping : [],
        checkoutDeliveryOptions: Array.isArray(result?.checkoutDeliveryOptions) ? result.checkoutDeliveryOptions : [],
        fulfillmentOrderId: result?.fulfillmentOrderId ?? null,
        shopifyRateQuoteId: result?.shopifyRateQuoteId ?? null,
        labelRatesAvailable,
        labelRatesMessage,
        rateSource: typeof result?.rateSource === 'string' ? result.rateSource : null,
        rates,
      };
      setShopifyRatesResult(normalized);
      if (!labelRatesAvailable) setShopifyRatesNotice(labelRatesMessage);
      if (labelRatesAvailable && !rates.length) setShopifyRatesError('Shopify returned no live shipping rates for this order.');
    } catch (error) {
      setShopifyRatesResult(null);
      setShopifyRatesNotice(null);
      setShopifyRatesError(error instanceof Error ? error.message : 'Failed to browse Shopify Rates.');
    } finally {
      setShopifyRatesLoading(false);
    }
  }

  // Fetch all scoped carrier accounts in one UI request. The backend still calls
  // ShipStation per carrier, but it does that work in parallel and returns one
  // grouped result set for the modal.
  // PS-206 / PS-345: browseRates reports coverage, not a carrier count.
  // uncoveredPids = scoped accounts whose terminal state after this request is
  // 'uncached'. A cached-only modal-open probe can display that state, but it
  // cannot silently start live carrier work.
  type BrowseCoverage = { carriersWithRates: number; uncoveredPids: number[] };

  async function browseRates(
    confirmationOverride?: RateConfirmation,
    options: BrowseRateOptions = {}
  ): Promise<BrowseCoverage> {
    if (!zip || zip.length < 5 || !hasWeight || !hasDims) return { carriersWithRates: 0, uncoveredPids: [] };
    if (!testMode && !rateShippingAccounts.length) return { carriersWithRates: 0, uncoveredPids: [] };

    let carriersWithRates = 0;
    const uncoveredPids: number[] = [];
    const requestSeq = browseSequenceRef.current + 1;
    browseSequenceRef.current = requestSeq;
    const totalOz = lbNum * 16 + ozNum;
    const rateConfirmation = normalizeConfirmationForRates(confirmationOverride ?? confirmation);
    const effectiveInsuranceProvider = options.insuranceProviderOverride ?? insuranceProvider;
    const effectiveInsuredValue = options.insuredValueOverride ?? insuredValue;
    // PS-164: delegate to the canonical insurance normalizer (single alias owner; unknown -> 'none').
    const { insuranceProvider: normalizedInsuranceProvider, insuredValue: normalizedInsuredValue } =
      normalizeInsurance({ insuranceProvider: effectiveInsuranceProvider, insuredValue: effectiveInsuredValue });
    setBrowsing(true);
    if (options.forceLive !== true) resetRateBrowseWorkflow();
    const seededBestRate = buildOrderBestRateSeed(order, rateShippingAccounts);
    const seededPid =
      typeof seededBestRate?.shippingProviderId === 'number'
        ? seededBestRate.shippingProviderId
        : null;
    setRatesByPid(
      seededBestRate && seededPid != null
        ? { [String(seededPid)]: [seededBestRate] }
        : {}
    );
    setRateErrorsByPid({});
    setRateMetaByPid({});
    setCarrierTimingByPid({});
    setRateBrowserTiming(null);
    setRateBrowserFailure(null);
    // PS-279: a fresh browse clears any prior unresolved-best diagnostic.
    setBestRateUnresolved(false);
    if (seededPid != null) {
      setSelectedPid((current) => current ?? seededPid);
    }
    setPendingPids(
      options.cachedOnly
        ? new Set()
        : new Set(rateShippingAccounts.map((a) => a.shippingProviderId))
    );
    let liveFetchedRates: RateRow[] = [];
    // PS-135: the backend's authoritative bestRate (captured from the browse response below),
    // consumed after every carrier finishes so the modal's auto-applied best matches the
    // backend selection instead of a divergent client-side re-rank.
    let canonicalBackendBest: unknown = null;
    // PS-292: clear any prior run's house tuple up front so a stale SHIPP best can't bleed into a
    // fresh browse before the new canonical best is captured below.
    canonicalBestRef.current = null;

    // Per user override unlock shipped data on 2026-07-11: persist dimensions
    // before browsing; a rejected write stops carrier work and remains retryable.
    if (order?.orderId) {
      try {
        await apiClient.saveOrderDims(order.orderId, {
          l: lenNum,
          w: widNum,
          h: hgtNum,
          weightOz: totalOz,
        });
      } catch (error) {
        if (browseSequenceRef.current !== requestSeq) return { carriersWithRates, uncoveredPids };
        setCarrierStatusByPid(
          Object.fromEntries(rateShippingAccounts.map((acct) => [String(acct.shippingProviderId), 'uncached' as CarrierRateStatus])),
        );
        setRateBrowserFailure({
          code: 'ORDER_DIMS_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to save order dimensions',
        });
        finishBrowseRequest(requestSeq);
        return { carriersWithRates, uncoveredPids };
      }
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
      // PS-280: forward the BACKEND residential/commercial verdict (PS-276 owner) via the shared
      // FE rule — the SAME helper OrdersView uses (residentialForRate). No re-derivation from the
      // legacy order.residential / sourceResidential, raw shipTo, ZIP, or company name. A missing
      // verdict defaults residential-safe so the residential surcharge is never under-quoted, and
      // the backend stays authoritative (resolveRateInput + the label parity guard).
      const residentialForQuote = residentialForRate(order);
      const destinationCountry = normalizeDestinationCountry(order?.shipTo?.country);
      const browsePayload = {
        fromPostalCode: selectedLocation?.postalCode?.slice(0, 5) ?? undefined,
        toPostalCode: zip,
        toCountry: destinationCountry,
        shipFrom,
        shipFromLocationId: selectedLocation?.locationId,
        weight: { value: totalOz, units: 'ounces' },
        dimensions: {
          units: 'inches',
          length: lenNum,
          width: widNum,
          height: hgtNum,
        },
        residential: residentialForQuote,
        carrierIds: carrierIds.length ? carrierIds : undefined,
        preferredCarrierId: preferredAccount?.carrierId ?? undefined,
        storeId: toFiniteNumber(order?.storeId) ?? undefined,
        clientId: toFiniteNumber(order?.clientId) ?? undefined,
        clientName: toOptionalString(order?.clientName) ?? undefined,
        confirmation: rateConfirmation,
        insuranceProvider: normalizedInsuranceProvider,
        insuredValue: normalizedInsuredValue,
        orderId: toFiniteNumber(order?.orderId ?? (order as Record<string, unknown> | null)?.id) ?? undefined,
        customPackageId: packageId ? Number(packageId) : undefined,
        orderNumber:
          toOptionalString(order?.orderNumber) ??
          toOptionalString((order as Record<string, unknown> | null)?.order_number) ??
          undefined,
        externalOrderId:
          toOptionalString(order?.externalOrderId) ??
          toOptionalString(order?.external_order_id) ??
          toOptionalString(order?.orderNumber) ??
          undefined,
        includeVisibleDirectCarriers: true,
        cachedOnly: options.cachedOnly === true,
        forceLive: options.forceLive === true,
        forceRefresh: options.forceLive === true,
        ...(options.manualEstimateCompare ? { manualEstimate: true } : {}),
      };
      const applyPartialBrowseResult = (partialResult: Record<string, unknown>) => {
        if (browseSequenceRef.current !== requestSeq) return;
        setRateBrowserTiming(
          partialResult.rateBrowseTiming && typeof partialResult.rateBrowseTiming === 'object'
            ? partialResult.rateBrowseTiming as RateBrowserTimingDiagnostics
            : null,
        );
        setRateBrowserFailure(
          partialResult.rateBrowseFailure && typeof partialResult.rateBrowseFailure === 'object'
            ? partialResult.rateBrowseFailure as RateBrowserFailureDiagnostic
            : null,
        );
        const partialDisplay = buildPartialRateBrowseDisplayState({
          partialResult,
          accounts: rateShippingAccounts,
          formatAccountDisplay,
        });
        if (!partialDisplay) return;
        setRateErrorsByPid((current) => ({ ...current, ...partialDisplay.errorsByPid }));
        setCarrierTimingByPid((current) => ({ ...current, ...partialDisplay.timingByPid }));
        setCarrierStatusByPid((current) => ({ ...current, ...partialDisplay.statusByPid }));
        setRatesByPid((current) => ({ ...current, ...partialDisplay.ratesByPid }));
        setPendingPids((current) =>
          nextRateBrowserPendingPidsAfterPartial({
            pendingPids: current,
            ratesByPid: partialDisplay.ratesByPid,
            statusByPid: partialDisplay.statusByPid,
          }),
        );
        setRateBrowseInfo(partialDisplay.info);
      };
      const browseResult = await (
        options.forceLive === true
          ? runRateBrowseWorkflow(browsePayload, { onPartialResult: applyPartialBrowseResult })
          : apiClient.browseRates(browsePayload)
      );
      if (browseSequenceRef.current !== requestSeq) return { carriersWithRates, uncoveredPids };
      // PS-135: capture the backend-selected bestRate for the auto-apply step (the browseResult
      // const is scoped to this try block; the selection runs after the finally).
      canonicalBackendBest = (browseResult as { bestRate?: unknown } | null)?.bestRate ?? null;
      // PS-292: expose it to the apply/render closures so a SHIPP house best carries its tuple.
      canonicalBestRef.current = canonicalBackendBest;
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
      setRateBrowserTiming(
        browseResult?.rateBrowseTiming && typeof browseResult.rateBrowseTiming === 'object'
          ? browseResult.rateBrowseTiming as RateBrowserTimingDiagnostics
          : null,
      );
      setRateBrowserFailure(
        browseResult?.rateBrowseFailure && typeof browseResult.rateBrowseFailure === 'object'
          ? browseResult.rateBrowseFailure as RateBrowserFailureDiagnostic
          : null,
      );
      // PS-197: capture the backend-EFFECTIVE insurance for this quote + a redacted request
      // snapshot (no PII/secrets — just the quote facts) so the operator can see why the total
      // differs from a manual no-insurance ShipStation estimate (effective_policy_diff).
      setBackendEffectiveInsurance(
        typeof browseResult?.effectiveInsuranceProvider === 'string' && browseResult.effectiveInsuranceProvider
          ? {
              provider: browseResult.effectiveInsuranceProvider,
              value:
                typeof browseResult?.effectiveInsuredValue === 'number' && Number.isFinite(browseResult.effectiveInsuredValue)
                  ? browseResult.effectiveInsuredValue
                  : null,
              source:
                typeof browseResult?.effectiveInsuranceSource === 'string'
                  ? browseResult.effectiveInsuranceSource
                  : null,
              // PS-197 residential parity: prefer the BACKEND-resolved classification + its
              // evidence tier (e.g. "commercial (manual_override)") over the FE-sent boolean.
              diagnostics: `Quoted with: ZIP ${zip} · ${totalOz} oz · ${lenNum}×${widNum}×${hgtNum} in · ${
                typeof browseResult?.residentialClassification === 'string'
                  ? `${browseResult.residentialClassification}${typeof browseResult?.residentialSource === 'string' ? ` (${browseResult.residentialSource})` : ''}`
                  : `residential ${residentialForQuote ? 'yes' : 'no'}`
              } · confirmation ${rateConfirmation || 'none'} · ${browseResult?.cached ? 'cached' : 'live'} rates`,
            }
          : null,
      );
      // PS-197b: capture the uninsured manual baseline when this browse requested it; clear it
      // on any other browse so the reference can never go stale against new request params.
      if (options.manualEstimateCompare) {
        const manualRates = (browseResult as { manualEstimate?: { rates?: unknown } } | null)?.manualEstimate?.rates;
        setManualEstimateRates(Array.isArray(manualRates) ? (manualRates as RateRow[]) : null);
      } else {
        setManualEstimateRates(null);
      }

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
      const nextTimingByPid: Record<string, number> = {};
      const timingCarriers = Array.isArray((browseResult as any)?.rateBrowseTiming?.carriers)
        ? (browseResult as any).rateBrowseTiming.carriers as RateBrowserProviderDiagnostic[]
        : [];
      for (const timing of timingCarriers) {
        const carrierId = toOptionalString(timing.carrierId);
        const account = carrierId ? accountByCarrierId.get(carrierId) : undefined;
        const durationMs = toFiniteNumber(timing.durationMs);
        if (account && durationMs != null) {
          nextTimingByPid[String(account.shippingProviderId)] = durationMs;
        }
      }
      const carrierStatuses = Array.isArray(browseResult?.carrierStatuses)
        ? browseResult.carrierStatuses as Array<{ carrierId?: string; status?: CarrierRateStatus; error?: string; durationMs?: number }>
        : [];
      for (const status of carrierStatuses) {
        if (!status.carrierId) continue;
        const account = accountByCarrierId.get(status.carrierId);
        if (account) {
          const key = String(account.shippingProviderId);
          nextStatusByPid[key] = status.status ?? 'unavailable';
          if (status.error) nextErrorsByPid[key] = status.error;
          const durationMs = toFiniteNumber(status.durationMs);
          if (durationMs != null && nextTimingByPid[key] == null) nextTimingByPid[key] = durationMs;
        }
      }
      setCarrierTimingByPid(nextTimingByPid);

      liveFetchedRates = sortRateRowsByBackendDisplayRank(dedupeRateRows(
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
      ));

      const grouped = groupRatesByProviderId(liveFetchedRates);
      const nextRatesByPid: Record<string, RateRow[]> = {};
      for (const acct of rateShippingAccounts) {
        const key = String(acct.shippingProviderId);
        const accountRates = grouped[key] ?? [];
        if (accountRates.length > 0) {
          nextRatesByPid[key] = accountRates;
          nextStatusByPid[key] = browseResult?.cached ? 'cached' : 'live';
        } else if (options.cachedOnly) {
          // PS-206: a cached-only probe is TERMINAL for this account — it has
          // no cached coverage and was not checked ('uncached'), it is NOT
          // 'loading' (nothing is in flight). The operator can explicitly click
          // Browse/Refresh when live coverage is needed.
          nextStatusByPid[key] ??= 'uncached';
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
      carriersWithRates = Object.values(nextRatesByPid).filter(
        (rows) => Array.isArray(rows) && rows.length > 0,
      ).length;
      // PS-206: coverage identity for the caller — every scoped account whose
      // terminal state is 'uncached' still needs a live check.
      for (const acct of rateShippingAccounts) {
        if (nextStatusByPid[String(acct.shippingProviderId)] === 'uncached') {
          uncoveredPids.push(acct.shippingProviderId);
        }
      }
    } catch {
      if (browseSequenceRef.current !== requestSeq) return { carriersWithRates, uncoveredPids };
      setRateErrorsByPid({});
      // PS-206: a failed browse leaves every scoped account in a TERMINAL
      // 'error' state — never blank/loading — so the header and sidebar can't
      // claim work is still happening when nothing is in flight.
      setCarrierStatusByPid(
        Object.fromEntries(rateShippingAccounts.map((acct) => [String(acct.shippingProviderId), 'error' as CarrierRateStatus])),
      );
      setRateBrowseInfo({ source: seededBestRate ? 'cache' : null });
      setRateMetaByPid({});
      setCarrierTimingByPid({});
      setRateBrowserTiming(null);
      setRateBrowserFailure(null);
      setRatesByPid(
        seededBestRate && seededPid != null
          ? { [String(seededPid)]: [seededBestRate] }
          : {}
      );
    } finally {
      if (browseSequenceRef.current === requestSeq) setPendingPids(new Set());
    }

    // PS-260 / PS-345: a cached-only probe is display state, not an authority
    // to apply a new best rate when coverage is incomplete. The cached seed
    // stays visible, but only a complete cached set or an explicit live browse
    // can emit the backend canonical best to the order panel.
    const cachedProbeHasIncompleteCoverage = options.cachedOnly === true && uncoveredPids.length > 0;
    if (!cachedProbeHasIncompleteCoverage && onBestRateResolved && (liveFetchedRates.length || seededBestRate)) {
      // Choose the best only after every carrier account has finished.
      // If ShipStation returns no live rates, fall back to the table's
      // already-saved best rate so the modal stays consistent with the row.
      const ratesToRank = liveFetchedRates.length ? liveFetchedRates : [seededBestRate!];
      const available = filterBySvcClass(ratesToRank).filter((r) => !isBackendUnavailableRate(r, order, currentRateShippingOptions));
      // PS-135 / PS-279: the backend owns best-rate selection (src/services/rates.ts picks the
      // cheapest ELIGIBLE rate POST-markup). Consume that canonical winner — matched WITHIN the
      // eligible set so the operator's service-class filter + blocked rules still apply. We must
      // NOT substitute a parallel client-side re-rank when the backend winner is absent: a FE
      // "local cheapest" can silently diverge from the backend (markup-map drift, eligibility
      // differences) and persist a different "best" than the table/row shows. When no canonical
      // best resolves, emit NOTHING and flag an unresolved/retry diagnostic instead.
      const canonicalBest = findCanonicalBestRate(canonicalBackendBest, available);
      const decision = decideBestRateEmission(canonicalBest);
      if (decision.kind === 'emit' && rateIsBackendComplete(decision.rate)) {
        const applied = toAppliedRate(decision.rate);
        if (applied) {
          setBestRateUnresolved(false);
          setSelectedPid(applied.shippingProviderId);
          emitBestRateResolved(applied);
        } else {
          setBestRateUnresolved(true);
        }
      } else {
        // No backend canonical best for the eligible set — do not fabricate/persist a FE-ranked
        // local cheapest. Surface the unresolved state so the operator can retry the browse.
        setBestRateUnresolved(true);
      }
    }

    finishBrowseRequest(requestSeq);
    return { carriersWithRates, uncoveredPids };
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
    return sortRateRowsByBackendDisplayRank(dedupeRateRows(filterBySvcClass(out)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratesByPid, rateShippingAccounts, svcClass]);

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
  // PS-206: "loading" is derived ONLY from genuinely in-flight requests
  // (pendingPids). Counting a resting status string as in-flight was what left
  // the header stuck on "Checking carriers..." with zero requests running.
  const totalCarriersLoading = useMemo(
    () =>
      rateShippingAccounts.filter((c) => pendingPids.has(c.shippingProviderId)).length,
    [pendingPids, rateShippingAccounts]
  );
  const totalVisibleRates = combinedAll.length;
  const rateBrowserHeaderText = useMemo(() => {
    if (!anyFetched) return '';
    const rateLabel = totalVisibleRates === 1 ? 'rate' : 'rates';
    const accountLabel = totalCarriersLoading === 1 ? 'account' : 'accounts';
    if (totalCarriersLoading > 0) {
      return `${totalVisibleRates} ${rateLabel} found · checking ${totalCarriersLoading} ${accountLabel}`;
    }
    if (browsing) {
      return totalVisibleRates > 0
        ? `${totalVisibleRates} ${rateLabel} found · finalizing`
        : 'Checking carriers...';
    }
    return `${totalCarriersChecked} of ${rateShippingAccounts.length} carriers checked · ${totalCarriersAvailable} with rates`;
  }, [
    anyFetched,
    browsing,
    rateShippingAccounts.length,
    totalCarriersAvailable,
    totalCarriersChecked,
    totalCarriersLoading,
    totalVisibleRates,
  ]);
  const carrierDisplayCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of rateShippingAccounts) {
      const label = formatAccountDisplay(account);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  }, [rateShippingAccounts]);

  // PS-216: duplicate nicknames disambiguate with HUMAN facts only — the
  // backend-owned displayDisambiguator ("USPS"/"UPS"/provider label), with a
  // same-shaped carrier-family fallback for deploy skew. The old suffix
  // appended carrierId/directCarrierAccountId/shippingProviderId, which
  // leaked se-442006-style provider ids into the HUGRAB sidebar. When no
  // human label can be derived, show NO suffix — never an identifier.
  const SIDEBAR_FAMILY_FALLBACK: Record<string, string> = {
    stamps_com: 'USPS',
    usps: 'USPS',
    ups: 'UPS',
    ups_walleted: 'UPS',
    fedex: 'FedEx',
    fedex_walleted: 'FedEx',
    dhl_express: 'DHL',
    shipp: 'Shipp',
    easypost: 'EasyPost',
    shipengine: 'ShipEngine',
    walmart_shipping: 'Walmart Shipping',
    ebay_shipping: 'eBay Shipping',
    amazon_shipping: 'Amazon Shipping',
    prepship_test: 'PrepShip Test',
  };

  function sidebarAccountDisambiguator(account: RbCarrierAccountDto): string | null {
    const fromDto = toDisplayLabel(account.displayDisambiguator);
    if (fromDto) return fromDto;
    const code = String(account.carrierCode ?? account.code ?? '').trim().toLowerCase();
    return SIDEBAR_FAMILY_FALLBACK[code] ?? null;
  }

  function formatSidebarAccountDisplay(account: RbCarrierAccountDto): string {
    const label = formatAccountDisplay(account);
    if ((carrierDisplayCounts.get(label) ?? 0) <= 1) return label;
    const family = sidebarAccountDisambiguator(account);
    return family ? `${label} (${family})` : label;
  }

  function currentAppliedInsurance(): Pick<RbAppliedRate, 'insuranceProvider' | 'insuredValue'> {
    // PS-164: delegate to the canonical insurance normalizer (single alias owner; unknown -> 'none').
    return normalizeInsurance({ insuranceProvider, insuredValue });
  }

  function rateInsuranceProof(r: RateRow): Pick<
    RbAppliedRate,
    'insuranceCost' | 'insuranceProvenance' | 'insuranceCostUnresolved' | 'insuranceCostError' | 'insurance_amount' | 'insuranceCertainty' | 'raw'
  > {
    return {
      insuranceCost: r.insuranceCost ?? r.raw?.insuranceCost,
      insuranceProvenance: r.insuranceProvenance ?? r.raw?.insuranceProvenance,
      insuranceCostUnresolved: r.insuranceCostUnresolved ?? r.raw?.insuranceCostUnresolved,
      insuranceCostError: r.insuranceCostError ?? r.raw?.insuranceCostError,
      insurance_amount: r.insurance_amount ?? r.raw?.insurance_amount,
      // PS-274: carry the backend insurance-certainty fact through Apply (display-only).
      insuranceCertainty: r.insuranceCertainty ?? r.raw?.insuranceCertainty,
      raw: r.raw ?? r,
    };
  }

  // PS-198: lift the backend-issued quote proof off a rate row so Apply preserves it
  // end-to-end (Apply → persist best_rate_json → Create Label / Print Queue). The
  // translated row carries the fields top-level; `raw` (the verbatim backend rate) is
  // the fallback for shapes that pre-date the top-level stamp. Pass-through ONLY —
  // absent fields stay absent, so a proof-less rate (manual estimate, legacy cache)
  // remains structurally non-purchasable at the backend boundary.
  function rateBackendProof(r: RateRow): Partial<
    Pick<
      RbAppliedRate,
      'rateQuoteId' | 'selectedRateKey' | 'selectionRef' | 'requestFingerprint' | 'cacheKey' | 'cacheCreatedAt' | 'cacheExpiresAt' | 'proofSource' | 'isComplete' | 'secondBestRate'
    >
  > {
    const raw = (r.raw && typeof r.raw === 'object' ? r.raw : null) as Record<string, unknown> | null;
    const canonical =
      findCanonicalBestRate(canonicalBestRef.current, [r]) === r &&
      canonicalBestRef.current &&
      typeof canonicalBestRef.current === 'object'
        ? (canonicalBestRef.current as Record<string, unknown>)
        : null;
    const out: Partial<RbAppliedRate> = {};
    for (const key of [
      'rateQuoteId',
      'selectedRateKey',
      'selectionRef',
      'requestFingerprint',
      'cacheKey',
      'cacheCreatedAt',
      'cacheExpiresAt',
      'proofSource',
    ] as const) {
      const value = (r as Record<string, unknown>)[key] ?? raw?.[key] ?? canonical?.[key];
      if (typeof value === 'string' && value) out[key] = value as any;
    }
    const isComplete = (r as Record<string, unknown>).isComplete ?? raw?.isComplete ?? canonical?.isComplete;
    if (typeof isComplete === 'boolean') out.isComplete = isComplete;
    const secondBestRate = (r as Record<string, unknown>).secondBestRate ?? raw?.secondBestRate ?? canonical?.secondBestRate;
    if (secondBestRate != null) out.secondBestRate = secondBestRate;
    return out;
  }

  function rateIsBackendComplete(r: RateRow | null | undefined): boolean {
    if (!r) return false;
    const canonical =
      findCanonicalBestRate(canonicalBestRef.current, [r]) === r &&
      canonicalBestRef.current &&
      typeof canonicalBestRef.current === 'object'
        ? (canonicalBestRef.current as Record<string, unknown>)
        : null;
    return rateBrowserBackendProofIsComplete(r) || canonical?.isComplete === true;
  }

  function isRecommendedRate(r: RateRow): boolean {
    if (browsing || totalCarriersLoading > 0 || bestRateUnresolved) return false;
    return findCanonicalBestRate(canonicalBestRef.current, [r]) === r && rateIsBackendComplete(r);
  }

  function handleRateClick(r: RateRow): void {
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    if (!Number.isFinite(pid) || !r.serviceCode) return;
    if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return;
    // Per user override unlock shipped data on 2026-07-11: the parent Apply
    // command atomically persists the provider; avoid a second racing write.
    onApplyRate({
      carrierCode: r.carrierCode,
      serviceCode: r.serviceCode,
      serviceName: r.serviceName,
      shippingProviderId: pid,
      shipmentCost: r.shipmentCost,
      otherCost: r.otherCost,
      amount: r.amount,
      carrierNickname: r.carrierNickname ?? undefined,
      confirmation: normalizeConfirmationForRates(confirmation),
      ...currentAppliedInsurance(),
      ...rateInsuranceProof(r),
      ...rateBackendProof(r),
      // PS-292: if this clicked row IS the backend canonical SHIPP best, carry its house tuple so the
      // saved best_rate_json keeps the customer_rate/margin (the Awaiting row renders the two-tier).
      ...houseTupleForRow(r, canonicalBestRef.current),
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
    if (isBackendUnavailableRate(r, order, currentRateShippingOptions)) return null;
    return {
      carrierCode: r.carrierCode,
      serviceCode: r.serviceCode,
      serviceName: r.serviceName,
      shippingProviderId: pid,
      shipmentCost: r.shipmentCost,
      otherCost: r.otherCost,
      amount: r.amount,
      carrierNickname: r.carrierNickname ?? undefined,
      confirmation: normalizeConfirmationForRates(confirmation),
      ...currentAppliedInsurance(),
      ...rateInsuranceProof(r),
      ...rateBackendProof(r),
      // PS-292: carry the backend SHIPP house tuple when this row is the canonical best (auto-recommend
      // emission path), so onBestRateResolved persists the customer_rate/margin like the manual click.
      ...houseTupleForRow(r, canonicalBestRef.current),
      weight: { lb: lbNum, oz: ozNum },
      dims: { length: lenNum, width: widNum, height: hgtNum },
    };
  }

  if (!open) return null;

  // ── Sub-renderers ──────────────────────────────────────────────────────────

  // PS-157: the row markup now lives in <RateRowItem> (pure presentation). The
  // blocked/total decision functions and all selection state stay here and are
  // passed down so behavior is byte-for-byte identical. The same React key the
  // original root <div> used is preserved on the element so list reconciliation
  // is unchanged.
  function renderRateRow(r: RateRow, index: number, showCarrier: boolean, isRecommended: boolean): ReactNode {
    const pid =
      typeof r.shippingProviderId === 'number'
        ? r.shippingProviderId
        : Number(r.shippingProviderId);
    // PS-292: when THIS row is the backend canonical SHIPP best for a house-account order, show the
    // two-tier tuple — bold customer_rate (backend nextBestNonHouseRate.totalCost) over the SHIPP
    // drp_cost (the row's own base) + a HOUSE badge. null for every other row / non-house / redacted
    // (non-financial viewers get a nulled totalCost from the backend, so this stays hidden).
    const houseTuple = isRecommended
      ? houseDisplayForRow(r, canonicalBestRef.current, rateBrowserRateCostAmount(r))
      : null;
    return (
      <RateRowItem
        key={`${pid}-${r.serviceCode}-${index}`}
        r={r}
        index={index}
        showCarrier={showCarrier}
        isRecommended={isRecommended}
        order={order}
        rateShippingAccounts={rateShippingAccounts}
        currentRateShippingOptions={currentRateShippingOptions}
        onRateClick={handleRateClick}
        rateBlockedReason={(row, rowOrder, shippingOptions) =>
          rateBlockedReason(row, rowOrder, shippingOptions, { proofFinalizing: rateProofFinalizing })
        }
        houseTuple={houseTuple}
      />
    );
  }

  function formatShopifyMoney(amount: unknown, currency: unknown): string {
    const value = toFiniteNumber(amount);
    const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : 'USD';
    if (value == null) return '—';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(value);
    } catch {
      return `${value.toFixed(2)} ${code}`;
    }
  }

  function renderShopifyRatesPanel(): ReactNode {
    if (!isShopifyOrder) return null;
    const checkoutShipping = shopifyRatesResult?.checkoutShipping ?? [];
    const checkoutDeliveryOptions = shopifyRatesResult?.checkoutDeliveryOptions ?? [];
    const shopifyRates = shopifyRatesResult?.rates ?? [];
    return (
      <div
        data-rate-browser="shopifyRatesPanel"
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '12px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>Shopify Shipping</div>
            {checkoutShipping.length ? (
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>
                Buyer-paid checkout shipping:{' '}
                {checkoutShipping.map((line, index) => (
                  <span key={`${line.title ?? 'checkout'}-${index}`}>
                    {index > 0 ? ', ' : ''}
                    {line.title ?? 'Shipping'} {formatShopifyMoney(line.amount, line.currency)}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void browseShopifyRates(true)}
            disabled={shopifyRatesLoading || !hasWeight || !hasDims}
            style={{ fontSize: 12, padding: '7px 10px', whiteSpace: 'nowrap' }}
          >
            {shopifyRatesLoading ? 'Fetching...' : shopifyRatesResult ? 'Refresh Shopify Shipping' : 'Check Shopify Shipping'}
          </button>
        </div>

        {shopifyRatesNotice ? (
          <div
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] font-semibold leading-snug text-amber-900"
          >
            {shopifyRatesNotice}
          </div>
        ) : null}

        {shopifyRatesError ? (
          <div
            role="status"
            style={{
              fontSize: 11.5,
              color: 'var(--red)',
              background: 'rgba(185, 28, 28, 0.08)',
              border: '1px solid rgba(185, 28, 28, 0.18)',
              borderRadius: 6,
              padding: '7px 9px',
            }}
          >
            {shopifyRatesError}
          </div>
        ) : null}

        {shopifyRates.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {shopifyRates.map((rate) => {
              return (
                <div
                  key={rate.selectedRateKey}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: 10,
                    alignItems: 'center',
                    border: '1px solid var(--border)',
                    borderRadius: 7,
                    padding: '9px 10px',
                    background: 'var(--surface2)',
                  }}
                >
                  <span
                    style={{
                      minWidth: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800, color: 'var(--text)' }}>
                        {rate.title ?? rate.serviceCode ?? 'Shopify Shipping'}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)' }}>
                        {[rate.carrierCode, rate.serviceCode].filter(Boolean).join(' · ') || rate.handle || 'Shopify Shipping'}
                      </span>
                    </span>
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    {formatShopifyMoney(rate.amount, rate.currency)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {checkoutDeliveryOptions.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text3)', textTransform: 'uppercase' }}>
              Checkout delivery options - not Shopify label rates
            </div>
            {checkoutDeliveryOptions.map((rate, index) => (
              <div
                key={rate.selectedRateKey || `${rate.title ?? 'checkout'}-${index}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 10,
                  alignItems: 'center',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  padding: '9px 10px',
                  background: 'var(--surface2)',
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 800, color: 'var(--text)' }}>
                    {rate.title ?? rate.serviceCode ?? 'Shopify delivery option'}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)' }}>
                    {[rate.carrierCode, rate.serviceCode].filter(Boolean).join(' · ') || rate.handle || 'Checkout delivery'}
                  </span>
                </span>
                <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                  {formatShopifyMoney(rate.amount, rate.currency)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // PS-157: the rates body (empty/loading/all/carriers states + the All-Rates and
  // per-carrier views) moved verbatim into <RateRowsView>. The parent still owns
  // combinedAll / display-only service-class filtering / backend availability facts and the row rendering
  // (renderRateRow), passing them down so behavior is byte-for-byte identical.

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rate Browser"
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/[0.45]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[calc(100vh-32px)] max-h-[820px] w-[1280px] max-w-[97vw] flex-col overflow-hidden rounded-modal bg-surface shadow-[0_8px_40px_rgba(0,0,0,0.3)]"
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center border-b border-line bg-surface-2 px-[18px] py-[13px]"
        >
          <span className="flex-1 text-[15px] font-bold text-ink">
            Rate Browser
          </span>
          {/* PS-276 (slice 4-UI): the order's backend resi/comm verdict (one per browse, not per rate). */}
          <span className="mr-3 text-[11px]">
            <ResidentialTag facts={residentialTagFacts(order)} />
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="cursor-pointer border-0 bg-transparent px-1 text-[22px] leading-none text-ink-3"
          >
            ×
          </button>
        </div>

        {hugrabGroundSaverBlocked ? (
          <div
            className="border-b border-line bg-surface px-[18px] py-2 text-[11.5px] font-bold leading-[1.4] text-danger"
          >
            {HUGRAB_GROUND_SAVER_BLOCK_REASON}
          </div>
        ) : null}

        {/* Body: 3 columns */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* LEFT: Configure */}
          <div
            className="flex w-[280px] shrink-0 flex-col overflow-y-hidden border-r border-line bg-surface"
          >
            <div
              className="mb-1.5 px-3.5 pt-3.5 text-[11px] font-bold uppercase tracking-[0.5px] text-ink-3"
            >
              Configure Rates
            </div>

            <div
              className="flex min-h-0 flex-1 flex-col gap-2.5 px-3.5"
            >
              {/* Ship From */}
              <div>
                <div className={RATE_BROWSER_FIELD_LABEL}>
                  Ship From
                </div>
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="ship-select"
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
                <div className={RATE_BROWSER_FIELD_LABEL}>
                  Ship To
                </div>
                <div className={RATE_BROWSER_HINT_LABEL}>
                  Postal Code
                </div>
                <input
                  type="text"
                  maxLength={10}
                  placeholder="90001 or 90001-1234"
                  value={zip}
                  onChange={(e) => setZip(sanitizePostalInput(e.target.value))}
                  className="ship-input"
                />
                <div
                  className="mt-1.5 flex items-center gap-[5px] text-xs text-ink-2"
                >
                  {/* PS-280: show the BACKEND residential/commercial verdict (never "always
                      residential"). Reuses the shared ResidentialTag; on deploy-skew with no
                      verdict, a safe fallback label — never the old hardcoded "always". */}
                  {(() => {
                    const facts = residentialTagFacts(order)
                    return facts
                      ? <ResidentialTag facts={facts} />
                      : <span className="text-[11px] text-ink-3">Residential · fallback</span>
                  })()}
                </div>
              </div>

              {/* Shipment Info */}
              <div>
                <div className="mb-2 text-xs font-bold text-ink">
                  Shipment Information
                </div>

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Weight{' '}
                  {hasWeight && (
                    <span
                      className={RATE_BROWSER_SAVED_MARK}
                      title="Weight saved for this SKU"
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div
                  className="mb-2.5 flex items-center gap-1"
                >
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={wtLb}
                    onChange={(e) => setWtLb(e.target.value)}
                    className="ship-input !w-[54px]"
                  />
                  <span className="text-[11px] text-ink-3">(lb)</span>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    step={1}
                    value={wtOz}
                    onChange={(e) => setWtOz(e.target.value)}
                    className="ship-input !w-[54px]"
                  />
                  <span className="text-[11px] text-ink-3">(oz)</span>
                </div>

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Package
                </div>
                <select
                  value={packageId}
                  onChange={(e) => onPackageChange(e.target.value)}
                  className="ship-select mb-2.5"
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

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Size (L × W × H in){' '}
                  {hasDims && (
                    <span
                      className={RATE_BROWSER_SAVED_MARK}
                      title="Dims saved for this SKU"
                    >
                      ✓
                    </span>
                  )}
                </div>
                <div
                  className="mb-2.5 flex flex-wrap items-center gap-[3px]"
                >
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={lenStr}
                    onChange={(e) => setLen(e.target.value)}
                    className="ship-input !w-12"
                  />
                  <span className={RATE_BROWSER_UNIT_LABEL}>L</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={widStr}
                    onChange={(e) => setWid(e.target.value)}
                    className="ship-input !w-12"
                  />
                  <span className={RATE_BROWSER_UNIT_LABEL}>W</span>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={hgtStr}
                    onChange={(e) => setHgt(e.target.value)}
                    className="ship-input !w-12"
                  />
                  <span className={RATE_BROWSER_UNIT_LABEL}>H</span>
                </div>

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Delivery Confirmation
                  <span
                    className="mt-0.5 block text-[10px] font-semibold text-ink-3"
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
                  className="ship-select mb-2.5"
                >
                  {CONFIRMATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Insurance
                </div>
                <div className="mb-2.5 flex gap-1.5">
                  <select
                    value={insuranceProvider}
                    onChange={(e) => {
                      const next = e.target.value;
                      setInsuranceProvider(next);
                      if (anyFetched && !browsing) {
                        void browseRates(confirmation, { forceLive: true, insuranceProviderOverride: next });
                      }
                    }}
                    className="ship-select flex-1"
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
                      const next = e.target.value;
                      setInsuredValue(next);
                      if (anyFetched && !browsing) {
                        void browseRates(confirmation, { forceLive: true, insuredValueOverride: next });
                      }
                    }}
                    className={`ship-input !w-[70px] ${insuranceProvider !== 'none' ? 'block' : 'hidden'}`}
                    placeholder="$0"
                  />
                </div>

                {(() => {
                  // PS-197: show the backend-EFFECTIVE insurance whenever the quote was made
                  // under a policy (e.g. HUGRAB ParcelGuard $100 default) — especially when it
                  // differs from the dropdown above, which previously read "None" while the
                  // totals were label-safe insured (the #1461 $8.95-vs-$7.93 confusion).
                  const display = classifyEffectiveInsuranceDisplay({
                    backendProvider: backendEffectiveInsurance?.provider,
                    backendValue: backendEffectiveInsurance?.value,
                    backendSource: backendEffectiveInsurance?.source,
                    operatorProvider: insuranceProvider,
                    operatorValue: insuredValue,
                  });
                  if (!display) return null;
                  const overridden = display.kind === 'effective_policy_diff';
                  // PS-197b: per-ACCOUNT verdict from the backend-stamped rate fields — clicking
                  // USPS shows "ParcelGuard $100 (+$1.09)", clicking ORION/ROCEL shows "Carrier
                  // declared value $100 — free first $100". Display-only; the dropdown above
                  // stays operator INTENT and is never auto-mutated.
                  const selectedAccountRates = selectedPid != null ? ratesByPid[String(selectedPid)] : null;
                  const accountVerdict = classifyAccountEffectiveInsurance(
                    selectedAccountRates,
                    backendEffectiveInsurance?.value ?? null,
                  );
                  const selectedAccountLabel =
                    rateShippingAccounts.find((account) => account.shippingProviderId === selectedPid)?.nickname ?? null;
                  // PS-197b: uninsured manual baseline rows for the selected account (reference
                  // only — these rates carry NO proof keys and can never be selected/purchased).
                  const manualForAccount = Array.isArray(manualEstimateRates) && selectedPid != null
                    ? manualEstimateRates.filter(
                        (rate) => toFiniteNumber(rate.shippingProviderId) === toFiniteNumber(selectedPid),
                      )
                    : [];
                  // PS-197 correction (DJ 2026-06-10): when an account is selected, its
                  // per-account verdict IS the effective insurance (e.g. ROCEL direct-UPS ->
                  // "Carrier declared value $100", NOT the request-level ParcelGuard policy).
                  // The request-level policy drops to a secondary "request policy" note — it
                  // still owns the fingerprint/cache key, but it is not what the selected
                  // account purchases with.
                  const primaryLabel = accountVerdict && selectedAccountLabel
                    ? `Effective insurance (${selectedAccountLabel}): ${accountVerdict.label}`
                    : `Effective insurance: ${display.label}`;
                  return (
                    <div className="-mt-1 mb-2.5">
                      <div
                        data-rate-browser="effectiveInsurance"
                        title={backendEffectiveInsurance?.diagnostics ?? undefined}
                        className={`cursor-help text-[11px] ${overridden ? 'text-warn' : 'text-ink-3'}`}
                      >
                        {primaryLabel}
                        {overridden ? ' (backend policy — included in the totals; totals are label-safe)' : ''}
                      </div>
                      {accountVerdict && selectedAccountLabel ? (
                        <div
                          data-rate-browser="accountEffectiveInsurance"
                          className="mt-0.5 text-[11px] text-ink-3"
                        >
                          Request policy: {display.label}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        data-rate-browser="manualEstimateCompare"
                        disabled={browsing || manualEstimateLoading}
                        onClick={() => {
                          setManualEstimateLoading(true);
                          void browseRates(confirmation, { forceLive: true, manualEstimateCompare: true })
                            .finally(() => setManualEstimateLoading(false));
                        }}
                        className={`mt-1 border-0 bg-transparent p-0 text-[11px] text-brand underline ${browsing || manualEstimateLoading ? 'cursor-wait' : 'cursor-pointer'}`}
                      >
                        {manualEstimateLoading ? 'Comparing…' : 'Compare ShipStation manual estimate'}
                      </button>
                      {manualForAccount.length ? (
                        <div
                          data-rate-browser="manualEstimateList"
                          className="mt-1 text-[11px] leading-[1.5] text-ink-3"
                        >
                          <div className="font-semibold">
                            ShipStation manual estimate (uninsured — not label-safe):
                          </div>
                          {manualForAccount.map((rate, index) => {
                            const base = (toFiniteNumber(rate.shipmentCost) ?? toFiniteNumber(rate.amount) ?? 0) +
                              (toFiniteNumber(rate.otherCost) ?? 0);
                            return (
                              <div key={`${rate.serviceCode ?? index}`}>
                                {String(rate.serviceName ?? rate.serviceCode ?? 'Service')}: ${base.toFixed(2)}
                              </div>
                            );
                          })}
                        </div>
                      ) : manualEstimateRates && selectedPid != null ? (
                        <div className="mt-1 text-[11px] text-ink-3">
                          No manual-estimate rows for this account.
                        </div>
                      ) : null}
                    </div>
                  );
                })()}

                <div className={RATE_BROWSER_HINT_LABEL}>
                  Service Class
                </div>
                <select
                  value={svcClass}
                  onChange={(e) => setSvcClass(e.target.value as '' | 'ground' | 'express')}
                  className="ship-select mb-2.5"
                >
                  <option value="">Show All</option>
                  <option value="ground">Ground / Economy</option>
                  <option value="express">Express / Priority</option>
                </select>
              </div>
            </div>

            {/* Browse button pinned to bottom */}
            <div
              className="shrink-0 border-t border-line px-3.5 py-3"
            >
              <button
                type="button"
                className="btn btn-primary w-full justify-center p-[9px] text-[13px]"
                onClick={() => void browseRates(undefined, { forceLive: true })}
                disabled={
                  browsing ||
                  !hasWeight ||
                  !hasDims ||
                  !zip ||
                  zip.length < 5 ||
                  (!testMode && !rateShippingAccounts.length)
                }
              >
                {browsing ? 'Fetching...' : anyFetched ? 'Refresh Live Rates' : 'Browse Rates'}
              </button>
            </div>
          </div>

          {/* MIDDLE: Carrier accounts — PS-157 extracted to <RateBrowserCarrierSidebar> */}
          <RateBrowserCarrierSidebar
            rateShippingAccounts={rateShippingAccounts}
            testMode={testMode}
            scopedAccountsLoading={scopedAccountsLoading}
            scopedAccountsError={scopedAccountsError}
            selectedPid={selectedPid}
            ratesByPid={ratesByPid}
            rateErrorsByPid={rateErrorsByPid}
            carrierStatusByPid={carrierStatusByPid}
            carrierTimingByPid={carrierTimingByPid}
            hideUnavail={hideUnavail}
            pendingPids={pendingPids}
            shouldHideRate={shouldHideUnavailableRate}
            formatSidebarAccountDisplay={formatSidebarAccountDisplay}
            onSelectCarrier={(pid) => {
              setSelectedPid(pid);
              setViewMode('carriers');
            }}
          />

          {/* RIGHT: Rates */}
          <div
            className="flex min-w-0 flex-1 flex-col bg-surface"
          >
            {/* Rates top bar */}
            <div
              className="flex shrink-0 items-center gap-2.5 border-b border-line bg-surface-2 px-[18px] py-2.5"
            >
              <span className="text-sm font-bold text-ink">
                {isShopifyOrder ? 'PrepShip Rates' : 'Rates'}
              </span>
              <span className="flex-1 text-[11.5px] text-ink-3">
                {rateBrowserHeaderText}
                {rateBrowseInfo.source === 'cache'
                  ? ` | cached ${formatCacheAge(rateBrowseInfo.cacheAgeMs) ?? ''}`.trimEnd()
                  : rateBrowseInfo.source === 'live'
                    ? ' | live'
                    : rateBrowseInfo.source === 'mixed'
                      ? ' | cached + live'
                      : ''}
              </span>
              {/* PS-279: backend returned no canonical best for the eligible set — we persist
                  NOTHING (never a FE-ranked local cheapest); prompt the operator to retry. */}
              {bestRateUnresolved && !browsing && totalCarriersLoading === 0 ? (
                <span
                  role="status"
                  className="whitespace-nowrap text-[11.5px] text-warn"
                >
                  Best rate unresolved — retry
                </span>
              ) : null}
              {rateWorkflowProgressText ? (
                <span
                  role="status"
                  data-rate-browser="workflowProgress"
                  className="whitespace-nowrap text-[11.5px] text-ink-3"
                >
                  {rateWorkflowProgressText}
                </span>
              ) : null}
              <label className="flex cursor-pointer select-none items-center gap-[5px] text-[11.5px] text-ink-3">
                <input
                  type="checkbox"
                  checked={hideUnavail}
                  onChange={(e) => setHideUnavail(e.target.checked)}
                  className="cursor-pointer"
                />
                Hide Unavailable
              </label>
              <span className="text-[11.5px] text-ink-3">View By:</span>
              <select
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as 'all' | 'carriers')}
                className="ship-select !w-[110px] text-xs"
              >
                <option value="carriers">Carriers</option>
                <option value="all">All Rates</option>
              </select>
            </div>

            <RateBrowserDiagnosticsPanel
              timing={rateBrowserTiming}
              failure={rateBrowserFailure}
            />

            {/* Rates content */}
            <div
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              {renderShopifyRatesPanel()}
              {/* PS-157: rates body extracted to <RateRowsView>; parent keeps the
                  row rendering + all rate math/filtering and passes them down. */}
              <RateRowsView
                hasWeight={hasWeight}
                hasDims={hasDims}
                browsing={browsing}
                hasAnyRateRows={hasAnyRateRows}
                anyFetched={anyFetched}
                zip={zip}
                viewMode={viewMode}
                hideUnavail={hideUnavail}
                selectedPid={selectedPid}
                combinedAll={combinedAll}
                rateShippingAccounts={rateShippingAccounts}
                ratesByPid={ratesByPid}
                rateErrorsByPid={rateErrorsByPid}
                rateMetaByPid={rateMetaByPid}
                filterBySvcClass={filterBySvcClass}
                shouldHideRate={shouldHideUnavailableRate}
                renderRateRow={renderRateRow}
                isRecommendedRate={isRecommendedRate}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
