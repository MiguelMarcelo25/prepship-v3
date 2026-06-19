/**
 * PS-286 guard — the "applied a rate in the Rate Browser, then immediately hit
 * Send/Print-Queue on a not-yet-reconciled Awaiting row" race is closed.
 *
 * Each applied-rate persist (applyRateSelection + onBestRateResolved) is registered
 * in an in-flight Map by orderId, and the Rate Browser CLOSE awaits the relevant
 * ones before it hides the modal — so the row is only exposed once its SOT has
 * persisted + refetched. Pins the pure helpers + the OrdersView wiring.
 *
 *   npx tsx scripts/ps-286-applied-rate-sync-guard.ts
 */
import { readFileSync } from 'node:fs';
import {
  trackAppliedRatePersist,
  awaitAppliedRatePersists,
} from '../web/src/components/Views/orders-applied-rate-sync';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

async function main(): Promise<void> {
  // ── pure helpers ──────────────────────────────────────────────────────────
  {
    const map = new Map<number, Promise<unknown>>();
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    const returned = trackAppliedRatePersist(map, 42, p);
    check('trackAppliedRatePersist registers the persist under its orderId', map.get(42) === p);
    check('trackAppliedRatePersist returns the same promise', returned === p);
    resolve();
    await p;
    await flush();
    check('the entry auto-clears once the persist settles', !map.has(42));
  }
  {
    const map = new Map<number, Promise<unknown>>();
    await awaitAppliedRatePersists(map, [1, 2, 3]);
    check('awaitAppliedRatePersists resolves immediately when nothing is in-flight', true);
  }
  {
    const map = new Map<number, Promise<unknown>>();
    let settled = false;
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; }).then(() => { settled = true; });
    trackAppliedRatePersist(map, 7, p);
    const waiter = awaitAppliedRatePersists(map, [7]).then(() => {
      check('awaitAppliedRatePersists waited for the in-flight persist to settle', settled);
    });
    resolve();
    await waiter;
  }
  {
    // a REJECTED persist must not reject the waiter (the persist owns its own toast).
    const map = new Map<number, Promise<unknown>>();
    trackAppliedRatePersist(map, 9, Promise.reject(new Error('boom')));
    let waiterRejected = false;
    try { await awaitAppliedRatePersists(map, [9]); } catch { waiterRejected = true; }
    check('awaitAppliedRatePersists never rejects on a failed persist', !waiterRejected);
    await flush();
    check('a settled (rejected) persist still auto-clears from the map', !map.has(9));
  }

  // ── OrdersView wiring ────────────────────────────────────────────────────
  const ov = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
  check('OrdersView imports the applied-rate sync helpers',
    /trackAppliedRatePersist/.test(ov) && /awaitAppliedRatePersists/.test(ov) && /orders-applied-rate-sync/.test(ov));
  check('OrdersView holds an in-flight applied-rate persist ref',
    /appliedRatePersists\w*Ref\b/.test(ov) && /useRef\(\s*new Map<number,\s*Promise<unknown>>\(\)\s*\)/.test(ov));
  check('OrdersView has a close-after-persist gate that awaits then closes',
    /closeRateBrowserAfterPersist/.test(ov) && /awaitAppliedRatePersists\s*\(/.test(ov) && /setRateBrowserOpen\(false\)/.test(ov));
  check('OrdersView registers every applied-rate persist via trackAppliedRatePersist (>= 4 sites)',
    (ov.match(/trackAppliedRatePersist\s*\(/g) ?? []).length >= 4);
  check('OrdersView no longer bare-void-fire-and-forgets persistAppliedRateForOrder',
    !/void persistAppliedRateForOrder\s*\(/.test(ov));
  check('the Rate Browser modal onClose routes through the close-after-persist gate',
    /onClose=\{\(\)\s*=>\s*\{?\s*void closeRateBrowserAfterPersist\(\)/.test(ov));

  check('package.json wires test:ps-286-applied-rate-sync',
    /test:ps-286-applied-rate-sync/.test(readFileSync('package.json', 'utf8')));
}

main().then(() => {
  if (failures > 0) {
    console.error(`\nFAIL ps-286 applied-rate sync guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS ps-286 applied-rate sync guard');
}).catch((err) => {
  console.error('FAIL ps-286 applied-rate sync guard threw:', err);
  process.exit(1);
});
