/**
 * PS-324 — behavioral test for the two backend-owned inventory WRITE-PATH rules.
 *
 * Pure + deterministic (no DB): exercises the canonical owners the adjust/receive routes delegate
 * to, so the persisted movement quantity and the movement-direction invariant are proven by
 * behavior, not just by the static guard's code-shape regexes.
 *  A. resolveReceiveUnits — pack→unit expansion uses the CANONICAL units_per_pack; packs wins;
 *     a legacy pre-multiplied qty is back-compat; missing → 0.
 *  B. movementDirectionError — ship/pick/damage must REMOVE stock; adjust/receive/return are free.
 * Offline. No postage, no real inventory movement.
 */
import assert from 'node:assert/strict';
import { resolveReceiveUnits } from '../src/lib/inventory-receive-units.js';
import {
  movementDirectionError,
  type InventoryMovementType,
} from '../src/lib/inventory-movement-direction.js';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── A. resolveReceiveUnits — receive pack→unit expansion ─────────────────────────────────
check('packs intent expands by the CANONICAL units_per_pack (3 packs × 6 = 18)', () => {
  assert.equal(resolveReceiveUnits({ packs: 3 }, 6), 18);
});
check('packs ignores a stale/extra qty — only packs × canonical matters', () => {
  assert.equal(resolveReceiveUnits({ packs: 2, qty: 999 }, 5), 10);
});
check('units_per_pack of 1 → one unit per pack', () => {
  assert.equal(resolveReceiveUnits({ packs: 7 }, 1), 7);
});
check('missing / non-positive units_per_pack defaults to 1 (never 0)', () => {
  assert.equal(resolveReceiveUnits({ packs: 4 }, null), 4);
  assert.equal(resolveReceiveUnits({ packs: 4 }, 0), 4);
  assert.equal(resolveReceiveUnits({ packs: 4 }, -3), 4);
});
check('legacy pre-multiplied qty is honored for back-compat when no packs', () => {
  assert.equal(resolveReceiveUnits({ qty: 12 }, 6), 12);
});
check('neither packs nor qty → 0 (the route rejects a non-positive receive)', () => {
  assert.equal(resolveReceiveUnits({}, 6), 0);
});

// ── B. movementDirectionError — manual-adjust direction invariant ────────────────────────
const decrementOnly: InventoryMovementType[] = ['ship', 'pick', 'damage'];
for (const type of decrementOnly) {
  check(`${type} with a POSITIVE qty is rejected (must remove stock)`, () => {
    assert.ok(movementDirectionError(type, 5), 'expected an error string');
  });
  check(`${type} with a ZERO qty is rejected (qty >= 0)`, () => {
    assert.ok(movementDirectionError(type, 0), 'expected an error string');
  });
  check(`${type} with a NEGATIVE qty is allowed`, () => {
    assert.equal(movementDirectionError(type, -5), null);
  });
}
for (const type of ['adjust', 'receive', 'return'] as InventoryMovementType[]) {
  check(`${type} is a free direction (allowed either way)`, () => {
    assert.equal(movementDirectionError(type, 5), null);
    assert.equal(movementDirectionError(type, -5), null);
  });
}

if (failures > 0) {
  console.error(`\nPS-324 inventory write-path test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-324 inventory write-path test passed.');
