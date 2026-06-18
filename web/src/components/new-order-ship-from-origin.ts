/**
 * PS-291 — resolve the operator-selected Ship-From origin for the New Order
 * modal's rate preview.
 *
 * The backend rate quoter (src/connectors/carrier/ship-from-address.ts
 * readShipFrom) remains the source of truth for origin resolution. This helper
 * is a thin FE selector: it turns the operator's choice (a saved location OR a
 * typed custom origin) into the camelCase `shipFrom` shape readShipFrom already
 * tolerates (street1/city/state/postalCode/country) plus a 5-digit fromZip.
 * It NEVER computes a rate, price, or insurance verdict.
 */

export interface ShipFromOrigin {
  /** Free-form first address line. */
  street1: string;
  city: string;
  /** 2-letter state/province (US/CA). */
  state: string;
  /** Postal/ZIP, trimmed (the backend re-normalizes to 5 digits). */
  postalCode: string;
  /** ISO-2 country, upper-cased. */
  country: string;
}

export interface CustomOriginFields {
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/**
 * Resolve the selected origin from one of three sources, in priority order:
 *   1. A custom origin the operator typed (when `useCustom` is on).
 *   2. A saved location the operator picked (matched by locationId/id).
 *   3. The `fallbackZip` (legacy default) — postal only, no street/city/state.
 */
export function resolveShipFromOrigin(input: {
  useCustom: boolean;
  custom: CustomOriginFields;
  locations: Array<Record<string, any>>;
  selectedLocationId: string;
  fallbackZip: string;
}): ShipFromOrigin {
  const { useCustom, custom, locations, selectedLocationId, fallbackZip } = input;

  if (useCustom) {
    return {
      street1: (custom.street1 ?? '').trim(),
      city: (custom.city ?? '').trim(),
      state: (custom.state ?? '').trim(),
      postalCode: (custom.zip ?? '').trim(),
      country: ((custom.country ?? 'US').trim() || 'US').toUpperCase(),
    };
  }

  const match = (Array.isArray(locations) ? locations : []).find(
    (loc) => String(loc?.locationId ?? loc?.id ?? '') === String(selectedLocationId),
  );
  if (selectedLocationId && match) {
    return {
      street1: String(match.street1 ?? match.address1 ?? '').trim(),
      city: String(match.city ?? '').trim(),
      state: String(match.state ?? '').trim(),
      postalCode: String(match.postalCode ?? match.zip ?? '').trim(),
      country: (String(match.country ?? 'US').trim() || 'US').toUpperCase(),
    };
  }

  return {
    street1: '',
    city: '',
    state: '',
    postalCode: (fallbackZip ?? '').trim(),
    country: 'US',
  };
}
