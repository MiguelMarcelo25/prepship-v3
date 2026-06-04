/**
 * PS-081 Guard — Awaiting-Shipment table rate cells converge with the panel's
 * resolved best-rate state and never strand on an infinite spinner.
 *
 * Root cause this locks: the passive auto-rate effect re-runs whenever an order
 * is SELECTED (its detail loads -> effect deps change -> cleanup sets
 * `cancelled=true`). Previously the row entry write was gated behind
 * `if (!cancelled)` while the watchdog was cleared unconditionally and the
 * request key stayed in `requestedRef`, so a fetch cancelled by that re-run was
 * left permanently "requested" with NO entry and NO watchdog -> the cell's
 * `calculating` spinner never terminated.
 *
 * The fix routes every SETTLED passive fetch through `planSettledAutoRate`,
 * which ALWAYS produces the row entry (keyed by the request fingerprint) and
 * only gates the PANEL preview side effects on cancellation.
 *
 * Safety (PS-078): the entry is keyed by the exact request fingerprint; the row
 * only treats it as displayable when that key matches the CURRENT request, so
 * this never widens label authority. We assert that here too.
 *
 *   npx tsx scripts/ps-081-rate-sync-guard.ts
 *
 * Read-only: no DB, no IO, mutates nothing.
 */
import {
  classifyAwaitingRateCellState,
  awaitingRateCellIsSpinner,
  planSettledAutoRate,
} from '../web/src/components/Views/orders-parity';

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (!Object.is(got, want)) {
    failures += 1;
    console.error(`FAIL ${name}: got ${String(got)}, want ${String(want)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const KEY = '200014787177264|v=ground-saver-v2|...';
const RATE = { amount: 6.56, serviceCode: 'usps_ground_advantage', shippingProviderId: 433542 };

// ── THE REGRESSION: a fetch cancelled by an effect re-run (e.g. the operator
// SELECTING the order) must STILL record the row entry, so the cell resolves
// instead of spinning forever. ───────────────────────────────────────────────
{
  const { entry, applyPanelPreview } = planSettledAutoRate({
    requestKey: KEY, rate: RATE, cancelled: true, isPanelOrder: true,
  });
  check('cancelled fetch STILL writes the row entry', entry.key, KEY);
  check('cancelled fetch entry carries the rate', entry.rate, RATE);
  check('cancelled fetch does NOT touch the panel preview', applyPanelPreview, false);
}

// Not cancelled + panel is on this order -> the panel preview may update too.
{
  const { entry, applyPanelPreview } = planSettledAutoRate({
    requestKey: KEY, rate: RATE, cancelled: false, isPanelOrder: true,
  });
  check('live fetch writes the row entry', entry.rate, RATE);
  check('live fetch on the panel order updates the panel', applyPanelPreview, true);
}

// Not cancelled but the panel is on a DIFFERENT order -> row updates, panel does not.
{
  const { applyPanelPreview } = planSettledAutoRate({
    requestKey: KEY, rate: RATE, cancelled: false, isPanelOrder: false,
  });
  check('live fetch for a non-panel order leaves the panel alone', applyPanelPreview, false);
}

// No rate found -> terminal entry (rate=null, no error). Drives `unavailable`.
{
  const { entry } = planSettledAutoRate({ requestKey: KEY, rate: null, cancelled: false, isPanelOrder: false });
  check('no-rate settle yields a null-rate entry', entry.rate, null);
  check('no-rate settle has no error', entry.error, undefined);
}

// Errored fetch -> terminal error entry, never a panel preview. Drives `error`.
{
  const { entry, applyPanelPreview } = planSettledAutoRate({
    requestKey: KEY, rate: null, error: 'Rate lookup failed', cancelled: false, isPanelOrder: true,
  });
  check('error settle yields an error entry', entry.error, 'Rate lookup failed');
  check('error settle has null rate', entry.rate, null);
  check('error settle never previews in the panel', applyPanelPreview, false);
}

// ── PS-078 safety: a settled entry is only "displayable" when its key matches
// the CURRENT request. A stale-key entry must NOT make the row show the rate. ──
function rowStateForEntry(entry: { key: string; rate: unknown; error?: string }, currentKey: string) {
  const resolvedForKey = entry.key === currentKey;
  const resolvedError = resolvedForKey && Boolean(entry.error);
  const resolvedNoRate = resolvedForKey && !entry.rate && !entry.error;
  const hasDisplayableBestRate = resolvedForKey && Boolean(entry.rate);
  return classifyAwaitingRateCellState({
    hasDims: true,
    hasWeight: true,
    hasDisplayableBestRate,
    // a saved (possibly stale) rate exists for display in this scenario
    isCalculatingBestRate: !hasDisplayableBestRate,
    resolvedNoRate,
    resolvedError,
    hasCarrierContext: true,
    accountsLoading: false,
  });
}

{
  const { entry } = planSettledAutoRate({ requestKey: KEY, rate: RATE, cancelled: true, isPanelOrder: true });
  // Same key as current -> the resolved rate shows (convergence).
  check('exact-key resolved entry => ready (table converges)', rowStateForEntry(entry, KEY), 'ready');
  // Different current key -> the entry is ignored (no stale authority); the row
  // falls back to a BOUNDED calculating spinner (a fresh request will resolve it
  // or the 45s watchdog turns it terminal) — never shows the stale rate.
  const staleState = rowStateForEntry(entry, 'DIFFERENT-KEY');
  check('stale-key entry never shows the rate', staleState === 'ready', false);
  check('stale-key entry is a bounded spinner, not terminal-final', awaitingRateCellIsSpinner(staleState), true);
}

// A resolved error/no-rate entry for the current key is TERMINAL, not a spinner
// (this is the "do not spin forever" guarantee at the row layer).
{
  const errEntry = planSettledAutoRate({ requestKey: KEY, rate: null, error: 'boom', cancelled: false, isPanelOrder: false }).entry;
  check('resolved error => terminal error (not spinner)', rowStateForEntry(errEntry, KEY), 'error');
  check('error row is not a spinner', awaitingRateCellIsSpinner(rowStateForEntry(errEntry, KEY)), false);
  const noRateEntry = planSettledAutoRate({ requestKey: KEY, rate: null, cancelled: false, isPanelOrder: false }).entry;
  check('resolved no-rate => terminal unavailable (not spinner)', rowStateForEntry(noRateEntry, KEY), 'unavailable');
  check('unavailable row is not a spinner', awaitingRateCellIsSpinner(rowStateForEntry(noRateEntry, KEY)), false);
}

if (failures > 0) {
  console.error(`\nFAIL PS-081 rate sync guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-081 rate sync guard');
