/**
 * PS-248 (Card 3, slice) — concurrent label PURCHASES for one order are serialized (no double postage).
 *
 * createLabelV2's route scope (PS-233) + editable + PS-128/129 safe-to-ship guards already block the
 * single-threaded cases. The remaining gap was the CONCURRENCY race: two near-simultaneous buys both
 * pass the not-yet-shipped check and purchase two labels. createLabelV2 now wraps its impl in a
 * per-order NON-BLOCKING DB lease: a second in-flight buy for the same order is rejected with
 * LABEL_PURCHASE_IN_PROGRESS, not queued. The lease expires if a worker is interrupted mid-purchase,
 * so pooled DB sessions cannot strand a label lock. The buy/persist logic is unchanged. (Concurrent
 * behavior itself is canary-verified; offline cert can't run two simultaneous buys — this guard pins
 * the MECHANISM + wiring.)
 *
 *   npx tsx scripts/ps-248-label-purchase-lock-guard.ts
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const lock = readFileSync('src/lib/label-purchase-lock.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');

// ── the lock helper ──
check('lock helper creates the durable label_purchase_locks table',
  /CREATE TABLE IF NOT EXISTS label_purchase_locks/.test(lock));
check('lock helper keys the lease by order_id primary key',
  /order_id integer PRIMARY KEY/.test(lock));
check('lock helper stores a token and expiry for each lease',
  /token text NOT NULL/.test(lock) && /expires_at timestamptz NOT NULL/.test(lock));
check('lock helper uses NON-BLOCKING insert/upsert lease acquisition',
  /ON CONFLICT \(order_id\) DO UPDATE SET/.test(lock) &&
    /WHERE label_purchase_locks\.expires_at <= now\(\)/.test(lock) &&
    /RETURNING token/.test(lock));
check('lock helper releases only the matching token',
  /DELETE FROM label_purchase_locks/.test(lock) &&
    /WHERE order_id = \$\{orderId\}/.test(lock) &&
    /AND token = \$\{token\}/.test(lock));
check('lock helper no longer depends on pooled session advisory locks',
  !/pg_try_advisory_lock|pg_advisory_unlock|sql\.reserve\(\)/.test(lock));
check('a second in-flight buy is rejected with LABEL_PURCHASE_IN_PROGRESS',
  /class LabelPurchaseInProgressError/.test(lock) && /code = 'LABEL_PURCHASE_IN_PROGRESS'/.test(lock));
check('active lock check ignores expired leases',
  /export async function isLabelPurchaseLockActive/.test(lock) && /expires_at > now\(\)/.test(lock));

// ── createLabelV2 wraps the impl with the lock ──
check('createLabelV2 acquires the per-order purchase lock', /acquireLabelPurchaseLock\(body\.orderId\)/.test(labels));
check('createLabelV2 delegates the buy to the impl inside the lock',
  /return await createLabelV2Impl\(body, scope\)/.test(labels));
check('createLabelV2 ALWAYS releases the lock (finally)',
  /finally \{\s*await purchaseLock\.release\(\)/.test(labels));
check('the impl (all guards + buy + persist) still exists', /async function createLabelV2Impl\(/.test(labels));

check('package.json wires test:ps-248-label-purchase-lock',
  /test:ps-248-label-purchase-lock/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-248 label-purchase lock guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-248 label-purchase lock guard');
