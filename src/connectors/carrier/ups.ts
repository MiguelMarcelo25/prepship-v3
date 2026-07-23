import type { CarrierConnector } from '../../domain/fulfillment/types.js';
import { timedFetch } from '../../lib/http/timing.js';
import { normalizeShippingOptions } from '../../lib/shipping-options.js';
import { readShipFrom } from './ship-from-address.js';

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

function upsPackageServiceOptions(input: Record<string, unknown>) {
  const options = normalizeShippingOptions(input.shippingOptions as Record<string, unknown> | undefined ?? input);
  const serviceOptions: Record<string, unknown> = {};
  if (options.confirmation === 'signature' || options.confirmation === 'direct_signature') {
    serviceOptions.DeliveryConfirmation = { DCISType: '2' };
  } else if (options.confirmation === 'adult_signature') {
    serviceOptions.DeliveryConfirmation = { DCISType: '3' };
  }
  if (options.insuranceProvider !== 'none' && options.insuredValue != null) {
    serviceOptions.DeclaredValue = {
      CurrencyCode: 'USD',
      MonetaryValue: options.insuredValue.toFixed(2),
    };
  }
  return Object.keys(serviceOptions).length ? serviceOptions : null;
}

async function getUpsAccessToken(creds: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
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
    signal,
  });
  if (!res.ok) {
    const t = await res.text().then((s) => s.slice(0, 300)).catch(() => '');
    throw new Error(`UPS OAuth ${res.status}: ${t || res.statusText}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token) throw new Error('UPS OAuth response missing access_token');
  return data.access_token;
}

export async function probeUpsCredentials(input: {
  clientId: string;
  clientSecret: string;
}): Promise<{
  ok: boolean;
  ups_status: number;
  ups_body: string;
  sent: {
    clientId_length: number;
    clientId_first6: string;
    clientId_last4: string;
    clientSecret_length: number;
    clientId_has_whitespace: boolean;
    clientSecret_has_whitespace: boolean;
  };
}> {
  const clientId = String(input.clientId ?? '').trim();
  const clientSecret = String(input.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new Error('UPS clientId and clientSecret are required');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const upsRes = await timedFetch('ups.credentials.probe', 'https://onlinetools.ups.com/security/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  });
  const upsBody = await upsRes.text();

  return {
    ok: upsRes.ok,
    ups_status: upsRes.status,
    ups_body: upsBody.slice(0, 800),
    sent: {
      clientId_length: clientId.length,
      clientId_first6: clientId.slice(0, 6),
      clientId_last4: clientId.slice(-4),
      clientSecret_length: clientSecret.length,
      clientId_has_whitespace: /\s/.test(clientId),
      clientSecret_has_whitespace: /\s/.test(clientSecret),
    },
  };
}

async function ratesFromUps(input: Record<string, unknown>): Promise<Array<{ service: string; cost: number; days: number; currency: string }>> {
  const signal = input.signal as AbortSignal | undefined;
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('UPS accountNumber is required');
  if (!input.toZip) throw new Error('toZip is required for UPS rate quotes');

  const token = await getUpsAccessToken(creds, signal);
  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const fromZip = String(input.fromZip || '90248').replace(/[^0-9]/g, '').slice(0, 5);
  const toZip = String(input.toZip).replace(/[^0-9]/g, '').slice(0, 5);
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  const packageServiceOptions = upsPackageServiceOptions(input);
  // PS-135(a): the PS-127 backend-classified residential flag, threaded via the connector input
  // (residential-safe default upstream). UPS treats it as presence-based on ShipTo.Address.
  const residential = input.residential === true;

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
          // PS-135(a): UPS ResidentialAddressIndicator is PRESENCE-based — the tag's mere existence
          // marks the destination residential (any value, incl 'Y', is ignored). Commercial = OMIT
          // the key entirely (there is NO 'N'/false form). Closes the UPS-native residential
          // surcharge gap for rate quotes (rate<->label parity with createLabelUps below).
          Address: {
            PostalCode: toZip,
            CountryCode: 'US',
            ...(residential ? { ResidentialAddressIndicator: 'Y' } : {}),
          },
        },
        Package: {
          PackagingType: { Code: '02' },
          ...(dims ? { Dimensions: dims } : {}),
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(weightLb),
          },
          ...(packageServiceOptions ? { PackageServiceOptions: packageServiceOptions } : {}),
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
    signal,
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

async function createLabelUps(input: Record<string, unknown>): Promise<{
  trackingNumber: string;
  labelUrl: string;
  cost: number;
  currency: string;
  raw: unknown;
}> {
  const creds = input.credentials && typeof input.credentials === 'object'
    ? input.credentials as Record<string, unknown>
    : {};
  const signal = input.signal as AbortSignal | undefined;
  const accountNumber = String(creds?.accountNumber ?? '').trim();
  if (!accountNumber) throw new Error('UPS accountNumber required');
  const token = await getUpsAccessToken(creds, signal);

  const weightOz = Number(input.weightOz ?? 16);
  const weightLb = Math.max(0.1, Math.round((weightOz / 16) * 10) / 10);
  const dimsL = Number(input.dimsL ?? 0);
  const dimsW = Number(input.dimsW ?? 0);
  const dimsH = Number(input.dimsH ?? 0);
  const serviceCode = String(input.serviceCode ?? '03');
  // Canonical origin read (snake_case Address read correctly; was `shipFrom.city/.zip`
  // etc. — camelCase that read undefined → UPS quoted/labeled from a blank/default origin).
  const from = readShipFrom(input.shipFrom as Record<string, unknown>, undefined, (input as { fromZip?: unknown }).fromZip);
  const shipTo = input.shipTo as Record<string, unknown>;
  const packageServiceOptions = upsPackageServiceOptions(input);
  // PS-135(a): accept the residential flag from the top-level input OR a stamped shipTo.residential
  // (parity with the ShipStation connector idiom). The decision is the PS-127 backend classification
  // resolved server-side at the label boundary; the connector is a thin consumer.
  const residential = input.residential === true || (shipTo as { residential?: unknown } | null)?.residential === true;

  const body = {
    ShipmentRequest: {
      Request: {
        SubVersion: '2403',
        RequestOption: 'nonvalidate',
        TransactionReference: { CustomerContext: 'prepship-label' },
      },
      Shipment: {
        Description: 'Merchandise',
        Shipper: {
          Name: from.name,
          AttentionName: from.name,
          ShipperNumber: accountNumber,
          Phone: { Number: from.phone || '0000000000' },
          Address: {
            AddressLine: [from.line1, from.line2].filter(Boolean),
            City: from.city,
            StateProvinceCode: from.state,
            PostalCode: from.postalCode,
            CountryCode: from.country,
          },
        },
        ShipTo: {
          Name: shipTo.name,
          AttentionName: shipTo.name,
          Phone: { Number: shipTo.phone || '0000000000' },
          Address: {
            AddressLine: [shipTo.street1, shipTo.street2].filter(Boolean),
            City: shipTo.city,
            StateProvinceCode: shipTo.state,
            PostalCode: shipTo.zip,
            CountryCode: shipTo.country,
            // PS-135(a): presence-based residential flag — include 'Y' for residential, OMIT for
            // commercial (no 'N'/false form). Changes the actual UPS label charge (residential
            // surcharge). residential is the PS-127 server-side classification (api/carriers/labels.ts).
            ...(residential ? { ResidentialAddressIndicator: 'Y' } : {}),
          },
        },
        ShipFrom: {
          Name: from.name,
          AttentionName: from.name,
          Phone: { Number: from.phone || '0000000000' },
          Address: {
            AddressLine: [from.line1, from.line2].filter(Boolean),
            City: from.city,
            StateProvinceCode: from.state,
            PostalCode: from.postalCode,
            CountryCode: from.country,
          },
        },
        PaymentInformation: {
          ShipmentCharge: {
            Type: '01',
            BillShipper: { AccountNumber: accountNumber },
          },
        },
        Service: { Code: serviceCode },
        Package: {
          Description: 'Merchandise',
          Packaging: { Code: '02' },
          Dimensions: {
            UnitOfMeasurement: { Code: 'IN' },
            Length: String(dimsL),
            Width: String(dimsW),
            Height: String(dimsH),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(weightLb),
          },
          ...(packageServiceOptions ? { PackageServiceOptions: packageServiceOptions } : {}),
        },
      },
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  };

  const res = await timedFetch('ups.labels', 'https://onlinetools.ups.com/api/shipments/v2403/ship', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      transId: `prepship-${Date.now().toString(36)}`,
      transactionSrc: 'prepship',
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* leave as text */ }
  if (!res.ok) {
    const errMsg = data?.response?.errors?.[0]?.message ?? text.slice(0, 600);
    throw new Error(`UPS Shipping ${res.status}: ${errMsg}`);
  }

  const shipResult = data?.ShipmentResponse?.ShipmentResults;
  const trackingNumber =
    shipResult?.PackageResults?.TrackingNumber ??
    shipResult?.PackageResults?.[0]?.TrackingNumber ??
    null;
  const labelImageBase64 =
    shipResult?.PackageResults?.ShippingLabel?.GraphicImage ??
    shipResult?.PackageResults?.[0]?.ShippingLabel?.GraphicImage ??
    null;
  const cost = Number(shipResult?.ShipmentCharges?.TotalCharges?.MonetaryValue ?? 0);
  const currency = String(shipResult?.ShipmentCharges?.TotalCharges?.CurrencyCode ?? 'USD');

  if (!trackingNumber) throw new Error('UPS Shipping response missing TrackingNumber');
  if (!labelImageBase64) throw new Error('UPS Shipping response missing label image');

  return {
    trackingNumber,
    labelUrl: `data:image/gif;base64,${labelImageBase64}`,
    cost,
    currency,
    raw: data,
  };
}

export function createUpsCarrierConnector(): CarrierConnector {
  return {
    provider: 'ups',
    capabilities: ['rates.quote', 'labels.create', 'tracking.read'],
    getRates: ratesFromUps,
    createLabel: createLabelUps,
  };
}

export const upsCarrierConnector = createUpsCarrierConnector();
