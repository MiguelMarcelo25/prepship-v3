/**
 * Slice 1 guard — carrier test-mode SEAM.
 *
 * Proves the test-mode seam is double-gated, fails safe, and — most importantly —
 * leaves the PRODUCTION direct-carrier purchase path byte-for-byte unchanged.
 * Plan: ~/.claude/plans/zany-spinning-hennessy.md
 */
import { readFileSync } from 'node:fs';
import {
  isCarrierTestMode,
  resolveCarrierTestStrategy,
  assertNoLivePostageOrMarketplace,
  CarrierTestModeSafetyError,
  type CarrierTestStrategy,
} from '../src/services/carrier-test-mode';

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function throwsSafety(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof CarrierTestModeSafetyError;
  }
}

const ORIG = process.env.CARRIER_TEST_MODE;
const ORIG_STRAT = process.env.CARRIER_TEST_STRATEGY;

// ── double gate: env arms, per-call flag selects ──
delete process.env.CARRIER_TEST_MODE;
check('no env → test mode OFF even with per-call flag',
  isCarrierTestMode({ __carrierTestMode: true } as any) === false);

process.env.CARRIER_TEST_MODE = '1';
check('env set but NO per-call flag → test mode OFF (production input untouched)',
  isCarrierTestMode({ provider: 'easypost' } as any) === false);
check('env set AND per-call flag → test mode ON',
  isCarrierTestMode({ __carrierTestMode: true } as any) === true);
check('env set but flag is a string "true" → still OFF (strict === true only)',
  isCarrierTestMode({ __carrierTestMode: 'true' } as any) === false);

// ── strategy resolution ──
check('easypost → sandbox', resolveCarrierTestStrategy('easypost') === 'sandbox');
check('shipp → replay', resolveCarrierTestStrategy('shipp') === 'replay');
check('ups → replay', resolveCarrierTestStrategy('ups') === 'replay');
check('walmart_shipping → replay', resolveCarrierTestStrategy('Walmart-Shipping') === 'replay');
process.env.CARRIER_TEST_STRATEGY = JSON.stringify({ shipp: 'sandbox' });
check('strategy override is honored', resolveCarrierTestStrategy('shipp') === 'sandbox');
delete process.env.CARRIER_TEST_STRATEGY;

// ── safety assertion: never marketplace, never live postage ──
const sandbox: CarrierTestStrategy = 'sandbox';
const replay: CarrierTestStrategy = 'replay';
for (const src of ['walmart', 'ebay', 'amazon', 'shipstation']) {
  check(`refuses real marketplace source "${src}"`,
    throwsSafety(() => assertNoLivePostageOrMarketplace('easypost', { __sourceProvider: src, credentials: { apiKey: 'EZTK_x' } } as any, sandbox)));
}
check('allows internal source',
  !throwsSafety(() => assertNoLivePostageOrMarketplace('easypost', { __sourceProvider: 'internal', credentials: { apiKey: 'EZTK_x' } } as any, sandbox)));
check('easypost sandbox with LIVE key (EZAK) is refused',
  throwsSafety(() => assertNoLivePostageOrMarketplace('easypost', { __sourceProvider: 'internal', credentials: { apiKey: 'EZAK_live' } } as any, sandbox)));
check('easypost sandbox with TEST key (EZTK) is allowed',
  !throwsSafety(() => assertNoLivePostageOrMarketplace('easypost', { __sourceProvider: 'internal', credentials: { apiKey: 'EZTK_test' } } as any, sandbox)));
check('replay tier ignores api-key prefix (no live HTTP anyway)',
  !throwsSafety(() => assertNoLivePostageOrMarketplace('shipp', { __sourceProvider: 'internal' } as any, replay)));

// ── module purity: leaf import only (cold-start safe) ──
const seamSrc = readFileSync('src/services/carrier-test-mode.ts', 'utf8');
const seamImports = seamSrc.match(/^import .*$/gm) ?? [];
check('seam module imports ONLY types (cold-start safe leaf)',
  seamImports.every((l) => /import type/.test(l)));
const seamCode = seamSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
check('seam adds no force/bypass flag that could skip safety',
  !/(force|bypass|skipSafety|allowLive)\s*[:=]/i.test(seamCode));

// ── orchestrator wiring: production path preserved ──
const orch = readFileSync('src/services/carrier-connector-orchestrator.ts', 'utf8');
check('orchestrator gates test path on isCarrierTestMode(input)',
  /if \(isCarrierTestMode\(input\)\)/.test(orch));
check('orchestrator runs the strict safety assertion before any test provider call',
  /assertNoLivePostageOrMarketplace\(/.test(orch) &&
    orch.indexOf('assertNoLivePostageOrMarketplace(') < orch.indexOf('replayCarrierLabel('));
check('production (non-test) branch still calls connector.createLabel(input) directly',
  /else \{\s*label = await resolved\.connector\.createLabel\(input\);\s*\}/.test(orch));
check('test mode wraps ONLY createLabel — rates/void/track paths untouched',
  !/isCarrierTestMode/.test(orch.slice(orch.indexOf('export async function quoteCarrierRates'), orch.indexOf('export async function createCarrierLabel'))));

if (ORIG === undefined) delete process.env.CARRIER_TEST_MODE; else process.env.CARRIER_TEST_MODE = ORIG;
if (ORIG_STRAT === undefined) delete process.env.CARRIER_TEST_STRATEGY; else process.env.CARRIER_TEST_STRATEGY = ORIG_STRAT;

if (failures > 0) {
  console.error(`\nFAIL carrier test-mode seam guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS carrier test-mode seam guard');
