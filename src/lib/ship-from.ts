import { env } from './env';
import type { Address } from './shipstation/types';
import { getDefaultLocation } from '../services/locations';

const FALLBACK_SHIP_FROM_PHONE = '3103295555';

function fallbackPhone(): string {
  return env.SHIP_FROM_PHONE || FALLBACK_SHIP_FROM_PHONE;
}

function fromEnv(): Address {
  const e = env;
  const missing: string[] = [];
  if (!e.SHIP_FROM_NAME) missing.push('SHIP_FROM_NAME');
  if (!e.SHIP_FROM_STREET1) missing.push('SHIP_FROM_STREET1');
  if (!e.SHIP_FROM_CITY) missing.push('SHIP_FROM_CITY');
  if (!e.SHIP_FROM_STATE) missing.push('SHIP_FROM_STATE');
  if (!e.SHIP_FROM_POSTAL_CODE) missing.push('SHIP_FROM_POSTAL_CODE');
  if (missing.length) {
    throw new Error(
      `Default ship-from address is not configured. Set a default Location in the UI, or set env vars: ${missing.join(', ')}`
    );
  }
  return {
    name: e.SHIP_FROM_NAME!,
    company_name: e.SHIP_FROM_COMPANY || undefined,
    phone: fallbackPhone(),
    address_line1: e.SHIP_FROM_STREET1!,
    address_line2: e.SHIP_FROM_STREET2 || undefined,
    city_locality: e.SHIP_FROM_CITY!,
    state_province: e.SHIP_FROM_STATE!,
    postal_code: e.SHIP_FROM_POSTAL_CODE!,
    country_code: e.SHIP_FROM_COUNTRY,
  };
}

export async function getDefaultShipFrom(): Promise<Address> {
  try {
    const loc = await getDefaultLocation();
    if (loc) {
      const missing: string[] = [];
      if (!loc.street1) missing.push('street1');
      if (!loc.city) missing.push('city');
      if (!loc.state) missing.push('state');
      if (!loc.postalCode) missing.push('postalCode');
      if (missing.length) {
        throw new Error(
          `Default location "${loc.name}" is missing required fields: ${missing.join(', ')}`
        );
      }
      return {
        name: loc.name,
        company_name: loc.company ?? undefined,
        phone: loc.phone || fallbackPhone(),
        address_line1: loc.street1!,
        address_line2: loc.street2 ?? undefined,
        city_locality: loc.city!,
        state_province: loc.state!,
        postal_code: loc.postalCode!,
        country_code: loc.country,
      };
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Default location')) {
      throw err;
    }
    // DB fetch failed — fall through to env fallback
  }
  return fromEnv();
}
