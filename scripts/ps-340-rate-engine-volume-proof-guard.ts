/**
 * PS-340 - backend rate-engine volume proof.
 *
 * Offline behavior guard: proves the requested 100-order/large-carrier scenario
 * is described by backend-owned caps and observability, not by frontend guesses.
 * No DB, provider calls, labels, queue writes, or shipped/cancelled mutations.
 */
import { readFileSync } from 'node:fs';
import {
  buildRateEngineVolumeProof,
  type RateEngineVolumeProofInput,
} from '../src/services/rate-engine-volume-proof';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const highVolumeInput: RateEngineVolumeProofInput = {
  selectedOrders: 100,
  visibleShipStationAccounts: 9,
  visibleDirectCarrierAccounts: 17,
  rateFetchConcurrency: 4,
  directCarrierConcurrency: 4,
  backfillOrderConcurrency: 2,
  awaitingPageLoadProviderCalls: 0,
  usesRateBrowseSingleFlight: true,
  usesCacheFirstOpenPreview: true,
  pendingHeartbeatMs: 120_000,
  pendingStaleWindowMs: 360_000,
};

const proof = buildRateEngineVolumeProof(highVolumeInput);
const rates = read('src/services/rates.ts');
const browseProducer = read('src/services/rate-browse-response-producer.ts');
const timingDiagnostics = read('src/services/rate-browser-timing-diagnostics.ts');
const ps340Guard = read('scripts/ps-340-backend-rate-engine-guard.ts');
const ps340Doc = read('docs/ps-tickets/ps-340-backend-rate-engine.md');
const packageJson = read('package.json');

check('100-order proof preserves the selected workload count', proof.selectedOrders === 100, proof);
check('Awaiting load does not perform provider calls', proof.awaitingPageLoadProviderCalls === 0, proof);
check('cache-first open preview is display-only while live browse stays explicit', proof.cacheFirstOpenPreview === true, proof);
check('identical live browse requests are single-flighted', proof.liveBrowseSingleFlight === true, proof);
check('backfill order workers are capped at 2 for a 100-order burst', proof.maxConcurrentBackfillOrders === 2, proof);
check('ShipStation active carrier calls never exceed the backend cap', proof.maxShipStationCarrierCalls === 4, proof);
check('direct carrier calls are bounded per active backfill order', proof.maxDirectCarrierCalls === 8, proof);
check('pending heartbeat refreshes before the stale-display window', proof.pendingHeartbeatSafe === true, proof);
check('proof emits operator-safe request-count facts', proof.requestCountSummary.includes('100 selected') && proof.requestCountSummary.includes('2 active orders'), proof);

check(
  'rate service exposes limiter snapshots from the backend owner',
  /export type RateEngineLimiterSnapshot = \{/.test(rates) &&
    /export function getRateEngineLimiterSnapshot\(\): RateEngineLimiterSnapshot/.test(rates),
);

check(
  'Rate Browser producer captures limiter snapshots around backend fan-out',
  /const limiterBefore = getRateEngineLimiterSnapshot\(\)/.test(browseProducer) &&
    /const limiterAfter = getRateEngineLimiterSnapshot\(\)/.test(browseProducer) &&
    /limiterBefore/.test(browseProducer) &&
    /limiterAfter/.test(browseProducer),
);

check(
  'rate browse timing diagnostics carries backend limiter observability',
  /rateEngineLimiter\?: \{/.test(timingDiagnostics) &&
    /limiterBefore/.test(timingDiagnostics) &&
    /limiterAfter/.test(timingDiagnostics),
);

check(
  'PS-340 aggregate guard requires volume proof',
  ps340Guard.includes('ps-340-rate-engine-volume-proof-guard.ts') &&
    ps340Guard.includes('buildRateEngineVolumeProof'),
);

check(
  'PS-340 doc records high-volume request-count evidence',
  ps340Doc.includes('## 2026-06-30 Volume Proof Slice') &&
    ps340Doc.includes('100 selected orders') &&
    ps340Doc.includes('limiter snapshots'),
);

check(
  'package wires PS-340 volume proof guard',
  packageJson.includes('"test:ps-340-rate-engine-volume-proof": "tsx scripts/ps-340-rate-engine-volume-proof-guard.ts"'),
);

if (failures > 0) {
  console.error(`\nFAIL PS-340 rate-engine volume proof guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-340 rate-engine volume proof guard');
