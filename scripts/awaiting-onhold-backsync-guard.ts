/**
 * Stage 1 — awaiting on-hold/pending back-sync guard.
 *
 * Root cause of "PrepShip Awaiting != ShipStation Awaiting": order-sync only back-synced shipped +
 * cancelled, so orders ShipStation moved to On-Hold / Pending Fulfillment / Awaiting Payment stayed
 * stuck in PrepShip's awaiting list. Fix: status catch-up now covers those non-terminal states, and
 * the per-order UPDATE transitions from ANY non-terminal status (never overwriting shipped/cancelled).
 * Since the awaiting view filters order_status='awaiting_shipment', held orders drop off automatically;
 * they auto-revert via the import upsert when SS un-holds them, and still convert to shipped/cancelled.
 *
 * Per user override unlock shipped data on 2026-06-10.
 * Offline / pure: readFileSync only.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/services/order-sync.ts', 'utf8');

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}

// ── (1) catch-up passes include the non-terminal SS states ──
for (const status of ['shipped', 'cancelled', 'on_hold', 'awaiting_payment', 'pending_fulfillment']) {
  check(`catch-up passes include orderStatus '${status}'`,
    new RegExp(`const STATUS_CATCHUP_STATUSES[\\s\\S]*'${status}'`).test(src) &&
      /STATUS_CATCHUP_STATUSES\.flatMap/.test(src));
}

// ── (2) the status-catch-up UPDATE never overwrites terminal rows, and is no longer awaiting-only ──
check('updateExistingOrderStatusesBatch excludes terminal rows (notInArray shipped/cancelled)',
  /notInArray\(orders\.orderStatus, \['shipped', 'cancelled'\]\)/.test(src));
check('the catch-up UPDATE no longer hard-pins WHERE order_status = awaiting_shipment',
  !/eq\(orders\.orderStatus, 'awaiting_shipment'\)\s*\)\s*\)\s*\.returning\(\)/.test(src));
check('no-op rewrites skipped via ne(orders.orderStatus, orderStatus)',
  /ne\(orders\.orderStatus, orderStatus\)/.test(src));

// ── (3) the catch-up status type carries the new states ──
check('CatchUpOrderStatus type includes on_hold/awaiting_payment/pending_fulfillment',
  /type CatchUpOrderStatus =[\s\S]*'on_hold'[\s\S]*'awaiting_payment'[\s\S]*'pending_fulfillment'/.test(src));

// ── (4) ONLY 'shipped' deducts inventory in the catch-up (on_hold/pending must not) ──
// The catch-up's deduction loop is gated on `orderStatus === 'shipped'`; the new hold statuses fall
// outside that branch so they never deduct stock.
check("catch-up inventory deduction stays gated to orderStatus === 'shipped'",
  /if \(orderStatus === 'shipped'\) \{/.test(src) &&
  /enqueueInventoryDeduction\(row, \{ source: 'order_sync_status' \}\)/.test(src));

if (failures > 0) {
  console.error(`\nFAIL awaiting on-hold back-sync guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS awaiting on-hold back-sync guard');
