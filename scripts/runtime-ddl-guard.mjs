import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scanRoots = ['src', 'api'];
const ddlPattern =
  /\b(?:create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|index|function|trigger|policy|type)|alter\s+table|drop\s+(?:table|index|function|trigger|policy|type))\b/i;

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

const discovered = scanRoots
  .flatMap((scanRoot) => walk(path.join(root, scanRoot)))
  .filter((file) => ddlPattern.test(fs.readFileSync(file, 'utf8')))
  .map(relative)
  .sort();

assert(
  discovered.length === 0,
  discovered.length
    ? `production runtime contains no schema DDL: ${discovered.join(', ')}`
    : 'production runtime contains no schema DDL',
);

const migrationOwnership = [
  ['drizzle/0019_selling_fees.sql', ['selling_fee', 'orders_selling_fee_source_idx']],
  ['drizzle/0021_orders_endpoint_performance.sql', ['shipments_order_latest_idx', 'shipments_order_number_latest_idx']],
  ['drizzle/0040_webhook_events.sql', ['webhook_events', 'webhook_events_dedupe_idx']],
  ['drizzle/0041_order_rate_jobs.sql', ['order_rate_jobs', 'order_rate_jobs_updated_idx']],
  ['drizzle/0042_order_recipient_override.sql', ['recipient_override']],
  ['drizzle/0042_shipment_tracking_status.sql', ['shipment_tracking_status', 'auto_retired_at']],
  ['drizzle/0043_billing_box_resolutions.sql', ['billing_box_resolutions']],
  ['drizzle/0044_audit_log.sql', ['audit_log', 'audit_log_no_update_delete']],
  ['drizzle/0047_packaging_rule_engine.sql', ['client_sku_classes', 'client_packing_rules']],
  ['drizzle/0048_address_classifications.sql', ['address_classifications']],
  ['drizzle/0049_order_competitive_rate.sql', ['order_competitive_rate']],
  ['drizzle/0050_billing_config_house_account.sql', ['house_account_enabled']],
  ['drizzle/0052_shipment_bundles.sql', ['shipment_bundles', 'shipment_bundle_members']],
  ['drizzle/0053_billing_hugrab_shipping_rate_override.sql', ['hugrab_shipping_rate_override_enabled']],
  ['drizzle/0054_shipments_selected_rate_cost.sql', ['selected_rate_cost']],
  ['drizzle/0055_billing_storage_proof.sql', ['billing_storage_proof']],
  ['drizzle/0057_store_source_cutovers.sql', ['store_source_cutovers']],
  ['drizzle/0059_billing_finalized_lock.sql', ['billing_finalization_group_locks', 'billing_line_items_finalized_guard']],
  ['drizzle/0060_package_consumption_ledger.sql', ['package_consumption_reviews', 'package_ledger_idempotency_key_unq']],
  ['drizzle/0061_inventory_ledger_effective_at.sql', ['inventory_ledger_effective_at_idx', 'inventory_ledger_idempotency_key_unq']],
  [
    'drizzle/0062_runtime_schema_ownership.sql',
    [
      'direct_carrier_rate_cache',
      'rate_limiter_state',
      'billing_fee_waivers',
      'billing_manual_overrides',
      'label_purchase_locks',
      'label_purchase_intents',
      'print_queue_send_jobs',
      'print_queue_batch_job_items',
      'print_queue_merged_pdfs',
      'print_queue_pdf_chunks',
      'rate_browse_jobs',
      'rate_browse_job_provider_statuses',
      'worker_status_events',
    ],
  ],
  [
    'drizzle/0064_print_queue_merge_jobs.sql',
    ['print_queue_merge_jobs', 'print_queue_merge_jobs_updated_at_idx'],
  ],
  [
    'drizzle/0065_billing_close_workflow.sql',
    [
      'billing_finalizations',
      'billing_credit_notes',
      'billing_finalizations_overlap_guard',
      'billing_line_items_closed_period_guard',
      'billing_finalizations_no_update_delete',
      'billing_credit_notes_no_update_delete',
      'billing_credit_notes_balance_guard',
      'billing_finalizations_no_truncate',
      'billing_credit_notes_no_truncate',
    ],
  ],
  [
    'drizzle/0066_billing_ref_rate_identity.sql',
    ['billing_ref_rates_identity_unq'],
  ],
  [
    'drizzle/0067_durable_worker_execution_fences.sql',
    [
      'rate_browse_jobs_request_active_unq',
      'rate_browse_jobs_recovery_idx',
      'print_queue_merge_jobs_recovery_idx',
      'generation',
    ],
  ],
  [
    'drizzle/0068_billing_shipment_cardinality.sql',
    ['billing_li_shipment_unique_idx', 'billing_li_order_unique_idx', 'shipment_id'],
  ],
  [
    'drizzle/0070_order_lifecycle_commands.sql',
    [
      'order_lifecycle_events',
      'fulfillment_line_claims',
      'order_lifecycle_events_command_unq',
      'order_lifecycle_events_no_update_delete',
      'order_lifecycle_events_block_mutations',
      'fulfillment_line_claims_idempotency_unq',
    ],
  ],
  [
    'drizzle/0071_billing_weekend_rollforward.sql',
    ['billing_effective_date', 'billing_policy_version', 'billing_li_effective_date_idx'],
  ],
  [
    'drizzle/0072_external_operations.sql',
    [
      'external_operations',
      'external_operations_key_unq',
      'external_operations_idempotency_unq',
      'external_operations_state_lease_idx',
    ],
  ],
  [
    'drizzle/0073_print_queue_send_execution_fences.sql',
    [
      'current_chunk_sequence',
      'attempt_count',
      'heartbeat_at',
      'print_queue_send_jobs_generation_nonnegative',
      'print_queue_send_jobs_chunk_sequence_positive',
      'print_queue_batch_job_items_attempt_count_nonnegative',
      'print_queue_batch_job_items_generation_nonnegative',
      'print_queue_send_jobs_recovery_idx',
    ],
  ],
];

for (const [file, tokens] of migrationOwnership) {
  const source = read(file);
  for (const token of tokens) {
    assert(source.includes(token), `${file} owns ${token}`);
  }
}

const newMigration = read('drizzle/0062_runtime_schema_ownership.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN))\b/i.test(newMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(newMigration),
  '0062 is additive and never mutates or destructively alters orders/shipments',
);
const mergeJobMigration = read('drizzle/0064_print_queue_merge_jobs.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN))\b/i.test(mergeJobMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(mergeJobMigration),
  '0064 is additive and never mutates or destructively alters orders/shipments',
);
const billingCloseMigration = read('drizzle/0065_billing_close_workflow.sql');
assert(
  !/\b(?:UPDATE\s+(?:public\.)?\w+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|COLUMN))\b/i.test(billingCloseMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingCloseMigration),
  '0065 is additive and never mutates or destructively alters orders/shipments',
);
const billingRefRateMigration = read('drizzle/0066_billing_ref_rate_identity.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingRefRateMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingRefRateMigration),
  '0066 only deduplicates billing_ref_rates and never mutates orders/shipments',
);
const durableWorkerMigration = read('drizzle/0067_durable_worker_execution_fences.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(durableWorkerMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(durableWorkerMigration),
  '0067 changes only durable job/artifact sidecars and never mutates orders/shipments',
);
const billingCardinalityMigration = read('drizzle/0068_billing_shipment_cardinality.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingCardinalityMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingCardinalityMigration),
  '0068 changes only the generated billing-line key and never mutates orders/shipments',
);
const orderLifecycleMigration = read('drizzle/0070_order_lifecycle_commands.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(orderLifecycleMigration) &&
    !/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(orderLifecycleMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(orderLifecycleMigration),
  '0070 adds lifecycle sidecars without mutating or destructively altering orders/shipments',
);
const billingWeekendMigration = read('drizzle/0071_billing_weekend_rollforward.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments|billing_line_items)\b/i.test(billingWeekendMigration) &&
    !/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(billingWeekendMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(billingWeekendMigration),
  '0071 is additive, performs no backfill, and never mutates orders/shipments or historical billing lines',
);
const externalOperationsMigration = read('drizzle/0072_external_operations.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(externalOperationsMigration) &&
    !/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(externalOperationsMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(externalOperationsMigration),
  '0072 adds the provider-operation sidecar without mutating or destructively altering orders/shipments',
);
const printQueueExecutionFenceMigration = read('drizzle/0073_print_queue_send_execution_fences.sql');
assert(
  !/\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|shipments)\b/i.test(printQueueExecutionFenceMigration) &&
    !/\bDROP\s+(?:TABLE|COLUMN)\b/i.test(printQueueExecutionFenceMigration) &&
    !/ALTER\s+TABLE\s+(?:public\.)?(?:orders|shipments)\b/i.test(printQueueExecutionFenceMigration),
  '0073 changes only Print Queue sidecars and never mutates or destructively alters orders/shipments',
);

const readiness = read('src/services/runtime-schema-readiness.ts');
for (const token of [
  'REQUIRED_RELATIONS',
  'REQUIRED_COLUMNS',
  'REQUIRED_INDEXES',
  'REQUIRED_CONSTRAINTS',
  'REQUIRED_FUNCTIONS',
  'REQUIRED_TRIGGERS',
  'Runtime schema is not migration-ready',
  '0073_print_queue_send_execution_fences.sql',
]) {
  assert(readiness.includes(token), `boot readiness checks ${token}`);
}

const readinessCallers = [
  'src/connectors/store/walmart-fees.ts',
  'src/db/ensure-billing-storage-proof.ts',
  'src/db/ensure-order-competitive-rate.ts',
  'src/db/ensure-shipments-selected-rate-cost.ts',
  'src/lib/label-purchase-intent.ts',
  'src/lib/label-purchase-lock.ts',
  'src/lib/shipstation/durable-rate-limiter.ts',
  'src/routes/analysis.ts',
  'src/services/audit-log.ts',
  'src/services/billing-fee-waiver-store.ts',
  'src/services/billing-finalization-policy.ts',
  'src/services/billing-hugrab-shipping-rate-override.ts',
  'src/services/billing-manual-overrides.ts',
  'src/services/billing.ts',
  'src/services/direct-carrier-rate-cache.ts',
  'src/services/fulfillment/webhook-ledger.ts',
  'src/services/house-account-opt-in.ts',
  'src/services/inventory-ledger-schema.ts',
  'src/services/order-recipient-override.ts',
  'src/services/orders-performance-maintenance.ts',
  'src/services/package-consumption-schema.ts',
  'src/services/packaging-rules.ts',
  'src/services/print-queue/queue-send-job-store.ts',
  'src/services/print-queue/merge-job-store.ts',
  'src/services/print-queue-pdf-store.ts',
  'src/services/rate-browse-job-store.ts',
  'src/services/shipment-bundles/ensure-shipment-bundles-schema.ts',
  'src/services/shipment-tracking.ts',
  'src/services/shipping-workflow/address-classification-cache.ts',
  'src/services/shipping-workflow/order-rate-job-status.ts',
  'src/services/store-source-cutover.ts',
  'src/services/worker-status-events.ts',
];

for (const file of readinessCallers) {
  assert(read(file).includes('assertRuntimeSchemaReady'), `${file} delegates to boot readiness`);
}

const main = read('src/main.ts');
const worker = read('src/worker.ts');
assert(
  main.indexOf('await assertRuntimeSchemaReady()') < main.indexOf('serve({'),
  'API verifies migration readiness before listening',
);
assert(
  worker.indexOf('await assertRuntimeSchemaReady()') < worker.indexOf('await startPrintQueueWorker()') &&
    worker.indexOf('await assertRuntimeSchemaReady()') < worker.indexOf('await startQueuedSyncScheduler()'),
  'worker verifies migration readiness before starting jobs',
);

if (process.exitCode) process.exit(process.exitCode);
