import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { timedFetch } from '../../lib/http/timing.js';
import { assertUnsupportedShippingOptions } from './shipping-option-support.js';
import { resolveWalmartShipFrom } from './walmart-ship-from.js';

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

async function getWalmartAccessToken(creds: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const clientId = firstString(creds.clientId, creds.client_id, creds.consumerId, creds.consumer_id);
  const clientSecret = firstString(creds.clientSecret, creds.client_secret, creds.privateKey, creds.private_key);
  if (!clientId || !clientSecret) {
    throw new Error('Walmart clientId and clientSecret are required');
  }
  const channelType = firstString(creds.channelType, creds.channel_type);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'WM_SVC.NAME': firstString(creds.serviceName, creds.service_name, 'Walmart Marketplace'),
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  const res = await timedFetch('walmart-shipping.token', 'https://marketplace.walmartapis.com/v3/token', {
    method: 'POST',
    headers,
    body: 'grant_type=client_credentials',
    signal,
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`Walmart OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data?.access_token) throw new Error('Walmart OAuth response missing access_token');
  return data.access_token;
}

function toWalmartIsoDate(value: unknown, fallbackDays: number): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(Date.now() + fallbackDays * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeProviderKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function slugRateService(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'rate';
}

function normalizeCarrierCodeForDirectRate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = normalizeProviderKey(raw);
  const compact = normalized.replace(/[^a-z0-9]+/g, '');
  if (compact.includes('fedex')) return 'fedex';
  if (compact.includes('usps') || compact.includes('postal')) return 'stamps_com';
  if (compact.includes('ups')) return 'ups';
  if (compact.includes('dhl')) return 'dhl_express';
  if (compact.includes('walmart')) return 'walmart_shipping';
  if (compact.includes('amazon')) return 'amazon_shipping';
  if (compact.includes('ebay')) return 'ebay_shipping';
  return normalized || null;
}

function inferCarrierCodeForDirectRate(provider: string, service: string): string {
  const p = normalizeProviderKey(provider);
  const s = service.toLowerCase();
  if (s.includes('usps') || s.includes('postal')) return 'stamps_com';
  if (s.includes('fedex')) return 'fedex';
  if (s.includes('ups')) return 'ups';
  if (s.includes('dhl')) return 'dhl_express';
  return p || 'direct_carrier';
}

function walmartMarketplaceHeaders(
  creds: Record<string, unknown>,
  token: string,
  accept = 'application/json',
  includeJsonContentType = false,
): Record<string, string> {
  const channelType = firstString(creds.channelType, creds.channel_type);
  const partnerId = firstString(creds.partnerId, creds.sellerId);
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'WM_SVC.NAME': firstString(creds.serviceName, creds.service_name, 'Walmart Marketplace'),
    'WM_MARKET': 'us',
    Accept: accept,
  };
  if (includeJsonContentType) headers['Content-Type'] = 'application/json';
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  if (partnerId) headers['WM_PARTNER.ID'] = partnerId;
  return headers;
}

export async function probeWalmartShippingCarriers(creds: Record<string, unknown>): Promise<{
  ok: boolean;
  step_a_oauth: 'success';
  step_b_carriers_endpoint: {
    status: number;
    ok: boolean;
    body: unknown;
  };
  correlationId: string;
  interpretation: string;
}> {
  const token = await getWalmartAccessToken(creds);
  const correlationId = `prepship-probe-${Date.now().toString(36)}`;
  const headers = {
    ...walmartMarketplaceHeaders(creds, token),
    'WM_QOS.CORRELATION_ID': correlationId,
  };

  const carriersRes = await timedFetch(
    'walmart-shipping.credentials.probe-carriers',
    'https://marketplace.walmartapis.com/v3/shipping/labels/carriers',
    { method: 'GET', headers },
  );
  const carriersText = await carriersRes.text().catch(() => '');
  let carriersBody: unknown = carriersText.slice(0, 1500);
  try {
    carriersBody = JSON.parse(carriersText);
  } catch {
    // Keep the safe text snippet when Walmart does not return JSON.
  }

  return {
    ok: carriersRes.ok,
    step_a_oauth: 'success',
    step_b_carriers_endpoint: {
      status: carriersRes.status,
      ok: carriersRes.ok,
      body: carriersBody,
    },
    correlationId,
    interpretation: carriersRes.ok
      ? 'OAuth + Shipping API access both working. The remaining 500 on /shipping-estimates is request-shape or ship-from-mismatch related.'
      : `Shipping API returned ${carriersRes.status}. If 401/403 -> the developer app is missing Shipping API permission (developer.walmart.com -> My Apps -> API Permissions). If 500 -> seller account isn't enrolled in Walmart Shipping Solutions. Either way, the issue is on Walmart's side, not in our request.`,
  };
}

async function readWalmartError(res: Response): Promise<string> {
  const text = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
  if (!text) return res.statusText;
  try {
    const parsed = JSON.parse(text) as { errors?: Array<{ info?: string; code?: string; description?: string }> };
    const first = parsed.errors?.[0];
    return first?.info || first?.description || first?.code || text;
  } catch {
    return text;
  }
}

function walmartEstimateCarrierName(rate: any): string {
  return firstString(
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    rate?.carrierDisplayName,
  );
}

function walmartEstimateServiceType(rate: any): string {
  return firstString(
    rate?.name,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.carrierServiceName,
    rate?.serviceLevel,
    rate?.method,
    rate?.displayName,
  );
}

function walmartEstimateServiceName(rate: any): string {
  const carrier = firstString(
    rate?.carrierDisplayName,
    rate?.carrierFullName,
    rate?.carrierName,
    rate?.carrier?.shortName,
    rate?.carrierShortName,
    rate?.carrier,
    'Walmart',
  );
  const service = firstString(
    rate?.displayName,
    rate?.serviceTypeGroupDisplayName,
    rate?.serviceType,
    rate?.carrierServiceType,
    rate?.serviceLevel,
    rate?.method,
    rate?.name,
  );
  return service ? `${carrier} ${service}` : carrier;
}

function walmartEstimateServiceCode(rate: any): string {
  const provider = 'walmart_shipping';
  const serviceName = walmartEstimateServiceName(rate);
  const explicitCarrierCode = normalizeCarrierCodeForDirectRate(
    rate?.carrierCode ?? rate?.carrierType ?? rate?.carrierName ?? rate?.carrierDisplayName,
  );
  const carrierCode = explicitCarrierCode ?? inferCarrierCodeForDirectRate(provider, serviceName);
  const carrierServicePrefix = carrierCode && carrierCode !== provider ? `${carrierCode}_` : '';
  return `${provider}_${carrierServicePrefix}${slugRateService(serviceName)}`;
}

function walmartEstimateCost(rate: any): number {
  return Number(
    rate?.estimatedRate?.amount ??
    rate?.totalCost?.amount ??
    rate?.cost?.amount ??
    rate?.totalCost ??
    rate?.cost ??
    rate?.amount ??
    0,
  ) || 0;
}

function walmartEstimateCurrency(rate: any): string {
  return String(
    rate?.estimatedRate?.currency ??
    rate?.totalCost?.currency ??
    rate?.cost?.currency ??
    rate?.currency ??
    'USD',
  );
}

function walmartEstimateList(data: any): any[] {
  return (
    (Array.isArray(data?.data?.estimates) && data.data.estimates) ||
    (Array.isArray(data?.shippingEstimates) && data.shippingEstimates) ||
    (Array.isArray(data?.rates) && data.rates) ||
    (Array.isArray(data?.estimates) && data.estimates) ||
    (Array.isArray(data?.payload) && data.payload) ||
    (Array.isArray(data) ? data : [])
  );
}

function walmartSafeObjectKeys(value: unknown): string[] {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).slice(0, 8);
}

function walmartLabelKeySummary(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 6);
  return `object(${keys.join(',') || 'no_keys'})`;
}

function walmartBoxItems(rawOrder: any): any[] {
  const orderLines = Array.isArray(rawOrder?.orderLines?.orderLine)
    ? rawOrder.orderLines.orderLine
    : [];
  return orderLines.map((line: any) => {
    const lineNumber = firstString(line?.lineNumber);
    if (!lineNumber) return null;
    const item: Record<string, unknown> = {
      lineNumber,
      sku: String(line?.item?.sku ?? ''),
      quantity: Number(line?.orderLineQuantity?.amount ?? 1) || 1,
    };
    const productName = firstString(line?.item?.productName, line?.item?.productNameInLocale);
    if (productName) item.productName = productName;
    return item;
  }).filter(Boolean);
}

function walmartLabelFromAddress(creds: Record<string, unknown>, shipFrom: any): Record<string, unknown> {
  // Root-cause fix (order 1338537): resolve through the SHARED resolver so the purchased
  // label ships from the SAME origin the rate quoted (snake_case `Address` read correctly,
  // selected-origin-first). Reading camelCase here silently defaulted labels to Carson too.
  const from = shipFrom && typeof shipFrom === 'object' ? (shipFrom as Record<string, unknown>) : null;
  const resolved = resolveWalmartShipFrom(from, creds);
  const result: Record<string, unknown> = {
    addressLine1: resolved.addressLines[0] ?? '',
    city: resolved.city,
    contactName: resolved.name,
    country: resolved.countryCode.toUpperCase(),
    phone: resolved.phone,
    postalCode: resolved.postalCode,
    state: resolved.state,
  };
  const addressLine2 = resolved.addressLines[1];
  const companyName = firstString(creds.shipFromCompany, from?.company_name, from?.company);
  const email = firstString(creds.shipFromEmail, from?.email);
  if (addressLine2) result.addressLine2 = addressLine2;
  if (companyName) result.companyName = companyName;
  if (email) result.email = email;
  return result;
}

function walmartEstimateFromAddress(labelAddress: Record<string, unknown>): Record<string, unknown> {
  return {
    addressLines: [labelAddress.addressLine1, labelAddress.addressLine2].map((v) => String(v ?? '').trim()).filter(Boolean),
    city: String(labelAddress.city ?? ''),
    state: String(labelAddress.state ?? ''),
    postalCode: String(labelAddress.postalCode ?? ''),
    countryCode: String(labelAddress.country ?? 'US'),
  };
}

function walmartShipToForLabel(body: Record<string, any>, rawOrder: any) {
  if (body?.shipTo && typeof body.shipTo === 'object') {
    return {
      street1: firstString(body.shipTo.street1, body.shipTo.address1),
      street2: firstString(body.shipTo.street2, body.shipTo.address2),
      city: firstString(body.shipTo.city),
      state: firstString(body.shipTo.state),
      zip: firstString(body.shipTo.zip, body.shipTo.postalCode),
      country: firstString(body.shipTo.country, body.shipTo.countryCode, 'US'),
    };
  }
  const wmAddr = rawOrder?.shippingInfo?.postalAddress;
  if (wmAddr) {
    return {
      street1: firstString(wmAddr.address1),
      street2: firstString(wmAddr.address2),
      city: firstString(wmAddr.city),
      state: firstString(wmAddr.state),
      zip: firstString(wmAddr.postalCode),
      country: firstString(wmAddr.country, 'US'),
    };
  }
  throw new Error('Could not resolve Walmart Shipping ship-to address');
}

function walmartEstimateToAddress(body: Record<string, any>, rawOrder: any): Record<string, unknown> {
  const shipTo = walmartShipToForLabel(body, rawOrder);
  return {
    addressLines: [shipTo.street1, shipTo.street2].filter(Boolean),
    city: shipTo.city,
    state: shipTo.state,
    postalCode: shipTo.zip,
    countryCode: shipTo.country || 'US',
  };
}

async function fetchWalmartEstimatesForLabel(
  creds: Record<string, unknown>,
  input: {
    weightOz: number;
    dimsL: number;
    dimsW: number;
    dimsH: number;
    purchaseOrderId: string;
    rawOrder: any;
    body: Record<string, any>;
    fromAddress: Record<string, unknown>;
    boxItems: any[];
    signal?: AbortSignal;
  },
): Promise<{ token: string; rates: any[] }> {
  const token = await getWalmartAccessToken(creds, input.signal);
  const weightLb = Math.max(0.1, Math.round((input.weightOz / 16) * 10) / 10);
  const estimateBody = {
    purchaseOrderId: input.purchaseOrderId,
    boxDimensions: {
      boxWeight: weightLb,
      boxWeightUnit: 'LB',
      boxLength: input.dimsL,
      boxWidth: input.dimsW,
      boxHeight: input.dimsH,
      boxDimensionUnit: 'IN',
    },
    fromAddress: walmartEstimateFromAddress(input.fromAddress),
    toAddress: walmartEstimateToAddress(input.body, input.rawOrder),
    packageType: 'CUSTOM_PACKAGE',
    shipByDate: toWalmartIsoDate(input.rawOrder?.shippingInfo?.estimatedShipDate, 1),
    deliverByDate: toWalmartIsoDate(input.rawOrder?.shippingInfo?.estimatedDeliveryDate, 5),
    includeServicesNotMeetingDeliveryPromise: true,
    boxItems: input.boxItems,
    addOns: false,
    hasBattery: false,
  };
  console.info('[walmart-shipping connector] label estimate request', {
    hasPurchaseOrderId: Boolean(input.purchaseOrderId),
    weightUnit: 'LB',
    dimensionUnit: 'IN',
    boxItemCount: input.boxItems.length,
    requestKeys: walmartSafeObjectKeys(estimateBody),
  });
  const res = await timedFetch('walmart-shipping.labels.estimates', 'https://marketplace.walmartapis.com/v3/shipping/labels/shipping-estimates', {
    method: 'POST',
    headers: walmartMarketplaceHeaders(creds, token, 'application/json', true),
    body: JSON.stringify(estimateBody),
    signal: input.signal,
  });
  if (!res.ok) {
    throw new Error(`Walmart Shipping Estimates ${res.status}: ${await readWalmartError(res)}`);
  }
  const data = await res.json() as any;
  const rates = walmartEstimateList(data).filter((rate) => walmartEstimateCost(rate) > 0);
  console.info('[walmart-shipping connector] label estimate response', {
    responseKeys: walmartSafeObjectKeys(data),
    dataKeys: walmartSafeObjectKeys((data as any)?.data),
    usableRateCount: rates.length,
  });
  return { token, rates };
}

function selectWalmartEstimateRate(rates: any[], serviceCode: unknown): any | null {
  const wanted = normalizeProviderKey(serviceCode);
  if (!wanted) return null;
  const exact = rates.find((rate) => normalizeProviderKey(walmartEstimateServiceCode(rate)) === wanted);
  if (exact) return exact;
  return rates.find((rate) => {
    const serviceSlug = slugRateService(walmartEstimateServiceName(rate));
    return serviceSlug && wanted.endsWith(serviceSlug);
  }) ?? null;
}

function walmartTrackingUrl(carrierName: string, trackingNumber: string): string {
  const carrier = normalizeProviderKey(carrierName);
  const encoded = encodeURIComponent(trackingNumber);
  if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (carrier.includes('usps') || carrier.includes('postal')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  return '';
}

async function downloadWalmartLabelPdf(
  creds: Record<string, unknown>,
  token: string,
  carrierName: string,
  trackingNumber: string,
): Promise<string> {
  const url = `https://marketplace.walmartapis.com/v3/shipping/labels/carriers/${encodeURIComponent(carrierName)}/trackings/${encodeURIComponent(trackingNumber)}`;
  const res = await timedFetch('walmart-shipping.labels.download-tracking', url, {
    headers: walmartMarketplaceHeaders(creds, token, 'application/pdf'),
  });
  if (!res.ok) {
    console.warn(`[walmart-shipping connector] label download ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }
  const contentType = res.headers.get('content-type') || 'application/pdf';
  if (!/pdf/i.test(contentType)) {
    console.warn(`[walmart-shipping connector] label download returned ${contentType}`);
    return '';
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:application/pdf;base64,${buffer.toString('base64')}`;
}

const WALMART_LABEL_BASE64_KEYS = new Set([
  'labeldata',
  'label_data',
  'labelbase64',
  'labelpdf',
  'pdffile',
  'pdfdata',
  'pdf_data',
  'pdfbase64',
]);

const WALMART_LABEL_URL_KEYS = new Set([
  'labelurl',
  'label_url',
  'labeldownloadurl',
  'label_download_url',
  'downloadurl',
  'download_url',
  'labeldownload',
  'label_download',
  'href',
  'url',
]);

const WALMART_LABEL_BASE64_CHILD_KEYS = new Set([
  'data',
  'content',
  'pdf',
  'base64',
  'labeldata',
  'label_data',
  'labelbase64',
  'pdfbase64',
]);

const WALMART_LABEL_URL_CHILD_KEYS = new Set([
  'href',
  'url',
  'pdf',
  'download',
  'downloadurl',
  'download_url',
  'labelurl',
  'label_url',
]);

function walmartLabelPath(parent: string, key: string): string {
  if (!parent || parent === 'response') return key;
  return `${parent}.${key}`;
}

function walmartLabelReject(diagnostics: string[], path: string, value: unknown, reason: string): void {
  diagnostics.push(`${path}:${walmartLabelKeySummary(value)}_${reason}`);
}

function validateWalmartLabelString(
  value: string,
  mode: 'base64' | 'url',
  path: string,
  diagnostics: string[],
): { value: string; path: string } | null {
  const text = value.trim();
  if (!text) {
    walmartLabelReject(diagnostics, path, value, 'empty');
    return null;
  }
  if (text === '[object Object]') {
    walmartLabelReject(diagnostics, path, value, 'invalid');
    return null;
  }
  if (mode === 'url') {
    if (/^https?:\/\//i.test(text)) return { value: text, path };
    walmartLabelReject(diagnostics, path, value, 'unsupported');
    return null;
  }
  const compact = text.replace(/\s+/g, '');
  if (/^data:application\/pdf/i.test(compact)) return { value: compact, path };
  if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
    return { value: compact, path };
  }
  walmartLabelReject(diagnostics, path, value, 'unsupported');
  return null;
}

function extractWalmartLabelReference(
  payload: unknown,
  mode: 'base64' | 'url',
): { value: string; path: string; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const rootKeys = mode === 'base64' ? WALMART_LABEL_BASE64_KEYS : WALMART_LABEL_URL_KEYS;
  const childKeys = mode === 'base64' ? WALMART_LABEL_BASE64_CHILD_KEYS : WALMART_LABEL_URL_CHILD_KEYS;

  const scan = (value: unknown, path: string, depth: number, withinCandidate: boolean): { value: string; path: string } | null => {
    if (depth > 8 || value == null) return null;
    if (typeof value === 'string') {
      return withinCandidate ? validateWalmartLabelString(value, mode, path, diagnostics) : null;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const found = scan(item, `${path}[${index}]`, depth + 1, withinCandidate);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') {
      if (withinCandidate) walmartLabelReject(diagnostics, path, value, 'unsupported');
      return null;
    }

    const record = value as Record<string, unknown>;
    for (const [key, raw] of Object.entries(record)) {
      const normalized = key.toLowerCase();
      const keyPath = walmartLabelPath(path, key);
      if (rootKeys.has(normalized) || (withinCandidate && childKeys.has(normalized))) {
        const found = scan(raw, keyPath, depth + 1, true);
        if (found) return found;
        if (raw == null || typeof raw !== 'object') {
          walmartLabelReject(diagnostics, keyPath, raw, 'unsupported');
        }
      }
    }

    for (const [key, raw] of Object.entries(record)) {
      const found = scan(raw, walmartLabelPath(path, key), depth + 1, withinCandidate);
      if (found) return found;
    }
    return null;
  };

  const found = scan(payload, 'response', 0, false);
  if (found) return { ...found, diagnostics };
  if (diagnostics.length) {
    throw new Error(`Walmart label ${mode} extraction rejected unsupported fields: ${diagnostics.slice(0, 8).join('; ')}`);
  }
  return { value: '', path: '', diagnostics };
}

export function __test_extractWalmartLabelReference(payload: unknown, mode: 'base64' | 'url') {
  return extractWalmartLabelReference(payload, mode);
}

function walmartLabelExtractionErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Walmart label extraction failed';
}

function findWalmartLabelString(value: unknown, keys: string[]): string {
  const normalized = new Set(keys.map((key) => key.toLowerCase()));
  const mode = [...normalized].some((key) => WALMART_LABEL_BASE64_KEYS.has(key)) ? 'base64' : 'url';
  try {
    return extractWalmartLabelReference(value, mode).value;
  } catch (err) {
    console.warn('[walmart-shipping connector] label extraction rejected:', walmartLabelExtractionErrorMessage(err));
    return '';
  }
}

function walmartLabelDataUrlFromPayload(payload: unknown): string {
  let base64 = '';
  try {
    base64 = extractWalmartLabelReference(payload, 'base64').value.replace(/\s+/g, '');
  } catch (err) {
    console.warn('[walmart-shipping connector] label data extraction rejected:', walmartLabelExtractionErrorMessage(err));
    return '';
  }
  if (!base64) return '';
  if (/^data:application\/pdf/i.test(base64)) return base64;
  if (/^[A-Za-z0-9+/=]+$/.test(base64) && base64.length > 100) {
    return `data:application/pdf;base64,${base64}`;
  }
  return '';
}

async function downloadWalmartLabelPdfFromUrl(
  creds: Record<string, unknown>,
  token: string,
  url: string,
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return '';
  const res = await timedFetch('walmart-shipping.labels.download-url', url, {
    headers: walmartMarketplaceHeaders(creds, token, 'application/pdf,application/json,image/png,*/*'),
  });
  if (!res.ok) {
    console.warn(`[walmart-shipping connector] label download url ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }

  const contentType = res.headers.get('content-type') || '';
  if (/pdf/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:application/pdf;base64,${buffer.toString('base64')}`;
  }
  if (/json/i.test(contentType)) {
    return walmartLabelDataUrlFromPayload(await res.json().catch(() => null));
  }
  if (/image\/png/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:image/png;base64,${buffer.toString('base64')}`;
  }
  return '';
}

async function downloadWalmartLabelPdfById(
  creds: Record<string, unknown>,
  token: string,
  labelId: string,
): Promise<string> {
  const res = await timedFetch(
    'walmart-shipping.labels.download-id',
    `https://marketplace.walmartapis.com/v3/shipping/labels/${encodeURIComponent(labelId)}`,
    {
      headers: walmartMarketplaceHeaders(creds, token, 'application/pdf,application/json'),
    },
  );
  if (!res.ok) {
    console.warn(`[walmart-shipping connector] label download by id ${res.status}: ${await readWalmartError(res)}`);
    return '';
  }

  const contentType = res.headers.get('content-type') || '';
  if (/pdf/i.test(contentType)) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return `data:application/pdf;base64,${buffer.toString('base64')}`;
  }

  const text = await res.text().catch(() => '');
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const labelUrl = walmartLabelDataUrlFromPayload(parsed);
    if (labelUrl) return labelUrl;
    const directUrl = findWalmartLabelString(parsed, ['labelUrl', 'labelURL', 'downloadUrl', 'downloadURL', 'href', 'url']);
    return directUrl ? downloadWalmartLabelPdfFromUrl(creds, token, directUrl) : '';
  } catch {
    const compact = text.trim().replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(compact) && compact.length > 100) {
      return `data:application/pdf;base64,${compact}`;
    }
    return '';
  }
}

async function ratesFromWalmartShipping(input: Record<string, unknown>): Promise<Array<{
  service: string;
  cost: number;
  days: number;
  currency: string;
  carrierCode?: string;
  carrierName?: string;
  carrierType?: string;
}>> {
  const signal = input.signal as AbortSignal | undefined;
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const purchaseOrderId = firstString(input.purchaseOrderId);
  if (!purchaseOrderId) {
    throw new Error(
      'Walmart Shipping Solutions rates require a Walmart purchaseOrderId. Open the Rate Browser on a Walmart-pulled order (orders whose external id starts with walmart-).',
    );
  }
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  if (!dimsL || !dimsW || !dimsH) {
    throw new Error(
      'Walmart Shipping Estimates require box dimensions (length, width, height). Set them in the Rate Browser before fetching rates.',
    );
  }

  const token = await getWalmartAccessToken(creds, signal);
  const channelType = firstString(creds.channelType, creds.channel_type);
  const partnerId = firstString(creds.partnerId, creds.sellerId);
  const headers: Record<string, string> = {
    'WM_SEC.ACCESS_TOKEN': token,
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    'WM_SVC.NAME': firstString(creds.serviceName, creds.service_name, 'Walmart Marketplace'),
    'WM_MARKET': 'us',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (channelType) headers['WM_CONSUMER.CHANNEL.TYPE'] = channelType;
  if (partnerId) headers['WM_PARTNER.ID'] = partnerId;

  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const rawOrder = input.rawOrder as any;
  const orderLines = Array.isArray(rawOrder?.orderLines?.orderLine)
    ? rawOrder.orderLines.orderLine
    : [];
  const boxItems = orderLines.length > 0
    ? orderLines.map((line: any) => ({
        lineNumber: String(line?.lineNumber ?? '1'),
        sku: line?.item?.sku ?? '',
        quantity: Number(line?.orderLineQuantity?.amount ?? 1) || 1,
      }))
    : [{ lineNumber: '1', sku: 'UNKNOWN', quantity: 1 }];

  const shipFromInput =
    input.shipFrom && typeof input.shipFrom === 'object' ? (input.shipFrom as Record<string, unknown>) : null;
  // Root-cause fix (order 1338537): read the SELECTED origin (an `Address` — snake_case)
  // correctly instead of camelCase (which read undefined and fell back to a Carson/
  // "Warehouse" default), so PrepShip quotes Walmart from the order's real ship-from.
  const fromAddress = resolveWalmartShipFrom(shipFromInput, creds, input.fromZip);

  const addr = rawOrder?.shippingInfo?.postalAddress ?? {};
  const toAddress = {
    name: firstString(addr?.name, 'Buyer'),
    addressLines: [firstString(addr?.address1), firstString(addr?.address2)].filter(Boolean),
    city: firstString(addr?.city),
    state: firstString(addr?.state),
    postalCode: firstString(addr?.postalCode),
    countryCode: firstString(addr?.country, 'US'),
    phone: firstString(rawOrder?.shippingInfo?.phone, '0000000000'),
  };
  const shippingOptions = assertUnsupportedShippingOptions('Walmart Shipping', input, {
    confirmation: ['delivery', 'none', 'signature'],
    insurance: false,
  });

  const body = {
    purchaseOrderId,
    boxDimensions: {
      boxWeight: weightLb,
      boxWeightUnit: 'LB',
      boxLength: dimsL,
      boxWidth: dimsW,
      boxHeight: dimsH,
      boxDimensionUnit: 'IN',
    },
    fromAddress,
    toAddress,
    packageType: 'CUSTOM_PACKAGE',
    shipByDate: toWalmartIsoDate(rawOrder?.shippingInfo?.estimatedShipDate, 1),
    deliverByDate: toWalmartIsoDate(rawOrder?.shippingInfo?.estimatedDeliveryDate, 5),
    includeServicesNotMeetingDeliveryPromise: true,
    boxItems,
    addOns: shippingOptions.confirmation === 'signature' ? ['SIGNATURE'] : false,
    hasBattery: false,
  };

  const url = 'https://marketplace.walmartapis.com/v3/shipping/labels/shipping-estimates';
  const res = await timedFetch('walmart-shipping.rates', url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    let walmartMessage = t || res.statusText;
    try {
      const parsed = JSON.parse(t) as { errors?: Array<{ info?: string; code?: string; description?: string }> };
      const first = parsed.errors?.[0];
      walmartMessage = first?.info || first?.description || first?.code || walmartMessage;
    } catch {
      // Keep Walmart's raw text fallback when it is not JSON.
    }
    const sentSummary = {
      purchaseOrderId,
      packageType: (body as any).packageType,
      boxDimensionKeys: Object.keys((body as any).boxDimensions ?? {}),
      fromAddressKeys: Object.keys((body as any).fromAddress ?? {}),
      toAddressKeys: Object.keys((body as any).toAddress ?? {}),
      boxItemKeys: Object.keys(boxItems[0] ?? {}),
      itemCount: boxItems.length,
      topLevelKeys: Object.keys(body),
      fromCity: (body as any).fromAddress?.city,
      fromState: (body as any).fromAddress?.state,
      fromZip: (body as any).fromAddress?.postalCode,
    };
    throw new Error(
      `Walmart Shipping Estimates ${res.status}: ${walmartMessage} | sent: ${JSON.stringify(sentSummary)}`,
    );
  }

  const data = await res.json() as any;
  const rateList: any[] =
    (Array.isArray(data?.data?.estimates) && data.data.estimates) ||
    (Array.isArray(data?.shippingEstimates) && data.shippingEstimates) ||
    (Array.isArray(data?.rates) && data.rates) ||
    (Array.isArray(data?.estimates) && data.estimates) ||
    (Array.isArray(data?.payload) && data.payload) ||
    (Array.isArray(data) ? data : []);

  return rateList
    .map((rate: any) => {
      const carrierName = String(
        rate?.carrierName ?? rate?.carrier?.shortName ?? rate?.carrierShortName ?? rate?.carrier ?? rate?.carrierDisplayName ?? 'Walmart',
      );
      const carrierDisplay = String(
        rate?.carrierDisplayName ?? rate?.carrierFullName ?? carrierName,
      );
      const carrierServiceType = String(
        rate?.name ?? rate?.serviceType ?? rate?.carrierServiceType ?? rate?.serviceLevel ?? rate?.method ?? rate?.displayName ?? '',
      );
      const svcType = String(
        rate?.displayName ?? rate?.serviceTypeGroupDisplayName ?? carrierServiceType,
      );
      const service = svcType ? `${carrierDisplay} ${svcType}` : carrierDisplay;
      const cost = Number(
        rate?.estimatedRate?.amount ?? rate?.totalCost?.amount ?? rate?.cost?.amount ?? rate?.totalCost ?? rate?.cost ?? rate?.amount ?? 0,
      );
      const currency = String(
        rate?.estimatedRate?.currency ?? rate?.totalCost?.currency ?? rate?.cost?.currency ?? rate?.currency ?? 'USD',
      );
      const days = Number(rate?.transitTime?.businessDays ?? rate?.transitDays ?? rate?.deliveryDays ?? 0) || 0;
      return {
        service,
        cost,
        days,
        currency,
        carrierCode: carrierName,
        carrierName,
        carrierType: carrierServiceType,
      };
    })
    .filter((rate) => rate.cost > 0);
}

async function createLabelWalmartShipping(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const signal = input.signal as AbortSignal | undefined;
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const body = input.body && typeof input.body === 'object' ? input.body as Record<string, any> : {};
  const contextInput = input.context && typeof input.context === 'object' ? input.context as any : {};
  const rawOrder = contextInput.rawOrder ?? input.rawOrder;
  const purchaseOrderId = firstString(contextInput.purchaseOrderId, input.purchaseOrderId);
  if (!purchaseOrderId) {
    throw new Error('Walmart Shipping labels require a Walmart purchaseOrderId');
  }

  const weightOz = Number(input.weightOz ?? body.weightOz ?? 0);
  const dimsL = Number(input.dimsL ?? body.dimsL ?? body.length ?? 0);
  const dimsW = Number(input.dimsW ?? body.dimsW ?? body.width ?? 0);
  const dimsH = Number(input.dimsH ?? body.dimsH ?? body.height ?? 0);
  if (!weightOz || !dimsL || !dimsW || !dimsH) {
    throw new Error('Walmart Shipping label creation requires weightOz and dimsL/W/H');
  }

  const fromAddress = walmartLabelFromAddress(creds, body.shipFrom ?? input.shipFrom);
  const boxItems = walmartBoxItems(rawOrder);
  if (!boxItems.length) {
    throw new Error('Cannot create Walmart Shipping label: missing Walmart order line numbers');
  }
  const { token, rates } = await fetchWalmartEstimatesForLabel(creds, {
    weightOz,
    dimsL,
    dimsW,
    dimsH,
    purchaseOrderId,
    rawOrder,
    body,
    fromAddress,
    boxItems,
    signal,
  });

  if (!rates.length) {
    throw new Error('Walmart returned 0 rates for this order. Browse Rates again with a different package size or confirm Ship With Walmart is enabled in Seller Center.');
  }

  const selectedRate = selectWalmartEstimateRate(rates, body.serviceCode ?? input.serviceCode);
  if (!selectedRate) {
    throw new Error('Selected Walmart Shipping service is no longer available. Click Browse Rates again and select one of the current Walmart rates.');
  }

  const carrierName = walmartEstimateCarrierName(selectedRate);
  const carrierServiceType = walmartEstimateServiceType(selectedRate);
  if (!carrierName || !carrierServiceType) {
    throw new Error('Walmart did not return the carrierName/carrierServiceType required to buy this label. Click Browse Rates again and choose another Walmart rate.');
  }

  const shippingOptions = assertUnsupportedShippingOptions('Walmart Shipping', {
    shippingOptions: input.shippingOptions,
    confirmation: body.confirmation ?? input.confirmation,
    insuranceProvider: body.insuranceProvider ?? input.insuranceProvider,
    insuredValue: body.insuredValue ?? input.insuredValue,
  }, {
    confirmation: ['delivery', 'none', 'signature'],
    insurance: false,
  });
  const addOns = shippingOptions.confirmation === 'signature' ? ['SIGNATURE'] : [];
  const labelBody: Record<string, unknown> = {
    boxDimensions: {
      boxWeight: Math.max(1, Math.round(weightOz)),
      boxWeightUnit: 'OZ',
      boxLength: dimsL,
      boxWidth: dimsW,
      boxHeight: dimsH,
      boxDimensionUnit: 'IN',
    },
    boxItems,
    carrierName,
    carrierServiceType,
    packageType: 'CUSTOM_PACKAGE',
    purchaseOrderId,
    fromAddress,
    returnAddress: fromAddress,
    addOns,
    hasBattery: false,
    hazmat: false,
  };
  const accountType = firstString(body.accountType, creds.accountType);
  if (accountType) labelBody.accountType = accountType;

  console.info('[walmart-shipping connector] create label request', {
    hasPurchaseOrderId: Boolean(purchaseOrderId),
    carrierName: Boolean(carrierName),
    carrierServiceType: Boolean(carrierServiceType),
    boxItemCount: boxItems.length,
    requestKeys: walmartSafeObjectKeys(labelBody),
  });
  const res = await timedFetch('walmart-shipping.labels.create', 'https://marketplace.walmartapis.com/v3/shipping/labels', {
    method: 'POST',
    headers: walmartMarketplaceHeaders(creds, token, 'application/json', true),
    body: JSON.stringify(labelBody),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Walmart Create Label ${res.status}: ${await readWalmartError(res)}`);
  }

  const data = await res.json() as any;
  const details = data?.data && typeof data.data === 'object' ? data.data : data;
  console.info('[walmart-shipping connector] create label response', {
    responseKeys: walmartSafeObjectKeys(data),
    detailKeys: walmartSafeObjectKeys(details),
    responseShape: walmartLabelKeySummary(data),
  });
  const labelId = firstString(
    details?.labelId,
    details?.labelID,
    details?.label_id,
    details?.id,
    data?.labelId,
  );
  const trackingNumber = firstString(
    details?.trackingNo,
    details?.trackingNumber,
    details?.tracking_number,
    details?.tracking,
  );
  if (!trackingNumber) {
    throw new Error('Walmart created a label response without a tracking number');
  }

  const responseCarrierName = firstString(details?.carrierName, carrierName);
  let labelUrl = walmartLabelDataUrlFromPayload(data);
  if (!labelUrl) {
    const directUrl = findWalmartLabelString(data, ['labelUrl', 'labelURL', 'downloadUrl', 'downloadURL', 'href', 'url']);
    if (directUrl) {
      labelUrl = await downloadWalmartLabelPdfFromUrl(creds, token, directUrl).catch((err) => {
        console.warn('[walmart-shipping connector] label PDF download url failed:', err instanceof Error ? err.message : err);
        return '';
      });
    }
  }
  if (!labelUrl && labelId) {
    labelUrl = await downloadWalmartLabelPdfById(creds, token, labelId).catch((err) => {
      console.warn('[walmart-shipping connector] label PDF download by id failed:', err instanceof Error ? err.message : err);
      return '';
    });
  }
  if (!labelUrl) {
    labelUrl = await downloadWalmartLabelPdf(creds, token, responseCarrierName, trackingNumber).catch((err) => {
      console.warn('[walmart-shipping connector] label PDF download failed:', err instanceof Error ? err.message : err);
      return '';
    });
  }
  const serviceName = walmartEstimateServiceName(selectedRate);
  const serviceCode = walmartEstimateServiceCode(selectedRate);
  const carrierCode = normalizeCarrierCodeForDirectRate(responseCarrierName) ?? inferCarrierCodeForDirectRate('walmart_shipping', serviceName);

  return {
    trackingNumber,
    labelUrl,
    labelFormat: labelUrl?.startsWith('data:application/pdf') ? 'pdf' : null,
    cost: walmartEstimateCost(selectedRate),
    currency: walmartEstimateCurrency(selectedRate),
    shipmentId: trackingNumber,
    carrierCode,
    carrierName: responseCarrierName,
    serviceCode,
    serviceName,
    selectedRate,
    raw: data,
    context: {
      ...contextInput,
      purchaseOrderId,
      rawOrder,
    },
    trackingUrl: walmartTrackingUrl(responseCarrierName, trackingNumber),
    shipmentConfirmed: null,
    shipmentConfirmError: null,
    shipmentConfirmRaw: null,
  };
}

export function createWalmartShippingCarrierConnector(): CarrierConnector {
  return {
    provider: 'walmart_shipping',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromWalmartShipping,
    createLabel: createLabelWalmartShipping,
  };
}

export const walmartShippingCarrierConnector = createWalmartShippingCarrierConnector();
