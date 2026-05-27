import type { CarrierConnector } from '../../domain/fulfillment/types';
import { timedFetch } from '../../lib/http/timing';

type EasyPostRate = { service: string; cost: number; days: number; currency: string };

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

async function ratesFromEasyPost(input: Record<string, unknown>): Promise<EasyPostRate[]> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const apiKey = firstString(creds.apiKey);
  if (!apiKey) {
    throw new Error('EasyPost requires apiKey on the carrier_account credentials.');
  }
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  if (!dimsL || !dimsW || !dimsH) {
    throw new Error('EasyPost rate quotes require box dimensions (length, width, height).');
  }

  const basic = Buffer.from(`${apiKey}:`).toString('base64');
  const credShipFromZip = firstString(creds.shipFromZip).replace(/[^0-9]/g, '').slice(0, 5);
  const fromZip = credShipFromZip || firstString(input.fromZip, '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const fromAddress = {
    name: firstString(creds.shipFromName, 'Seller'),
    street1: firstString(creds.shipFromAddress1, 'Warehouse'),
    city: firstString(creds.shipFromCity, 'Carson'),
    state: firstString(creds.shipFromState, 'CA'),
    zip: fromZip,
    country: 'US',
    phone: firstString(creds.shipFromPhone, '0000000000'),
  };

  const rawOrder = input.rawOrder as any;
  const orderAddr =
    rawOrder?.shippingInfo?.postalAddress ??
    rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress ??
    rawOrder?.ShippingAddress ??
    null;
  const toAddress = orderAddr
    ? {
        name: firstString(orderAddr.name, orderAddr.fullName, orderAddr.Name, 'Buyer'),
        street1: firstString(orderAddr.address1, orderAddr.addressLine1, orderAddr.AddressLine1),
        street2: firstString(orderAddr.address2, orderAddr.addressLine2, orderAddr.AddressLine2),
        city: firstString(orderAddr.city, orderAddr.City),
        state: firstString(orderAddr.state, orderAddr.stateOrProvince, orderAddr.StateOrRegion),
        zip: firstString(orderAddr.postalCode, orderAddr.PostalCode),
        country: firstString(orderAddr.country, orderAddr.countryCode, orderAddr.CountryCode, 'US'),
        phone: firstString(orderAddr.phone, orderAddr.Phone, '0000000000'),
      }
    : {
        name: 'Buyer',
        street1: '1 Main St',
        city: 'Oakland',
        state: 'CA',
        zip: firstString(input.toZip, '94601').replace(/[^0-9]/g, '').slice(0, 5),
        country: 'US',
        phone: '0000000000',
      };

  const body = {
    shipment: {
      from_address: fromAddress,
      to_address: toAddress,
      parcel: {
        length: dimsL,
        width: dimsW,
        height: dimsH,
        weight: Number(input.weightOz ?? 16),
      },
    },
  };

  const res = await timedFetch('easypost.rates', 'https://api.easypost.com/v2/shipments', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 800)).catch(() => '');
    throw new Error(`EasyPost ${res.status}: ${t || res.statusText}`);
  }
  const data = await res.json() as any;
  const rateList: any[] = Array.isArray(data?.rates) ? data.rates : [];

  return rateList
    .map((r: any) => ({
      service: `${r.carrier ?? 'EasyPost'} ${r.service ?? ''}`.trim(),
      cost: Number(r.rate ?? 0),
      days: Number(r.delivery_days ?? r.est_delivery_days ?? 0) || 0,
      currency: String(r.currency ?? 'USD'),
    }))
    .filter((r) => r.cost > 0)
    .sort((a, b) => a.cost - b.cost);
}

export function createEasyPostCarrierConnector(): CarrierConnector {
  return {
    provider: 'easypost',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: ratesFromEasyPost,
    createLabel: async () => {
      throw new Error('EasyPost labels are handled by api/carriers/labels.ts');
    },
  };
}

export const easyPostCarrierConnector = createEasyPostCarrierConnector();
