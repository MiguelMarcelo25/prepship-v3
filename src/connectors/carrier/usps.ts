import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

const USPS_MAIL_CLASSES = [
  { class: 'USPS_GROUND_ADVANTAGE', label: 'USPS Ground Advantage' },
  { class: 'PRIORITY_MAIL', label: 'USPS Priority Mail' },
  { class: 'PRIORITY_MAIL_EXPRESS', label: 'USPS Priority Mail Express' },
] as const;

async function getUspsAccessToken(creds: Record<string, unknown>): Promise<string> {
  const consumerKey = String(creds?.consumerKey ?? '').trim();
  const consumerSecret = String(creds?.consumerSecret ?? '').trim();
  if (!consumerKey || !consumerSecret) {
    throw new Error('USPS consumerKey and consumerSecret are required');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: consumerKey,
    client_secret: consumerSecret,
  });
  const res = await timedFetch('usps.token', 'https://apis.usps.com/oauth2/v3/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`USPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('USPS OAuth response missing access_token');
  return data.access_token;
}

async function ratesFromUsps(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  if (!input.toZip) throw new Error('toZip is required for USPS rate quotes');

  const token = await getUspsAccessToken(creds);
  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.0625, Math.round((weightOz / 16) * 100) / 100);
  const fromZip = String(input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);
  const length = Number(input.dimsL ?? 6);
  const width = Number(input.dimsW ?? 6);
  const height = Number(input.dimsH ?? 4);

  const results = await Promise.all(
    USPS_MAIL_CLASSES.map(async ({ class: mailClass, label }) => {
      try {
        const body = {
          originZIPCode: fromZip,
          destinationZIPCode: toZip,
          weight: weightLb,
          length,
          width,
          height,
          mailClass,
          processingCategory: 'MACHINABLE',
          rateIndicator: 'DR',
          destinationEntryFacilityType: 'NONE',
          priceType: 'COMMERCIAL',
        };
        const res = await timedFetch('usps.rates', 'https://apis.usps.com/prices/v3/base-rates/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as any;
        const rates: any[] = Array.isArray(data?.rates) ? data.rates : (data?.rate ? [data.rate] : []);
        if (rates.length === 0) {
          const directPrice = Number(data?.totalBasePrice ?? data?.price ?? 0);
          if (directPrice > 0) {
            return { service: label, cost: directPrice, days: 0, currency: 'USD' };
          }
          return null;
        }
        const cheapest = rates
          .map((rate: any) => Number(rate?.price ?? rate?.totalBasePrice ?? 0))
          .filter((value: number) => value > 0)
          .sort((a: number, b: number) => a - b)[0];
        if (!cheapest) return null;
        const days = Number(rates[0]?.deliveryDays ?? 0) || 0;
        return { service: label, cost: cheapest, days, currency: 'USD' };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((rate): rate is NonNullable<typeof rate> => rate !== null);
}

export function createUspsCarrierConnector(): CarrierConnector {
  return {
    provider: 'usps',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: ratesFromUsps,
    createLabel: async () => {
      throw new Error('USPS labels are not implemented yet');
    },
  };
}

export const uspsCarrierConnector = createUspsCarrierConnector();
