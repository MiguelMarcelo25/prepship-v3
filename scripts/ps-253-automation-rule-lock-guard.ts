/**
 * PS-253 (Card 8) guard — the shipping-automation-rule upsert is serialized so concurrent
 * saves can't lose each other's update (read-modify-write -> transaction + advisory lock).
 *
 * BEHAVIORAL: runs advisoryLockKeyPair (deterministic, signed-int4 range, name-distinct).
 * STATIC: upsertShippingAutomationRule wraps the read+write in db.transaction +
 * pg_advisory_xact_lock, and does both the select and the insert on the tx (so the lock covers them).
 *
 *   npx tsx scripts/ps-253-automation-rule-lock-guard.ts
 */
import { readFileSync } from 'node:fs';
import { advisoryLockKeyPair } from '../src/lib/advisory-lock';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) { failures += 1; console.error(`FAIL ${name}`); }
  else console.log(`ok   ${name}`);
}

const INT4_MIN = -(2 ** 31);
const INT4_MAX = 2 ** 31 - 1;

// ── 1. key helper: deterministic, in signed-int4 range, distinct per name ─────────────────────
const a = advisoryLockKeyPair('automation_shipping_controls');
const b = advisoryLockKeyPair('automation_shipping_controls');
check('returns a [int, int] pair', Array.isArray(a) && a.length === 2 && a.every(Number.isInteger));
check('deterministic for the same name', a[0] === b[0] && a[1] === b[1]);
check('both keys are in the signed int4 range',
  a[0] >= INT4_MIN && a[0] <= INT4_MAX && a[1] >= INT4_MIN && a[1] <= INT4_MAX);
const other = advisoryLockKeyPair('marketplace_fee_rules');
check('different names -> different lock keys', a[0] !== other[0] || a[1] !== other[1]);

// ── 2. the upsert is serialized under a transaction-scoped advisory lock ──────────────────────
const src = readFileSync('src/services/automations/shipping-controls.ts', 'utf8');
const fn = src.slice(src.indexOf('export async function upsertShippingAutomationControls'));
check('imports advisoryLockKeyPair from the shared owner',
  /import \{ advisoryLockKeyPair \} from '\.\.\/\.\.\/lib\/advisory-lock\.js'/.test(src));
check('upsert wraps the work in db.transaction', /db\.transaction\(async \(tx\) =>/.test(fn));
check('upsert acquires pg_advisory_xact_lock', /pg_advisory_xact_lock\(\$\{classid\}, \$\{objid\}\)/.test(fn));
check('upsert READS on the tx (lock covers the read)', /await tx\s*\n?\s*\.select\(/.test(fn));
check('upsert WRITES on the tx (lock covers the write)', /await tx\.insert\(automationShippingControls\)/.test(fn));

check('package.json wires test:ps-253-automation-rule-lock',
  /test:ps-253-automation-rule-lock/.test(readFileSync('package.json', 'utf8')));

if (failures > 0) {
  console.error(`\nFAIL PS-253 automation-rule lock guard (${failures} failing)`);
  process.exit(1);
}
console.log('\nPASS PS-253 automation-rule lock guard');
