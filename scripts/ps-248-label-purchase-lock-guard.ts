/**
 * PS-248 (Card 3, slice) — concurrent label PURCHASES for one order are serialized (no double postage).
 *
 * createLabelV2's route scope (PS-233) + editable + PS-128/129 safe-to-ship guards already block the
 * single-threaded cases. The remaining gap was the CONCURRENCY race: two near-simultaneous buys both
 * pass the not-yet-shipped check and purchase two labels. createLabelV2 now wraps its impl in a
 * per-order NON-BLOCKING session advisory lock on a RESERVED connection: a second in-flight buy for
 * the same order is rejected with LABEL_PURCHASE_IN_PROGRESS, not queued. The buy/persist logic is
 * unchanged. (Concurrent behavior itself is canary-verified; offline cert can't run two simultaneous
 * buys — this guard pins the MECHANISM + wiring.)
 *
 *   npx tsx scripts/ps-248-label-purchase-lock-guard.ts
 */
import { readFileSync } from 'node:fs';
import { advisoryLockKeyPair } from '../src/lib/advisory-lock';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const lock = readFileSync('src/lib/label-purchase-lock.ts', 'utf8');
const labels = readFileSync('src/services/labels.ts', 'utf8');

// ── the lock helper ──
check('lock helper reserves a dedicated connection (pool-safe unlock)', /sql\.reserve\(\)/.test(lock));
check('lock helper uses NON-BLOCKING pg_try_advisory_lock',
  /pg_try_advisory_lock\(\$\{classid\}, \$\{objid\}\)/.test(lock));
check('lock helper releases the session lock', /pg_advisory_unlock\(\$\{classid\}, \$\{objid\}\)/.test(lock));
check('lock helper ALWAYS releases the reserved connection (every exit path)',
  (lock.match(/reserved\.release\(\)/g)?.length ?? 0) >= 2);
check('a second in-flight buy is rejected with LABEL_PURCHASE_IN_PROGRESS',
  /class LabelPurchaseInProgressError/.test(lock) && /code = 'LABEL_PURCHASE_IN_PROGRESS'/.test(lock));
check('the lock is keyed per ORDER', /label_purchase:order:\$\{orderId\}/.test(lock));

// ── behavioral: same order -> same key; different order -> different key ──
const k1 = advisoryLockKeyPair('label_purchase:order:1');
const k1b = advisoryLockKeyPair('label_purchase:order:1');
const k2 = advisoryLockKeyPair('label_purchase:order:2');
check('lock key is deterministic per order', k1[0] === k1b[0] && k1[1] === k1b[1]);
check('different orders get different lock keys', k1[0] !== k2[0] || k1[1] !== k2[1]);

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
