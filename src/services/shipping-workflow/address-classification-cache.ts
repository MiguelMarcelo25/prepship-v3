// PS-276 (slice 2) — per-ADDRESS residential/commercial validation cache.
//
// Address-keyed store of carrier address-validation evidence (USPS business marker,
// UPS/FedEx provider verdict) so a repeat customer / reorder reuses one validation
// across orders and clients. The pure key builder is deterministic so the SAME
// physical address always maps to the SAME row. Read-on-miss is handled by the
// resolver (resolve-address-classification.ts, slice 2b); this module owns ONLY the
// table (ensure), the key, and get/set — no carrier calls, no classification policy.
//
// Lockdown: additive table only. No shipped/cancelled data, no shipments writes.
import { eq, inArray } from 'drizzle-orm';
import { db, sql as pg } from '../../db/client';
import {
  addressClassifications,
  type AddressClassificationRow,
  type NewAddressClassificationRow,
} from '../../db/schema/address-classifications';
import { normalizeShippingPostalCode } from './postal-code';

// ── Runtime schema ensure (mirrors drizzle/0048_address_classifications.sql; same
// pattern as shipment-tracking.ts so worker/API both work pre-migration). ──
let schemaEnsured: Promise<void> | null = null;

export async function ensureAddressClassificationsSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await pg`
      CREATE TABLE IF NOT EXISTS address_classifications (
        address_key text PRIMARY KEY,
        business boolean,
        provider_classification text,
        provider text,
        dpv_confirmation text,
        zip_plus4 text,
        carrier_route text,
        raw jsonb,
        resolved_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `;
    await pg`CREATE INDEX IF NOT EXISTS address_classifications_expires_idx ON address_classifications (expires_at)`;
    await pg`ALTER TABLE address_classifications ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
}

/** Default address-classification TTL: addresses rarely change resi/comm type. */
export const ADDRESS_CLASSIFICATION_TTL_DAYS = 90;

function normalizeStreet(value: string | null | undefined): string | null {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw || null;
}

/**
 * The deterministic per-address cache key: COUNTRY|ZIP(+4)|STATE|street1. Returns
 * null when street1 or postal code is missing (the caller then resolves fresh / skips
 * the cache rather than keying on an ambiguous address). Pure — safe to unit test.
 */
export function addressClassificationKey(input: {
  street1?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string | null {
  const street = normalizeStreet(input.street1);
  const { exact } = normalizeShippingPostalCode(input.postalCode, input.country);
  if (!street || !exact) return null;
  const state = String(input.state ?? '').trim().toUpperCase();
  const country = (String(input.country ?? '').trim().toUpperCase()) || 'US';
  return `${country}|${exact}|${state}|${street}`;
}

/** Read a non-expired cached classification by key. Best-effort: never throws into a quote. */
export async function getCachedAddressClassification(
  key: string | null,
): Promise<AddressClassificationRow | null> {
  if (!key) return null;
  try {
    await ensureAddressClassificationsSchema();
    const [row] = await db
      .select()
      .from(addressClassifications)
      .where(eq(addressClassifications.addressKey, key))
      .limit(1);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null; // expired -> miss
    return row;
  } catch {
    return null; // cache outage must never block a rate
  }
}

/**
 * Batch-read non-expired cached classifications by key (slice 2b-2c). One `IN (...)` query for a
 * whole orders page instead of N round-trips. Best-effort: a cache outage returns an empty Map so
 * the list render falls back to the override/heuristic verdict — it must NEVER block /orders.
 */
export async function getCachedAddressClassifications(
  keys: Array<string | null | undefined>,
): Promise<Map<string, AddressClassificationRow>> {
  const out = new Map<string, AddressClassificationRow>();
  const unique = Array.from(new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0)));
  if (unique.length === 0) return out;
  try {
    await ensureAddressClassificationsSchema();
    const rows = await db
      .select()
      .from(addressClassifications)
      .where(inArray(addressClassifications.addressKey, unique));
    const now = Date.now();
    for (const row of rows) {
      if (row.expiresAt && row.expiresAt.getTime() <= now) continue; // expired -> miss
      out.set(row.addressKey, row);
    }
  } catch {
    return out; // cache outage must never block the list
  }
  return out;
}

/** Upsert a resolved classification. Best-effort: a write failure just means the next call re-resolves. */
export async function setCachedAddressClassification(
  key: string | null,
  value: Omit<NewAddressClassificationRow, 'addressKey' | 'resolvedAt' | 'expiresAt'> & {
    ttlDays?: number;
  },
): Promise<void> {
  if (!key) return;
  const ttlDays = value.ttlDays ?? ADDRESS_CLASSIFICATION_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  try {
    await ensureAddressClassificationsSchema();
    await db
      .insert(addressClassifications)
      .values({
        addressKey: key,
        business: value.business ?? null,
        providerClassification: value.providerClassification ?? null,
        provider: value.provider ?? null,
        dpvConfirmation: value.dpvConfirmation ?? null,
        zipPlus4: value.zipPlus4 ?? null,
        carrierRoute: value.carrierRoute ?? null,
        raw: value.raw ?? null,
        resolvedAt: new Date(),
        expiresAt,
      })
      .onConflictDoUpdate({
        target: addressClassifications.addressKey,
        set: {
          business: value.business ?? null,
          providerClassification: value.providerClassification ?? null,
          provider: value.provider ?? null,
          dpvConfirmation: value.dpvConfirmation ?? null,
          zipPlus4: value.zipPlus4 ?? null,
          carrierRoute: value.carrierRoute ?? null,
          raw: value.raw ?? null,
          resolvedAt: new Date(),
          expiresAt,
        },
      });
  } catch {
    /* best-effort: a write failure just means the next call re-resolves */
  }
}

/** Manual refresh / invalidation hook (operator-triggered re-validation). */
export async function invalidateAddressClassification(key: string | null): Promise<void> {
  if (!key) return;
  try {
    await ensureAddressClassificationsSchema();
    await db.delete(addressClassifications).where(eq(addressClassifications.addressKey, key));
  } catch {
    /* best-effort */
  }
}
