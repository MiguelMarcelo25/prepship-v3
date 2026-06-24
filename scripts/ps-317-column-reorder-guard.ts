/**
 * PS-317 (Phase 3) — unit guard for the PURE column drag-to-reorder logic (computeReorderedColumns),
 * extracted from OrdersView. Pins the exact splice semantics the e2e column tests can't exercise
 * (synthetic HTML5 drag races Playwright): source removed at its index, reinserted at the target's
 * ORIGINAL index; invalid moves (missing/equal keys, the immovable 'select' column) return null.
 */
import { computeReorderedColumns, IMMOVABLE_COLUMN_KEY } from '../web/src/components/Views/orders/column-reorder';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const cols = [{ key: 'select' }, { key: 'A' }, { key: 'B' }, { key: 'C' }, { key: 'D' }];
const keys = (r: Array<{ key: string }> | null): string => (r ? r.map((c) => c.key).join(',') : 'null');

// Forward drag (source BEFORE target): A onto C → A lands AFTER C (splice-out shifts the target slot).
check('forward move: A→C lands A after C', keys(computeReorderedColumns(cols, 'A', 'C')) === 'select,B,C,A,D');
// Backward drag (source AFTER target): D onto B → D lands AT B's slot (before B).
check('backward move: D→B lands D before B', keys(computeReorderedColumns(cols, 'D', 'B')) === 'select,A,D,B,C');
// Adjacent forward: A onto B → A after B.
check('adjacent move: A→B', keys(computeReorderedColumns(cols, 'A', 'B')) === 'select,B,A,C,D');

// Invalid moves all return null (no reorder).
check('same key is a no-op (null)', computeReorderedColumns(cols, 'B', 'B') === null);
check('immovable select as SOURCE is null', computeReorderedColumns(cols, IMMOVABLE_COLUMN_KEY, 'B') === null);
check('immovable select as TARGET is null', computeReorderedColumns(cols, 'B', IMMOVABLE_COLUMN_KEY) === null);
check('unknown source key is null', computeReorderedColumns(cols, 'Z', 'B') === null);
check('unknown target key is null', computeReorderedColumns(cols, 'B', 'Z') === null);
check('null source is null', computeReorderedColumns(cols, null, 'B') === null);
check('undefined target is null', computeReorderedColumns(cols, 'B', undefined) === null);

// Purity: the input array is never mutated.
const snapshot = cols.map((c) => c.key).join(',');
computeReorderedColumns(cols, 'A', 'C');
check('input array is not mutated (pure)', cols.map((c) => c.key).join(',') === snapshot);

if (failures > 0) {
  console.error(`\nPS-317 column-reorder guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-317 column-reorder guard passed.');
