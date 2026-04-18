import { env } from './env';
import type { Address } from './shipstation/types';

export function getDefaultShipFrom(): Address {
  const e = env;
  const missing: string[] = [];
  if (!e.SHIP_FROM_NAME) missing.push('SHIP_FROM_NAME');
  if (!e.SHIP_FROM_STREET1) missing.push('SHIP_FROM_STREET1');
  if (!e.SHIP_FROM_CITY) missing.push('SHIP_FROM_CITY');
  if (!e.SHIP_FROM_STATE) missing.push('SHIP_FROM_STATE');
  if (!e.SHIP_FROM_POSTAL_CODE) missing.push('SHIP_FROM_POSTAL_CODE');
  if (!e.SHIP_FROM_PHONE) missing.push('SHIP_FROM_PHONE');
  if (missing.length) {
    throw new Error(
      `Default ship-from address is not configured. Missing env vars: ${missing.join(', ')}`
    );
  }

  return {
    name: e.SHIP_FROM_NAME!,
    company_name: e.SHIP_FROM_COMPANY || undefined,
    phone: e.SHIP_FROM_PHONE!,
    address_line1: e.SHIP_FROM_STREET1!,
    address_line2: e.SHIP_FROM_STREET2 || undefined,
    city_locality: e.SHIP_FROM_CITY!,
    state_province: e.SHIP_FROM_STATE!,
    postal_code: e.SHIP_FROM_POSTAL_CODE!,
    country_code: e.SHIP_FROM_COUNTRY,
  };
}
