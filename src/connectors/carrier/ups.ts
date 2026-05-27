import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Saver',
  '92': 'UPS Ground Saver',
  '93': 'UPS SurePost 1 lb or Greater',
};

async function getUpsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const clientId = String(creds?.clientId ?? '').trim();
  const clientSecret = String(creds?.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('UPS clientId and clientSecret are required');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await timedFetch('ups.token', 'https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`UPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('UPS OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromUps(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('UPS accountNumber is required');
  if (!input.toZip) throw new Error('toZip is required for UPS rate quotes');

  const token = await getUpsAccessToken(creds);
  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const fromZip = String(input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);

  const dims = (dimsL > 0 && dimsW > 0 && dimsH > 0)
    ? {
        UnitOfMeasurement: { Code: 'IN' },
        Length: String(dimsL),
        Width: String(dimsW),
        Height: String(dimsH),
      }
    : undefined;

  const body = {
    RateRequest: {
      Request: {
        TransactionReference: { CustomerContext: 'prepship-rates' },
        RequestOption: 'Shop',
      },
      Shipment: {
        Shipper: {
          ShipperNumber: accountNumber,
          Address: { PostalCode: fromZip, CountryCode: 'US' },
        },
        ShipFrom: {
          Address: { PostalCode: fromZip, CountryCode: 'US' },
        },
        ShipTo: {
          Address: { PostalCode: toZip, CountryCode: 'US' },
        },
        Package: {
          PackagingType: { Code: '02' },
          ...(dims ? { Dimensions: dims } : {}),
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(weightLb),
          },
        },
      },
    },
  };

  const res = await timedFetch('ups.rates', 'https://onlinetools.ups.com/api/rating/v2403/Shop', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      transId: `prepship-${Date.now().toString(36)}`,
      transactionSrc: 'prepship',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`UPS Rating ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as {
    RateResponse?: {
      RatedShipment?: Array<{
        Service?: { Code?: string; Description?: string };
        TotalCharges?: { MonetaryValue?: string; CurrencyCode?: string };
        GuaranteedDelivery?: { BusinessDaysInTransit?: string };
      } | undefined> | { Service?: unknown } | undefined;
    };
  };
  const rated = data?.RateResponse?.RatedShipment;
  const list: any[] = Array.isArray(rated) ? rated : rated ? [rated] : [];

  return list.map((row: any) => {
    const code = String(row?.Service?.Code ?? '');
    const service = UPS_SERVICE_NAMES[code]
      ?? row?.Service?.Description
      ?? `UPS Service ${code || '?'}`;
    const cost = Number(row?.TotalCharges?.MonetaryValue ?? 0);
    const currency = String(row?.TotalCharges?.CurrencyCode ?? 'USD');
    const days = Number(row?.GuaranteedDelivery?.BusinessDaysInTransit ?? 0) || 0;
    return { service, cost, days, currency };
  }).filter((r) => r.cost > 0);
}

export function createUpsCarrierConnector(): CarrierConnector {
  return {
    provider: 'ups',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: ratesFromUps,
    createLabel: async () => {
      throw new Error('UPS labels are handled by api/carriers/labels.ts');
    },
  };
}

export const upsCarrierConnector = createUpsCarrierConnector();
