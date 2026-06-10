/**
 * Part B — deleted-upstream sweep guard.
 *
 * When ShipStation edits an order it deletes the original and creates a new one (new id + number),
 * leaving a phantom awaiting row in PrepShip pointing at a now-deleted SS order. The sweep in
 * reconcile-shipstation-awaiting.ts confirms deletion by a DEFINITIVE 404 and cancels the phantom —
 * but ONLY with strong safety properties, which this guard pins (a false 404 would wrongly cancel a
 * live order):
 *   1. 404 detected by RAW status code; non-404/non-ok => 'error', NEVER 'deleted'.
 *   2. Each suspect routed to the account that OWNS its store; unknown store => skipped (no guessing creds).
 *   3. The cancel UPDATE is gated on --apply AND `order_status='awaiting_shipment'` (idempotent).
 *   4. The whole sweep is opt-in via --resolve-deleted.
 *
 * Per user override unlock shipped data on 2026-06-10. Offline / pure: readFileSync only.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/reconcile-shipstation-awaiting.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// (1) 404-by-raw-status; never treat 5xx/network as deleted
check('shipStationOrderExists returns deleted ONLY on raw 404',
  /if \(res\.status === 404\) return 'deleted';/.test(src));
check('non-404 / non-ok returns error (never deleted)',
  /if \(res\.ok\) return 'exists';\s*\n\s*return 'error';/.test(src) &&
  /catch \{\s*\n\s*return 'error';/.test(src));

// (2) account routing: unknown store => null => skip (no wrong-creds 404)
check('accountForStore returns null when no known account owns the store',
  /function accountForStore[\s\S]*?return null;\s*\n\}/.test(src) &&
  /main && main\.storeIds\.includes\(storeId\)/.test(src));
check('sweep skips suspects with no owning account or no externalOrderId',
  /if \(!account \|\| !s\.externalOrderId\) \{\s*\n\s*skipped \+= 1;/.test(src));

// (3) cancel gated on apply + awaiting-only idempotent WHERE
check('cancel only under options.apply',
  /if \(options\.apply && deleted\.length\)/.test(src));
check("cancel UPDATE guarded by order_status='awaiting_shipment'",
  /SET order_status = 'cancelled', canonical_status = 'cancelled'[\s\S]*?WHERE id = \$\{s\.id\} AND order_status = 'awaiting_shipment'/.test(src));

// (4) opt-in flag + dry-run default
check('sweep is opt-in via --resolve-deleted (only runs when flagged)',
  /const resolveDeleted = hasFlag\('resolve-deleted'\);/.test(src) &&
  /if \(resolveDeleted && needsConfirmation\.length\)/.test(src));

// (5) account routing safety: per-org clients' stores are EXCLUDED from main.storeIds so a store is
//     never queried with the wrong org's credentials (a wrong-creds 404 would falsely confirm deletion).
check('main.storeIds excludes stores owned by per-org-credentialed clients',
  /const perOrgStoreIds = new Set\(/.test(src) &&
  /\.filter\(\(row\) => row\.ssApiKey && row\.ssApiSecret\)/.test(src) &&
  /\.filter\(\(storeId\) => !perOrgStoreIds\.has\(storeId\)\)/.test(src));

// (6) suspect set pinned to the explicit classifier kind (not the fragile targetStatus===null proxy)
check('needsConfirmation pinned to kind local_awaiting_missing_from_shipstation',
  /finding\.kind === 'local_awaiting_missing_from_shipstation' &&/.test(src));

// (7) scope guard: unscoped --apply must NOT write — cancellation requires --store-id and/or --order-number
check('cancellation requires an explicit scope (writeDeleted = apply && scoped)',
  /const scoped = Boolean\(\(orderNumbers && orderNumbers\.length\) \|\| \(storeIds && storeIds\.length\)\);/.test(src) &&
  /const writeDeleted = apply && scoped;/.test(src) &&
  /apply: writeDeleted,/.test(src));
check('unscoped --apply warns it is refusing to cancel',
  /REFUSING to cancel without scope/.test(src));

if (failures > 0) {
  console.error(`\nFAIL deleted-upstream sweep guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS deleted-upstream sweep guard');
