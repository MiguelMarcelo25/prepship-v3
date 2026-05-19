import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const serviceSource = read('src/services/ref-rates-fetch.ts');
const billingRouteSource = read('src/routes/billing.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  serviceSource.includes("import { settings } from '../db/schema/settings'"),
  'reference-rate fetch imports settings table',
);

assert(
  serviceSource.includes("REF_RATES_FETCH_STATUS_KEY = 'billing_ref_rates_fetch.last_run'"),
  'reference-rate fetch uses durable settings key',
);

assert(
  serviceSource.includes('persistRefRatesJobSnapshot'),
  'reference-rate fetch persists job snapshots',
);

assert(
  serviceSource.includes('getLatestRefRatesJobSnapshot'),
  'reference-rate fetch exposes durable latest snapshot reader',
);

assert(
  billingRouteSource.includes('getLatestRefRatesJobSnapshot'),
  'billing route imports durable latest snapshot reader',
);

assert(
  billingRouteSource.includes('durableJob: await getLatestRefRatesJobSnapshot()'),
  'billing status includes durable latest ref-rate job snapshot',
);

assert(
  packageJson.scripts?.['test:ref-rates-durable'] ===
    'node scripts/ref-rates-durable-guard.mjs',
  'package exposes reference-rate durable guard',
);
