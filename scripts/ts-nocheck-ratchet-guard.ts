/**
 * PS-257 (Card 12) — @ts-nocheck ratchet.
 *
 * `npm run typecheck` reports a FALSE green: ~94 files under web/src open with `// @ts-nocheck`,
 * so tsc skips them entirely. This guard can't fix those files, but it freezes the count at a
 * CEILING that may only go DOWN: removing a @ts-nocheck (and fixing the file's types) lowers it;
 * ADDING a new @ts-nocheck fails the build. The debt can shrink, never grow.
 *
 * When you remove @ts-nocheck files, LOWER `CEILING` to the new count in the SAME PR. Never raise it.
 *
 *   npx tsx scripts/ts-nocheck-ratchet-guard.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Baseline count on 2026-06-16. Lower this with every file you de-nocheck; never raise it.
// 2026-06-17 (PS-257 blitz slice 1): de-nocheck'd 33 provably-clean files (single bare
// directive, typecheck-clean once removed, zero residual @ts-nocheck) — 94 -> 61.
// 2026-06-17 (PS-257 blitz slice 2): recovered 11 more — 4 trailing-text directives that
// type-check clean once fully stripped (OrdersBatchPanel, OrdersPanelSections,
// orders-persistent-queue-job, DashboardSkuTableRow) + 7 ratchet FALSE-POSITIVES whose
// only @ts-nocheck was a prose mention in an already-strict file — 61 -> 50.
// 2026-06-17 (PS-257 blitz slice 3): 13 single-error files fixed TYPE-ONLY (phantom
// @prepshipv2/contracts type imports + missing types/api *Dto imports -> local type
// aliases; 2 casts) — all type-erased, emitted JS byte-identical — 50 -> 37.
// 2026-06-17 (PS-257 blitz slice 4): 13 type-noise files de-nocheck'd BYTE-IDENTICALLY
// (as-casts, ! assertions, local type aliases, annotations — all TS-erased, no runtime
// change). One type-gap flagged for follow-up: orders-parity PrintQueueEntryDto should add
// optional shipping_hold/held_reason. markups.ts cast `(type as string)==='percent'` (narrow
// MarkupType union; widen as follow-up). — 37 -> 24.
// 2026-06-17 (PS-257 blitz slice 5): 14 mid-error files de-nocheck'd BYTE-IDENTICALLY,
// domain-grouped (billing/orders/inventory/sidebar/cards). Cross-file ripples from the
// now-structured parity types were resolved at the consumers (PackagesView casts, sidebar/
// billing draft casts, orders-display-state LooseBestRate shared export) — all type-erased.
// PrintQueueEntryDto + PackageLedgerEntryDto follow-up fixes already landed in slice 4. — 24 -> 10.
const CEILING = 10;

const ROOT = 'web/src';
const EXTS = ['.ts', '.tsx'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTS.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const files = walk(ROOT)
  .filter((f) => readFileSync(f, 'utf8').includes('@ts-nocheck'))
  .sort();
const count = files.length;

console.log(`@ts-nocheck files under ${ROOT}: ${count} (ceiling ${CEILING})`);

if (count > CEILING) {
  console.error(`\nFAIL @ts-nocheck ratchet: ${count} > ${CEILING}.`);
  console.error('A new @ts-nocheck file was added. Type the file properly instead, or — if truly');
  console.error('unavoidable — justify it; the ceiling only moves DOWN. Current @ts-nocheck files:');
  for (const f of files) console.error(`  ${f}`);
  process.exit(1);
}

if (count < CEILING) {
  console.log(`\nNOTE: count dropped to ${count}. Lower CEILING to ${count} in this PR to lock the gain.`);
}

console.log('\nPASS @ts-nocheck ratchet');
