/**
 * PS-253 (Card 8, slice 2) — the fulfillment outbox reclaims orphaned 'processing' rows.
 *
 * claimDueOutboxRows flips a row to 'processing' when claimed. The worker is multi-process and
 * restart/crash-prone, so a crash between claim and complete/fail would otherwise strand the row in
 * 'processing' forever (the claim only ever took pending/failed) -> the shipment is NEVER confirmed.
 * This pins the lease-TTL reclaim: a 'processing' row older than OUTBOX_PROCESSING_LEASE_MINUTES is
 * reclaimable. The write path (complete/fail/markShipmentConfirmationState) must stay unchanged.
 *
 *   npx tsx scripts/ps-253-outbox-stale-reclaim-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const outbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');
const start = outbox.indexOf('async function claimDueOutboxRows');
const endRel = outbox.indexOf('\nasync function claimOutboxRowById', start);
const claimRaw = start >= 0 ? outbox.slice(start, endRel > start ? endRel : start + 2000) : '';
const claimFlat = claimRaw.replace(/\s+/g, '');

check('claimDueOutboxRows exists', start >= 0);
check('a lease constant bounds how long a row may sit in processing',
  /const OUTBOX_PROCESSING_LEASE_MINUTES = \d+;/.test(outbox));
check('the claim still takes due pending/failed rows',
  /status IN \('pending', 'failed'\) AND next_run_at <= NOW\(\)/.test(claimRaw));
check('the claim ALSO reclaims orphaned processing rows past the lease',
  claimFlat.includes("status='processing'") &&
    claimFlat.includes("updated_at<NOW()-(" ) &&
    /OUTBOX_PROCESSING_LEASE_MINUTES/.test(claimRaw));
check('reclaim is the lease guard, not SKIP LOCKED (lock released at claim time)',
  /FOR UPDATE SKIP LOCKED/.test(claimRaw));

// the write path must be byte-identical (only claim eligibility changed)
check('completeOutboxRow still marks succeeded + shipment confirmation_status',
  /status = 'succeeded'/.test(outbox) && /status: 'succeeded'/.test(outbox));
check('failOutboxRow still increments attempts + bounds by MAX_ATTEMPTS',
  /attempts < MAX_ATTEMPTS/.test(outbox));
check('a succeeded outbox row is never re-claimed (left out of the claim filter)',
  !/status IN \('pending', 'failed', 'succeeded'\)/.test(claimRaw));

check('package.json wires test:ps-253-outbox-stale-reclaim',
  /test:ps-253-outbox-stale-reclaim/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-253 outbox stale-reclaim guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-253 outbox stale-reclaim guard');
