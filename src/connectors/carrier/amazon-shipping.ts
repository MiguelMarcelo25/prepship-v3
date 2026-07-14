import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { timedFetch } from '../../lib/http/timing.js';
import { assertUnsupportedShippingOptions } from './shipping-option-support.js';
import { readShipFrom } from './ship-from-address.js';

type Rate = { service: string; cost: number; days: number; currency: string };

function stringOrDefault(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

async function getAmazonLwaAccessToken(creds: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const lwaClientId = String(creds?.lwaClientId ?? '').trim();
  const lwaClientSecret = String(creds?.lwaClientSecret ?? '').trim();
  const refreshToken = String(creds?.refreshToken ?? '').trim();
  if (!lwaClientId || !lwaClientSecret || !refreshToken) {
    throw new Error('Amazon Buy Shipping requires lwaClientId, lwaClientSecret, refreshToken on the carrier_account credentials.');
  }

  const lwaBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: lwaClientId,
    client_secret: lwaClientSecret,
  });
  const lwaRes = await timedFetch('amazon-shipping.lwa', 'https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: lwaBody.toString(),
    signal,
  });
  if (!lwaRes.ok) {
    const text = await lwaRes.text().then((s) => s.slice(0, 200)).catch(() => '');
    throw new Error(`Amazon LWA ${lwaRes.status}: ${text || lwaRes.statusText}`);
  }
  const data = (await lwaRes.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('Amazon LWA response missing access_token');
  return data.access_token;
}

function buildShipTo(input: Record<string, unknown>, rawOrder: Record<string, any> | null) {
  const orderAddr = rawOrder?.ShippingAddress ?? rawOrder?.shippingAddress ?? null;
  if (orderAddr) {
    return {
      name: orderAddr.Name ?? orderAddr.name ?? 'Buyer',
      addressLine1: orderAddr.AddressLine1 ?? orderAddr.addressLine1 ?? '',
      addressLine2: orderAddr.AddressLine2 ?? orderAddr.addressLine2 ?? '',
      city: orderAddr.City ?? orderAddr.city ?? '',
      stateOrRegion: orderAddr.StateOrRegion ?? orderAddr.stateOrRegion ?? '',
      postalCode: orderAddr.PostalCode ?? orderAddr.postalCode ?? '',
      countryCode: orderAddr.CountryCode ?? orderAddr.countryCode ?? 'US',
      phoneNumber: orderAddr.Phone ?? orderAddr.phone ?? '0000000000',
    };
  }

  return {
    name: 'Buyer',
    addressLine1: '1 Main St',
    city: 'Oakland',
    stateOrRegion: 'CA',
    postalCode: String(input.toZip || '94601').replace(/[^0-9]/g, '').slice(0, 5),
    countryCode: 'US',
    phoneNumber: '0000000000',
  };
}

async function ratesFromAmazonBuyShipping(input: Record<string, unknown>): Promise<Rate[]> {
  const signal = input.signal as AbortSignal | undefined;
  assertUnsupportedShippingOptions('Amazon Shipping', input, { confirmation: ['delivery', 'none'], insurance: false });
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const rawOrder = input.rawOrder && typeof input.rawOrder === 'object'
    ? input.rawOrder as Record<string, any>
    : null;

  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  if (!dimsL || !dimsW || !dimsH) {
    throw new Error('Amazon Buy Shipping requires box dimensions (length, width, height). Set them in the Rate Browser before fetching rates.');
  }

  const accessToken = await getAmazonLwaAccessToken(creds, signal);
  // Canonical origin (was FULLY hardcoded to a Carson/"Warehouse" default — never read
  // input.shipFrom, so every Amazon quote shipped from the wrong origin).
  const from = readShipFrom(input.shipFrom as Record<string, unknown>, creds, input.fromZip);
  const shipFrom = {
    name: from.name,
    addressLine1: from.line1,
    ...(from.line2 ? { addressLine2: from.line2 } : {}),
    city: from.city,
    stateOrRegion: from.state,
    postalCode: from.postalCode,
    countryCode: from.country,
    phoneNumber: from.phone,
  };

  const weightOz = Number(input.weightOz ?? 0);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const packages = [
    {
      packageClientReferenceId: '1',
      dimensions: {
        length: dimsL,
        width: dimsW,
        height: dimsH,
        unit: 'INCH',
      },
      weight: { value: weightLb, unit: 'POUND' },
    },
  ];

  const externalOrderId = typeof input.externalOrderId === 'string' ? input.externalOrderId : '';
  const isAmazonOrder = externalOrderId.startsWith('amazon-');
  const amazonOrderId = isAmazonOrder ? externalOrderId.slice('amazon-'.length) : null;
  const channelDetails = isAmazonOrder
    ? { channelType: 'AMAZON', amazonOrderDetails: { amazonOrderId } }
    : { channelType: 'EXTERNAL' };

  const body = {
    shipDate: new Date().toISOString(),
    shipFrom,
    shipTo: buildShipTo(input, rawOrder),
    packages,
    channelDetails,
  };

  const url = 'https://sellingpartnerapi-na.amazon.com/shipping/v2/shipments/rates';
  const apiRes = await timedFetch('amazon-shipping.rates', url, {
    method: 'POST',
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!apiRes.ok) {
    const text = await apiRes.text().then((s) => s.slice(0, 800)).catch(() => '');
    const sentSummary = {
      hasShipFrom: true,
      hasShipTo: true,
      packageCount: packages.length,
      channelType: channelDetails.channelType,
      shipFromKeys: Object.keys(shipFrom),
      shipToKeys: Object.keys(body.shipTo),
    };
    throw new Error(
      `Amazon Buy Shipping ${apiRes.status}: ${text || apiRes.statusText} | sent: ${JSON.stringify(sentSummary)}`,
    );
  }

  const data = (await apiRes.json()) as any;
  const flat: any[] = [];
  if (Array.isArray(data?.rates)) flat.push(...data.rates);
  if (Array.isArray(data?.payload?.rates)) flat.push(...data.payload.rates);
  if (Array.isArray(data?.rateGroups)) {
    for (const group of data.rateGroups) {
      if (Array.isArray(group?.rates)) flat.push(...group.rates);
    }
  }
  if (Array.isArray(data?.payload?.rateGroups)) {
    for (const group of data.payload.rateGroups) {
      if (Array.isArray(group?.rates)) flat.push(...group.rates);
    }
  }

  return flat
    .map((rate: any) => {
      const carrier = String(rate?.carrierName ?? rate?.carrier?.name ?? rate?.carrier ?? 'Amazon');
      const serviceName = String(rate?.serviceName ?? rate?.service?.name ?? rate?.serviceLevel ?? '');
      const service = serviceName ? `${carrier} ${serviceName}` : carrier;
      const cost = Number(
        rate?.totalCharge?.value ??
          rate?.totalCharge?.amount ??
          rate?.billedWeight?.value ??
          rate?.amount ??
          0,
      );
      const currency = String(
        rate?.totalCharge?.unit ?? rate?.totalCharge?.currency ?? rate?.currency ?? 'USD',
      );
      const promise = rate?.promise?.deliveryWindow ?? rate?.promise ?? null;
      const endDate = promise?.end ?? promise?.latest ?? null;
      const days = endDate
        ? Math.max(1, Math.round((new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : 0;
      return { service, cost, days, currency };
    })
    .filter((rate) => rate.cost > 0);
}

export function createAmazonShippingCarrierConnector(): CarrierConnector {
  return {
    provider: 'amazon_shipping',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromAmazonBuyShipping,
    createLabel: async () => {
      throw new Error('Amazon Shipping labels are not implemented in the connector yet');
    },
  };
}

export const amazonShippingCarrierConnector = createAmazonShippingCarrierConnector();
