/**
 * PS-224 guard — negative-stock reconciler is PROPOSE-ONLY.
 *
 * Unit-tests the pure proposal core and statically pins the reconciler's read-only
 * contract: no --apply, no SQL/ORM mutation, delegates to the canonical
 * effective-stock owner, every proposal carries safeToAutoRepair:false.
 *
 *   npx tsx scripts/ps-224-negative-stock-guard.ts
 */
import { readFileSync } from 'node:fs';
import { proposeNegativeStockCorrection } from '../src/lib/negative-stock-core';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
function read(p: string): string { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ── Pure core unit tests ────────────────────────────────────────────────────

// 1. baseline_receive: cache == ledger truth (both negative) → missing receive, floor to 0.
const baseline = proposeNegativeStockCorrection({
  inventoryId: 1, sku: 'a', clientId: 4, cacheStockQty: -3, effectiveStock: -3, totalReceived: 0, totalSold: 3,
});
check('baseline_receive when cache==ledger (both negative)', baseline.proposalType === 'baseline_receive');
check('baseline proposes a receive', baseline.proposedLedgerType === 'receive');
check('baseline floors to 0 (delta +3 → 0)', baseline.proposedDelta === 3 && baseline.resultingStockQty === 0);

// 2. cache_correction: cache drifted from a non-negative ledger truth → adjust to ledger.
const drift = proposeNegativeStockCorrection({
  inventoryId: 2, sku: 'b', clientId: 4, cacheStockQty: -2, effectiveStock: 5, totalReceived: 10, totalSold: 5,
});
check('cache_correction when cache != ledger', drift.proposalType === 'cache_correction');
check('cache_correction proposes an adjust', drift.proposedLedgerType === 'adjust');
check('cache_correction targets the ledger value (-2 → 5, delta +7)',
  drift.proposedDelta === 7 && drift.resultingStockQty === 5);

// 3. cache_correction but ledger ALSO negative → floor to 0, never below.
const bothNegDrift = proposeNegativeStockCorrection({
  inventoryId: 3, sku: 'c', clientId: null, cacheStockQty: -4, effectiveStock: -1, totalReceived: 1, totalSold: 5,
});
check('floors to 0 when ledger truth is also negative', bothNegDrift.resultingStockQty === 0 && bothNegDrift.proposedDelta === 4);

// 4. Every proposal is review-only.
check('every proposal carries safeToAutoRepair:false',
  baseline.safeToAutoRepair === false && drift.safeToAutoRepair === false && bothNegDrift.safeToAutoRepair === false);
check('proposed delta is never negative',
  [baseline, drift, bothNegDrift].every((p) => p.proposedDelta >= 0));

// ── Static contract ─────────────────────────────────────────────────────────
const recon = read('scripts/ps-224-negative-stock-reconcile.ts');
check('reconciler exists', recon.length > 0);
// No apply-mode LOGIC (the docstring may mention "no --apply flag" in prose — we
// pin the absence of the flag-reading code, not the word).
check('reconciler has NO apply mode',
  !/includes\(\s*['"]--apply['"]\s*\)/.test(recon) && !/\bconst\s+APPLY\b/.test(recon));
check('reconciler performs NO SQL mutation',
  !/insert\s+into/i.test(recon) && !/\bupdate\s+\w+\s+set\b/i.test(recon) && !/delete\s+from/i.test(recon));
check('reconciler performs NO ORM mutation', !/\.insert\(|\.update\(|\.delete\(/.test(recon));
check('reconciler delegates to the canonical effective-stock owner',
  recon.includes('computeEffectiveStockForIds'));
check('reconciler is labelled propose-only / read-only',
  /PROPOSE-ONLY/i.test(recon) && /READ-ONLY/i.test(recon));
check('reconciler only selects negative stock rows', /stock_qty < 0/.test(recon));

const pkg = read('package.json');
check('package.json wires the propose-only reconciler', /ps-224:negative-stock:reconcile/.test(pkg));
check('package.json wires test:ps-224-negative-stock', /test:ps-224-negative-stock/.test(pkg));

if (failures > 0) {
  console.error(`\nFAIL PS-224 negative-stock guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-224 negative-stock guard');
