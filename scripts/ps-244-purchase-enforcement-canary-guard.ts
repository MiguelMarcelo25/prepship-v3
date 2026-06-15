/**
 * PS-244 Phase 4 guard — purchase-boundary snapshot ENFORCEMENT flip + canary.
 *
 * Per user override unlock shipped data on 2026-06-15.
 *
 * Proves:
 *   1. The enforcement mode defaults to 'canary' (RATE_PROOF_ENFORCEMENT !== 'strict')
 *      so the deployed purchase behavior is byte-identical until DJ flips it.
 *   2. The canary records every outcome and never throws / never touches the DB —
 *      instrumentation can't break a purchase.
 *   3. The label-purchase boundary still ENFORCES a valid proof on the legacy path
 *      (missing proof -> throws), and records legacy_only when no snapshot ref is sent.
 *   4. The strict gate exists and reuses the SAME strict validator (fail-safe: never
 *      weaker than canary), with the override cited at the boundary + module.
 *   5. The read-only canary surface is wired into /observability.
 *
 *   npx tsx scripts/ps-244-purchase-enforcement-canary-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  assertLabelPurchaseRateSelection,
} from '../src/services/shipping-workflow/rate-quote-snapshot-store';
import {
  resolveRateQuoteForPurchase,
  selectedRateOpaqueKey,
} from '../src/services/shipping-workflow/rate-quote-snapshot';
import {
  getRateProofCanaryStats,
  recordRateProofCanary,
  rateProofEnforcementMode,
  resetRateProofCanaryStats,
} from '../src/services/shipping-workflow/rate-proof-enforcement';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── Fixtures (same proven-valid shape as the PS-105 guard) ────────────────────
const cacheKey =
  'v=ground-saver-v2|eligibility=ps-057-hugrab-ground-saver-v1|d=2026-06-15|w=510|z=77422|co=US|st=TX|ci=brazoria|r=1|cl=10|l=90|dw=60|h=30|c=se-433542,se-595995';
const rateA = { carrierCode: 'ups', serviceCode: 'ups_ground', shippingProviderId: 595995, shipmentCost: 6.89, otherCost: 0, packageCode: 'package' };
const rateB = { carrierCode: 'stamps_com', serviceCode: 'usps_ground_advantage', shippingProviderId: 433542, shipmentCost: 9.21, otherCost: 0, packageCode: 'package' };
const keyA = selectedRateOpaqueKey(rateA);
const freshSnapshot = { cacheKey, rates: [rateA, rateB], fetchedAt: Date.now() };
const okRes = resolveRateQuoteForPurchase({ snapshot: freshSnapshot, selectedRateKey: keyA });
const validProof = okRes.ok ? okRes.proof : null;

async function main(): Promise<void> {
  check('fixture: a valid carried proof was built', validProof !== null);

  // ── 1. Default mode is the safe canary (no behavior change until DJ flips) ───
  check("default enforcement mode is 'canary'", rateProofEnforcementMode() === 'canary');

  // ── 2. Canary recorder: records, exposes stats, never throws ─────────────────
  resetRateProofCanaryStats();
  let recorderThrew = false;
  try {
    recordRateProofCanary('snapshot_enforced');
    recordRateProofCanary('snapshot_fallback', 'snapshot_expired');
    recordRateProofCanary('legacy_only');
  } catch { recorderThrew = true; }
  check('recordRateProofCanary never throws', !recorderThrew);
  const tally = getRateProofCanaryStats();
  check('stats expose mode + per-outcome + per-reason counters',
    tally.mode === 'canary' &&
    tally.outcomes.snapshot_enforced === 1 &&
    tally.outcomes.snapshot_fallback === 1 &&
    tally.outcomes.legacy_only === 1 &&
    tally.reasons.snapshot_expired === 1);

  // ── 3a. Legacy-only path: a VALID carried proof passes + records legacy_only ─
  resetRateProofCanaryStats();
  let validPassed = true;
  try {
    await assertLabelPurchaseRateSelection({ selectedRateProof: validProof });
  } catch { validPassed = false; }
  const afterValid = getRateProofCanaryStats();
  check('no-ref valid carried proof passes the boundary', validPassed);
  check('no-ref path records legacy_only', afterValid.outcomes.legacy_only === 1);

  // ── 3b. Legacy-only path STILL ENFORCES: a missing proof BLOCKS the purchase ──
  let missingBlocked = false;
  try {
    await assertLabelPurchaseRateSelection({ selectedRateProof: null });
  } catch { missingBlocked = true; }
  check('missing carried proof still blocks the purchase (boundary not weakened)', missingBlocked);

  // ── 4. Static pins: outcomes recorded, strict gate, fail-safe, override ──────
  const store = readFileSync('src/services/shipping-workflow/rate-quote-snapshot-store.ts', 'utf8');
  const mod = readFileSync('src/services/shipping-workflow/rate-proof-enforcement.ts', 'utf8');

  check('boundary records all three outcomes (enforced / fallback+reason / legacy_only)',
    /recordRateProofCanary\('snapshot_enforced'\)/.test(store) &&
    /recordRateProofCanary\('snapshot_fallback', resolved\.reason\)/.test(store) &&
    /recordRateProofCanary\('legacy_only'\)/.test(store));
  check("the env-gated strict enforcement flip exists (default canary)",
    /rateProofEnforcementMode\(\) === 'strict'/.test(store));
  check('strict reuses the SAME strict validator (fail-safe, never weaker than canary)',
    /if \(rateProofEnforcementMode\(\) === 'strict'\) \{[\s\S]{0,200}?assertSelectedRateProofForLabelPurchase\(\s*resolved\.reason === 'snapshot_missing' \? null : \{ requestFingerprint: null \}/.test(store));
  check('boundary keeps the legacy carried-proof fallback verbatim (canary default)',
    /assertSelectedRateProofForLabelPurchase\(body\.selectedRateProof \?\? null\)/.test(store));
  check('override is cited at the boundary AND in the new module',
    /Per user override unlock shipped data on 2026-06-15/.test(store) &&
    /Per user override unlock shipped data on 2026-06-15/.test(mod));

  // ── 5. The module is side-effect-free: no DB / no throw escape hatch ─────────
  const modCode = mod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  check('enforcement module touches no DB (analytics-cache / db / drizzle)',
    !/analytics-cache|\.\.\/\.\.\/db|drizzle/.test(modCode));
  check('default helper returns canary for anything but the literal "strict"',
    /process\.env\.RATE_PROOF_ENFORCEMENT === 'strict' \? 'strict' : 'canary'/.test(mod));

  // ── 6. Read-only canary surface wired into /observability ────────────────────
  const obs = readFileSync('src/routes/observability.ts', 'utf8');
  check('/observability exposes the read-only canary surface',
    /getRateProofCanaryStats/.test(obs) && /rate-proof-canary/.test(obs));

  // ── 7. package.json wires this guard ────────────────────────────────────────
  const pkg = readFileSync('package.json', 'utf8');
  check('package.json wires test:ps-244-purchase-enforcement-canary',
    /test:ps-244-purchase-enforcement-canary/.test(pkg));

  if (failures > 0) {
    console.error(`\nFAIL PS-244 purchase-enforcement canary guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-244 purchase-enforcement canary guard');
}

void main();
