/**
 * PS-276 (slice 2a) guard — address_classifications cache infra.
 *
 * Pins: (1) the address key is deterministic + normalized (same physical address -> same
 * row; missing street/zip -> null so we never key on an ambiguous address); (2) the table
 * is managed by a runtime ensure + hand-written migration and is NOT in drizzle.config.ts
 * / schema index (the 500-before-migration-safe pattern, like shipment_tracking_status);
 * (3) get/set are best-effort (a cache outage never throws into a quote).
 *
 *   npx tsx scripts/ps-276-address-classification-cache-guard.ts
 */
import { readFileSync } from 'node:fs';
import { addressClassificationKey } from '../src/services/shipping-workflow/address-classification-cache';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. Deterministic + normalized key ─────────────────────────────────────────
const a = addressClassificationKey({ street1: '123 Main St.', state: 'TX', postalCode: '77422', country: 'US' });
const b = addressClassificationKey({ street1: ' 123   main  st ', state: 'tx', postalCode: '77422-0000', country: 'us' });
check('key is produced for a complete address', typeof a === 'string' && a!.length > 0);
check('same physical address normalizes to the SAME key (case/space/punct/zip+4)',
  a !== null && a === addressClassificationKey({ street1: '123 MAIN ST', state: 'TX', postalCode: '77422', country: 'US' }));
// 77422 vs 77422-0000 differ on the +4 (exact ZIP), which is intentional — keep them distinct.
check('zip+4 participates in the key (77422 vs 77422-0000 are distinct addresses)', a !== b);
check('different street -> different key',
  a !== addressClassificationKey({ street1: '125 Main St', state: 'TX', postalCode: '77422', country: 'US' }));
check('missing street -> null (never key on an ambiguous address)',
  addressClassificationKey({ street1: '', state: 'TX', postalCode: '77422', country: 'US' }) === null);
check('missing zip -> null', addressClassificationKey({ street1: '123 Main St', state: 'TX', postalCode: '', country: 'US' }) === null);
check('country defaults to US + is upcased in the key', (a ?? '').startsWith('US|'));
const ca = addressClassificationKey({ street1: '1 Yonge', state: 'ON', postalCode: 'K1A 0B1', country: 'CA' });
check('non-US postal preserved (never truncated)', (ca ?? '').includes('K1A 0B1'));

// ── 2. The 500-before-migration-safe pattern ──────────────────────────────────
const schema = readFileSync('src/db/schema/address-classifications.ts', 'utf8');
const svc = readFileSync('src/services/shipping-workflow/address-classification-cache.ts', 'utf8');
const migration = readFileSync('drizzle/0048_address_classifications.sql', 'utf8');
const drizzleConfig = readFileSync('drizzle.config.ts', 'utf8');
const schemaIndex = readFileSync('src/db/schema/index.ts', 'utf8');

check('schema declares the address-keyed table (addressKey PK + expires index)',
  /pgTable\(\s*'address_classifications'/.test(schema) &&
    /addressKey: text\(\)\.primaryKey\(\)/.test(schema) &&
    /address_classifications_expires_idx/.test(schema));
check('runtime ensure exists with the lazy-Promise + reset-on-error pattern',
  /export async function ensureAddressClassificationsSchema/.test(svc) &&
    /schemaEnsured \?\?=/.test(svc) &&
    /schemaEnsured = null;/.test(svc) &&
    /CREATE TABLE IF NOT EXISTS address_classifications/.test(svc) &&
    /ENABLE ROW LEVEL SECURITY/.test(svc));
check('hand-written migration mirrors the ensure (idempotent CREATE TABLE IF NOT EXISTS)',
  /CREATE TABLE IF NOT EXISTS address_classifications/.test(migration) &&
    /ENABLE ROW LEVEL SECURITY/.test(migration));
check('NOT in drizzle.config.ts (managed by runtime ensure + hand-written SQL — 500-safe)',
  !/address-classifications/.test(drizzleConfig));
check('NOT re-exported from schema/index.ts (service imports it directly)',
  !/address-classifications/.test(schemaIndex));

// ── 3. Best-effort: get/set never throw into a quote ──────────────────────────
check('getCachedAddressClassification swallows errors (returns null on outage)',
  /export async function getCachedAddressClassification[\s\S]{0,900}?catch \{\s*return null;/.test(svc));
check('setCachedAddressClassification swallows errors (best-effort upsert)',
  /export async function setCachedAddressClassification[\s\S]{0,1400}?catch \{/.test(svc));
check('set upserts (onConflictDoUpdate) — refresh updates in place', /onConflictDoUpdate\(/.test(svc));

// ── 4. package.json wiring ────────────────────────────────────────────────────
check('package.json wires test:ps-276-address-classification-cache',
  /test:ps-276-address-classification-cache/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 address-classification cache guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 address-classification cache guard');
