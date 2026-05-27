import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

async function getWalmartAccessToken(creds: Record<string, unknown>): Promise<string> {
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

async function ratesFromWalmartShipping(input: Record<string, unknown>): Promise<Array<{
  service: string;
  cost: number;
  days: number;
  currency: string;
  carrierCode?: string;
  carrierName?: string;
  carrierType?: string;
}>> {
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

  const token = await getWalmartAccessToken(creds);
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

  const credShipFromZip = firstString(creds.shipFromZip).replace(/[^0-9]/g, '').slice(0, 5);
  const shipFromInput = input.shipFrom && typeof input.shipFrom === 'object' ? input.shipFrom as any : {};
  const fromZip = credShipFromZip ||
    firstString(shipFromInput?.postalCode, input.fromZip, '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const fromAddress = {
    name: firstString(creds.shipFromName, shipFromInput?.name, 'Seller'),
    addressLines: [
      firstString(creds.shipFromAddress1, shipFromInput?.addressLine1, shipFromInput?.street1, 'Warehouse'),
      firstString(creds.shipFromAddress2, shipFromInput?.addressLine2, shipFromInput?.street2),
    ].filter(Boolean),
    city: firstString(creds.shipFromCity, shipFromInput?.city, 'Carson'),
    state: firstString(creds.shipFromState, shipFromInput?.state, 'CA'),
    postalCode: fromZip,
    countryCode: firstString(shipFromInput?.country, 'US'),
    phone: firstString(creds.shipFromPhone, shipFromInput?.phone, '0000000000'),
  };

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
    addOns: false,
    hasBattery: false,
  };

  const url = 'https://marketplace.walmartapis.com/v3/shipping/labels/shipping-estimates';
  const res = await timedFetch('walmart-shipping.rates', url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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

export function createWalmartShippingCarrierConnector(): CarrierConnector {
  return {
    provider: 'walmart_shipping',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: ratesFromWalmartShipping,
    createLabel: async () => {
      throw new Error('Walmart Shipping labels are handled by api/carriers/labels.ts');
    },
  };
}

export const walmartShippingCarrierConnector = createWalmartShippingCarrierConnector();
