/**
 * PS-276 (slice 2b-2c) guard — the Orders list DTO reads the resolver's address-classification cache
 * so each row's resi/comm TAG reflects the SAME resolved verdict the rate fingerprint used.
 *
 * Pins: (1) a BATCH cache reader exists (one IN(...) query, not N round-trips) and is best-effort;
 * (2) the list endpoint is ENV-GATED — it only reads the cache when ADDRESS_RESOLVER=on, so it's
 * inert (zero extra query) until DJ flips the flag; (3) it feeds the cached evidence THROUGH the
 * shared evidence owner (buildCanonicalOrderModel's resolvedResidential param), NOT a bespoke
 * classification — so the money-safe residentialForShipping policy still governs; (4) cache-ONLY on
 * the list path (no live USPS call), so the high-frequency /orders endpoint never fans out to USPS.
 *
 *   npx tsx scripts/ps-276-list-tag-parity-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const cache = readFileSync('src/services/shipping-workflow/address-classification-cache.ts', 'utf8');
const orders = readFileSync('src/routes/orders.ts', 'utf8');

// ── 1. Batch reader: one IN(...) query, best-effort (never throws into /orders) ───────────────
check('getCachedAddressClassifications is a batch reader using inArray (one query, not N)',
  /export async function getCachedAddressClassifications\(/.test(cache) &&
    /inArray\(addressClassifications\.addressKey, unique\)/.test(cache) &&
    /import \{ eq, inArray \} from 'drizzle-orm'/.test(cache));
check('batch reader is best-effort — a cache outage returns an empty Map (catch -> out)',
  /catch \{\s*\n\s*return out; \/\/ cache outage must never block the list/.test(cache));
check('batch reader drops expired rows (parity with the single-key reader)',
  /if \(row\.expiresAt && row\.expiresAt\.getTime\(\) <= now\) continue;/.test(cache));

// ── 2. List endpoint is ENV-GATED — only reads the cache when ADDRESS_RESOLVER=on ─────────────
check('orders list gates the cache read behind addressResolverMode() === \'on\' (inert when off)',
  /if \(addressResolverMode\(\) === 'on'\) \{/.test(orders) &&
    /const resolvedResidentialByOrderId = new Map<number, ResolvedAddressEvidence>\(\);/.test(orders));
check('orders list calls the BATCH reader (not a per-row read) for the page',
  /const cacheByKey = await getCachedAddressClassifications\(\[\.\.\.keyByOrderId\.values\(\)\]\);/.test(orders));

// ── 3. Feeds the SHARED owner (money-safe policy still governs), keyed per order ───────────────
check('list passes the cached evidence into buildCanonicalOrderModel\'s resolvedResidential param',
  /resolvedResidentialByOrderId\.get\(r\.order\.id\) \?\? null,/.test(orders) &&
    /resolvedResidentialByOrderId\.set\(orderId, evidenceFromCacheRow\(row\)\)/.test(orders));
check('list builds the key with the SAME deterministic addressClassificationKey owner',
  /const key = addressClassificationKey\(\{/.test(orders));

// ── 4. Cache-ONLY on the list path — NO live USPS call from /orders ───────────────────────────
check('orders list does NOT call resolveAddressClassification (no live USPS fan-out on the list)',
  !/resolveAddressClassification\(/.test(orders));

check('package.json wires test:ps-276-list-tag-parity',
  /test:ps-276-list-tag-parity/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-276 list-tag parity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-276 list-tag parity guard');
