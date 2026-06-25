/**
 * PS-183 guard — the rate freshness window (cacheExpiresAt) is backend-owned.
 *
 * THE BUG: OrdersView's withRateRequestMetadata unconditionally minted
 * `cacheExpiresAt = now + 6h` whenever the caller's metadata lacked one — i.e.
 * for every manual Rate Browser apply and most auto-rate persists. A FE-minted
 * window restarts the 6h clock at APPLY time instead of QUOTE time, making a
 * stale quote look fresh and silently diverging from the server's CACHE_TTL_MS
 * (the TTL the rate cache itself enforces).
 *
 * THE FIX:
 *   - /rates/browse stamps `cacheExpiresAt` (fetchedAt + CACHE_TTL_MS) on the
 *     response top level AND the best rate;
 *   - both apiClient metadata blocks (browseRates + fetchRates) pass it through
 *     (never minted client-side);
 *   - withRateRequestMetadata prefers the explicit metadata value, then the
 *     rate's backend-stamped expiry; the local mint survives ONLY as a warned,
 *     display-only last resort (purchase authority is untouched — proof and the
 *     server-side snapshot TTL never read this field).
 *
 *   npx tsx scripts/ps-183-backend-cache-ttl-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── backend stamps the expiry from the canonical TTL ─────────────────────────
const ratesRoute = readFileSync('src/routes/rates.ts', 'utf8');
check('browse computes cacheExpiresAt from fetchedAt + CACHE_TTL_MS',
  /browseCacheExpiresAt = new Date\(\s*new Date\(result\.fetchedAt\)\.getTime\(\) \+ CACHE_TTL_MS\s*\)\.toISOString\(\)/.test(ratesRoute));
check('payload carries the backend expiry top-level',
  /cacheExpiresAt: browseCacheExpiresAt,\s*\n\s*effectiveInsuranceProvider/.test(ratesRoute));
check('bestRate carries the backend expiry',
  /cacheCreatedAt: result\.fetchedAt,\s*\n\s*cacheExpiresAt: browseCacheExpiresAt/.test(ratesRoute));

// ── apiClient passes through, never mints ────────────────────────────────────
const apiClient = readFileSync('web/src/lib/v2-apiClient.ts', 'utf8');
check('browseRates metadata passes cacheExpiresAt through',
  /cacheExpiresAt: backendResult\?\.cacheExpiresAt \?\? null/.test(apiClient));
check('fetchRates metadata passes cacheExpiresAt through',
  /cacheExpiresAt: res\?\.cacheExpiresAt \?\? null/.test(apiClient));
check('apiClient metadata blocks never mint an expiry',
  !/cacheExpiresAt: new Date\(/.test(apiClient));

// ── withRateRequestMetadata prefers the backend value; mint is a warned last resort ───────
// PS-317: withRateRequestMetadata moved to ./orders/best-rate/rate-proof.ts (call sites
// stay in OrdersView). The body checks now read the new owner; the no-6h-mint census still
// scans OrdersView so a re-introduced FE mint at any call site cannot slip past.
const rateProof = readFileSync('web/src/components/Views/orders/best-rate/rate-proof.ts', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
// TEETH: slice the moved function body and require it be non-empty so a missing/renamed
// definition fails LOUD instead of a negation passing vacuously on '' .
const metadataStart = rateProof.indexOf('export function withRateRequestMetadata(');
const metadataEnd = rateProof.indexOf('\nexport function getSavedBestRateRecord', metadataStart);
const metadataBody = metadataStart >= 0 && metadataEnd > metadataStart
  ? rateProof.slice(metadataStart, metadataEnd)
  : '';
check('withRateRequestMetadata block found in rate-proof.ts', metadataStart >= 0 && metadataBody.length > 0);
check('withRateRequestMetadata prefers metadata then the rate-stamped backend expiry',
  metadataStart >= 0 && metadataBody.length > 0 &&
    /toStringValue\(metadata\.cacheExpiresAt\) \?\? toStringValue\(rate\.cacheExpiresAt\)/.test(metadataBody));
check('the local mint is reached only when the backend sent nothing, and warns',
  metadataStart >= 0 && metadataBody.length > 0 &&
    /if \(!backendExpiresAt\) \{\s*\n\s*console\.warn\('\[orders\] backend rate carried no cacheExpiresAt/.test(metadataBody));
// The 6h display-fallback mint was REMOVED entirely: the helper now does
// `expiresAt = backendExpiresAt ?? null` (it only warns). Zero FE mint sites is
// strictly more conservative — a stale rate can never be made to look fresh by a
// client-minted window. This still fails if any 6h mint is re-introduced in EITHER
// the moved helper or any OrdersView call site.
check('no display-fallback 6h mint site remains in OrdersView or rate-proof.ts (FE never mints an expiry)',
  ((ordersView + rateProof).match(/new Date\(Date\.now\(\) \+ 6 \* 60 \* 60 \* 1000\)/g) ?? []).length === 0);

if (failures > 0) {
  console.error(`\nFAIL PS-183 backend cache TTL guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-183 backend cache TTL guard');
