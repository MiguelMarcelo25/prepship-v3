import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { timedFetch } from '../../lib/http/timing.js';
import { assertUnsupportedShippingOptions } from './shipping-option-support.js';
import { readShipFrom } from './ship-from-address.js';
// PS-271 (Layer 1): observed-set thin-response retry. Default-OFF per account; with the opt-in flag
// absent NONE of this runs and the connector does today's exact single POST.
import {
  acquireShippQuoteBudget,
  isQuoteInCooldown,
  missingObservedCarriers,
  normalizeObservedCarrier,
  readObservedCarriers,
  recordQuoteCooldown,
  shippObservedRetryEnabled,
} from './shipp-observed-carriers.js';
// PS-271 (Layer 4): thin-source honesty marker — rides non-enumerably on the rate array so an
// accepted-thin partial is carried out alongside (never inside) the rates. Default-inert.
import { attachObservedIncomplete } from './shipp-observed-incomplete-marker.js';
// PS-274: the backend-owned insurance-CERTAINTY fact. Shipp brokers UPS/FedEx/USPS — it is NEVER
// a direct verified carrier account, so a Shipp rate that declared an insured value is
// 'requested_application_uncertain' (we requested it via customsValue; we cannot prove the carrier
// applied declared value at purchase) and a Shipp rate with no declared value is 'not_included'.
// Identity FIRST: the connector that brokered the rate stamps the honest certainty here.
import { resolveInsuranceCertainty } from '../../services/shipping-workflow/insurance-certainty.js';
import { PDFDocument } from 'pdf-lib';
// PS-294: the single owner of the SHIPP label 4×6 placement math (raster/image path).
import { computeFourBySixPlacement } from './shipp-label-4x6-placement.js';
// PS-294 slice 2: B's PS-287 content-aware 4×6 normalizer — the PURE print-queue-pdf module (NOT the
// print-queue.ts barrel, which drags in db/client + env). Crops the PDF label to its visible artwork
// bounds + scales it to FILL the 4×6 canvas, so an oversized/corner SHIPP label fills 4×6.
import { appendNormalizedLabelPages } from '../../services/print-queue-pdf.js';
import { createRequire } from 'node:module';
import UPNG from '@pdf-lib/upng';

const require = createRequire(import.meta.url);
const UPNG_API = (UPNG as any).default ?? (UPNG as any);
const { GifReader } = require('omggif') as {
  GifReader: new (buffer: Uint8Array) => {
    width: number;
    height: number;
    numFrames: () => number;
    decodeAndBlitFrameRGBA: (frameIndex: number, pixels: Uint8Array) => void;
  };
};

function shippSplitSetCookie(header: string): string[] {
  if (!header) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function shippCookieHeaderFrom(res: any, data: any): string {
  const getSetCookie = typeof res?.headers?.getSetCookie === 'function'
    ? res.headers.getSetCookie.bind(res.headers)
    : null;
  const setCookies: string[] = getSetCookie
    ? getSetCookie()
    : shippSplitSetCookie(String(res?.headers?.get?.('set-cookie') ?? ''));
  const cookiePairs = setCookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter((cookie): cookie is string => Boolean(cookie));

  const accessToken = String(data?.session?.access_token ?? data?.access_token ?? '').trim();
  const refreshToken = String(data?.session?.refresh_token ?? data?.refresh_token ?? '').trim();
  if (accessToken && !cookiePairs.some((cookie) => cookie.startsWith('sb-access-token='))) {
    cookiePairs.push(`sb-access-token=${encodeURIComponent(accessToken)}`);
  }
  if (refreshToken && !cookiePairs.some((cookie) => cookie.startsWith('sb-refresh-token='))) {
    cookiePairs.push(`sb-refresh-token=${encodeURIComponent(refreshToken)}`);
  }

  return cookiePairs.join('; ');
}

function shippRequiredString(value: unknown, fallback: string): string {
  const v = String(value ?? '').trim();
  return v || fallback;
}

function shippCountryCode(value: unknown, fallback = 'US'): string {
  const v = shippRequiredString(value, fallback).toUpperCase();
  if (v === 'USA' || v === 'UNITED STATES' || v === 'UNITED STATES OF AMERICA') return 'US';
  return v.slice(0, 2) || fallback;
}

function shippBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function shippFirstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

const shippZipCache = new Map<string, { city?: string; state?: string }>();
// Hard cap on TOTAL /quote POSTs per quote — SHARED by the transient (5xx/429) retry loop AND the
// PS-271 observed-set thin-response re-ask (they do NOT stack a second budget). At 2 this is the
// today behavior + at most ONE thin re-ask; bump to 3 to allow one transient retry AND one thin
// re-ask in the same quote (documented 3x ceiling). Login is never counted (a re-POST reuses the
// session). Env-overridable but clamped to [1,3] so a misconfig can't fan out provider calls.
const SHIPP_QUOTE_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(3, Number.parseInt(process.env.SHIPP_QUOTE_MAX_ATTEMPTS ?? '2', 10) || 2),
);
// Backoff before a re-POST. The transient (5xx/429) path already sleeps 500ms; the new PS-271 thin
// re-ask gets its OWN (slightly longer) backoff so a non-deterministic carrier set has a moment to
// settle before we re-ask.
const SHIPP_THIN_RETRY_BACKOFF_MS = Math.max(
  0,
  Number.parseInt(process.env.SHIPP_THIN_RETRY_BACKOFF_MS ?? '750', 10) || 750,
);

function shippShouldRetryQuoteStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function shippSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function shippLookupUsZip(zip: unknown, signal?: AbortSignal): Promise<{ city?: string; state?: string }> {
  const five = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(five)) return {};
  const cached = shippZipCache.get(five);
  if (cached) return cached;

  try {
    const res = await timedFetch('shipp.zip-lookup', `https://api.zippopotam.us/us/${five}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!res.ok) {
      const empty = {};
      shippZipCache.set(five, empty);
      return empty;
    }
    const data = await res.json() as any;
    const place = Array.isArray(data?.places) ? data.places[0] : null;
    const result = {
      city: shippFirstString(place?.['place name']),
      state: shippFirstString(place?.['state abbreviation']),
    };
    shippZipCache.set(five, result);
    return result;
  } catch {
    signal?.throwIfAborted();
    return {};
  }
}

function shippCarrierCode(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  return normalized.replace(/[^a-z0-9_]+/g, '').replace(/^_+|_+$/g, '') || null;
}

function shippCarrierName(value: unknown): string | null {
  const code = shippCarrierCode(value);
  if (code === 'fedex') return 'FedEx';
  if (code === 'ups') return 'UPS';
  if (code === 'stamps_com') return 'USPS';
  if (code === 'dhl_express') return 'DHL';
  const raw = String(value ?? '').trim();
  return raw || null;
}

function shippDateDays(deliveryDate: unknown, deliveryDay: unknown): number {
  const dateString = String(deliveryDate ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const start = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const end = Date.parse(`${dateString}T00:00:00Z`);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return Math.max(0, Math.ceil((end - start) / 86_400_000));
    }
  }
  const numeric = Number(deliveryDay);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * PS-494: the country of origin declared to Shipp.
 *
 * Order of preference, and the reasoning for each step:
 *   1. The backend-resolved origin (`customs-origin.ts`), when the order's customs items
 *      agree on one. This is a recorded fact, not an inference.
 *   2. The operator's configured default, beside the existing packageDescription — the
 *      goods description was already correctable and the origin was not, which looked
 *      unintentional.
 *   3. 'US', preserving the previous behaviour so no existing Shipp shipment changes.
 *
 * A MIXED carton lands on step 2/3 and that is a known limitation, not a decision: this
 * request carries ONE synthetic package line item, so it has room for one origin. Declaring
 * a mixed carton truthfully needs per-product line items, which belongs to the PS-492
 * customs builder — restructuring this body would change what 246 live domestic shipments
 * send, for a field with no customs meaning on a domestic lane.
 */
function shippCountryOfManufacture(
  input: Record<string, unknown>,
  creds: Record<string, unknown> | undefined,
): string {
  const resolved = input.countryOfManufacture;
  if (typeof resolved === 'string' && /^[A-Za-z]{2}$/.test(resolved.trim())) {
    return resolved.trim().toUpperCase();
  }
  const configured = creds?.packageOriginCountry;
  if (typeof configured === 'string' && /^[A-Za-z]{2}$/.test(configured.trim())) {
    return configured.trim().toUpperCase();
  }
  return 'US';
}

function shippRefNumber(input: Record<string, unknown>): string | undefined {
  const rawOrder = input.rawOrder as any;
  const candidates = [
    input.orderNumber,
    input.externalOrderId,
    rawOrder?.purchaseOrderId,
    rawOrder?.orderId,
    rawOrder?.OrderId,
    rawOrder?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) return value.slice(0, 80);
  }
  return undefined;
}

function shippHasRawShipTo(rawOrder: any): boolean {
  if (!rawOrder) return false;
  if (rawOrder?.shippingInfo?.postalAddress) return true;
  if (Array.isArray(rawOrder?.fulfillmentStartInstructions)
    && rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo) return true;
  if (rawOrder?.ShippingAddress) return true;
  if (rawOrder?.shipTo || rawOrder?.ship_to) return true;
  return false;
}

function shippShipTo(rawOrder: any, toZip?: string, explicitShipTo?: any, residential?: boolean) {
  const wmAddr = rawOrder?.shippingInfo?.postalAddress ?? null;
  const ebayContact = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const ebayAddr = ebayContact?.contactAddress ?? null;
  const amazonAddr = rawOrder?.ShippingAddress ?? null;
  const ssAddr = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const explicit = explicitShipTo && typeof explicitShipTo === 'object' ? explicitShipTo : null;
  const addr = explicit ?? wmAddr ?? ebayAddr ?? amazonAddr ?? ssAddr;
  const postalCode = String(
    addr?.postalCode ??
      addr?.zip ??
      addr?.PostalCode ??
      addr?.postal_code ??
      toZip ??
      '94601',
  ).replace(/[^0-9-]/g, '').slice(0, 10);

  return {
    name: String(
      addr?.name ??
        ebayContact?.fullName ??
        addr?.Name ??
        ssAddr?.name ??
        'Buyer',
    ),
    phone: String(
      addr?.phone ??
        rawOrder?.shippingInfo?.phone ??
        ebayContact?.primaryPhone?.phoneNumber ??
        addr?.Phone ??
        ssAddr?.phone ??
        '0000000000',
    ),
    company_name: String(addr?.company ?? ebayContact?.companyName ?? addr?.CompanyName ?? ''),
    address_line1: String(
      addr?.street1 ??
        addr?.address1 ??
        addr?.addressLine1 ??
        addr?.AddressLine1 ??
        ssAddr?.street1 ??
        '1 Main St',
    ),
    address_line2: String(
      addr?.street2 ??
        addr?.address2 ??
        addr?.addressLine2 ??
        addr?.AddressLine2 ??
        ssAddr?.street2 ??
        '',
    ) || null,
    city_locality: String(addr?.city ?? addr?.City ?? ssAddr?.city ?? 'Oakland'),
    state_province: String(
      addr?.state ??
        addr?.stateOrProvince ??
        addr?.StateOrRegion ??
        ssAddr?.state ??
        'CA',
    ),
    postal_code: postalCode || '94601',
    country_code: String(addr?.country ?? addr?.countryCode ?? addr?.CountryCode ?? ssAddr?.country ?? 'US'),
    // PS-127: honor the backend-resolved residential (commercial only on a trusted signal);
    // default residential-safe ('yes') when unknown, matching prior behavior.
    address_residential_indicator: residential === false ? 'no' : 'yes',
  };
}

function shippShipFrom(
  creds: Record<string, unknown>,
  input: { fromZip?: unknown; shipFrom?: any },
) {
  // Canonical origin (was camelCase reads → undefined → Carson default).
  const a = readShipFrom(input.shipFrom as Record<string, unknown>, creds, input.fromZip);
  return {
    name: a.name,
    phone: a.phone,
    company_name: a.company,
    address_line1: a.line1,
    address_line2: a.line2 || null,
    city_locality: a.city,
    state_province: a.state,
    postal_code: a.postalCode,
    country_code: a.country,
  };
}

async function shippLogin(
  creds: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ apiKey: string; cookieHeader: string; email: string }> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const email = String(creds?.email ?? '').trim();
  const password = String(creds?.password ?? '').trim();
  if (!apiKey || !email || !password) {
    throw new Error('Shipp requires apiKey, email, and password on the carrier account credentials.');
  }

  const res = await timedFetch('shipp.login', 'https://shipp.to/api/supabase/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ email, password }),
    signal,
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!res.ok) {
    throw new Error(`Shipp login ${res.status}: ${text.slice(0, 600) || res.statusText}`);
  }

  const cookieHeader = shippCookieHeaderFrom(res, data);
  if (!cookieHeader) {
    throw new Error('Shipp login succeeded but did not return a session cookie.');
  }

  return { apiKey, cookieHeader, email };
}

/**
 * PS-083 — the declared value Shipp insures the shipment for, mapped from the
 * request's normalized insurance options into packageLineItems[].customsValue.
 * Shipp's API accepts the insured/declared value on the PackageLineItem
 * (customsValue); previously this was hard-coded to 0, so HUGRAB's $100 was
 * never declared. Returns 0 when the order is not insured or the value is
 * missing/invalid so we never declare a phantom value.
 */
export function shippDeclaredValue(options: {
  insuranceProvider?: string | null;
  insuredValue?: number | null;
}): number {
  if (!options || options.insuranceProvider == null || options.insuranceProvider === 'none') {
    return 0;
  }
  const value = Number(options.insuredValue);
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : 0;
}

function shippCustomsValue(options: {
  insuranceProvider?: string | null;
  insuredValue?: number | null;
}): { amount: number; currency: 'USD' } {
  return { amount: shippDeclaredValue(options), currency: 'USD' };
}

// PS-271 (Layer 1): the carriers a non-empty Shipp 200 actually returned (normalized lowercase),
// used to decide whether an observed-expected carrier is missing (a "thin" response).
function shippReturnedCarriers(rateList: any[]): string[] {
  const carriers = new Set<string>();
  for (const rate of rateList) {
    const code = shippCarrierCode(shippRawCarrier(rate));
    const normalized = normalizeObservedCarrier(code);
    if (normalized) carriers.add(normalized);
  }
  return [...carriers];
}

// PS-271 (Layer 1): a stable per-shipment lane fingerprint for the durable negative-memory cooldown.
// Keyed on the shipment facts that determine the carrier set (weight/dims/destination), NOT the
// account — the account is a separate key column.
function shippLaneFingerprint(input: Record<string, unknown>): string {
  return [
    Math.round(Number(input.weightOz ?? 0)),
    Number(input.dimsL ?? 0),
    Number(input.dimsW ?? 0),
    Number(input.dimsH ?? 0),
    String(input.toZip ?? '').replace(/\D/g, '').slice(0, 5),
    input.residential === false ? 'com' : 'res',
  ].join('|');
}

// PS-271 (Layer 1): resolve the OBSERVED-recently expected carrier set for this account+lane. Prefers
// an explicitly injected set (used by the offline behavioral guard — no DB) and otherwise reads the
// durable cache. Returns [] when the feature can't derive an expectation cheaply, which the caller
// treats as "no retry" (fail-safe to today's behavior).
async function shippResolveObservedSet(
  input: Record<string, unknown>,
  ref: { accountId: number | null; sourceTable: string | null; requestKey: string | null; laneFingerprint: string },
): Promise<string[]> {
  const injected = (input as any).shippObservedCarriers;
  if (Array.isArray(injected)) {
    return injected.map(normalizeObservedCarrier).filter(Boolean);
  }
  return readObservedCarriers(ref).catch(() => []);
}

async function quoteShippRatesRaw(input: Record<string, unknown>): Promise<{
  session: { apiKey: string; cookieHeader: string };
  rates: any[];
  // PS-271 (Layer 4): the observed-expected carriers STILL missing when Layer 1 accepted a thin
  // partial at the cap. [] in every other case (flag OFF, complete set, or transient retry). Default
  // EMPTY — Layer 1 only fills this when the per-account opt-in ran and accepted a known-thin pass.
  observedMissing: string[];
}> {
  const signal = input.signal as AbortSignal | undefined;
  // PS-083 — Shipp now supports declaring an insured value via the
  // PackageLineItem customsValue, so insured orders (e.g. HUGRAB $100) are
  // accepted instead of being dropped. Capture the normalized options the gate
  // returns so the declared value stays in lockstep with what was validated.
  const shippingOptions = assertUnsupportedShippingOptions('Shipp', input, { confirmation: ['delivery', 'none'], insurance: true });
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('Shipp rate quotes require box dimensions (length, width, height).');
  }

  const session = await shippLogin(creds, signal);
  const from = shippShipFrom(creds, { fromZip: input.fromZip, shipFrom: input.shipFrom });
  const rawOrder = input.rawOrder as any;
  const to = shippShipTo(
    rawOrder,
    String(input.toZip ?? ''),
    input.shipTo,
    typeof input.residential === 'boolean' ? input.residential : undefined,
  );
  const hasRawShipTo = shippHasRawShipTo(rawOrder);
  const toZipPlace = await shippLookupUsZip(to.postal_code, signal);
  // Was the city/state EXPLICITLY provided (vs defaulted)? Read the canonical Address
  // snake_case (city_locality/state_province) + creds — NOT camelCase shipFrom.city.
  const sfRaw = (input.shipFrom ?? {}) as Record<string, unknown>;
  const fromHasExplicitCity = Boolean(shippFirstString(creds?.shipFromCity, sfRaw.city_locality));
  const fromHasExplicitState = Boolean(shippFirstString(creds?.shipFromState, sfRaw.state_province));
  const fromZipPlace = (!fromHasExplicitCity || !fromHasExplicitState)
    ? await shippLookupUsZip(from.postal_code, signal)
    : {};
  const weightLb = Math.max(0.01, Math.round((Number(input.weightOz || 16) / 16) * 100) / 100);
  const refNumber = shippRefNumber(input);

  const shippingInfo: Record<string, unknown> = {
    fromCompanyName: shippRequiredString(from.company_name, shippRequiredString(from.name, 'Seller')),
    fromName: shippRequiredString(from.name, 'Seller'),
    fromStreet1: shippRequiredString(from.address_line1, 'Warehouse'),
    fromStreet2: String(from.address_line2 ?? ''),
    fromCity: shippRequiredString(fromHasExplicitCity ? from.city_locality : shippFirstString(fromZipPlace.city, from.city_locality), 'Carson'),
    fromState: shippRequiredString(fromHasExplicitState ? from.state_province : shippFirstString(fromZipPlace.state, from.state_province), 'CA').slice(0, 2).toUpperCase(),
    fromZipcode: shippRequiredString(from.postal_code, '90248'),
    fromCountry: shippCountryCode(from.country_code),
    fromPhone: shippRequiredString(from.phone, '0000000000'),
    fromIsResidential: shippBool(creds?.shipFromIsResidential, false),
    toCompanyName: String(to.company_name ?? ''),
    toName: shippRequiredString(hasRawShipTo ? to.name : shippFirstString(input.toName, to.name), 'Buyer'),
    toStreet1: shippRequiredString(hasRawShipTo ? to.address_line1 : shippFirstString(input.toAddress, to.address_line1), '1 Main St'),
    toStreet2: String(to.address_line2 ?? ''),
    toCity: shippRequiredString(hasRawShipTo ? to.city_locality : shippFirstString(input.toCity, toZipPlace.city, to.city_locality), 'Oakland'),
    toState: shippRequiredString(hasRawShipTo ? to.state_province : shippFirstString(input.toState, toZipPlace.state, to.state_province), 'CA').slice(0, 2).toUpperCase(),
    toZipcode: shippRequiredString(to.postal_code, String(input.toZip ?? '94601')),
    toCountry: shippCountryCode(hasRawShipTo ? to.country_code : shippFirstString(input.toCountry, to.country_code)),
    toPhone: shippRequiredString(to.phone, '0000000000'),
    toIsResidential: shippBool(creds?.toIsResidential, true),
    requireSignature: shippBool(creds?.requireSignature, false),
    shipDate: new Date().toISOString().slice(0, 10),
  };
  if (refNumber) shippingInfo.refNumber = refNumber;

  const body = {
    shippingInfo,
    packageLineItems: [
      {
        weight: { value: weightLb },
        dimensions: {
          length: Number(input.dimsL),
          width: Number(input.dimsW),
          height: Number(input.dimsH),
        },
        description: String(creds?.packageDescription ?? 'Merchandise'),
        itemDescription: String(creds?.packageDescription ?? 'Merchandise'),
        // PS-083 — declare the insured value here (Shipp reads customsValue as
        // the declared/insured amount). 0 when the order is not insured.
        customsValue: shippCustomsValue(shippingOptions),
        // PS-494 — was hardcoded 'US'. Country of origin is a declarable customs fact and
        // a property of the ITEM, not of the business: PrepShip is a 3PL, and 22 of the
        // 333 customs line items ShipStation has recorded are KR or CN client goods.
        // The backend resolves it (customs-origin.ts); this only applies the operator's
        // configured default when the order carries no single agreed origin.
        countryOfManufacture: shippCountryOfManufacture(input, creds),
      },
    ],
  };

  // PS-271 (Layer 1): observed-set thin-response retry context. DEFAULT OFF — when the per-account
  // opt-in flag is absent, `observedRetryOn` is false and the loop below behaves EXACTLY like today
  // (single POST + transient retry only; no observed-set logic, no extra POST, no DB read).
  const observedRetryOn = shippObservedRetryEnabled(creds);
  const observedRef = {
    accountId: typeof input.directCarrierAccountId === 'number' ? input.directCarrierAccountId : null,
    sourceTable: typeof input.directCarrierSourceTable === 'string' ? input.directCarrierSourceTable : null,
    requestKey: typeof input.requestKey === 'string' ? input.requestKey : null,
    laneFingerprint: shippLaneFingerprint(input),
  };
  const expectedCarriers = observedRetryOn ? await shippResolveObservedSet(input, observedRef) : [];

  let lastQuoteError: Error | null = null;
  for (let attempt = 1; attempt <= SHIPP_QUOTE_MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    // PS-271 (Layer 1): route /quote through a per-provider token bucket (Shipp /quote bypasses the
    // global limiter today). Only runs when the observed-set feature is opted in, so the OFF path is
    // unchanged. Bounds /quote burst; the login floor is untouched.
    if (observedRetryOn) await acquireShippQuoteBudget(signal);
    try {
      res = await timedFetch(attempt > 1 ? 'shipp.rates.retry' : 'shipp.rates', 'https://shipp.to/api/shipping/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': session.apiKey,
          Cookie: session.cookieHeader,
        },
        body: JSON.stringify(body),
        signal,
      }, { attempt });
    } catch (err) {
      lastQuoteError = err instanceof Error ? err : new Error(String(err));
      if (attempt < SHIPP_QUOTE_MAX_ATTEMPTS) {
        await shippSleep(500, signal);
        continue;
      }
      throw new Error(`Shipp quote failed after retry: ${lastQuoteError.message}`);
    }

    const text = await res.text().catch(() => '');
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
    if (!res.ok) {
      lastQuoteError = new Error(`Shipp quote ${res.status}: ${text.slice(0, 800) || res.statusText}`);
      if (attempt < SHIPP_QUOTE_MAX_ATTEMPTS && shippShouldRetryQuoteStatus(res.status)) {
        await shippSleep(500, signal);
        continue;
      }
      if (attempt > 1 && shippShouldRetryQuoteStatus(res.status)) {
        throw new Error(`Shipp quote failed after retry: ${lastQuoteError.message}`);
      }
      throw lastQuoteError;
    }

    const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];
    if (rateList.length === 0) {
      // PRESERVED EXACTLY: an empty 200 is still a hard error (accept-partial is ONLY for the
      // non-empty-but-thin case below). Do NOT weaken this.
      const errors = Array.isArray(data?.errors) && data.errors.length
        ? ` Carrier errors: ${JSON.stringify(data.errors).slice(0, 500)}`
        : '';
      throw new Error(`Shipp returned 0 rates for this shipment.${errors}`);
    }

    // PS-271 (Layer 1): observed-set thin-response retry. ONLY runs when opted in. On a NON-EMPTY 200
    // where an observed-expected carrier is missing, re-ask once (within the SHARED attempt cap, and
    // only if not in negative-memory cooldown). After the cap, ACCEPT the partial — we NEVER throw on
    // a non-empty-but-thin response; a real (cheaper) rate that came back is always better than an
    // error. The 31oz #1502 case: pass 1 returns FedEx-only while {ups,fedex} is expected -> re-ask;
    // pass 2 returns UPS+FedEx -> complete (or, if still FedEx-only at the cap, accept FedEx + start
    // the cooldown so we don't hammer Shipp next quote).
    if (observedRetryOn && expectedCarriers.length) {
      const missing = missingObservedCarriers(expectedCarriers, shippReturnedCarriers(rateList));
      if (missing.length && attempt < SHIPP_QUOTE_MAX_ATTEMPTS) {
        const inCooldown = await isQuoteInCooldown(observedRef, missing[0]!).catch(() => false);
        if (!inCooldown) {
          lastQuoteError = new Error(
            `Shipp returned a thin rate set (missing ${missing.join(',')}); re-asking before the cap.`,
          );
          if (SHIPP_THIN_RETRY_BACKOFF_MS > 0) await shippSleep(SHIPP_THIN_RETRY_BACKOFF_MS, signal);
          continue;
        }
      } else if (missing.length) {
        // At the cap and STILL missing an observed carrier — accept the partial but start the durable
        // cooldown so the next quote this window doesn't re-ask (fleet-safe negative memory).
        await recordQuoteCooldown(observedRef, missing[0]!).catch(() => {});
        // PS-271 (Layer 4): surface the accepted-thin partial HONESTLY alongside the (unchanged) rates
        // so downstream completeness/display can mark it thin/unproven. Only reachable when Layer 1 ran
        // (per-account opt-in ON) AND accepted a known-thin pass — OFF path never sets this.
        return { session, rates: rateList, observedMissing: missing };
      }
    }

    return { session, rates: rateList, observedMissing: [] };
  }

  throw lastQuoteError ?? new Error('Shipp quote failed after retry.');
}

// PS-274: read the request's insured value/provider for the certainty fact. The connector input
// carries the normalized shippingOptions (rates.ts) and the flat fields (labels path); read either.
function shippInsuranceContext(input: Record<string, unknown>): { insuranceProvider: string | null; insuredValue: number | null } {
  const opts = (input.shippingOptions && typeof input.shippingOptions === 'object'
    ? input.shippingOptions
    : input) as Record<string, unknown>;
  const insuranceProvider = opts.insuranceProvider != null ? String(opts.insuranceProvider) : null;
  const rawValue = Number(opts.insuredValue);
  return {
    insuranceProvider,
    insuredValue: Number.isFinite(rawValue) ? rawValue : null,
  };
}

async function ratesFromShipp(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const { rates: rateList, observedMissing } = await quoteShippRatesRaw(input);
  // PS-274: the declared value we will request via customsValue, mapped through the SAME owner the
  // body uses. Drives the per-rate certainty tag — Shipp is brokered, so a declared value can only be
  // 'requested_application_uncertain' (never carrier_declared_value/explicitly_included).
  const shippInsurance = shippInsuranceContext(input);
  const declaredValue = shippDeclaredValue(shippInsurance);
  const mapped = rateList
    .map((r: any) => {
      const rawCarrier = r?.carrierType ?? r?.carrier ?? r?.carrierCode ?? r?.carrierName;
      const carrierCode = shippCarrierCode(rawCarrier);
      const carrierName = shippCarrierName(rawCarrier);
      const serviceName = String(r?.serviceName ?? r?.serviceType ?? 'Shipp').trim();
      const serviceCode = shippServiceCodeForRate(r);
      // PS-274: identity-first certainty — provider 'shipp' + the `shipp_` service code mark this as
      // brokered. isDirectVerifiedAccount is FALSE for every Shipp rate (Shipp has no direct verified
      // carrier contract on PrepShip's side), so declared value -> uncertain, none -> not_included.
      const insuranceCertainty = resolveInsuranceCertainty({
        provider: 'shipp',
        serviceCode,
        insuredValue: declaredValue,
        isDirectVerifiedAccount: false,
      });
      return {
        service: serviceName,
        carrierCode,
        carrierName,
        carrierType: rawCarrier ? String(rawCarrier).trim() : null,
        cost: Number(r?.price ?? 0),
        price: Number(r?.price ?? 0),
        days: shippDateDays(r?.deliveryDate, r?.deliveryDay),
        currency: 'USD',
        quoted_shipment_id: r?.quoted_shipment_id,
        serviceType: r?.serviceType,
        serviceName,
        serviceCode,
        deliveryDate: r?.deliveryDate,
        deliveryDay: r?.deliveryDay,
        // PS-274: backend-owned certainty fact rides onto the rate (toDirectRate spreads it onto the
        // canonical Rate; the Rate Browser renders the tag). Display/honesty only — never blocks.
        insuranceCertainty,
      };
    })
    .filter((r) => r.cost > 0)
    .sort((a, b) => a.cost - b.cost);
  // PS-271 (Layer 4): ride a NON-ENUMERABLE thin-source marker on the returned array. The array's
  // enumerable contents (JSON/spread/map/keys) are byte-identical to today; only quoteCarrierRates,
  // which explicitly reads the marker, sees it. attachObservedIncomplete is a no-op when nothing is
  // missing — so the flag-OFF path returns the exact same array shape as before this change.
  return attachObservedIncomplete(mapped, observedMissing);
}

function shippRawCarrier(rate: any): unknown {
  return rate?.carrierType ?? rate?.carrier ?? rate?.carrierCode ?? rate?.carrierName;
}

function shippRateServiceName(rate: any): string {
  return String(rate?.serviceName ?? rate?.serviceType ?? 'Shipp').trim();
}

function shippSlugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function shippServiceCodeForRate(rate: any): string {
  const carrierCode = shippCarrierCode(shippRawCarrier(rate));
  const carrierPrefix = carrierCode && carrierCode !== 'shipp' ? `${carrierCode}_` : '';
  return `shipp_${carrierPrefix}${shippSlugRateService(shippRateServiceName(rate))}`;
}

function selectShippRate(rates: any[], requestedServiceCode: unknown): any {
  const wanted = String(requestedServiceCode ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const sorted = [...rates]
    .filter((rate) => Number(rate?.price ?? 0) > 0)
    .sort((a, b) => Number(a?.price ?? 0) - Number(b?.price ?? 0));
  const exact = sorted.find((rate) => shippServiceCodeForRate(rate) === wanted);
  if (exact) return exact;

  const wantedSlug = wanted.replace(/^shipp_/, '');
  const fuzzy = sorted.find((rate) => {
    const carrierCode = shippCarrierCode(shippRawCarrier(rate));
    const serviceSlug = shippSlugRateService(shippRateServiceName(rate));
    return wantedSlug === serviceSlug || wantedSlug === `${carrierCode}_${serviceSlug}`;
  });
  if (fuzzy) return fuzzy;

  throw new Error(`Shipp did not return the selected service ${String(requestedServiceCode ?? '')}. Please browse rates again.`);
}

function shippTrackingFromLabel(label: any): string {
  return String(
    label?.data?.tracking_number ??
      label?.tracking_number ??
      label?.ShipmentResponse?.ShipmentResults?.ShipmentIdentificationNumber ??
      label?.output?.transactionShipments?.[0]?.masterTrackingNumber ??
      '',
  );
}

// 4×6 @72dpi. The page-size literal stays here (pinned by the PS-099 static 4x6 guard); PS-294 moved
// only the duplicated PLACEMENT MATH out to shipp-label-4x6-placement.ts (the single graft point),
// and feeds these dims in as the target so addPage and the placement can never diverge.
const SHIPP_LABEL_PAGE_WIDTH = 288;
const SHIPP_LABEL_PAGE_HEIGHT = 432;

function shippPngBytesFromGifBytes(gifBytes: Uint8Array): Uint8Array {
  const reader = new GifReader(gifBytes);
  if (!reader.numFrames()) {
    throw new Error('Shipp GIF label contained no frames.');
  }
  const rgba = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  const rgbaBuffer = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  return new Uint8Array(UPNG_API.encode([rgbaBuffer], reader.width, reader.height, 0));
}

function shippPdfDataUrl(bytes: Uint8Array): string {
  return `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function appendShippPdfPages(output: PDFDocument, bytes: Uint8Array): Promise<number> {
  const src = await PDFDocument.load(bytes);
  // PS-294 slice 2: delegate to B's PS-287 content-aware normalizer instead of a whole-page contain-fit.
  // It crops each page to its visible artwork bounds (deriveArtworkBounds) and scales that to FILL the
  // 4×6 canvas (placeArtworkOnCanvas), so an oversized / corner-positioned SHIPP or FedEx label fills
  // 4×6 instead of shrinking. A rotated page is copied as-is so its orientation is never altered.
  const before = output.getPageCount();
  await appendNormalizedLabelPages(output, src);
  return output.getPageCount() - before;
}

async function appendShippImagePage(output: PDFDocument, bytes: Uint8Array, format: string): Promise<number> {
  const image = format === 'image/png' || format === 'png'
    ? await output.embedPng(bytes)
    : await output.embedPng(shippPngBytesFromGifBytes(bytes));
  const placement = computeFourBySixPlacement({ srcWidth: image.width, srcHeight: image.height, targetWidth: SHIPP_LABEL_PAGE_WIDTH, targetHeight: SHIPP_LABEL_PAGE_HEIGHT });
  const page = output.addPage([SHIPP_LABEL_PAGE_WIDTH, SHIPP_LABEL_PAGE_HEIGHT]);
  page.drawImage(image, {
    x: placement.x,
    y: placement.y,
    width: placement.drawWidth,
    height: placement.drawHeight,
  });
  return 1;
}

async function pdfDataUrlFromParts(parts: Array<{ base64: string; format?: string }>): Promise<string | null> {
  const pdf = await PDFDocument.create();
  let pages = 0;

  for (const part of parts) {
    const base64 = String(part.base64 ?? '').trim();
    if (!base64) continue;
    const format = String(part.format ?? 'application/pdf').toLowerCase();
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (format === 'application/pdf' || format === 'pdf') {
      pages += await appendShippPdfPages(pdf, bytes);
    } else if (format === 'image/png' || format === 'png') {
      pages += await appendShippImagePage(pdf, bytes, format);
    } else if (format === 'image/gif' || format === 'gif') {
      pages += await appendShippImagePage(pdf, bytes, format);
    }
  }

  if (!pages) return null;
  const merged = await pdf.save();
  return shippPdfDataUrl(merged);
}

async function shippLabelUrl(label: any, carrierCode: string | null): Promise<string | null> {
  if (label?.data?.packages) {
    const parts = (Array.isArray(label.data.packages) ? label.data.packages : [])
      .map((pkg: any) => ({
        base64: String(pkg?.label ?? ''),
        format: String(pkg?.label_format ?? 'application/pdf'),
      }));
    return pdfDataUrlFromParts(parts);
  }

  if (carrierCode === 'fedex' && label?.output?.transactionShipments?.[0]?.pieceResponses) {
    const docs = label.output.transactionShipments[0].pieceResponses
      .flatMap((piece: any) => Array.isArray(piece?.packageDocuments) ? piece.packageDocuments : [])
      .map((doc: any) => ({
        base64: String(doc?.encodedLabel ?? ''),
        format: 'application/pdf',
      }));
    return pdfDataUrlFromParts(docs);
  }

  if (carrierCode === 'ups' && label?.ShipmentResponse?.ShipmentResults?.PackageResults) {
    const packages = Array.isArray(label.ShipmentResponse.ShipmentResults.PackageResults)
      ? label.ShipmentResponse.ShipmentResults.PackageResults
      : [label.ShipmentResponse.ShipmentResults.PackageResults];
    const parts = packages
      .map((pkg: any) => ({
        base64: String(pkg?.ShippingLabel?.GraphicImage ?? ''),
        format: 'image/gif',
      }));
    return pdfDataUrlFromParts(parts);
  }

  return null;
}

export const __test_normalizeShippLabelPartsToPdfDataUrl = pdfDataUrlFromParts;
export const __test_shippLabelUrl = shippLabelUrl;

async function createLabelShipp(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('Shipp label creation requires box dimensions (length, width, height).');
  }

  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const labelShippingOptions = assertUnsupportedShippingOptions('Shipp', input, { confirmation: ['delivery', 'none'], insurance: true });
  const { session, rates } = await quoteShippRatesRaw(input);
  const selectedRate = selectShippRate(rates, input.serviceCode);
  const quotedShipmentId = String(selectedRate?.quoted_shipment_id ?? '').trim();
  if (!quotedShipmentId) {
    throw new Error('Shipp selected rate is missing quoted_shipment_id. Please browse rates again.');
  }

  const serviceType = String(selectedRate?.serviceType ?? selectedRate?.serviceName ?? '').trim();
  if (!serviceType) {
    throw new Error('Shipp selected rate is missing serviceType. Please browse rates again.');
  }

  const labelRes = await timedFetch('shipp.labels', 'https://shipp.to/api/shipping/label/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': session.apiKey,
      Cookie: session.cookieHeader,
    },
    body: JSON.stringify({
      quoted_shipment_id: quotedShipmentId,
      serviceType,
      saturdayDelivery: /saturday/i.test(shippRateServiceName(selectedRate)),
      customsValue: shippCustomsValue(labelShippingOptions),
    }),
    signal: input.signal as AbortSignal | undefined,
  });
  const text = await labelRes.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!labelRes.ok) {
    throw new Error(`Shipp label ${labelRes.status}: ${text.slice(0, 800) || labelRes.statusText}`);
  }

  const label = data?.label ?? data;
  const carrierCode = shippCarrierCode(shippRawCarrier(selectedRate));
  const carrierName = shippCarrierName(shippRawCarrier(selectedRate));
  const trackingNumber = shippTrackingFromLabel(label);
  const labelUrl = await shippLabelUrl(label, carrierCode);
  const serviceCode = shippServiceCodeForRate(selectedRate);

  if (!trackingNumber) {
    throw new Error('Shipp created a label but did not return a tracking number.');
  }
  if (!labelUrl) {
    throw new Error('Shipp created a label but PrepShip could not read the label PDF.');
  }

  return {
    trackingNumber,
    labelUrl,
    cost: Number(selectedRate?.price ?? 0),
    currency: 'USD',
    shipmentId: quotedShipmentId,
    carrierCode,
    carrierName,
    serviceName: shippRateServiceName(selectedRate),
    serviceCode,
    selectedRate,
    deliveryDays: shippDateDays(selectedRate?.deliveryDate, selectedRate?.deliveryDay),
    raw: data,
  };
}

export function createShippCarrierConnector(): CarrierConnector {
  return {
    provider: 'shipp',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromShipp,
    createLabel: createLabelShipp,
  };
}

export const shippCarrierConnector = createShippCarrierConnector();
