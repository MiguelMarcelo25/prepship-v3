/**
 * PS-188 guard — rate-shop origin is backend-owned; no hardcoded '90248' in Views.
 *
 * THE BUG: the Rate Shop hardcoded origin ZIP '90248' in THREE places
 * (RatesView form default, buildLiveRatesPayload fallback, meta-label fallback).
 * The backend /rates/browse route never even reads the FE origin — it always
 * quotes from the canonical getDefaultShipFrom (default Location row, env
 * fallback) — so the FE hardcode could silently DISAGREE with the true quoting
 * origin on a multi-warehouse setup, and the meta label displayed an origin
 * that was never used.
 *
 * THE FIX:
 *   - New thin read GET /locations/default-ship-from → getDefaultShipFrom
 *     (the same owner the label + rate paths use).
 *   - RatesView seeds the origin field from that endpoint (never overwrites an
 *     operator-typed value); the form default is empty.
 *   - buildLiveRatesPayload sends the operator value verbatim (no literal
 *     fallback); buildRatesMetaLabel says 'default origin' instead of inventing
 *     a ZIP.
 *
 * Pins:
 *   1. No '90248' anywhere in web/src/components/Views (recursive sweep).
 *   2. Backend route exists and delegates to getDefaultShipFrom.
 *   3. RatesView seeds from the endpoint and only fills an untouched field.
 *   4. Payload/meta-label fallbacks carry no ZIP literal.
 *   5. Owner unchanged: services/rates.ts still defaults input.shipFrom via
 *      getDefaultShipFrom (the quote path the endpoint mirrors).
 *
 *   npx tsx scripts/ps-188-backend-origin-zip-guard.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. sweep: no 90248 in any Views file ─────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}
const offenders = walk('web/src/components/Views').filter((f) => readFileSync(f, 'utf8').includes('90248'));
check('no hardcoded 90248 anywhere in web/src/components/Views', offenders.length === 0, offenders.join(', '));

// ── 2. backend thin route over the canonical owner ───────────────────────────
const locationsRoute = readFileSync('src/routes/locations.ts', 'utf8');
check('GET /locations/default-ship-from exists and delegates to getDefaultShipFrom',
  /app\.get\('\/default-ship-from'[\s\S]{0,200}getDefaultShipFrom\(\)/.test(locationsRoute));
check('route returns postalCode + countryCode (origin DTO)',
  /postalCode: addr\.postal_code/.test(locationsRoute) && /countryCode: addr\.country_code/.test(locationsRoute));

// ── 3. RatesView seeds from the endpoint, never overwrites operator input ────
const ratesView = readFileSync('web/src/components/Views/RatesView.tsx', 'utf8');
check('RatesView seeds the origin from /locations/default-ship-from',
  /api\.get[^\n]*'\/locations\/default-ship-from'/.test(ratesView));
check('seed only fills an untouched field (operator value wins)',
  /current\.fromZip\.trim\(\) \? current : \{ \.\.\.current, fromZip: res\.postalCode! \}/.test(ratesView));
check('form default origin is empty (no ZIP literal)',
  /fromZip: '',/.test(ratesView));

// ── 4. parity helpers carry no ZIP literal fallback ──────────────────────────
const ratesParity = readFileSync('web/src/components/Views/rates-parity.ts', 'utf8');
check('buildLiveRatesPayload sends the operator value verbatim',
  /fromPostalCode: form\.fromZip\.trim\(\),/.test(ratesParity));
check("meta label says 'default origin' instead of inventing a ZIP",
  /form\.fromZip\.trim\(\) \|\| 'default origin'/.test(ratesParity));

// ── 5. quote-path owner unchanged ────────────────────────────────────────────
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
check('services/rates.ts still defaults the origin via getDefaultShipFrom',
  /input\.shipFrom \?\? \(await getDefaultShipFrom\(\)\)/.test(ratesService));

if (failures > 0) {
  console.error(`\nFAIL PS-188 backend origin zip guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-188 backend origin zip guard');
