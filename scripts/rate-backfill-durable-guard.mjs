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

const serviceSource = read('src/services/rates-backfill.ts');
const routeSource = read('src/routes/rates.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  serviceSource.includes("import { settings } from '../db/schema/settings'"),
  'rate backfill imports settings table',
);

assert(
  serviceSource.includes("RATE_BACKFILL_STATUS_KEY = 'rate_backfill_best_rates.last_run'"),
  'rate backfill uses durable settings key',
);

assert(
  serviceSource.includes('persistBackfillJobSnapshot'),
  'rate backfill persists job snapshots',
);

assert(
  serviceSource.includes('getLatestBackfillJobSnapshot'),
  'rate backfill exposes durable latest snapshot reader',
);

assert(
  routeSource.includes("getLatestBackfillJobSnapshot"),
  'rates route imports durable latest snapshot reader',
);

assert(
  routeSource.includes("app.get('/backfill-best/latest'"),
  'rates route exposes latest durable backfill status endpoint',
);

assert(
  packageJson.scripts?.['test:rate-backfill-durable'] ===
    'node scripts/rate-backfill-durable-guard.mjs',
  'package exposes rate backfill durable guard',
);
