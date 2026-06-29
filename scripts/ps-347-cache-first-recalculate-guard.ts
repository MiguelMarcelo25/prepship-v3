import { readFileSync } from 'node:fs';

type Check = {
  name: string;
  pass: boolean;
  detail?: string;
};

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function ok(name: string, pass: boolean, detail?: string): Check {
  return { name, pass, detail };
}

const packageJson = read('package.json');
const recalcUi = read('web/src/components/Views/orders-recalculate-all.ts');
const toolbar = read('web/src/components/Views/OrdersFilterToolbar.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const ratesRoute = read('src/routes/rates.ts');
const backfill = read('src/services/rates-backfill.ts');

const checks: Check[] = [
  ok(
    'package wires PS-347 cache-first Recalculate All guard',
    /"test:ps-347-cache-first-recalculate"\s*:\s*"tsx scripts\/ps-347-cache-first-recalculate-guard\.ts"/.test(packageJson),
  ),
  ok(
    'normal Recalculate All frontend default is cache-first, not maxAgeHours=0 force-live',
    /FAST_RECALCULATE_MAX_AGE_HOURS\s*=\s*(?!0\b)\d+/.test(recalcUi)
      && /startRecalculateAllBestRates\([^)]*FAST_RECALCULATE_MAX_AGE_HOURS/.test(recalcUi)
      && !/startRecalculateAllBestRates\(maxAgeHours\s*=\s*0\)/.test(recalcUi),
  ),
  ok(
    'frontend exposes a separate explicit full-live Recalculate All/audit starter',
    /startFullLiveRecalculateAllBestRates/.test(recalcUi)
      && /mode:\s*['"]full_live_audit['"]/.test(recalcUi)
      && /maxAgeHours:\s*0/.test(recalcUi),
  ),
  ok(
    'OrdersView normal toolbar action calls the cache-first Recalculate All starter',
    /startRecalculateAllBestRates\(\)/.test(ordersView)
      && !/startRecalculateAllBestRates\(0\)/.test(ordersView),
  ),
  ok(
    'toolbar copy describes normal Recalculate All as cache-first/fast instead of strict live',
    /cache-first|fast refresh|reuse/i.test(toolbar)
      && !/title="Re-rate ALL awaiting orders in the background/.test(toolbar),
  ),
  ok(
    'rates route accepts an explicit backfill mode so force-live is intentional',
    /mode:\s*z\.enum\(\[\s*['"]cache_first['"]\s*,\s*['"]full_live_audit['"]\s*(?:,\s*['"]preexpiry_refresh['"]\s*)?\]\)/s.test(ratesRoute),
  ),
  ok(
    'backend maps full_live_audit to manual force-live and cache_first to cache-friendly',
    /mode\?:\s*['"]cache_first['"]\s*\|\s*['"]full_live_audit['"]/.test(backfill)
      && /opts\.mode\s*===\s*['"]full_live_audit['"]/.test(backfill)
      && /opts\.mode\s*===\s*['"]cache_first['"]/.test(backfill),
  ),
  ok(
    'backend live forceRefresh is restricted to manual/full-live audit mode',
    /const liveRecalculate\s*=\s*.*full_live_audit/.test(backfill)
      && /getRates\(rateInput,\s*liveRecalculate\s*\?\s*\{\s*forceRefresh:\s*true/.test(backfill),
  ),
  ok(
    'cache-friendly mode is documented as the normal operator path and keeps provider budget protected',
    /PS-347/.test(backfill)
      && /cache-first/i.test(backfill)
      && /Full Live Recalculate|full-live/i.test(backfill),
  ),
];

let failed = 0;
for (const check of checks) {
  if (check.pass) {
    console.log(`ok   ${check.name}`);
  } else {
    failed += 1;
    console.error(`fail ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
  }
}

if (failed) {
  console.error(`\nFAIL PS-347 cache-first Recalculate All guard (${failed} failure${failed === 1 ? '' : 's'})`);
  process.exit(1);
}

console.log('\nPASS PS-347 cache-first Recalculate All guard');
