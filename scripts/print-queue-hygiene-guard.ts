/**
 * Stage 2 — print-queue hygiene guard.
 *
 * Operator confusion: the Print Queue showed already-shipped/blocked orders ("ALREADY SHIPPED — LABEL
 * BLOCKED") and still counted them in "N queued labels not printed" — so it said "7 to print, click
 * Print All" when all 7 were blocked. The merge/print job already EXCLUDED held entries server-side;
 * this aligns the ACTIVE queue display with it: listQueue (when !includePrinted) drops entries whose
 * order is on a shipping hold (locally shipped/cancelled, cancelled upstream, externally shipped). The
 * FE count (unprintedQueueCount ← queuedEntries ← listQueue) then auto-corrects; history keeps all rows.
 *
 * Per user override unlock shipped data on 2026-06-10.
 * Offline / pure: readFileSync only.
 */
import { readFileSync } from 'node:fs';

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
check('holds still come from loadShippingHoldsForOrderIds (locally shipped/cancelled + upstream)',
  /const holds = await loadShippingHoldsForOrderIds\(entries\.map\(/.test(src));
check('history path (includePrinted) still returns every entry (no silent data loss)',
  /includePrinted\s*\?\s*entries/.test(src));

if (failures > 0) {
  console.error(`\nFAIL print-queue hygiene guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS print-queue hygiene guard');
