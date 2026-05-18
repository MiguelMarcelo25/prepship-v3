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
    service.includes('writeRateCache(key, resolvedInput, rawRates, liveResult.carrierDiagnostics, now)'),
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
    route.includes("matchQuality: 'exact' as const") &&
    route.includes("matchQuality: 'rough' as const") &&
    route.includes('approximate: false') &&
    route.includes('approximate: true'),
  '/rates/cached/bulk supports exact cache keys and marks rough matches approximate',
);

assert(
  client.includes('carrierDiagnostics') &&
    client.includes("source: 'direct'") &&
    client.includes("source: 'shipstation'"),
  'Rate Browser client returns normalized ShipStation and direct-carrier diagnostics',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
