/**
 * PS-279 — the Rate Browser must NOT persist a FE-ranked local "cheapest" best when the
 * backend canonical best is absent.
 *
 * DoD: when findCanonicalBestRate(...) returns null, RateBrowserModal must emit NOTHING through
 * onBestRateResolved and instead surface an unresolved/retry diagnostic state. The backend
 * (src/services/rates.ts) owns best-rate selection; the FE renders the canonical winner verbatim
 * and never substitutes a parallel client-side re-rank (markup/eligibility drift would persist a
 * different "best" than the row shows).
 *
 *   npx tsx scripts/ps-279-rate-browser-no-fallback-best-guard.ts
 */
import { readFileSync } from 'node:fs';
import { decideBestRateEmission } from '../web/src/lib/rate-browser-best-emission';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── 1. the pure emission boundary exists and enforces the rule ──
check('decideBestRateEmission emits the canonical best verbatim', (() => {
  const canonical = { serviceCode: 'ups_ground', shippingProviderId: 7 };
  const d = decideBestRateEmission(canonical);
  return d.kind === 'emit' && d.rate === canonical;
})());
check('decideBestRateEmission returns unresolved when canonical best is null', (() => {
  const d = decideBestRateEmission(null);
  return d.kind === 'unresolved' && !('rate' in d);
})());
check('decideBestRateEmission returns unresolved when canonical best is undefined',
  decideBestRateEmission(undefined).kind === 'unresolved');

// ── 2. the modal no longer falls back to a FE-ranked local cheapest in the emission path ──
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');

// The forbidden pattern: canonicalBest ?? [...available].sort(...rateDisplayTotal...)[0]
// chosen as `best`, then pushed through onBestRateResolved.
check('modal no longer assigns `const best = canonicalBest ?? [...].sort(...)[0]`',
  !/const\s+best\s*=\s*\n?\s*canonicalBest\s*\?\?[\s\S]{0,200}?\.sort\([\s\S]{0,160}?rateDisplayTotal[\s\S]{0,160}?\)\[0\]/.test(modal));

// The emission must be driven by the canonical best alone (via the pure boundary), so a
// null canonical best can never produce an applied rate.
check('modal imports decideBestRateEmission from the lib boundary',
  /import\s*\{[^}]*\bdecideBestRateEmission\b[^}]*\}\s*from\s*'\.\.\/lib\/rate-browser-best-emission'/.test(modal));
check('modal routes the emission through decideBestRateEmission(canonicalBest)',
  /decideBestRateEmission\(\s*canonicalBest\s*\)/.test(modal));

// ── 3. the modal surfaces an unresolved/retry diagnostic state instead of silently emitting ──
check('modal tracks an unresolved best-rate diagnostic state',
  /bestRateUnresolved|best-rate could not be resolved|unresolved/i.test(modal));

// ── 4. package.json wires the test script ──
check('package.json wires test:ps-279-rate-browser-no-fallback-best',
  /test:ps-279-rate-browser-no-fallback-best/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-279 rate-browser no-fallback-best guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-279 rate-browser no-fallback-best guard');
