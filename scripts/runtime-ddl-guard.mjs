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
const orderItemsMigrationPath = 'drizzle/0024_order_items_phase2.sql';
const orderItemsMigration = fs.readFileSync(
  path.join(root, orderItemsMigrationPath),
  'utf8',
);
const orderItemsTriggerMigrationPath = 'drizzle/0025_order_items_sync_trigger.sql';
const orderItemsTriggerMigration = fs.readFileSync(
  path.join(root, orderItemsTriggerMigrationPath),
  'utf8',
);
const ordersEndpointPerformanceMigrationPath = 'drizzle/0021_orders_endpoint_performance.sql';
const ordersEndpointPerformanceMigration = fs.readFileSync(
  path.join(root, ordersEndpointPerformanceMigrationPath),
  'utf8',
);
const dashboardSalesPerformanceMigrationPath = 'drizzle/0022_dashboard_sales_performance.sql';
const dashboardSalesPerformanceMigration = fs.readFileSync(
  path.join(root, dashboardSalesPerformanceMigrationPath),
  'utf8',
);
const inventoryListPerformanceMigrationPath = 'drizzle/0023_inventory_list_performance.sql';
const inventoryListPerformanceMigration = fs.readFileSync(
  path.join(root, inventoryListPerformanceMigrationPath),
  'utf8',
);
const inventoryLowerSkuMigrationPath = 'drizzle/0026_inventory_lower_sku_idx.sql';
const inventoryLowerSkuMigration = fs.readFileSync(
  path.join(root, inventoryLowerSkuMigrationPath),
  'utf8',
);
const ordersListCountIndexesMigrationPath = 'drizzle/0033_orders_list_count_indexes.sql';
const ordersListCountIndexesMigration = fs.readFileSync(
  path.join(root, ordersListCountIndexesMigrationPath),
  'utf8',
);
const ordersQueryRound2IndexesMigrationPath = 'drizzle/0034_orders_query_round2_indexes.sql';
const ordersQueryRound2IndexesMigration = fs.readFileSync(
  path.join(root, ordersQueryRound2IndexesMigrationPath),
  'utf8',
);
const scanRoots = ['src', 'api'];
const ddlPattern =
  /(?:create\s+(?:unique\s+)?(?:table|index)(?:\s+concurrently)?\s+if\s+not\s+exists|alter\s+table\s+[\s\S]{0,160}?add\s+column\s+if\s+not\s+exists)/i;

const expectedRuntimeDdlFiles = [
  'api/_lib/walmart-fees-sync.ts',
  'api/carriers/walmart/fees.ts',
  // PS-200 S3 (2026-06-12): api/cron/sync-walmart-fees.ts deleted — the daily
  // fee sync runs on the v4 worker (sync-scheduler runWalmartFeesTick) and its
  // column-bootstrap fallback lives in src/connectors/store/walmart-fees.ts.
  'src/services/orders-performance-maintenance.ts',
  'src/routes/analysis.ts',
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

const orderItemsRelations = [
  'order_items',
  'order_items_order_line_idx',
  'order_items_order_id_idx',
  'order_items_sku_idx',
  'order_items_lower_sku_idx',
  'order_items_date_idx',
  'order_items_client_date_idx',
  'order_items_store_date_idx',
  'order_items_active_date_idx',
  'order_items_active_client_date_idx',
  'order_items_active_sku_date_idx',
  'analytics_cache',
  'analytics_cache_expires_idx',
];

const lowRiskPerformanceIndexes = [
  {
    indexName: 'orders_status_date_id_idx',
    migrationPath: ordersEndpointPerformanceMigrationPath,
    migration: ordersEndpointPerformanceMigration,
  },
  {
    indexName: 'orders_store_status_date_idx',
    migrationPath: ordersEndpointPerformanceMigrationPath,
    migration: ordersEndpointPerformanceMigration,
  },
  {
    indexName: 'orders_walmart_shipstation_order_number_idx',
    migrationPath: ordersListCountIndexesMigrationPath,
    migration: ordersListCountIndexesMigration,
  },
  {
    indexName: 'orders_walmart_direct_order_number_latest_idx',
    migrationPath: ordersListCountIndexesMigrationPath,
    migration: ordersListCountIndexesMigration,
  },
  {
    indexName: 'orders_store_status_date_id_idx',
    migrationPath: ordersQueryRound2IndexesMigrationPath,
    migration: ordersQueryRound2IndexesMigration,
  },
  {
    indexName: 'orders_client_status_date_id_idx',
    migrationPath: ordersQueryRound2IndexesMigrationPath,
    migration: ordersQueryRound2IndexesMigration,
  },
  {
    indexName: 'clients_test_client_id_idx',
    migrationPath: ordersQueryRound2IndexesMigrationPath,
    migration: ordersQueryRound2IndexesMigration,
  },
  {
    indexName: 'clients_active_client_id_idx',
    migrationPath: ordersQueryRound2IndexesMigrationPath,
    migration: ordersQueryRound2IndexesMigration,
  },
  {
    indexName: 'orders_dashboard_sales_date_idx',
    migrationPath: dashboardSalesPerformanceMigrationPath,
    migration: dashboardSalesPerformanceMigration,
  },
  {
    indexName: 'orders_dashboard_sales_client_date_idx',
    migrationPath: dashboardSalesPerformanceMigrationPath,
    migration: dashboardSalesPerformanceMigration,
  },
  {
    indexName: 'inventory_active_updated_idx',
    migrationPath: inventoryListPerformanceMigrationPath,
    migration: inventoryListPerformanceMigration,
  },
  {
    indexName: 'inventory_client_active_updated_idx',
    migrationPath: inventoryListPerformanceMigrationPath,
    migration: inventoryListPerformanceMigration,
  },
  {
    indexName: 'inventory_ledger_inv_type_idx',
    migrationPath: inventoryListPerformanceMigrationPath,
    migration: inventoryListPerformanceMigration,
  },
  {
    indexName: 'inventory_lower_sku_idx',
    migrationPath: inventoryLowerSkuMigrationPath,
    migration: inventoryLowerSkuMigration,
  },
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
  audit.includes('Move to migration-readiness only after shipped-fee') &&
    audit.includes('settled-fee side-effect paths'),
  `${auditPath} keeps shipped-fee DDL out of generic cleanup`,
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

for (const relation of orderItemsRelations) {
  assert(
    orderItemsMigration.includes(`"${relation}"`) ||
      orderItemsTriggerMigration.includes(`"${relation}"`),
    `${orderItemsMigrationPath} or ${orderItemsTriggerMigrationPath} owns ${relation}`,
  );
}

assert(
  orderItemsTriggerMigration.includes('prepship_refresh_order_items_for_order') &&
    orderItemsTriggerMigration.includes('prepship_order_items_refresh'),
  `${orderItemsTriggerMigrationPath} owns order_items trigger/function`,
);

for (const { indexName, migrationPath, migration } of lowRiskPerformanceIndexes) {
  assert(
    migration.includes(`"${indexName}"`),
    `${migrationPath} owns ${indexName}`,
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

assert(
  audit.includes('src/services/order-items.ts') &&
    audit.includes(orderItemsMigrationPath) &&
    audit.includes(orderItemsTriggerMigrationPath),
  `${auditPath} documents order_items runtime DDL migration resolution`,
);

assert(
  audit.includes('orders/inventory performance indexes') &&
    audit.includes(ordersEndpointPerformanceMigrationPath) &&
    audit.includes(inventoryListPerformanceMigrationPath),
  `${auditPath} documents low-risk performance index runtime DDL migration resolution`,
);

assert(
  audit.includes('src/services/fulfillment/outbox.ts') &&
    audit.includes('api/carriers/labels.ts') &&
    audit.includes('drizzle/0020_fulfillment_outbox.sql') &&
    audit.includes('drizzle/0032_connector_architecture.sql'),
  `${auditPath} documents fulfillment outbox/direct-label runtime DDL migration resolution`,
);

if (process.exitCode) process.exit(process.exitCode);
