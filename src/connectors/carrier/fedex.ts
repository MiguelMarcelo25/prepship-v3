import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

const FEDEX_SERVICE_NAMES: Record<string, string> = {
  FEDEX_GROUND: 'FedEx Ground',
  GROUND_HOME_DELIVERY: 'FedEx Home Delivery',
  FEDEX_2_DAY: 'FedEx 2Day',
  FEDEX_2_DAY_AM: 'FedEx 2Day AM',
  FEDEX_EXPRESS_SAVER: 'FedEx Express Saver',
  STANDARD_OVERNIGHT: 'FedEx Standard Overnight',
  PRIORITY_OVERNIGHT: 'FedEx Priority Overnight',
  FIRST_OVERNIGHT: 'FedEx First Overnight',
  FEDEX_FIRST_FREIGHT: 'FedEx First Freight',
  INTERNATIONAL_PRIORITY: 'FedEx International Priority',
  INTERNATIONAL_ECONOMY: 'FedEx International Economy',
  FEDEX_INTERNATIONAL_GROUND: 'FedEx International Ground',
  SMART_POST: 'FedEx SmartPost',
};

async function getFedexAccessToken(creds: Record<string, unknown>): Promise<string> {
  const apiKey = String(creds?.apiKey ?? '').trim();
  const apiSecret = String(creds?.apiSecret ?? '').trim();
  if (!apiKey || !apiSecret) {
    throw new Error('FedEx apiKey and apiSecret are required');
  }
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const tokenUrl = useSandbox
    ? 'https://apis-sandbox.fedex.com/oauth/token'
    : 'https://apis.fedex.com/oauth/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  });
  const res = await timedFetch('fedex.token', tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`FedEx OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data?.access_token) throw new Error('FedEx OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromFedex(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('FedEx accountNumber is required');
  if (!input.toZip) throw new Error('toZip is required for FedEx rate quotes');

  const token = await getFedexAccessToken(creds);
  const useSandbox = String(creds?.sandbox ?? '').toLowerCase() === 'true';
  const ratesUrl = useSandbox
    ? 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes'
    : 'https://apis.fedex.com/rate/v1/rates/quotes';

  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const fromZip = String(input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);

  const pkg: Record<string, unknown> = {
    weight: { units: 'LB', value: weightLb },
  };
  if (dimsL > 0 && dimsW > 0 && dimsH > 0) {
    pkg.dimensions = {
      length: dimsL,
      width: dimsW,
      height: dimsH,
      units: 'IN',
    };
  }

  const body = {
    accountNumber: { value: accountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: { address: { postalCode: fromZip, countryCode: 'US' } },
      recipient: { address: { postalCode: toZip, countryCode: 'US' } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT', 'LIST'],
      requestedPackageLineItems: [pkg],
    },
  };

  const res = await timedFetch('fedex.rates', ratesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-locale': 'en_US',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 600)).catch(() => '');
    throw new Error(`FedEx Rate ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json() as any;
  const replyDetails: any[] = Array.isArray(data?.output?.rateReplyDetails)
    ? data.output.rateReplyDetails
    : [];

  const transitDays: Record<string, number> = {
    ONE_DAY: 1, TWO_DAYS: 2, THREE_DAYS: 3, FOUR_DAYS: 4, FIVE_DAYS: 5,
    SIX_DAYS: 6, SEVEN_DAYS: 7, EIGHT_DAYS: 8, NINE_DAYS: 9, TEN_DAYS: 10,
    ELEVEN_DAYS: 11, TWELVE_DAYS: 12, THIRTEEN_DAYS: 13, FOURTEEN_DAYS: 14,
    FIFTEEN_DAYS: 15, SIXTEEN_DAYS: 16, SEVENTEEN_DAYS: 17, EIGHTEEN_DAYS: 18,
  };

  return replyDetails
    .map((detail: any) => {
      const code = String(detail?.serviceType ?? '');
      const service = FEDEX_SERVICE_NAMES[code]
        ?? detail?.serviceName
        ?? `FedEx ${code || '?'}`;
      const shipDetails = Array.isArray(detail?.ratedShipmentDetails)
        ? detail.ratedShipmentDetails
        : [];
      const charges = shipDetails
        .map((shipment: any) => Number(shipment?.totalNetCharge ?? shipment?.totalNetFedExCharge ?? 0))
        .filter((value: number) => value > 0)
        .sort((a: number, b: number) => a - b);
      const cost = charges[0] ?? 0;
      const currency = String(shipDetails[0]?.currency ?? 'USD');
      const transitKey = String(detail?.operationalDetail?.transitTime ?? '');
      const days = transitDays[transitKey] ?? 0;
      return { service, cost, days, currency };
    })
    .filter((rate) => rate.cost > 0);
}

export function createFedexCarrierConnector(): CarrierConnector {
  return {
    provider: 'fedex',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: ratesFromFedex,
    createLabel: async () => {
      throw new Error('FedEx labels are not implemented yet');
    },
  };
}

export const fedexCarrierConnector = createFedexCarrierConnector();
