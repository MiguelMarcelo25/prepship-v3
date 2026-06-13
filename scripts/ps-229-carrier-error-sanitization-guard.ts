/**
 * PS-229 guard — carrier rate errors are sanitized before reaching the client.
 *
 * api/carriers/rates.ts per-provider catch blocks used to return the raw
 * err.message to the browser, leaking upstream/credential-shaped detail (FedEx
 * OAuth/accountNumber, Amazon LWA 401, raw upstream bodies). They now route through
 * sanitizedProviderRateError(): generic client message + stable code, full detail
 * server-side only. Pins that so a future provider block can't reintroduce a leak.
 *
 *   npx tsx scripts/ps-229-carrier-error-sanitization-guard.ts
 */
import { readFileSync } from 'node:fs';

const rates = readFileSync('api/carriers/rates.ts', 'utf8');
const ps200 = (() => { try { return readFileSync('docs/ps-200-legacy-api-decommission.md', 'utf8'); } catch { return ''; } })();
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// 1. The sanitizing helper exists, logs server-side, returns a generic message.
check('sanitizedProviderRateError helper exists', rates.includes('function sanitizedProviderRateError('));
check('helper logs the real error server-side', /sanitizedProviderRateError[\s\S]{0,200}console\.error/.test(rates));
check('helper returns a generic client message', /return 'Rate quote failed'/.test(rates));

// 2. Every per-provider catch routes through the helper (was 9 leaky blocks).
check('all provider blocks use the helper (>=9)', count(rates, 'sanitizedProviderRateError(provider, err)') >= 9);
check('each sanitized response carries a stable code', count(rates, "code: 'RATE_QUOTE_FAILED'") >= 9);

// 3. The raw leak pattern survives ONLY inside the helper's server-side log (exactly once).
check('no raw err.message leaks to the client (pattern only in the server log)',
  count(rates, 'err instanceof Error ? err.message : String(err)') === 1);

// 4. "both" decision recorded on the PS-200 carry-forward note.
check('PS-200 doc records the PS-229 carry-forward', ps200.includes('PS-229') && /sanitizedProviderRateError/.test(ps200));

// 5. Self-wiring.
check('package.json exposes test:ps-229-carrier-error-sanitization', /test:ps-229-carrier-error-sanitization/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-229 carrier error sanitization guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-229 carrier error sanitization guard');
