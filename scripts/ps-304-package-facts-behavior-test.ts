/**
 * PS-304 — REAL EXECUTION test for the backend row package-facts read-model.
 *
 * ps-304-package-facts-row-owner-guard regexes the module's shape; this test EXECUTES
 * buildOrderRowPackageFacts and asserts the display-safe contract the FE consumes instead of
 * re-deriving: immutableReason precedence (which REINFORCES the shipped/cancelled lock),
 * package-state derivation, and the stale-rate/re-rate interaction with closed rows. A
 * regression (e.g. a shipped row reporting requiresRerate, or has_label outranking shipped)
 * would pass the regex guard but fail here.
 *
 * Pure + deterministic (no I/O). Run: npm run test:ps-304-package-facts-behavior
 */
import { buildOrderRowPackageFacts, type BuildOrderRowPackageFactsInput } from '../src/services/shipping-workflow/order-row-package-facts';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    return;
  }
  console.log(`ok   ${name}`);
}

const DIMS = { length: 10, width: 8, height: 6 };
function facts(over: Partial<BuildOrderRowPackageFactsInput>) {
  return buildOrderRowPackageFacts({
    orderStatus: 'awaiting_shipment',
    externallyShipped: false,
    canonicalStatus: 'awaiting_shipment',
    hasActiveLabel: false,
    weightOz: 16,
    dims: DIMS,
    selectedPackageId: 'pkg-1',
    ...over,
  });
}

// 1. Baseline awaiting row with a complete package.
const baseline = facts({});
check('baseline: immutableReason null', baseline.immutableReason === null);
check('baseline: complete package → state resolved', baseline.state === 'resolved', baseline.state);
check('baseline: not stale, no re-rate', baseline.staleRateImpact === false && baseline.requiresRerate === false);

// 2. immutableReason precedence: cancelled > shipped > has_label > null.
check('cancelled via orderStatus', facts({ orderStatus: 'cancelled' }).immutableReason === 'cancelled');
check('cancelled via canonicalStatus', facts({ canonicalStatus: 'cancelled' }).immutableReason === 'cancelled');
check('shipped via externallyShipped', facts({ externallyShipped: true }).immutableReason === 'shipped');
check('shipped via orderStatus', facts({ orderStatus: 'shipped' }).immutableReason === 'shipped');
check('has_label when not shipped/cancelled', facts({ hasActiveLabel: true }).immutableReason === 'has_label');
check('cancelled outranks shipped', facts({ orderStatus: 'shipped', canonicalStatus: 'cancelled' }).immutableReason === 'cancelled');
check('shipped outranks has_label', facts({ orderStatus: 'shipped', hasActiveLabel: true }).immutableReason === 'shipped');

// 3. Package-state derivation: PS-301 axis wins; else dims-completeness fallback.
check('packageState axis passes through (source) even with dims', facts({ packageState: 'source' }).state === 'source');
check('no axis + missing dims → needs_dims', facts({ dims: null }).state === 'needs_dims');
check('no axis + zero weight → needs_dims', facts({ weightOz: 0 }).state === 'needs_dims');
check('no axis + complete → resolved', facts({}).state === 'resolved');

// 4. Stale-rate impact + re-rate — closed rows are realized and never re-rate.
check('stale rate on open row → staleRateImpact + requiresRerate', (() => {
  const f = facts({ rateState: 'stale' });
  return f.staleRateImpact === true && f.requiresRerate === true;
})());
check('expired rate on open row → staleRateImpact', facts({ rateState: 'expired' }).staleRateImpact === true);
check('stale rate on a SHIPPED row → no impact, no re-rate (closed)', (() => {
  const f = facts({ rateState: 'stale', orderStatus: 'shipped' });
  return f.staleRateImpact === false && f.requiresRerate === false;
})());
check('final rate → no stale impact', facts({ rateState: 'final' }).staleRateImpact === false);

// 5. Explicit requiresRerate flag honored on open rows, suppressed on closed rows.
check('requiresRerate flag on open row → true', facts({ requiresRerate: true }).requiresRerate === true);
check('requiresRerate flag on a CANCELLED row → suppressed', facts({ requiresRerate: true, orderStatus: 'cancelled' }).requiresRerate === false);

// 6. Display fields pass through verbatim.
const passthrough = facts({ weightOz: 22, dims: DIMS, selectedPackageId: 'pkg-9' });
check('weightOz/dims/selectedPackageId echoed verbatim',
  passthrough.weightOz === 22 && passthrough.dims === DIMS && passthrough.selectedPackageId === 'pkg-9');

if (failures > 0) {
  console.error(`\nPS-304 package-facts behavior test FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-304 package-facts behavior test passed.');
