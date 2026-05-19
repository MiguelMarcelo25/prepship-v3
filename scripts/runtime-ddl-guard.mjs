import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const auditPath = 'RUNTIME_DDL_MIGRATION_AUDIT.md';
const audit = fs.readFileSync(path.join(root, auditPath), 'utf8');
const reportingMetricsMigrationPath = 'drizzle/0029_reporting_metrics.sql';
const reportingMetricsMigration = fs.readFileSync(
  path.join(root, reportingMetricsMigrationPath),
  'utf8',
);
const storeOrdersMigrationPath = 'drizzle/0030_store_orders.sql';
const storeOrdersMigration = fs.readFileSync(
  path.join(root, storeOrdersMigrationPath),
  'utf8',
);
const credentialAccountsRlsMigrationPath = 'drizzle/0031_credential_accounts_rls.sql';
const credentialAccountsRlsMigration = fs.readFileSync(
  path.join(root, credentialAccountsRlsMigrationPath),
  'utf8',
);
const scanRoots = ['src', 'api'];
const ddlPattern =
  /create\s+(?:unique\s+)?(?:table|index)(?:\s+concurrently)?\s+if\s+not\s+exists/i;

const expectedRuntimeDdlFiles = [
  'api/carriers/labels.ts',
  'src/services/fulfillment/outbox.ts',
  'src/services/order-items.ts',
  'src/services/orders-performance-maintenance.ts',
];

const requiredClassifications = [
  'already covered by migration',
  'compatibility fallback to keep temporarily',
  'safe to move to migration now',
  'requires separate shipped/label review',
];

const reportingMetricTables = [
  'reporting_refresh_runs',
  'daily_sales_metrics',
  'sku_velocity_metrics',
  'inventory_risk_metrics',
  'billing_summary_metrics',
];

const storeOrderRelations = [
  'store_orders',
  'store_orders_provider_external_idx',
  'store_orders_carrier_account_idx',
  'store_orders_last_fetched_at_idx',
  'store_orders_shipment_status_idx',
];

const credentialAccountRlsTables = [
  'carrier_accounts',
  'store_accounts',
  'carrier_account_clients',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

const discovered = scanRoots
  .flatMap((scanRoot) => walk(path.join(root, scanRoot)))
  .filter((file) => ddlPattern.test(fs.readFileSync(file, 'utf8')))
  .map(rel)
  .sort();

const expected = [...expectedRuntimeDdlFiles].sort();
const unexpected = discovered.filter((file) => !expected.includes(file));
const missing = expected.filter((file) => !discovered.includes(file));

assert(
  unexpected.length === 0,
  unexpected.length
    ? `no undocumented runtime DDL files: ${unexpected.join(', ')}`
    : 'no undocumented runtime DDL files',
);

assert(
  missing.length === 0,
  missing.length
    ? `runtime DDL inventory entries still exist: ${missing.join(', ')}`
    : 'runtime DDL inventory matches current src/api scan',
);

for (const file of expectedRuntimeDdlFiles) {
  assert(audit.includes(`\`${file}\``), `${auditPath} documents ${file}`);
}

for (const classification of requiredClassifications) {
  assert(
    audit.includes(classification),
    `${auditPath} includes classification: ${classification}`,
  );
}

assert(
  audit.includes('Do not change without a label/shipment-specific plan') &&
    audit.includes('Do not refactor in this batch'),
  `${auditPath} keeps label/shipment-adjacent DDL out of generic cleanup`,
);

for (const table of reportingMetricTables) {
  assert(
    reportingMetricsMigration.includes(`"${table}"`),
    `${reportingMetricsMigrationPath} owns ${table}`,
  );
}

for (const relation of storeOrderRelations) {
  assert(
    storeOrdersMigration.includes(`"${relation}"`),
    `${storeOrdersMigrationPath} owns ${relation}`,
  );
}

for (const table of credentialAccountRlsTables) {
  assert(
    credentialAccountsRlsMigration.includes(`"${table}"`),
    `${credentialAccountsRlsMigrationPath} enables RLS for ${table}`,
  );
}

assert(
  audit.includes('src/services/reporting-metrics.ts') &&
    audit.includes(reportingMetricsMigrationPath),
  `${auditPath} documents reporting metrics DDL migration resolution`,
);

assert(
  audit.includes('api/carriers/ebay/orders.ts') &&
    audit.includes('api/carriers/walmart/orders.ts') &&
    audit.includes(storeOrdersMigrationPath),
  `${auditPath} documents store_orders DDL migration resolution`,
);

assert(
  audit.includes('src/services/credential-account-schema.ts') &&
    audit.includes(credentialAccountsRlsMigrationPath),
  `${auditPath} documents credential account runtime DDL migration resolution`,
);

if (process.exitCode) process.exit(process.exitCode);
