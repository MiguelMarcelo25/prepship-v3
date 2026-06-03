#!/usr/bin/env node
// Guard: the /api/carriers/rates Vercel function can never crash as
// FUNCTION_INVOCATION_FAILED. It must (1) guard the pre-try auth verification
// and body parsing so a JWKS network throw / malformed body returns a clean
// status instead of an uncaught crash, (2) bound each upstream carrier rate
// quote with a timeout so a hung provider returns a clean error before the
// platform limit, and (3) pin the serverless region to the US (was observed
// running in sin1/Singapore against a US database).
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const rates = read('api/carriers/rates.ts');
const vercel = JSON.parse(read('vercel.json'));

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${msg}`);
  } else {
    console.log(`PASS ${msg}`);
  }
};

// 0) ROOT CAUSE: the wider-src/ helpers (jose auth + shipping-eligibility) are
//    DEFERRED to request time, not statically imported at module top — a static
//    import threw at COLD START on Vercel and crashed the function before any
//    handler/try-catch ran (even a token-free GET crashed).
assert(
  !/^import\s+\{[^}]*verifySupabaseJwt/m.test(rates) &&
    rates.includes('async function ensureRateDeps') &&
    rates.includes("await import('../../src/lib/auth/verify-supabase-jwt.js')") &&
    rates.includes('await ensureRateDeps();'),
  'wider-src/ helpers are deferred (lazy import) so a load failure is a clean 500, not a cold-start crash',
);

// 1) Auth verification is guarded AND bounded by a timeout (it runs before the
//    main try and does a remote JWKS fetch that can throw OR hang).
assert(
  /verified = await withRateTimeout\(_verifySupabaseJwt\(token\)/.test(rates) &&
    rates.includes("logServerError('carriers/rates:auth'"),
  'verifySupabaseJwt (deferred) is wrapped in try/catch + timeout (throw OR hang -> clean 503)',
);

// 1b) Outermost fatal guard: nothing can escape as FUNCTION_INVOCATION_FAILED.
assert(
  rates.includes("logServerError('carriers/rates:fatal'") &&
    rates.includes('res.headersSent'),
  'an outermost try/catch turns any unexpected throw into a clean JSON 500',
);

// 1c) Token-free GET version marker so a deploy can be verified from a browser.
assert(
  /req\.method === 'GET'/.test(rates) && /build: 'rates-/.test(rates),
  'GET returns a build/version marker for deploy verification',
);

// 2) Body parsing is guarded.
assert(
  /try\s*{\s*\n\s*body = \(await readBody\(req\)\)/.test(rates) &&
    rates.includes("'Invalid JSON body'"),
  'readBody is wrapped in try/catch (malformed body -> 400, not a crash)',
);

// 3) Upstream carrier quote is bounded by a timeout, with no unhandled
//    rejection if the timeout wins the race.
assert(
  rates.includes('function withRateTimeout') &&
    rates.includes('await withRateTimeout(connector.getRates(input)') &&
    rates.includes('wrapped.catch(() => {})'),
  'connector.getRates is bounded by withRateTimeout (hung carrier -> clean timeout error)',
);

// 4) Region is pinned to a US region (avoid running far from the DB).
const US_REGIONS = new Set(['iad1', 'cle1', 'pdx1', 'sfo1', 'dev1']);
assert(
  Array.isArray(vercel.regions) &&
    vercel.regions.length > 0 &&
    vercel.regions.every((r) => US_REGIONS.has(r)),
  `vercel.json pins functions to a US region (got ${JSON.stringify(vercel.regions ?? null)})`,
);

if (failures > 0) {
  console.error(`\nFAIL carriers/rates function hardening guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carriers/rates function hardening guard');
