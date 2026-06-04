/**
 * PS-082 Guard — Browse Rates reconciles the Awaiting table Best Rate (and the
 * selected service) to the LIVE best on open.
 *
 * Operator requirement: clicking Browse Rates fetches live rates; if the live
 * best differs from the table's cached best, the table adopts the live best
 * (Best Rate column + selected ship account/service). If equal, nothing changes.
 *
 * Safety (PS-078): the reconcile is only ever applied as an entry keyed by the
 * EXACT current request fingerprint, and the caller re-quotes with the table's
 * request params before persisting — so the displayed/selected rate is always
 * the live best for the conditions the label will actually use. This guard locks
 * the pure DECISION (`planBrowseRateReconcile`); the caller wires the fetch.
 *
 *   npx tsx scripts/ps-082-browse-rate-reconcile-guard.ts
 *
 * Read-only: no DB, no IO, mutates nothing.
 */
import { planBrowseRateReconcile } from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const KEY = '200014787177264|fingerprint';
const LIVE = { amount: 6.21, serviceCode: 'usps_ground_advantage', shippingProviderId: 433542 };

// Live best is CHEAPER than the cached table best -> adopt live (update + select).
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: LIVE,
    liveBestAmount: 6.21,
    currentBestAmount: 6.56,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
  });
  check('different live best => shouldUpdate', r.shouldUpdate, true);
  check('entry is keyed by the exact request fingerprint', r.entry?.key, KEY);
  check('entry carries the live rate', r.entry?.rate, LIVE);
  check('selection points at the live best account', r.selection?.shipAccountId, '433542');
  check('selection points at the live best service', r.selection?.serviceCode, 'usps_ground_advantage');
}

// Live best EQUALS the cached table best (same cents) -> no update, but still
// confirm the entry so the row reflects the verified-current rate.
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: { ...LIVE, amount: 6.56 },
    liveBestAmount: 6.56,
    currentBestAmount: 6.56,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
  });
  check('equal live best => no update', r.shouldUpdate, false);
  check('equal live best still yields a confirming entry', r.entry?.key, KEY);
}

// Sub-cent differences are treated as equal (carrier float noise must not churn).
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: { ...LIVE, amount: 6.564 },
    liveBestAmount: 6.564,
    currentBestAmount: 6.56,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
  });
  check('sub-cent drift => no update', r.shouldUpdate, false);
}

// No cached best yet (table was spinning) -> any live best is an update.
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: LIVE,
    liveBestAmount: 6.21,
    currentBestAmount: null,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
  });
  check('no cached best => update', r.shouldUpdate, true);
}

// No live best found (carriers returned nothing) -> never update, no entry.
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: null,
    liveBestAmount: null,
    currentBestAmount: 6.56,
    providerAccountId: null,
    serviceCode: null,
  });
  check('no live best => no update', r.shouldUpdate, false);
  check('no live best => no entry', r.entry, null);
  check('no live best => no selection', r.selection, null);
}

// Live best missing provider/service -> update the amount, but no selection change.
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: { amount: 5.99 },
    liveBestAmount: 5.99,
    currentBestAmount: 6.56,
    providerAccountId: null,
    serviceCode: 'usps_ground_advantage',
  });
  check('missing provider => no selection', r.selection, null);
  check('missing provider still updates the rate', r.shouldUpdate, true);
}

// A non-positive live amount is not a usable rate -> never update.
{
  const r = planBrowseRateReconcile({
    requestKey: KEY,
    liveBest: { amount: 0 },
    liveBestAmount: 0,
    currentBestAmount: 6.56,
    providerAccountId: 433542,
    serviceCode: 'usps_ground_advantage',
  });
  check('zero live amount => no update', r.shouldUpdate, false);
  check('zero live amount => no entry', r.entry, null);
}

if (failures > 0) {
  console.error(`\nFAIL PS-082 browse-rate reconcile guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-082 browse-rate reconcile guard');
