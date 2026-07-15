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

const scriptPath = 'scripts/reconcile-inventory-stock.ts';
const script = read(scriptPath);
const packageJson = JSON.parse(read('package.json'));
const devTasks = read('DEV_TASKS_README.md');
const sourceAudit = read('SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md');
const inventoryPlan = read('INVENTORY_SOURCE_OF_TRUTH_PLAN.md');
const reconciliationPlan = read('RECONCILIATION_REPORTS_PLAN.md');
const repairOwner = read('src/services/inventory-reconciliation.ts');

assert(
  packageJson.scripts?.['inventory:reconcile:dry-run'] ===
    'tsx scripts/reconcile-inventory-stock.ts',
  'package exposes inventory reconciliation dry-run command',
);

assert(
  packageJson.scripts?.['test:inventory-reconciliation-dry-run'] ===
    'node scripts/inventory-reconciliation-dry-run-guard.mjs',
  'package exposes inventory reconciliation dry-run guard',
);

const requiredScriptText = [
  'read-only and dry-run only',
  'does not modify inventory, orders, shipped/cancelled rows, or shipments',
  'intentionally has no apply mode',
  "mode: 'dry-run'",
  'No rows changed.',
  'inventory.stockQty',
  'inventory_ledger balance',
  'effectiveStock',
  '--client-id',
  '--sku',
  '--limit',
  '--json',
  '--include-matched',
  '--out-json',
  '--out-csv',
  'artifactPaths',
  'writeTextArtifact',
  'rowsToCsv',
  'cacheVsLedgerDelta',
  'cacheVsEffectiveDelta',
  'ledgerVsEffectiveDelta',
  'classification',
  'classificationCounts',
  'recommendedAction',
  'safeToAutoRepair',
  'missing_receive_ledger',
  'sold_exceeds_received',
  'cache_differs_from_ledger',
  'client_sku_collision_risk',
  'inactive_or_deactivated_sku',
  'reporting_effective_stock_review',
];

for (const text of requiredScriptText) {
  assert(script.includes(text), `${scriptPath} includes ${text}`);
}

const forbiddenScriptPatterns = [
  { pattern: /--apply\b/, label: '--apply flag' },
  { pattern: /hasFlag\(['"]apply['"]\)/, label: 'apply flag parser' },
  { pattern: /\b(update|delete|insert|truncate|alter|drop|create)\s+/i, label: 'SQL mutation keyword' },
  { pattern: /\.(update|delete|insert)\s*\(/, label: 'Drizzle mutation call' },
  { pattern: /\btx\./, label: 'transaction mutation helper' },
];

for (const { pattern, label } of forbiddenScriptPatterns) {
  assert(!pattern.test(script), `${scriptPath} does not include ${label}`);
}

const docs = [
  ['DEV_TASKS_README.md', devTasks],
  ['SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md', sourceAudit],
  ['INVENTORY_SOURCE_OF_TRUTH_PLAN.md', inventoryPlan],
  ['RECONCILIATION_REPORTS_PLAN.md', reconciliationPlan],
];

for (const [name, contents] of docs) {
  assert(
    contents.includes('inventory:reconcile:dry-run'),
    `${name} references inventory reconciliation dry-run command`,
  );
  assert(
    contents.includes('test:inventory-reconciliation-dry-run'),
    `${name} references inventory reconciliation dry-run guard`,
  );
}

assert(
  inventoryPlan.includes('production apply remains disabled by default') &&
    reconciliationPlan.includes('read-only first') &&
    repairOwner.includes('APPLY_DISABLED') &&
    repairOwner.includes('reviewedPlanHash'),
  'read-only detection stays separate from the default-off reviewed repair boundary',
);

if (process.exitCode) {
  process.exit(process.exitCode);
}
