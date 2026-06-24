import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { timedFetch } from '../../lib/http/timing.js';
import { assertUnsupportedShippingOptions } from './shipping-option-support.js';
import { readShipFrom } from './ship-from-address.js';

async function getEbayLogisticsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const appId = String(creds?.appId ?? '').trim();
  const certId = String(creds?.certId ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!appId || !certId || !refreshToken) {
    throw new Error('eBay Shipping requires appId, certId, and refreshToken.');
  }
  const useSandbox = String(creds?.environment ?? '').toLowerCase() === 'sandbox';
  const tokenUrl = useSandbox
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token';
  const basic = Buffer.from(`${appId}:${certId}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://api.ebay.com/oauth/api_scope/sell.logistics',
  });
  const res = await timedFetch('ebay-shipping.token', tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 400)).catch(() => '');
    throw new Error(`eBay Logistics OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('eBay Logistics OAuth response missing access_token');
  return data.access_token;
}

function ebayOrderIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('ebay-') ? trimmed.slice('ebay-'.length) : trimmed;
}

// eBay's createShippingQuote orders[].orderId must be the eBay Sell order id (shape NN-NNNNN-NNNNN). A
// ShipStation-synced eBay order carries that eBay id in its order NUMBER, while externalOrderId is
// ShipStation's own numeric id — sending the latter yields a 400 "Invalid field" (errorId 90020). Prefer
// the value matching the eBay order-id shape across the order number, external id, and the raw order.
function resolveEbayOrderId(...values: unknown[]): string | null {
  const normed = values
    .map((value) => ebayOrderIdFrom(value))
    .filter((value): value is string => value != null);
  return normed.find((value) => /^\d{2}-\d{5}-\d{5}$/.test(value)) ?? normed[0] ?? null;
}

// eBay rejects optional fields sent as explicit null / '' with a 400 "Invalid field". Deep-remove every
// null / undefined / empty-string value so only populated fields (companyName, addressLine2, county, …)
// reach the API.
function pruneEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => pruneEmpty(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === null || val === undefined || val === '') continue;
      out[key] = val && typeof val === 'object' ? pruneEmpty(val) : val;
    }
    return out as T;
  }
  return value;
}

function ebayShipToContact(rawOrder: any) {
  const ship = Array.isArray(rawOrder?.fulfillmentStartInstructions)
    ? rawOrder.fulfillmentStartInstructions[0]?.shippingStep?.shipTo
    : null;
  const addr = ship?.contactAddress ?? {};
  const postalCode = String(addr?.postalCode ?? '').trim();
  if (postalCode) {
    return {
      fullName: String(ship?.fullName ?? 'Buyer'),
      companyName: ship?.companyName ?? null,
      contactAddress: {
        addressLine1: String(addr?.addressLine1 ?? 'Address unavailable'),
        addressLine2: addr?.addressLine2 ?? null,
        city: String(addr?.city ?? ''),
        stateOrProvince: String(addr?.stateOrProvince ?? ''),
        postalCode,
        countryCode: String(addr?.countryCode ?? 'US'),
        county: String(addr?.county ?? ''),
      },
      primaryPhone: {
        phoneNumber: String(ship?.primaryPhone?.phoneNumber ?? '0000000000'),
      },
    };
  }

  const ssShipTo = rawOrder?.shipTo ?? rawOrder?.ship_to ?? null;
  const ssPostalCode = String(ssShipTo?.postalCode ?? ssShipTo?.postal_code ?? '').trim();
  if (!ssPostalCode) return null;
  return {
    fullName: String(ssShipTo?.name ?? 'Buyer'),
    companyName: ssShipTo?.company ?? null,
    contactAddress: {
      addressLine1: String(ssShipTo?.street1 ?? ssShipTo?.addressLine1 ?? 'Address unavailable'),
      addressLine2: ssShipTo?.street2 ?? ssShipTo?.addressLine2 ?? null,
      city: String(ssShipTo?.city ?? ''),
      stateOrProvince: String(ssShipTo?.state ?? ssShipTo?.stateOrProvince ?? ''),
      postalCode: ssPostalCode,
      countryCode: String(ssShipTo?.country ?? ssShipTo?.countryCode ?? 'US'),
      county: String(ssShipTo?.county ?? ''),
    },
    primaryPhone: {
      phoneNumber: String(ssShipTo?.phone ?? ssShipTo?.primaryPhone?.phoneNumber ?? '0000000000'),
    },
  };
}

async function ratesFromEbayShipping(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  assertUnsupportedShippingOptions('eBay Shipping', input, { confirmation: ['delivery', 'none'], insurance: false });
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const rawOrder = input.rawOrder && typeof input.rawOrder === 'object'
    ? input.rawOrder as Record<string, any>
    : null;
  const externalOrderId = typeof input.externalOrderId === 'string' ? input.externalOrderId : null;
  const orderNumber = typeof input.orderNumber === 'string' ? input.orderNumber : null;
  // Prefer the eBay-formatted id (the order NUMBER for ShipStation-synced eBay orders) over the
  // ShipStation external_order_id, which eBay rejects as an invalid orderId.
  const orderId = resolveEbayOrderId(orderNumber, externalOrderId, rawOrder?.orderId);
  if (!orderId) {
    throw new Error('eBay Shipping rates require an eBay order id. Open Browse Rates from an eBay-pulled order.');
  }

  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  if (!dimsL || !dimsW || !dimsH) {
    throw new Error('eBay Shipping rates require box dimensions (length, width, height).');
  }

  const shipTo = ebayShipToContact(rawOrder);
  if (!shipTo) {
    throw new Error('eBay Shipping rates require the eBay order ship-to address. Pull the eBay order first, then open Browse Rates from that order.');
  }

  const token = await getEbayLogisticsAccessToken(creds);
  const useSandbox = String(creds?.environment ?? '').toLowerCase() === 'sandbox';
  const apiBase = useSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const marketplaceId = String(creds?.marketplaceId ?? 'EBAY_US').trim() || 'EBAY_US';
  // Canonical origin (was camelCase reads — postalCode/city/state/addressLine1 — that read
  // undefined for the snake_case Address and fell back to a Carson default).
  const from = readShipFrom(input.shipFrom as Record<string, unknown>, creds, input.fromZip);
  const shipFrom = {
    fullName: from.name,
    companyName: from.company || from.name,
    contactAddress: {
      addressLine1: from.line1,
      addressLine2: from.line2,
      city: from.city,
      stateOrProvince: from.state,
      postalCode: from.postalCode,
      countryCode: from.country,
      county: String(creds?.shipFromCounty ?? ''),
    },
    primaryPhone: {
      phoneNumber: from.phone,
    },
  };

  const body = {
    // eBay REQUIRES orders[] — confirmed live: omitting it returns 400 errorId 90010 "Missing field:
    // orders". createShippingQuote is order-bound: it quotes a SPECIFIC eBay order in the seller's account.
    orders: [{ channel: 'EBAY', orderId }],
    packageSpecification: {
      dimensions: {
        length: String(dimsL),
        width: String(dimsW),
        height: String(dimsH),
        unit: 'INCH',
      },
      weight: {
        value: String(Math.max(0.1, Number(input.weightOz ?? 0))),
        unit: 'OUNCE',
      },
    },
    // eBay rejects explicit null / empty-string optional fields (companyName, addressLine2, county) with
    // a 400 "Invalid field" — prune so only populated fields are sent.
    shipFrom: pruneEmpty(shipFrom),
    shipTo: pruneEmpty(shipTo),
  };

  const res = await timedFetch('ebay-shipping.rates', `${apiBase}/sell/logistics/v1_beta/shipping_quote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    throw new Error(`eBay Shipping Quote ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as any;
  const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];
  const now = Date.now();
  return rateList
    .map((rate: any) => {
      const carrier = String(rate?.shippingCarrierName ?? rate?.shippingCarrierCode ?? 'USPS');
      const service = String(rate?.shippingServiceName ?? rate?.shippingServiceCode ?? 'eBay Shipping');
      const cost = Number(rate?.baseShippingCost?.value ?? 0);
      const currency = String(rate?.baseShippingCost?.currency ?? 'USD');
      const etaTime = Date.parse(rate?.maxEstimatedDeliveryDate ?? rate?.minEstimatedDeliveryDate ?? '');
      const days = Number.isFinite(etaTime)
        ? Math.max(1, Math.ceil((etaTime - now) / (24 * 60 * 60 * 1000)))
        : 0;
      return { service: `${carrier} ${service}`.trim(), cost, days, currency };
    })
    .filter((rate) => rate.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

export function createEbayShippingCarrierConnector(): CarrierConnector {
  return {
    provider: 'ebay_shipping',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromEbayShipping,
    createLabel: async () => {
      throw new Error('eBay Shipping labels are not implemented in the connector yet');
    },
  };
}

export const ebayShippingCarrierConnector = createEbayShippingCarrierConnector();
