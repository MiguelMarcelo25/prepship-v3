import { sql as pg } from '../db/client.js';

const REQUIRED_RELATIONS = [
  'address_classifications',
  'audit_log',
  'billing_box_resolutions',
  'billing_fee_waivers',
  'billing_finalizations',
  'billing_finalization_group_locks',
  'billing_credit_notes',
  'billing_manual_overrides',
  'billing_storage_proof',
  'client_packing_rules',
  'client_sku_classes',
  'direct_carrier_rate_cache',
  'external_operations',
  'label_purchase_intents',
  'label_purchase_locks',
  'order_competitive_rate',
  'order_lifecycle_events',
  'order_rate_jobs',
  'package_consumption_reviews',
  'fulfillment_line_claims',
  'print_queue_batch_job_items',
  'print_queue_merge_jobs',
  'print_queue_merged_pdfs',
  'print_queue_pdf_chunks',
  'print_queue_send_jobs',
  'rate_browse_job_provider_statuses',
  'rate_browse_jobs',
  'rate_limiter_state',
  'returns',
  'shipment_bundle_members',
  'shipment_bundles',
  'shipment_tracking_status',
  'store_source_cutovers',
  'webhook_events',
  'worker_status_events',
] as const;

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  billing_config: [
    'house_account_enabled',
    'hugrab_shipping_rate_override_enabled',
    'hugrab_shipping_rate_override_threshold',
    'hugrab_shipping_rate_override_amount',
  ],
  billing_line_items: [
    'billing_effective_date',
    'billing_policy_version',
    'source_finalization_id',
    'billing_adjustment_id',
  ],
  billing_credit_notes: [
    'adjustment_kind',
    'adjustment_source',
    'source_order_id',
    'posting_version',
    'effective_date',
    'billing_policy_version',
  ],
  billing_summary_metrics: ['adjustment_total'],
  client_combo_package_defaults: ['source'],
  external_operations: [
    'operation_key',
    'kind',
    'provider',
    'subject_type',
    'subject_id',
    'semantic_generation',
    'request_hash',
    'idempotency_key',
    'state',
    'generation',
    'lease_token',
    'lease_expires_at',
    'provider_receipt',
    'local_result',
  ],
  inventory_ledger: [
    'effective_at',
    'idempotency_key',
    'client_id',
    'sku',
    'source_entity',
    'source_id',
  ],
  orders: [
    'selling_fee',
    'selling_fee_breakdown',
    'selling_fee_synced_at',
    'selling_fee_source',
  ],
  order_overrides: ['recipient_override'],
  package_ledger: [
    'shipment_id',
    'order_id',
    'source',
    'source_account_id',
    'provider_shipment_id',
    'effective_at',
    'idempotency_key',
  ],
  print_queue_orders: ['auto_retired_at'],
  print_queue_merge_jobs: [
    'input_payload',
    'generation',
    'snapshot_updated_at',
    'claimed_at',
    'heartbeat_at',
    'cancel_requested_at',
    'cancel_acknowledged_at',
  ],
  // Per user override unlock shipped data on 2026-07-21: PS-452 fails closed
  // until the Print Queue execution-fence sidecars are migrated.
  print_queue_send_jobs: [
    'generation',
    'current_chunk_sequence',
    'snapshot_updated_at',
    'claimed_at',
    'heartbeat_at',
    'cancel_requested_at',
    'cancel_acknowledged_at',
  ],
  print_queue_batch_job_items: ['attempt_count', 'generation'],
  print_queue_pdf_chunks: ['generation'],
  rate_browse_jobs: [
    'request_payload',
    'generation',
    'snapshot_updated_at',
    'claimed_at',
    'heartbeat_at',
    'cancel_requested_at',
    'cancel_acknowledged_at',
  ],
  returns: ['return_customer_shipping_rate'],
  shipments: ['selected_rate_cost'],
};

const REQUIRED_INDEXES = [
  'address_classifications_expires_idx',
  'audit_log_resource_idx',
  'audit_log_ts_idx',
  'billing_manual_overrides_client_order_idx',
  'billing_li_order_unique_idx',
  'billing_li_shipment_unique_idx',
  'billing_li_storage_month_unq',
  'billing_li_effective_date_idx',
  'billing_li_adjustment_unq',
  'billing_li_source_finalization_idx',
  'billing_ref_rates_identity_unq',
  'billing_credit_notes_finalization_idx',
  'billing_credit_notes_idempotency_unq',
  'billing_credit_notes_id_client_unq',
  'billing_credit_notes_source_order_idx',
  'billing_finalizations_client_period_unq',
  'client_packing_rules_client_idx',
  'client_packing_rules_client_key_idx',
  'client_sku_classes_client_idx',
  'client_sku_classes_client_sku_idx',
  'direct_carrier_rate_cache_lookup_idx',
  'external_operations_idempotency_unq',
  'external_operations_key_unq',
  'external_operations_state_lease_idx',
  'external_operations_subject_idx',
  'inventory_ledger_effective_at_idx',
  'inventory_ledger_idempotency_key_unq',
  'inventory_ledger_source_identity_unq',
  'label_purchase_intents_unresolved_idx',
  'label_purchase_locks_expires_at_idx',
  'order_competitive_rate_house_idx',
  'order_competitive_rate_order_idx',
  'order_competitive_rate_projected_unq',
  'order_competitive_rate_realized_unq',
  'order_lifecycle_events_command_unq',
  'order_lifecycle_events_order_idx',
  'order_lifecycle_events_shipment_idx',
  'order_rate_jobs_updated_idx',
  'orders_selling_fee_source_idx',
  'package_consumption_reviews_idempotency_unq',
  'package_consumption_reviews_shipment_idx',
  'package_consumption_reviews_status_idx',
  'package_ledger_effective_at_idx',
  'package_ledger_idempotency_key_unq',
  'package_ledger_order_idx',
  'package_ledger_shipment_idx',
  'fulfillment_line_claims_event_status_idx',
  'fulfillment_line_claims_idempotency_unq',
  'fulfillment_line_claims_original_idx',
  'fulfillment_line_claims_shipment_idx',
  'print_queue_batch_job_items_job_idx',
  'print_queue_batch_job_items_state_idx',
  'print_queue_merge_jobs_updated_at_idx',
  'print_queue_merge_jobs_recovery_idx',
  'print_queue_send_jobs_updated_at_idx',
  'print_queue_send_jobs_recovery_idx',
  'rate_browse_job_provider_statuses_status_idx',
  'rate_browse_jobs_order_updated_idx',
  'rate_browse_jobs_request_active_idx',
  'rate_browse_jobs_request_active_unq',
  'rate_browse_jobs_recovery_idx',
  'shipment_bundle_members_bundle_idx',
  'shipment_bundles_client_idx',
  'shipment_tracking_status_order_idx',
  'shipment_tracking_status_poll_idx',
  'shipments_order_latest_idx',
  'shipments_order_number_latest_idx',
  'store_source_cutovers_active_legacy_idx',
  'store_source_cutovers_client_idx',
  'store_source_cutovers_identity_idx',
  'store_source_cutovers_legacy_idx',
  'store_source_cutovers_target_idx',
  'webhook_events_dedupe_idx',
  'webhook_events_order_status_idx',
  'webhook_events_source_id_idx',
  'webhook_events_source_lookup_idx',
  'worker_status_events_created_at_idx',
] as const;

// Per user override unlock shipped data on 2026-07-21: these constraints are
// part of the PS-452 execution fence. Missing counters must fail boot readiness
// even when every column and index happens to exist.
const REQUIRED_CONSTRAINTS = [
  'billing_credit_notes_adjustment_kind_chk',
  'billing_credit_notes_adjustment_source_chk',
  'billing_credit_notes_posting_version_chk',
  'billing_credit_notes_current_period_fields_chk',
  'billing_credit_notes_id_client_unq',
  'billing_credit_notes_finalization_client_fk',
  'billing_line_items_adjustment_reference_chk',
  'billing_line_items_source_finalization_client_fk',
  'billing_line_items_adjustment_client_fk',
  'print_queue_send_jobs_generation_nonnegative',
  'print_queue_send_jobs_chunk_sequence_positive',
  'print_queue_batch_job_items_attempt_count_nonnegative',
  'print_queue_batch_job_items_generation_nonnegative',
] as const;

const REQUIRED_FUNCTIONS = [
  'audit_log_block_mutations',
  'inventory_ledger_prepare_insert',
  'inventory_ledger_block_mutations',
  'inventory_block_identity_change_with_ledger',
  'billing_line_item_group_is_finalized',
  'billing_line_item_group_key',
  'order_lifecycle_events_block_mutations',
  'billing_line_item_lock_group',
  'billing_line_items_block_finalized_mutation',
  'billing_line_items_block_finalized_truncate',
  'billing_line_items_block_mixed_finalization_statement',
  'billing_finalizations_block_overlap',
  'billing_line_items_block_closed_period_mutation',
  'billing_close_records_block_mutations',
  'billing_credit_notes_block_excess',
  'billing_credit_notes_require_projection',
  'billing_line_items_block_adjustment_mutation',
] as const;

const REQUIRED_TRIGGERS = [
  'audit_log_no_update_delete',
  'inventory_ledger_prepare_insert_guard',
  'inventory_ledger_no_update_delete',
  'inventory_ledger_no_truncate',
  'inventory_identity_immutable_with_ledger',
  'billing_line_items_finalized_guard',
  'order_lifecycle_events_no_update_delete',
  'billing_line_items_finalized_truncate_guard',
  'billing_line_items_mixed_finalization_guard',
  'billing_finalizations_overlap_guard',
  'billing_line_items_closed_period_guard',
  'billing_finalizations_no_update_delete',
  'billing_credit_notes_no_update_delete',
  'billing_credit_notes_balance_guard',
  'billing_credit_notes_projection_guard',
  'billing_line_items_adjustment_immutable_guard',
  'billing_finalizations_no_truncate',
  'billing_credit_notes_no_truncate',
] as const;

let readiness: Promise<void> | null = null;

export function resetRuntimeSchemaReadinessForTests(): void {
  readiness = null;
}

export function assertRuntimeSchemaReady(): Promise<void> {
  readiness ??= verifyRuntimeSchema().catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}

async function verifyRuntimeSchema(): Promise<void> {
  const missing: string[] = [];

  const relationRows = await pg<Array<{ relation_name: string }>>`
    select relation_name
    from unnest(${[...REQUIRED_RELATIONS]}::text[]) as required(relation_name)
    where to_regclass('public.' || relation_name) is not null
  `;
  const presentRelations = new Set(relationRows.map((row) => String(row.relation_name)));
  for (const relation of REQUIRED_RELATIONS) {
    if (!presentRelations.has(relation)) missing.push(`relation:${relation}`);
  }

  const tableNames = Object.keys(REQUIRED_COLUMNS);
  const columnRows = await pg<Array<{ table_name: string; column_name: string }>>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = any(${tableNames})
  `;
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const columns = columnsByTable.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    columnsByTable.set(row.table_name, columns);
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = columnsByTable.get(table) ?? new Set<string>();
    for (const column of columns) {
      if (!present.has(column)) missing.push(`column:${table}.${column}`);
    }
  }

  const indexRows = await pg<Array<{ indexname: string }>>`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and indexname = any(${[...REQUIRED_INDEXES]})
  `;
  const presentIndexes = new Set(indexRows.map((row) => String(row.indexname)));
  for (const index of REQUIRED_INDEXES) {
    if (!presentIndexes.has(index)) missing.push(`index:${index}`);
  }

  const constraintRows = await pg<Array<{ conname: string }>>`
    select c.conname
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public'
      and c.conname = any(${[...REQUIRED_CONSTRAINTS]})
  `;
  const presentConstraints = new Set(constraintRows.map((row) => String(row.conname)));
  for (const constraint of REQUIRED_CONSTRAINTS) {
    if (!presentConstraints.has(constraint)) missing.push(`constraint:${constraint}`);
  }

  const functionRows = await pg<Array<{ proname: string }>>`
    select distinct p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(${[...REQUIRED_FUNCTIONS]})
  `;
  const presentFunctions = new Set(functionRows.map((row) => String(row.proname)));
  for (const functionName of REQUIRED_FUNCTIONS) {
    if (!presentFunctions.has(functionName)) missing.push(`function:${functionName}`);
  }

  const triggerRows = await pg<Array<{ tgname: string }>>`
    select tgname
    from pg_trigger
    where not tgisinternal
      and tgenabled <> 'D'
      and tgname = any(${[...REQUIRED_TRIGGERS]})
  `;
  const presentTriggers = new Set(triggerRows.map((row) => String(row.tgname)));
  for (const trigger of REQUIRED_TRIGGERS) {
    if (!presentTriggers.has(trigger)) missing.push(`trigger:${trigger}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Runtime schema is not migration-ready. Apply Drizzle migrations through ` +
        `the current release frontier (0074_billing_current_period_adjustments.sql, ` +
        `0075_inventory_quantity_sot.sql, and 0077_ps462_billing_storage_month.sql). ` +
        `Missing: ${missing.slice(0, 20).join(', ')}`,
    );
  }
}
