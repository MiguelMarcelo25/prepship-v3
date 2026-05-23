import { readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) {
    console.error(`api-contracts guard failed: ${message}`);
    process.exitCode = 1;
  }
}

const spec = readFileSync('web/e2e/site-actions.spec.js', 'utf8');
const matrix = readFileSync('docs/site-action-functionality-matrix.md', 'utf8');

for (const token of [
  '/health',
  '/health/ready',
  '/health/deep',
  '/init/stores',
  '/init/counts',
  '/orders',
  '/orders/:id/full',
  '/labels',
  '/rates',
  '/print-queue',
  '/inventory',
  '/packages',
  '/billing',
  '/api/carrier-accounts',
  '/api/store-accounts',
]) {
  assert(
    spec.includes(token) || matrix.includes(token),
    `missing API contract coverage token ${token}`
  );
}

for (const token of [
  'expectRequest',
  'expectNoForbiddenExternalRequests',
  'assertNoObjectObjectPayloads',
  'requestLedger',
]) {
  assert(spec.includes(token), `browser workflow spec missing ${token}`);
}

for (const forbidden of [
  'marketplace.walmartapis.com',
  'api.ebay.com',
  'apiz.ebay.com',
  'ssapi.shipstation.com',
  'api.shipstation.com',
]) {
  assert(spec.includes(forbidden), `browser workflow spec must block ${forbidden}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log('api-contracts guard passed');
