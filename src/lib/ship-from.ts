import { env } from './env.js';
import type { Address } from './shipstation/types.js';
import { getDefaultLocation } from '../services/locations.js';

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

/**
 * PS-474: guarantee a non-empty ship-from phone on ANY origin address.
 *
 * getDefaultShipFrom always sets one, but a caller-supplied origin skips it
 * entirely -- rates.ts resolves `input.shipFrom ?? await getDefaultShipFrom()`,
 * and /rates accepts shipFrom as `z.object({}).catchall(z.unknown())`, so a
 * Ship From picked in the Rate Browser arrives with whatever fields it happens
 * to have. Address.phone is optional, so no type error, no validation error --
 * it just goes out empty.
 *
 * That was invisible until hazmat, because the two paths send different bodies:
 * a normal quote uses /v2/rates/estimate, which carries postal codes and NO
 * addresses, while an active declaration switches to a full /v2/rates shipment.
 * Only then does the origin phone reach ShipStation, which answered:
 *
 *   HTTP 400 — 'phone' should not be empty.
 *
 * Normalising here rather than at the hazmat body keeps one owner for the rule:
 * every consumer of a ship-from gets a usable phone, not just the caller that
 * happened to hit the failure.
 */
export function withShipFromPhone(address: Address): Address {
  const phone = String(address.phone ?? '').trim();
  return phone ? address : { ...address, phone: fallbackPhone() };
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
