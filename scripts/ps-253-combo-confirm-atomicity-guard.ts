/**
 * PS-253 (Card 8, slice 3) — combo-default serialization + idempotent marketplace confirmation.
 *
 * (b) saveComboPackageDefault's upsert is atomic, but the sibling-order APPLY is a read-modify-write
 *     two concurrent saves could interleave. A per-(client,combo) blocking session advisory lock
 *     serializes them.
 * (c, confirm idempotency) a crash between the connector ack and completeOutboxRow leaves the outbox
 *     row 'processing'; the PS-253 stale-reclaim re-delivers it, so processOutboxRow now re-checks the
 *     shipment's confirmation state right before dispatch and settles WITHOUT re-confirming if it
 *     already succeeded (no double-confirm at the marketplace).
 *
 *   npx tsx scripts/ps-253-combo-confirm-atomicity-guard.ts
 */
import { readFileSync } from 'node:fs';
import { advisoryLockKeyPair } from '../src/lib/advisory-lock';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const lock = readFileSync('src/lib/advisory-session-lock.ts', 'utf8');
const combo = readFileSync('src/services/combo-package-defaults.ts', 'utf8');
const outbox = readFileSync('src/services/fulfillment/outbox.ts', 'utf8');

// ── the serializing session-lock helper ──
check('session-lock reserves a dedicated connection (pool-safe)', /sql\.reserve\(\)/.test(lock));
check('session-lock BLOCKS to serialize (pg_advisory_lock, not the non-blocking try variant)',
  /pg_advisory_lock\(\$\{classid\}, \$\{objid\}\)/.test(lock) && !/pg_try_advisory_lock/.test(lock));
check('session-lock always unlocks + releases the connection',
  /pg_advisory_unlock/.test(lock) && /reserved\.release\(\)/.test(lock));

// ── (b) combo-default serialization ──
check('saveComboPackageDefault serializes upsert+apply under a per-(client,combo) lock',
  /withAdvisorySessionLock\(`combo_default:\$\{clientId\}:\$\{comboKey\}`/.test(combo));

// ── (c) idempotent confirmation ──
const procStart = outbox.indexOf('async function processOutboxRow');
const proc = outbox.slice(procStart, procStart + 3200);
check('processOutboxRow re-checks the shipment confirmation state before dispatch',
  /confirmation_status, marketplace_confirmed_at/.test(proc) &&
  /FROM shipments WHERE id = \$\{idempotencyShipmentId\}/.test(proc));
check('an already-confirmed shipment settles the row WITHOUT re-confirming (the check precedes dispatch)',
  proc.indexOf('completeOutboxRow(row)') > 0 &&
  proc.indexOf('completeOutboxRow(row)') < proc.indexOf('connector.confirmShipment'));

// ── behavioral: the lock key is deterministic per resource ──
const k = advisoryLockKeyPair('combo_default:4:abc');
const k2 = advisoryLockKeyPair('combo_default:4:abc');
const k3 = advisoryLockKeyPair('combo_default:5:abc');
check('lock key is deterministic per (client,combo)', k[0] === k2[0] && k[1] === k2[1]);
check('different combos get different lock keys', k[0] !== k3[0] || k[1] !== k3[1]);

check('package.json wires test:ps-253-combo-confirm-atomicity',
  /test:ps-253-combo-confirm-atomicity/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-253 combo + confirm atomicity guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-253 combo + confirm atomicity guard');
