import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const planPath = 'INVENTORY_SOURCE_OF_TRUTH_PLAN.md';
const plan = fs.readFileSync(path.join(root, planPath), 'utf8');
const devTasks = fs.readFileSync(path.join(root, 'DEV_TASKS_README.md'), 'utf8');
const sourceAudit = fs.readFileSync(path.join(root, 'SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md'), 'utf8');
const reconciliationPlan = fs.readFileSync(path.join(root, 'RECONCILIATION_REPORTS_PLAN.md'), 'utf8');
const inventoryService = fs.readFileSync(path.join(root, 'src/services/inventory.ts'), 'utf8');
const inventoryRoute = fs.readFileSync(path.join(root, 'src/routes/inventory.ts'), 'utf8');
const inventoryView = fs.readFileSync(path.join(root, 'web/src/components/Views/InventoryView.tsx'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const requiredHeadings = [
  '## Executive Summary',
  '## Critical Blockers',
  '## High-Risk Issues',
  '## Medium-Risk Issues',
  '## Canonical Data Ownership',
  '## Phase Checklist',
  '## Recommended Patches',
  '## Test Plan',
  '## Deployment / Rollback Notes',
  '## Recommended Implementation Order',
];

for (const heading of requiredHeadings) {
  assert(plan.includes(heading), `${planPath} includes ${heading}`);
}

const requiredPolicyText = [
  'inventory_ledger',
  'inventory.stockQty',
  'materialized/cache',
  'effectiveStock',
  'total_received - total_sold_shipped_all_time',
  'sold 7d',
  'sold 30d',
  'days supply',
  'restock',
  'dry-run reconciliation',
  'shipped/cancelled',
  'shipments',
];

for (const text of requiredPolicyText) {
  assert(plan.toLowerCase().includes(text.toLowerCase()), `${planPath} documents ${text}`);
}

assert(
  inventoryService.includes('ledger is the source of truth') &&
    inventoryService.includes('.insert(inventoryLedger)') &&
    inventoryService.includes('.set({ stockQty: newQty'),
  'inventory movement service documents ledger ownership and updates cache with ledger writes',
);

assert(
  inventoryRoute.includes('effective_stock = total_received') &&
    inventoryRoute.includes('POST /admin/reconcile-inventory-stock'),
  'inventory route documents effective stock and existing reconciliation repair path',
);

assert(
  inventoryView.includes('getInventoryDisplayStock') &&
    inventoryView.includes('effectiveStock') &&
    inventoryView.includes('Cached stockQty'),
  'inventory UI prefers effectiveStock while exposing cached stock as audit fallback',
);

assert(
  devTasks.includes('INVENTORY_SOURCE_OF_TRUTH_PLAN.md') &&
    devTasks.includes('npm run test:inventory-source-of-truth'),
  'DEV_TASKS_README.md tracks inventory source-of-truth plan and guard',
);

assert(
  sourceAudit.includes('INVENTORY_SOURCE_OF_TRUTH_PLAN.md') &&
    sourceAudit.includes('inventory_ledger as canonical movement history'),
  'SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md references inventory source-of-truth plan',
);

assert(
  reconciliationPlan.includes('inventory_ledger') &&
    reconciliationPlan.includes('inventory.stockQty') &&
    reconciliationPlan.includes('dry-run reconcile'),
  'reconciliation plan tracks inventory ledger/cache reconciliation',
);

assert(
  packageJson.scripts?.['test:inventory-source-of-truth'] ===
    'node scripts/inventory-source-of-truth-guard.mjs',
  'package exposes inventory source-of-truth guard',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
