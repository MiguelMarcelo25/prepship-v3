/**
 * PS-295 guard — Browse Rates timing diagnostics + clearer in-flight UI.
 *
 * Pins the first safe speed pass: keep the final best-rate owner unchanged,
 * but expose timing diagnostics and replace vague "Checking carriers..." copy
 * with an honest "rates found / accounts checking" status.
 *
 *   npx tsx scripts/ps-295-rate-browser-speed-diagnostics-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  buildRateBrowseTimingDiagnostics,
  normalizeRateBrowseTimingStatus,
} from '../src/services/rate-browser-timing-diagnostics';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}${detail == null ? '' : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

check('timing status: ok -> live', normalizeRateBrowseTimingStatus('ok') === 'live');
check('timing status: empty -> unavailable', normalizeRateBrowseTimingStatus('empty') === 'unavailable');
check('timing status: cached -> cached', normalizeRateBrowseTimingStatus('cached') === 'cached');
check('timing status: timeout error -> timeout',
  normalizeRateBrowseTimingStatus('failed', 'Shipp Carrier rate request timed out after 25s') === 'timeout');
check('timing status: failed non-timeout -> error',
  normalizeRateBrowseTimingStatus('failed', 'invalid credentials') === 'error');

const timing = buildRateBrowseTimingDiagnostics({
  startedAtMs: 1_000,
  completedAtMs: 1_410,
  shipStationDurationMs: 120,
  directCarrierDurationMs: 275,
  carrierDiagnostics: [
    { source: 'shipstation', carrierId: 'se-1', nickname: 'UPS Chase', status: 'ok', rateCount: 2, durationMs: 90 },
    { source: 'direct', carrierId: 'se-10000025', nickname: 'Shipp Carrier', status: 'failed', rateCount: 0, durationMs: 25_000, error: 'Shipp Carrier rate request timed out after 25s' },
    { source: 'shipstation', carrierId: 'se-2', nickname: 'FedEx', status: 'empty', rateCount: 0, durationMs: 35 },
  ],
});

check('timing payload records total duration', timing.totalDurationMs === 410, timing);
check('timing payload records ShipStation duration', timing.shipStationDurationMs === 120, timing);
check('timing payload records direct-carrier duration', timing.directCarrierDurationMs === 275, timing);
check('timing payload maps timeout separately from workflow error',
  timing.carriers.find((carrier) => carrier.carrierId === 'se-10000025')?.status === 'timeout', timing);
check('timing payload keeps provider source on each carrier',
  timing.carriers.some((carrier) => carrier.source === 'shipstation') &&
  timing.carriers.some((carrier) => carrier.source === 'direct'), timing);

const routesRates = readFileSync('src/routes/rates.ts', 'utf8');
const svcRates = readFileSync('src/services/rates.ts', 'utf8');
const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const sidebar = readFileSync('web/src/components/RateBrowserCarrierSidebar.tsx', 'utf8');
const pkg = readFileSync('package.json', 'utf8');

check('/rates/browse builds and returns rateBrowseTiming diagnostics',
  /buildRateBrowseTimingDiagnostics/.test(routesRates) &&
  /rateBrowseTiming/.test(routesRates));
check('direct-carrier diagnostics record per-account duration',
  /const startedAt = Date\.now\(\)/.test(svcRates) &&
  /durationMs: Date\.now\(\) - startedAt/.test(svcRates));
check('Rate Browser header uses rates-found/accounts-checking copy',
  /rateBrowserHeaderText/.test(modal) &&
  /rateLabel/.test(modal) &&
  /found · checking/.test(modal) &&
  !/Checking carriers\.\.\.\$\{/.test(modal));
check('Rate Browser keeps final best-rate emission guarded by awaitingLiveFanout',
  /const awaitingLiveFanout = options\.cachedOnly === true && uncoveredPids\.length > 0/.test(modal));
check('carrier sidebar accepts and displays per-account timing',
  /carrierTimingByPid/.test(sidebar) &&
  /formatRateTimingLabel/.test(sidebar));
check('package.json exposes test:ps-295-rate-browser-speed-diagnostics',
  /test:ps-295-rate-browser-speed-diagnostics/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-295 rate-browser speed diagnostics guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-295 rate-browser speed diagnostics guard');
