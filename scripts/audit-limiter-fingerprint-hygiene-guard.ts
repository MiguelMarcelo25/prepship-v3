/**
 * Audit 2026-07-13 item 4.2 limiter-config and fingerprint hygiene guard.
 *
 * Offline only: pure fingerprint execution plus source inspection. No database,
 * provider, label/postage, marketplace, inventory, or production data access.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShippingRateRequestFingerprint } from '../src/services/shipping-workflow/rate-fingerprint';

const base = {
  version: 'audit-4.2',
  shipDateBucket: '2026-07-14',
  weightOz: 16,
  toZip: '90210',
  toCountry: 'US',
};

const stateFingerprint = buildShippingRateRequestFingerprint({
  ...base,
  toState: 'ca',
});
const storeFingerprint = buildShippingRateRequestFingerprint({
  ...base,
  storeId: 123,
});
const stateAndStoreFingerprint = buildShippingRateRequestFingerprint({
  ...base,
  toState: 'ca',
  storeId: 123,
});

assert.match(stateFingerprint, /(?:^|\|)st=CA(?:$|\|)/, 'state must retain the st= namespace');
assert.match(storeFingerprint, /(?:^|\|)sid=123(?:$|\|)/, 'store ID must use the sid= namespace');
assert.doesNotMatch(storeFingerprint, /(?:^|\|)st=123(?:$|\|)/, 'store ID must never reuse the state namespace');
assert.notEqual(stateFingerprint, storeFingerprint, 'state and store identities must not collide');
assert.match(
  stateAndStoreFingerprint,
  /(?:^|\|)st=CA\|sid=123(?:$|\|)/,
  'state and store ID must coexist as distinct fingerprint axes',
);

const limiterConfig = readFileSync('src/lib/shipstation/rate-limit-config.ts', 'utf8');
const v1Client = readFileSync('src/lib/shipstation/v1-client.ts', 'utf8');
const v2Client = readFileSync('src/lib/shipstation/client.ts', 'utf8');
const ratesService = readFileSync('src/services/rates.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const guardPack = readFileSync('scripts/sot-guard-pack.mjs', 'utf8');

for (const constant of [
  'SHIPSTATION_RATE_LIMIT_WINDOW_MS',
  'SHIPSTATION_V1_RATE_LIMIT_PER_MINUTE',
  'SHIPSTATION_RATE_LIMIT_PER_MINUTE',
  'SHIPSTATION_RATE_LIMIT_BURST',
  'SHIPSTATION_RATE_LIMIT_INTERACTIVE_BURST_RESERVE',
  'SHIPSTATION_RATE_LIMIT_INTERACTIVE_PER_MINUTE_RESERVE',
]) {
  assert.match(limiterConfig, new RegExp(`export const ${constant}\\b`), `${constant} must live in the shared config`);
}
assert.match(v1Client, /from '\.\/rate-limit-config\.js'/, 'V1 client must consume the shared limiter config');
assert.match(v2Client, /from '\.\/rate-limit-config\.js'/, 'V2 client must consume the shared limiter config');
assert.doesNotMatch(v1Client, /new (?:Durable)?TokenBucket\([^\n]*\b38\b/, 'V1 limiter must not repeat its 38/min literal');
assert.doesNotMatch(v2Client, /process\.env\.SHIPSTATION_RATE_LIMIT_/, 'V2 client must not reparse limiter env values');
assert.match(ratesService, /ground-saver-v4/, 'fingerprint namespace must bump to ground-saver-v4');
assert.doesNotMatch(ratesService, /ground-saver-v3/, 'the live cache namespace must not retain v3');
assert.ok(packageJson.includes('"test:audit-limiter-fingerprint-hygiene"'), 'package must expose the 4.2 guard');
assert.ok(
  guardPack.includes("'test:audit-limiter-fingerprint-hygiene'"),
  'SOT pack must require the 4.2 guard',
);

console.log('PASS Audit 4.2 limiter-config and fingerprint hygiene guard');
