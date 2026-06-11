/**
 * Stage 2 — print-queue hygiene guard.
 *
 * Operator confusion: the Print Queue showed already-shipped/blocked orders ("ALREADY SHIPPED — LABEL
 * BLOCKED") and still counted them in "N queued labels not printed" — so it said "7 to print, click
 * Print All" when all 7 were blocked. The merge/print job already EXCLUDED held entries server-side;
 * this aligns the ACTIVE queue display with it: listQueue (when !includePrinted) drops entries whose
 * order is on a shipping hold (cancelled locally/upstream, externally shipped). The FE count
 * (unprintedQueueCount ← queuedEntries ← listQueue) then auto-corrects; history keeps all rows.
 *
 * Per user override unlock shipped data on 2026-06-10.
 *
 * Per user override unlock shipped data on 2026-06-11: 'local_shipped' is NOT a print-queue hold.
 * createLabelV2 marks an order shipped BEFORE its queue entry exists, so the original hold set
 * (which included local_shipped) hid EVERY fresh label from the active queue and failed it at
 * merge — the queue read "empty" the moment a label was created (DJ report: order 1463). The
 * holds loader now skips exactly decision.code === 'local_shipped'; cancelled/external holds and
 * the label-CREATION block on shipped orders (decideShippingSafety) are unchanged.
 * Offline / pure: readFileSync only.
 */
import { readFileSync } from 'node:fs';
import { decideShippingSafety } from '../src/services/fulfillment/shipping-safety';

const src = readFileSync('src/services/print-queue.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── listQueue excludes held entries from the ACTIVE queue, keeps them in history ──
check('listQueue computes visibleEntries that exclude held orders when !includePrinted',
  /const visibleEntries = includePrinted\s*\?\s*entries\s*:\s*entries\.filter\(\(e\) => !holds\.has\(Number\(e\.orderId\)\)\)/.test(src));
check('active queue totals/list use visibleEntries (not raw entries)',
  /visibleEntries\.reduce\(/.test(src) &&
  /queuedOrders: visibleEntries\.map\(/.test(src) &&
  /totalOrders: visibleEntries\.length/.test(src));
check('holds still come from loadShippingHoldsForOrderIds (cancelled + upstream + external)',
  /const holds = await loadShippingHoldsForOrderIds\(entries\.map\(/.test(src));
check('history path (includePrinted) still returns every entry (no silent data loss)',
  /includePrinted\s*\?\s*entries/.test(src));

// ── 2026-06-11: local_shipped is a creation guard, not a print-queue hold ──
check('holds loader skips exactly local_shipped (fresh labels stay visible + printable)',
  /!decision\.safe && decision\.code !== 'local_shipped'/.test(src));
check('no other hold code is skipped (cancelled/external holds intact)',
  (src.match(/decision\.code !== /g) ?? []).length === 1);
// Creation-time safety is UNTOUCHED: a locally-shipped order still blocks new postage.
{
  const creation = decideShippingSafety({ orderStatus: 'shipped' });
  check('decideShippingSafety still blocks label creation for shipped orders',
    creation.safe === false && creation.code === 'local_shipped');
}
{
  const cancelled = decideShippingSafety({ orderStatus: 'cancelled' });
  check('decideShippingSafety still blocks cancelled orders',
    cancelled.safe === false && cancelled.code === 'local_cancelled');
}
{
  const external = decideShippingSafety({ orderStatus: 'awaiting_shipment', externallyShipped: true });
  check('decideShippingSafety still blocks externally-shipped orders',
    external.safe === false && external.code === 'externally_shipped');
}

if (failures > 0) {
  console.error(`\nFAIL print-queue hygiene guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS print-queue hygiene guard');
