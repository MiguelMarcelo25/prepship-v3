/**
 * PS-291 (card DoD #2) — keep a typed custom Ship-From origin as a SAVED location.
 *
 * The backend `POST /locations` route (src/routes/locations.ts) + the `locations`
 * table remain the source of truth for saved Ship-From locations. This is a thin
 * FE pair of pure functions: a predicate that decides whether the operator opted
 * in, and a builder that shapes the typed custom-origin fields + a nickname into
 * that route's zod body. It NEVER computes a rate, price, or insurance verdict —
 * it only persists an address the operator chose to keep.
 */
import type { CustomOriginFields } from './new-order-ship-from-origin';

export interface SaveLocationBody {
  name: string;
  street1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  // This body is handed to the loosely-typed apiClient.createLocation
  // (Record<string, unknown>) and serialized to JSON; the index signature makes
  // it assignable there without a cast. Named fields keep their checked types.
  [key: string]: unknown;
}

/**
 * True only when the operator is using a custom origin, ticked "Save this
 * location", named it, and typed at least a ZIP or a street — so an empty or
 * un-named origin never persists a junk row.
 */
export function shouldSaveCustomOrigin(input: {
  useCustom: boolean;
  save: boolean;
  name: string;
  custom: CustomOriginFields;
}): boolean {
  const { useCustom, save, name, custom } = input;
  if (!useCustom || !save) return false;
  if (!name.trim()) return false;
  return Boolean((custom.zip ?? '').trim() || (custom.street1 ?? '').trim());
}

/** Shape the nickname + typed custom origin into the canonical POST /locations body. */
export function buildSaveLocationBody(name: string, custom: CustomOriginFields): SaveLocationBody {
  return {
    name: name.trim(),
    street1: (custom.street1 ?? '').trim() || null,
    city: (custom.city ?? '').trim() || null,
    state: (custom.state ?? '').trim() || null,
    postalCode: (custom.zip ?? '').trim() || null,
    country: ((custom.country ?? 'US').trim() || 'US').toUpperCase(),
  };
}
