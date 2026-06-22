import type { Address } from '../../lib/shipstation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function upperText(value: string | null, fallback: string): string {
  return (value ?? fallback).trim().toUpperCase();
}

function readAddressResidentialIndicator(value: unknown): Address['address_residential_indicator'] | undefined {
  const text = firstText(value)?.toLowerCase();
  return text === 'yes' || text === 'no' || text === 'unknown' ? text : undefined;
}

/**
 * PS-291: normalize manual/rate-browser origin hints at the backend boundary.
 *
 * Frontend callers may send v2-style `fromZip` and camelCase `shipFrom`
 * (`street1`, `postalCode`, `country`). ShipStation's rate owner reads the
 * canonical v4 address shape (`address_line1`, `postal_code`, `country_code`),
 * while direct-carrier connectors tolerate both. Normalize once before calling
 * the rate service so every carrier quotes from the same selected origin.
 */
export function normalizeRateShipFromOrigin<T extends { fromZip?: unknown; shipFrom?: unknown }>(
  input: T,
): Omit<T, 'shipFrom'> & { shipFrom?: Address } {
  const from = isRecord(input.shipFrom) ? input.shipFrom : {};
  const postalCode = firstText(
    from.postal_code,
    from.postalCode,
    from.zip,
    from.postal,
    input.fromZip,
  );

  if (!postalCode) {
    const { shipFrom: _shipFrom, ...rest } = input;
    return rest;
  }

  const address: Address = {
    postal_code: postalCode ?? '',
    country_code: upperText(firstText(from.country_code, from.country), 'US'),
  };
  const name = firstText(from.name);
  const company = firstText(from.company_name, from.company);
  const phone = firstText(from.phone);
  const address1 = firstText(from.address_line1, from.street1, from.address1, from.address);
  const address2 = firstText(from.address_line2, from.street2, from.address2);
  const address3 = firstText(from.address_line3, from.street3, from.address3);
  const city = firstText(from.city_locality, from.city);
  const state = firstText(from.state_province, from.state);
  const residential = readAddressResidentialIndicator(from.address_residential_indicator);

  if (name) address.name = name;
  if (company) address.company_name = company;
  if (phone) address.phone = phone;
  if (address1) address.address_line1 = address1;
  if (address2) address.address_line2 = address2;
  if (address3) address.address_line3 = address3;
  if (city) address.city_locality = city;
  if (state) address.state_province = state;
  if (residential) address.address_residential_indicator = residential;

  return {
    ...input,
    shipFrom: address,
  };
}
