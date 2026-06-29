/**
 * PS-340 - backend rate-engine bounded fan-out guard.
 *
 * Trello PS-340 is broader than the existing local
 * `ps-340-ratebrowser-bridge-audit` guard. This guard pins the backend engine
 * slice: cache-first display may be instant, but every live carrier fan-out
 * must be backend-owned, bounded, and visible through diagnostics.
 *
 * Offline/static only: no DB, no provider calls, no labels, no queue mutation.
 */
import { existsSync, readFileSync } from 'node:fs';

let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  if (end <= start) throw new Error(`Missing ${endNeedle}`);
  return source.slice(start, end);
}

function sliceFrom(source: string, startNeedle: string): string {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(`Missing ${startNeedle}`);
  return source.slice(start);
}

const ratesService = read('src/services/rates.ts');
const ratesRoute = read('src/routes/rates.ts');
const ratesBackfill = read('src/services/rates-backfill.ts');
const modal = read('web/src/components/RateBrowserModal.tsx');
const ordersView = read('web/src/components/Views/OrdersView.tsx');
const packageJson = read('package.json');
const docPath = 'docs/ps-tickets/ps-340-backend-rate-engine.md';
const doc = existsSync(docPath) ? read(docPath) : '';

const directCarrierFunction = sliceFrom(
  ratesService,
  'export async function getDirectCarrierRatesForRateInput(',
);

const modalOpenEffect = sliceBetween(
  modal,
  '// Try the cache on open',
  '// Auto-select a package',
);

check(
  'backend exports a bounded direct-carrier live fan-out cap',
  /export const DIRECT_CARRIER_RATE_FETCH_CONCURRENCY = Math\.max\([\s\S]{0,260}DIRECT_CARRIER_RATE_FETCH_CONCURRENCY/.test(ratesService),
);

check(
  'direct-carrier live quotes use backend bounded concurrency instead of Promise.all over every account',
  /mapWithConcurrency\(\s*accounts,\s*DIRECT_CARRIER_RATE_FETCH_CONCURRENCY,\s*async \(account\) =>/.test(directCarrierFunction) &&
    !/const calls = accounts\.map/.test(directCarrierFunction) &&
    !/Promise\.all\(calls\)/.test(directCarrierFunction),
);

check(
  'direct-carrier quotes still return per-account diagnostics after bounding',
  /settled\.flatMap\(\(item\) => item\.rates\)/.test(directCarrierFunction) &&
    /diagnostics: settled\.map\(\(item\) => item\.diagnostic\)/.test(directCarrierFunction),
);

check(
  'ShipStation live fan-out remains bounded by the canonical rate service limiter',
  /RATE_FETCH_CONCURRENCY/.test(ratesService) &&
    /runWithGlobalRateLimiter/.test(ratesService) &&
    /fetchEstimateForCarrierWithRetry\([\s\S]{0,140}priority/.test(ratesService),
);

check(
  '/rates/browse collapses identical in-flight provider fan-outs before ranking/proof stamping',
  /runRateBrowseSingleFlight/.test(ratesRoute) &&
    /const \{ result, directRates, shipStationDurationMs, directCarrierDurationMs \} = await runRateBrowseSingleFlight/.test(ratesRoute),
);

check(
  'backend backfill stays bounded and uses background priority for ShipStation quotes',
  /const CONCURRENCY = Math\.max\(1, Math\.min\(liveRecalculate \? LIVE_BACKFILL_CONCURRENCY : 4, RATE_FETCH_CONCURRENCY\)\)/.test(ratesBackfill) &&
    /getRates\(rateInput, liveRecalculate \? \{ forceRefresh: true, priority: 'background' \} : \{ priority: 'background' \}\)/.test(ratesBackfill),
);

check(
  'Rate Browser open remains cache/display-only; live fan-out is explicit operator intent',
  /browseRates\(undefined, \{ cachedOnly: true \}\)/.test(modalOpenEffect) &&
    !/forceLive:\s*true/.test(modalOpenEffect) &&
    /onClick=\{\(\) => void browseRates\(undefined, \{ forceLive: true \}\)\}/.test(modal),
);

check(
  'Awaiting page does not restart browser-owned passive live-rate workers',
  !/runPassiveAutoRating|refreshVisibleBestRate|fetchCachedRatesBulk/.test(ordersView),
);

check(
  'package wires PS-340 backend rate-engine guard without replacing the older bridge-audit guard',
  packageJson.includes('"test:ps-340-backend-rate-engine": "tsx scripts/ps-340-backend-rate-engine-guard.ts"') &&
    packageJson.includes('"test:ps-340-ratebrowser-bridge-audit": "tsx scripts/ps-340-ratebrowser-bridge-audit-guard.ts"'),
);

check(
  'PS-340 backend-engine doc records owner, imperfect data injection, collision, and no shipped/cancelled touch',
  doc.includes('## Backend Owner') &&
    doc.includes('## Imperfect Data Injection') &&
    doc.includes('## PS-340 Number Collision') &&
    doc.includes('No shipped/cancelled surfaces are touched'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-340 backend rate-engine guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-340 backend rate-engine guard');
