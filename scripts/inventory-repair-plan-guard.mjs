import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(filePath) {
  return fs.readFileSync(path.join(root, filePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const packageJson = JSON.parse(read('package.json'));
const plan = read('INVENTORY_REPAIR_APPLY_PLAN.md');
const devTasks = read('DEV_TASKS_README.md');
const inventoryPlan = read('INVENTORY_SOURCE_OF_TRUTH_PLAN.md');
const sourceAudit = read('SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md');

for (const heading of [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Recommended Patches',
  '## Allowed Future Apply Scope',
  '## Explicitly Disallowed',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
]) {
  assert(plan.includes(heading), `INVENTORY_REPAIR_APPLY_PLAN.md includes ${heading}`);
}

for (const text of [
  'Rows scanned | 968',
  'Mismatch rows | 107',
  'Total `inventory.stockQty` vs `inventory_ledger` delta | -1',
  'Total `inventory.stockQty` vs `effectiveStock` delta | -425',
  'Total `inventory_ledger` vs `effectiveStock` delta | 424',
  '`client_sku_collision_risk` classifications | 93',
  '`sold_exceeds_received` classifications | 14',
  'classificationCounts',
  'recommendedAction',
  'safeToAutoRepair=false',
  'ledger-authoritative, cache-only apply owner',
  'default-off production gate',
  'reviewed plan hash',
  'No mutation of `orders`',
  'No mutation of shipped/cancelled order rows',
  'No mutation of `shipments`',
  'owner approval',
  'saved dry-run artifact',
  'client_id',
  'idempotent',
]) {
  assert(plan.includes(text), `INVENTORY_REPAIR_APPLY_PLAN.md documents ${text}`);
}

assert(
  packageJson.scripts?.['test:inventory-repair-plan'] ===
    'node scripts/inventory-repair-plan-guard.mjs',
  'package exposes inventory repair plan guard',
);

for (const [name, contents] of [
  ['DEV_TASKS_README.md', devTasks],
  ['INVENTORY_SOURCE_OF_TRUTH_PLAN.md', inventoryPlan],
  ['SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md', sourceAudit],
]) {
  assert(contents.includes('INVENTORY_REPAIR_APPLY_PLAN.md'), `${name} references inventory repair/apply plan`);
  assert(contents.includes('test:inventory-repair-plan'), `${name} references inventory repair plan guard`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}
