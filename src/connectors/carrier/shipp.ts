import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

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

async function shippLookupUsZip(zip: unknown): Promise<{ city?: string; state?: string }> {
  const five = String(zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (!/^\d{5}$/.test(five)) return {};
  const cached = shippZipCache.get(five);
  if (cached) return cached;

  try {
    const res = await timedFetch('shipp.zip-lookup', `https://api.zippopotam.us/us/${five}`, {
      headers: { Accept: 'application/json' },
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

function shippShipTo(rawOrder: any, toZip?: string) {
  const wmAddr = rawOrder?.shippingInfo?.postalAddress ?? null;
  const ebayContact = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const ebayAddr = ebayContact?.contactAddress ?? null;
  const amazonAddr = rawOrder?.ShippingAddress ?? null;
  const ssAddr = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const addr = wmAddr ?? ebayAddr ?? amazonAddr ?? ssAddr;
  const postalCode = String(
    addr?.postalCode ??
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
      rawOrder?.shippingInfo?.phone ??
        ebayContact?.primaryPhone?.phoneNumber ??
        addr?.Phone ??
        ssAddr?.phone ??
        '0000000000',
    ),
    company_name: String(addr?.company ?? ebayContact?.companyName ?? addr?.CompanyName ?? ''),
    address_line1: String(
      addr?.address1 ??
        addr?.addressLine1 ??
        addr?.AddressLine1 ??
        ssAddr?.street1 ??
        '1 Main St',
    ),
    address_line2: String(
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
  };
}

function shippShipFrom(
  creds: Record<string, unknown>,
  input: { fromZip?: unknown; shipFrom?: any },
) {
  const shipFromInput = input.shipFrom && typeof input.shipFrom === 'object' ? input.shipFrom : {};
  const fromZip = String(
    creds?.shipFromZip ??
      shipFromInput?.postalCode ??
      input.fromZip ??
      '90248',
  ).replace(/[^0-9-]/g, '').slice(0, 10);
  return {
    name: String(creds?.shipFromName ?? shipFromInput?.name ?? 'Seller'),
    phone: String(creds?.shipFromPhone ?? shipFromInput?.phone ?? '0000000000'),
    company_name: String(creds?.shipFromCompany ?? creds?.shipFromName ?? shipFromInput?.name ?? ''),
    address_line1: String(
      creds?.shipFromAddress1 ??
        shipFromInput?.addressLine1 ??
        shipFromInput?.street1 ??
        'Warehouse',
    ),
    address_line2: String(
      creds?.shipFromAddress2 ??
        shipFromInput?.addressLine2 ??
        shipFromInput?.street2 ??
        '',
    ) || null,
    city_locality: String(creds?.shipFromCity ?? shipFromInput?.city ?? 'Carson'),
    state_province: String(creds?.shipFromState ?? shipFromInput?.state ?? 'CA'),
    postal_code: fromZip || '90248',
    country_code: String(shipFromInput?.country ?? 'US') || 'US',
  };
}

async function shippLogin(creds: Record<string, unknown>): Promise<{ apiKey: string; cookieHeader: string; email: string }> {
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

async function ratesFromShipp(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  if (!input.dimsL || !input.dimsW || !input.dimsH) {
    throw new Error('Shipp rate quotes require box dimensions (length, width, height).');
  }

  const session = await shippLogin(creds);
  const from = shippShipFrom(creds, { fromZip: input.fromZip, shipFrom: input.shipFrom });
  const rawOrder = input.rawOrder as any;
  const to = shippShipTo(rawOrder, String(input.toZip ?? ''));
  const hasRawShipTo = shippHasRawShipTo(rawOrder);
  const toZipPlace = await shippLookupUsZip(to.postal_code);
  const shipFrom = input.shipFrom as any;
  const fromHasExplicitCity = Boolean(shippFirstString(creds?.shipFromCity, shipFrom?.city));
  const fromHasExplicitState = Boolean(shippFirstString(creds?.shipFromState, shipFrom?.state));
  const fromZipPlace = (!fromHasExplicitCity || !fromHasExplicitState)
    ? await shippLookupUsZip(from.postal_code)
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
        customsValue: { amount: 0, currency: 'USD' },
        countryOfManufacture: 'US',
      },
    ],
  };

  const res = await timedFetch('shipp.rates', 'https://shipp.to/api/shipping/quote', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': session.apiKey,
      Cookie: session.cookieHeader,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text fallback */ }
  if (!res.ok) {
    throw new Error(`Shipp quote ${res.status}: ${text.slice(0, 800) || res.statusText}`);
  }

  const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];
  if (rateList.length === 0) {
    const errors = Array.isArray(data?.errors) && data.errors.length
      ? ` Carrier errors: ${JSON.stringify(data.errors).slice(0, 500)}`
      : '';
    throw new Error(`Shipp returned 0 rates for this shipment.${errors}`);
  }

  return rateList
    .map((r: any) => {
      const rawCarrier = r?.carrierType ?? r?.carrier ?? r?.carrierCode ?? r?.carrierName;
      const carrierCode = shippCarrierCode(rawCarrier);
      const carrierName = shippCarrierName(rawCarrier);
      const serviceName = String(r?.serviceName ?? r?.serviceType ?? 'Shipp').trim();
      return {
        service: serviceName,
        carrierCode,
        carrierName,
        carrierType: rawCarrier ? String(rawCarrier).trim() : null,
        cost: Number(r?.price ?? 0),
        days: shippDateDays(r?.deliveryDate, r?.deliveryDay),
        currency: 'USD',
      };
    })
    .filter((r) => r.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

export function createShippCarrierConnector(): CarrierConnector {
  return {
    provider: 'shipp',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromShipp,
    createLabel: async () => {
      throw new Error('Shipp labels are handled by api/carriers/labels.ts');
    },
  };
}

export const shippCarrierConnector = createShippCarrierConnector();
