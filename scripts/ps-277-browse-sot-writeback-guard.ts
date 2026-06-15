/**
 * PS-277 (slice 1) guard — a plain browse reconciles the SOT, env-gated + lock-safe.
 *
 * Pins: (1) BROWSE_SOT_WRITEBACK is OFF by default (inert until flipped — live-write canary on a
 * high-frequency endpoint); (2) the reconcile only fires for a FRESH LIVE COMPLETE best on an order
 * (gated + orderId + bestRateComplete + !result.cached) and NOT when the FE already drove the strict
 * recalc (it's the `else` branch); (3) it persists only an 'apply' decision via the existing
 * persist owner; (4) that owner still REFUSES non-awaiting rows (shipped/cancelled lock intact),
 * so the browse reconcile can never mutate shipped/cancelled data.
 *
 *   npx tsx scripts/ps-277-browse-sot-writeback-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const rates = readFileSync('src/routes/rates.ts', 'utf8');
const persist = readFileSync('src/services/rates-recalculate-persist.ts', 'utf8');

// ── 1. Env gate default OFF ───────────────────────────────────────────────────
check('browse SOT writeback is env-gated, default OFF (BROWSE_SOT_WRITEBACK === on)',
  /function browseSotWritebackEnabled\(\)[\s\S]{0,120}process\.env\.BROWSE_SOT_WRITEBACK === 'on'/.test(rates));

// ── 2. Reconcile fires only on a fresh LIVE complete best, not on strict-recalc ──
check('reconcile is the ELSE of the strict-recalculate block (no double persist)',
  /strictRecalculation = \{[\s\S]{0,120}\.\.\.persist,\s*\};\s*\}\s*else if \(/.test(rates));
check('reconcile is gated + requires orderId + complete + a LIVE (not cached) result',
  /browseSotWritebackEnabled\(\) &&[\s\S]{0,200}body\.orderId === 'number' && body\.orderId > 0 &&[\s\S]{0,80}bestRateOut != null && bestRateComplete && !result\.cached/.test(rates));

// ── 3. Persists only an 'apply' decision via the existing owner, best-effort ───
check("reconcile persists only on decision 'apply'",
  /if \(reconcileDecision\.action === 'apply'\) \{/.test(rates));
check('reconcile reuses persistStrictRecalculateOutcome (the awaiting-only owner)',
  /await persistStrictRecalculateOutcome\(\{[\s\S]{0,200}decision: reconcileDecision/.test(rates));
check('reconcile write is best-effort (browse never fails on a reconcile error)',
  /catch \(err\) \{[\s\S]{0,160}SOT reconcile write failed \(best-effort\)/.test(rates));

// ── 4. The owner still refuses shipped/cancelled (lock intact) ────────────────
check('persist owner refuses non-awaiting rows (shipped/cancelled lock intact)',
  /order\.orderStatus !== 'awaiting_shipment'/.test(persist) &&
    /not editable/.test(persist));

// ── 5. package.json wiring ────────────────────────────────────────────────────
check('package.json wires test:ps-277-browse-sot-writeback',
  /test:ps-277-browse-sot-writeback/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-277 browse SOT writeback guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-277 browse SOT writeback guard');
