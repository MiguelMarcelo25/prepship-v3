/**
 * PS-312 (S0) — REAL execution test for the combined-shipment-bundle schema + membership
 * invariants. Proves the bundle-membership rules (exactly one primary, >=2 members, no duplicate
 * order) and that the new schema is purely ADDITIVE (references orders/shipments, never ALTERs the
 * locked tables) + registered. Pure/offline — no DB.
 */
import { readFileSync } from 'node:fs';
import { validateBundleMembership, primaryOrderIdOf } from '../src/services/shipment-bundles/shipment-bundle-invariants';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

// ── Invariants ──
const valid = [
  { orderId: 1778, role: 'primary' as const },
  { orderId: 1777, role: 'child' as const },
];
check('a 1-primary + 1-child bundle is VALID', validateBundleMembership(valid).valid);
check('the primary order id resolves', primaryOrderIdOf(valid) === 1778);

check('ZERO primaries is invalid',
  !validateBundleMembership([{ orderId: 1, role: 'child' }, { orderId: 2, role: 'child' }]).valid);
check('TWO primaries is invalid',
  !validateBundleMembership([{ orderId: 1, role: 'primary' }, { orderId: 2, role: 'primary' }]).valid);
check('a lone member (1) is invalid — a bundle needs >=2',
  !validateBundleMembership([{ orderId: 1, role: 'primary' }]).valid);
check('a duplicated order is invalid',
  !validateBundleMembership([{ orderId: 1, role: 'primary' }, { orderId: 1, role: 'child' }]).valid);
check('removed members do not count toward the bundle',
  !validateBundleMembership([
    { orderId: 1, role: 'primary' },
    { orderId: 2, role: 'child', status: 'removed' },
  ]).valid);
check('primaryOrderIdOf returns null for an invalid bundle', primaryOrderIdOf([{ orderId: 1, role: 'primary' }]) === null);

// ── Additive / non-destructive schema ──
const schema = readFileSync('src/db/schema/shipment-bundles.ts', 'utf8');
check('schema defines BOTH sidecar tables',
  /pgTable\(\s*'shipment_bundles'/.test(schema) && /pgTable\(\s*'shipment_bundle_members'/.test(schema));
check('member table pins order_id UNIQUE (an order is in AT MOST one bundle)',
  /uniqueIndex\([^)]*shipment_bundle_members_order_unq[^)]*\)[^]*?\.on\(t\.orderId\)/.test(schema) ||
  /shipment_bundle_members_order_unq'\)\.on\(t\.orderId\)/.test(schema));
check('schema is ADDITIVE — it only references orders/shipments, never ALTER/DROP-s them',
  /references\(\(\) => orders\.id\)/.test(schema) &&
  !/alterTable|DROP TABLE|ALTER TABLE\s+(orders|shipments)|\.drop\(/i.test(schema));
const index = readFileSync('src/db/schema/index.ts', 'utf8');
check('schema is registered in the drizzle schema index', /export \* from '\.\/shipment-bundles\.js'/.test(index));

// ── Runtime ensure is CREATE TABLE IF NOT EXISTS (no blocking migration), never DROP/ALTER locked ──
const ensure = readFileSync('src/services/shipment-bundles/ensure-shipment-bundles-schema.ts', 'utf8');
const migration = readFileSync('drizzle/0052_shipment_bundles.sql', 'utf8');
check('migration owns both tables and runtime delegates readiness',
  /CREATE TABLE IF NOT EXISTS shipment_bundles/.test(migration) &&
  /CREATE TABLE IF NOT EXISTS shipment_bundle_members/.test(migration) &&
  /assertRuntimeSchemaReady/.test(ensure) &&
  !/CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(ensure));

if (failures > 0) {
  console.error(`\nPS-312 shipment-bundle schema guard FAILED with ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nPS-312 shipment-bundle schema guard passed.');
