/**
 * PS-230 guard — JWT defense-in-depth on the Vercel credential-write functions.
 *
 * api/carrier-accounts.ts + api/store-accounts.ts used to call verifySupabaseJwt(token)
 * with no options, so issuer/audience validation depended on STRICT_JWT_CLAIMS (default
 * false). They now pass { strictClaims: true, supabaseUrl } explicitly, so a validly-
 * signed token from a DIFFERENT Supabase project is rejected regardless of the env flag.
 *
 *   npx tsx scripts/ps-230-jwt-strict-claims-guard.ts
 */
import { readFileSync } from 'node:fs';

const carrier = readFileSync('api/carrier-accounts.ts', 'utf8');
const store = readFileSync('api/store-accounts.ts', 'utf8');
const verify = readFileSync('src/lib/auth/verify-supabase-jwt.ts', 'utf8');
const ps200 = (() => { try { return readFileSync('docs/ps-200-legacy-api-decommission.md', 'utf8'); } catch { return ''; } })();
const pkg = readFileSync('package.json', 'utf8');

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

function callsStrict(src: string): boolean {
  return /verifySupabaseJwt\(\s*token,\s*\{[\s\S]*?strictClaims:\s*true[\s\S]*?supabaseUrl[\s\S]*?\}\s*\)/.test(src);
}

// 1. Both credential functions force strict claims with the supabase URL.
check('carrier-accounts verifies with strictClaims + supabaseUrl', callsStrict(carrier));
check('store-accounts verifies with strictClaims + supabaseUrl', callsStrict(store));

// 2. Neither calls the unguarded single-arg form anymore.
check('carrier-accounts no longer calls verifySupabaseJwt(token) bare', !/verifySupabaseJwt\(token\)/.test(carrier));
check('store-accounts no longer calls verifySupabaseJwt(token) bare', !/verifySupabaseJwt\(token\)/.test(store));

// 3. Boot-time empty-secret/URL check (strict claims can't be enforced without the URL).
check('carrier-accounts warns when SUPABASE_URL is empty', /SUPABASE_URL.*empty|empty.*SUPABASE_URL/i.test(carrier) || carrier.includes('!process.env.SUPABASE_URL'));
check('store-accounts warns when SUPABASE_URL is empty', /SUPABASE_URL.*empty|empty.*SUPABASE_URL/i.test(store) || store.includes('!process.env.SUPABASE_URL'));

// 4. The strict mechanism actually builds issuer + audience.
check('strictJwtOptions builds issuer + audience', /issuer:\s*`?\$\{base\}\/auth\/v1`?/.test(verify) && /audience:\s*'authenticated'/.test(verify));

// 5. PS-200 carry-forward records the STRICT_JWT_CLAIMS prod env step.
check('PS-200 doc records PS-230 carry-forward', ps200.includes('PS-230') && /STRICT_JWT_CLAIMS=true/.test(ps200));

// 6. Self-wiring.
check('package.json exposes test:ps-230-jwt-strict-claims', /test:ps-230-jwt-strict-claims/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-230 JWT strict-claims guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-230 JWT strict-claims guard');
