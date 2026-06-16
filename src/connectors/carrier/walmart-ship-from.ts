// Walmart-shaped ship-from. Delegates the actual origin resolution to the SINGLE
// canonical reader (readShipFrom) so Walmart can never drift from the other connectors
// or reintroduce the snake_case/camelCase misread (the Carson-default bug class). This
// module only maps the neutral normalized shape to Walmart's estimate/label fields.
import { readShipFrom } from './ship-from-address.js';

export type WalmartFromAddress = {
  name: string;
  addressLines: string[];
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  phone: string;
};

export function resolveWalmartShipFrom(
  shipFrom: Record<string, unknown> | null | undefined,
  creds: Record<string, unknown> | null | undefined,
  fallbackZip?: unknown,
): WalmartFromAddress {
  const a = readShipFrom(shipFrom, creds, fallbackZip);
  return {
    name: a.name,
    addressLines: [a.line1, a.line2].filter(Boolean),
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    countryCode: a.country,
    phone: a.phone,
  };
}
