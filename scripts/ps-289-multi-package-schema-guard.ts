/**
 * PS-289 - multi-package sidecar schema guard.
 *
 * Verifies the additive shipment-group persistence model without running DB
 * DDL, touching shipped/cancelled rows, buying labels, or enqueueing prints.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}`);
}

const schema = readFileSync('src/db/schema/shipment-groups.ts', 'utf8');
const schemaIndex = readFileSync('src/db/schema/index.ts', 'utf8');
const migration = readFileSync('drizzle/0051_shipment_groups.sql', 'utf8');
const planner = readFileSync('src/services/shipping-workflow/multi-package-shipment-plan.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');
const drizzleConfig = readFileSync('drizzle.config.ts', 'utf8');

check('schema exports shipmentGroups table',
  /export const shipmentGroups = pgTable\(\s*'shipment_groups'/.test(schema));
check('schema exports shipmentGroupPackages table',
  /export const shipmentGroupPackages = pgTable\(\s*'shipment_group_packages'/.test(schema));
check('schema references orders and clients without altering them',
  schema.includes("import { orders } from './orders.js'") &&
  schema.includes("import { clients } from './clients.js'"));
check('package rows may link to shipments without modifying shipment schema',
  schema.includes("import { shipments } from './shipments.js'") &&
  /shipmentId: integer\(\)\.references\(\(\) => shipments\.id\)/.test(schema));
check('schema pins unique group key and per-package idempotency',
  schema.includes('shipment_groups_group_key_unq') &&
  schema.includes('shipment_group_packages_label_idempotency_unq'));
check('schema index exports shipment group schema',
  schemaIndex.includes("export * from './shipment-groups.js';"));
check('drizzle config registers shipment group schema',
  drizzleConfig.includes("'./src/db/schema/shipment-groups.ts'"));

check('migration creates shipment_groups sidecar',
  /CREATE TABLE IF NOT EXISTS shipment_groups/.test(migration));
check('migration creates shipment_group_packages sidecar',
  /CREATE TABLE IF NOT EXISTS shipment_group_packages/.test(migration));
check('migration is additive and does not alter locked tables',
  !/\bALTER TABLE\s+(orders|shipments)\b/i.test(migration) &&
  !/\bUPDATE\s+(orders|shipments)\b/i.test(migration) &&
  !/\bDELETE FROM\s+(orders|shipments)\b/i.test(migration));
check('migration pins unique package and label idempotency indexes',
  migration.includes('shipment_group_packages_key_unq') &&
  migration.includes('shipment_group_packages_label_idempotency_unq'));

check('planner exports buildMultiPackagePersistenceDraft',
  /export function buildMultiPackagePersistenceDraft/.test(planner));
check('planner still avoids DB/provider/label/queue imports',
  !/from ['"].*(db|schema|connector|labels|print-queue|shipstation|shipp|easypost|walmart)/i.test(planner));
check('package wires PS-289 schema guard',
  packageJson.includes('"test:ps-289-multi-package-schema"'));

if (failures > 0) {
  console.error(`\nFAIL PS-289 multi-package schema guard (${failures} failing)`);
  process.exit(1);
}

console.log('\nPASS PS-289 multi-package schema guard');
