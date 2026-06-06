/**
 * Slice 3 guard — carrier replay/capture INFRASTRUCTURE + fixture schema.
 *
 * Proves: fixture envelope validation, path normalization, graceful missing-fixture
 * handling, validity of every recorded fixture on disk, and that the replay/capture
 * timedFetch hooks are gated behind CARRIER_TEST_MODE (inert in production).
 * Plan: ~/.claude/plans/zany-spinning-hennessy.md
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  validateCarrierFixture,
  fixturePath,
  loadCarrierFixture,
  CARRIER_FIXTURE_ROOT,
} from '../src/services/carrier-fixture-schema';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── envelope validation ──
const good = { provider: 'shipp', serviceCode: 'shipp_ups_ground', captured: true, steps: [{ name: 'shipp.labels', status: 200, body: {} }] };
check('valid fixture envelope passes', validateCarrierFixture(good).ok);
check('missing steps fails', !validateCarrierFixture({ ...good, steps: [] }).ok);
check('non-boolean captured fails', !validateCarrierFixture({ ...good, captured: 'yes' }).ok);
check('bad http status fails', !validateCarrierFixture({ ...good, steps: [{ name: 'x', status: 999, body: {} }] }).ok);
check('step without a name fails', !validateCarrierFixture({ ...good, steps: [{ status: 200, body: {} }] }).ok);
check('step without a body fails', !validateCarrierFixture({ ...good, steps: [{ name: 'x', status: 200 }] }).ok);
check('non-object fixture fails', !validateCarrierFixture(null).ok);

// ── path normalization ──
check('fixturePath normalizes provider + service',
  fixturePath('Walmart-Shipping', 'Walmart FedEx Ground') === `${CARRIER_FIXTURE_ROOT}/walmart_shipping/labels/walmart_fedex_ground.json`);

// ── graceful missing fixture ──
check('loadCarrierFixture returns null when none captured', loadCarrierFixture('shipp', '__definitely_missing__') === null);

// ── every fixture on disk is valid (zero is fine; guards future captures) ──
let onDisk = 0;
let invalid = 0;
if (existsSync(CARRIER_FIXTURE_ROOT)) {
  for (const provider of readdirSync(CARRIER_FIXTURE_ROOT)) {
    const dir = `${CARRIER_FIXTURE_ROOT}/${provider}/labels`;
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      onDisk += 1;
      const parsed = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
      if (!validateCarrierFixture(parsed).ok) { invalid += 1; console.error(`  invalid fixture: ${dir}/${file}`); }
    }
  }
}
check(`all ${onDisk} recorded fixture(s) on disk are valid`, invalid === 0);

// ── hooks are CARRIER_TEST_MODE-gated (structural; inert in production) ──
const timing = readFileSync('src/lib/http/timing.ts', 'utf8');
check('replay hook is gated by CARRIER_TEST_MODE',
  /function takeReplay[\s\S]*?if \(!__replaySteps \|\| !process\.env\.CARRIER_TEST_MODE\) return null/.test(timing));
check('capture sink is gated by CARRIER_TEST_MODE',
  /__captureSink = process\.env\.CARRIER_TEST_MODE \? sink : null/.test(timing));
check('replay short-circuits BEFORE the real fetch',
  timing.indexOf('const replayed = takeReplay(name);') < timing.indexOf('const res = await fetch(input, init);'));

const seam = readFileSync('src/services/carrier-test-mode.ts', 'utf8');
check('seam exposes withReplayFixture + withCaptureFixture',
  /export async function withReplayFixture/.test(seam) && /export async function withCaptureFixture/.test(seam));
check('replay throws a clear error when no fixture captured yet',
  /CarrierTestModeReplayMissingError/.test(seam));

if (failures > 0) {
  console.error(`\nFAIL carrier fixture/replay infra guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carrier fixture/replay infra guard');
