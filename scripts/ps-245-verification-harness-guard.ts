/**
 * PS-245 (Card 0) — verification harness: the card→guards resolver + the baseline snapshot store.
 *
 * The lockdown file-fence (the high-value Card 0 piece) already shipped (ps-245-lockdown-fence). This
 * adds the remaining OFFLINE-buildable harness: resolveCardGuards (cardId -> its package.json test:*
 * guards, so "verify card X" is one lookup) + the baseline snapshot store (read/write/upsert/diff).
 * BEHAVIORAL: imports + runs both. The GOLDEN money-surface capture + CI integration are the
 * operational tail (they read live data) — out of scope for an offline guard.
 *
 *   npx tsx scripts/ps-245-verification-harness-guard.ts
 */
import { readFileSync } from 'node:fs';
import { resolveCardGuards, normalizeCardNumber } from '../src/verification/verify-card';
import { emptyBaseline, upsertSnapshot, findSnapshot, readBaseline } from './baseline-snapshots';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

// ── verify-card resolver (behavioral) ──
check('normalizeCardNumber handles PS-249 / ps249 / 249',
  normalizeCardNumber('PS-249') === '249' && normalizeCardNumber('ps249') === '249' && normalizeCardNumber('249') === '249');
check('a non-card id resolves to empty', normalizeCardNumber('not-a-card') === '');

const g247 = resolveCardGuards('PS-247');
check('resolveCardGuards(PS-247) finds its guards',
  g247.includes('test:ps-247-inventory-deduct-atomic') && g247.includes('test:ps-247-inventory-route-scope'));
check('resolveCardGuards(PS-245) finds the lockdown-fence guard',
  resolveCardGuards('PS-245').includes('test:ps-245-lockdown-fence'));
check('an unknown card resolves to no guards', resolveCardGuards('PS-99999').length === 0);

// ── baseline snapshot store (behavioral round-trip, no file I/O) ──
const snap = { cardId: 'PS-249', surface: 'billing.grand_total', capturedAt: '2026-06-16', checksum: 'abc', data: { total: 100 } };
const seeded = upsertSnapshot(emptyBaseline(), snap);
check('upsertSnapshot stores a snapshot', findSnapshot(seeded, 'PS-249', 'billing.grand_total')?.checksum === 'abc');
const replaced = upsertSnapshot(seeded, { ...snap, checksum: 'def' });
check('upsertSnapshot REPLACES (no duplicate) for the same card+surface',
  replaced.snapshots.length === 1 && findSnapshot(replaced, 'PS-249', 'billing.grand_total')?.checksum === 'def');
check('readBaseline returns an empty baseline for a missing file',
  readBaseline('test-results/__ps245_nonexistent_baseline__.json').snapshots.length === 0);

check('package.json wires test:ps-245-verification-harness',
  /test:ps-245-verification-harness/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-245 verification harness guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-245 verification harness guard');
