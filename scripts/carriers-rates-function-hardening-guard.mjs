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

// 1) Auth verification is guarded (it runs before the main try and does a
//    remote JWKS fetch that can throw).
assert(
  /try\s*{\s*\n\s*verified = await verifySupabaseJwt\(token\);/.test(rates) &&
    rates.includes("logServerError('carriers/rates:auth'"),
  'verifySupabaseJwt is wrapped in try/catch (JWKS network throw -> clean 503, not a crash)',
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
