import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

const service = read('src/services/rates.ts');
const route = read('src/routes/rates.ts');
const schema = read('src/db/schema/rates.ts');
const migration = read('drizzle/0028_rate_cache_diagnostics.sql');
const client = read('web/src/lib/v2-apiClient.ts');
const siteActionsSpec = read('web/e2e/site-actions.spec.js');
const packageJson = read('package.json');

assert(
  service.includes('export function rateCacheKey'),
  'rate service exports one canonical rateCacheKey builder',
);

assert(
  service.includes('RATE_FETCH_CONCURRENCY') &&
    service.includes('mapWithConcurrency') &&
    service.includes('RATE_NEGATIVE_CACHE_TTL_MS'),
  'rate service enforces bounded live fetches and short negative cache TTL',
);

assert(
  schema.includes('diagnostics: jsonb().$type<unknown[]>()'),
  'rate_cache schema stores carrier diagnostics alongside cached rates',
);

assert(
  migration.includes('ALTER TABLE "rate_cache"') &&
    migration.includes('ADD COLUMN IF NOT EXISTS "diagnostics"'),
  'rate cache diagnostics migration exists',
);

assert(
  service.includes('cachedDiagnosticsFromCache') &&
    // QA audit 2026-06-23: writeRateCache now also receives the markups map (it picks the persisted
    // best on the MARKED customer charge, not raw cost). Same call site + diagnostics; match the
    // prefix so the added arg doesn't trip the pin.
    service.includes('writeRateCache(key, resolvedInput, rawRates, liveResult.carrierDiagnostics, now'),
  'getRates persists live diagnostics and reuses cached diagnostics',
);

assert(
  service.includes('writeRateCache') &&
    service.includes('rate_cache.diagnostics column missing') &&
    service.includes('legacy rate cache write failed') &&
    route.includes('rateCachePublicColumns'),
  'rate cache reads/writes are backward-compatible and do not block live rates',
);

assert(
    route.includes('rateCacheKey') &&
    route.includes('cacheKey: z.string().min(1).optional()') &&
    route.includes("matchQuality: matchQuality === 'exact' ? 'exact' as const : 'rough' as const") &&
    route.includes("'rough' as const") &&
    route.includes('approximate: false') &&
    route.includes("approximate: matchQuality === 'rough' ? true : false"),
  '/rates/cached/bulk supports exact cache keys and marks rough matches approximate',
);

// PS-203 (stage 3): the source-tagged diagnostic merge moved VERBATIM to the
// canonical combined-selection owner; the route consumes its output. Same
// pins, split homes.
const ratesCombinedSrc = read('src/services/rates-combined.ts');
assert(
  client.includes('carrierDiagnostics') &&
    route.includes('combinedCarrierDiagnostics') &&
    ratesCombinedSrc.includes("source: 'direct'") &&
    ratesCombinedSrc.includes("source: 'shipstation'"),
  'Rate Browser preserves backend-normalized ShipStation and direct-carrier diagnostics',
);

assert(
  siteActionsSpec.includes('Rate Browser partial carrier failures remain readable and keep successful rates selectable') &&
    siteActionsSpec.includes('10 of 10 carriers checked') &&
    siteActionsSpec.includes('7 with rates') &&
    siteActionsSpec.includes('Hide Unavailable') &&
    siteActionsSpec.includes('Shipp Carrier') &&
    siteActionsSpec.includes('EasyPost Account') &&
    siteActionsSpec.includes('UPS Carrier'),
  'Rate Browser browser certification covers mixed carrier success/failure diagnostics',
);

assert(
  packageJson.includes('test:workflow-certification:browser') &&
    packageJson.includes('web/e2e/site-actions.spec.js') &&
    packageJson.includes('test:full-site-certification') &&
    packageJson.includes('test:workflow-certification:browser'),
  'full-site certification includes Rate Browser workflow browser coverage',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
