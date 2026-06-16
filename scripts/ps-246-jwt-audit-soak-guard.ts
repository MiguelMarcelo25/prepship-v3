/**
 * PS-246 (Card 1) — JWT strict-claims audit soak.
 *
 * STRICT_JWT_CLAIMS defaults OFF (audit mode) and is flipped on after a soak. This guard proves the
 * strict path is real + correct so the flip is safe:
 *   - BEHAVIORAL (offline, no network — the HS256 attempt resolves first): a token signed with the
 *     correct secret + issuer + audience is ACCEPTED under strictClaims; a malformed token is REJECTED.
 *   - SOURCE: strictJwtOptions enforces BOTH issuer (`${url}/auth/v1`) and audience ('authenticated'),
 *     so a cross-project / wrong-audience token is rejected once strict is on; STRICT_JWT_CLAIMS is the
 *     env switch (default off until DJ flips it post-soak).
 * (The wrong-issuer reject path falls through to a remote JWKS fetch, so it's a live canary, not an
 * offline assertion — covered by the source check of the issuer/audience options instead.)
 *
 *   npx tsx scripts/ps-246-jwt-audit-soak-guard.ts
 */
import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { verifySupabaseJwt } from '../src/lib/auth/verify-supabase-jwt';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const SECRET_STR = 'ps246-audit-soak-test-secret-0123456789abcdef';
const SECRET = new TextEncoder().encode(SECRET_STR);
const SUPA = 'https://example.supabase.co';

const signed = await new SignJWT({ sub: 'user-1' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer(`${SUPA}/auth/v1`)
  .setAudience('authenticated')
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(SECRET);

// BEHAVIORAL (offline): correct secret + issuer + audience is accepted under strict claims.
const accepted = await verifySupabaseJwt(signed, { jwtSecret: SECRET_STR, supabaseUrl: SUPA, strictClaims: true });
check('strict mode ACCEPTS a token with the correct secret + issuer + audience', accepted.ok === true);

// BEHAVIORAL (offline): a malformed token is rejected immediately (no network).
const malformed = await verifySupabaseJwt('not.a.real.jwt', { jwtSecret: SECRET_STR, supabaseUrl: SUPA, strictClaims: true });
check('a malformed token is rejected', malformed.ok === false);

// SOURCE: strict claims enforce issuer + audience (so cross-project/wrong-aud tokens are rejected).
const jwt = readFileSync('src/lib/auth/verify-supabase-jwt.ts', 'utf8');
check('strict claims enforce the issuer (`${base}/auth/v1`)', /issuer: `\$\{base\}\/auth\/v1`/.test(jwt));
check("strict claims enforce the audience ('authenticated')", /audience: 'authenticated'/.test(jwt));
check('strict claims are gated by STRICT_JWT_CLAIMS (env switch)', /STRICT_JWT_CLAIMS/.test(jwt));

const env = readFileSync('src/lib/env.ts', 'utf8');
check('STRICT_JWT_CLAIMS is an env flag (default off until the post-soak flip)', /STRICT_JWT_CLAIMS/.test(env));

check('package.json wires test:ps-246-jwt-audit-soak',
  /test:ps-246-jwt-audit-soak/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-246 JWT audit-soak guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-246 JWT audit-soak guard');
