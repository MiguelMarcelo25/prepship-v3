# PrepShip Runtime DDL Migration Audit

## Audit 3.3 Result

Production-capable `src` and `api` paths contain no schema DDL. Stable
schema belongs to Drizzle SQL migrations. `src/services/runtime-schema-readiness.ts`
is the single boot gate: API verifies it before listening and worker verifies it
before starting print/sync jobs. Missing schema fails boot with the exact missing
relations, columns, indexes, functions, or triggers.

Request/job compatibility functions retain their public names so workflow callers
do not change, but each now delegates to `assertRuntimeSchemaReady()` instead of
creating or altering schema.

## Migration Ownership

- `drizzle/0019_selling_fees.sql`: settled-fee order columns/index.
- `drizzle/0021_orders_endpoint_performance.sql`: shipment lookup indexes.
- `drizzle/0040_webhook_events.sql`: webhook ledger.
- `drizzle/0041_order_rate_jobs.sql`: per-order rate job state.
- `drizzle/0042_order_recipient_override.sql`: recipient override column.
- `drizzle/0042_shipment_tracking_status.sql`: tracking sidecar and queue retirement column.
- `drizzle/0043_billing_box_resolutions.sql`: box-resolution sidecar.
- `drizzle/0044_audit_log.sql`: append-only audit table, trigger, and indexes.
- `drizzle/0047_packaging_rule_engine.sql`: packaging rule tables/indexes.
- `drizzle/0048_address_classifications.sql`: address cache.
- `drizzle/0049_order_competitive_rate.sql`: competitive-rate sidecar.
- `drizzle/0050_billing_config_house_account.sql`: house-account flag.
- `drizzle/0052_shipment_bundles.sql`: shipment bundle sidecars.
- `drizzle/0053_billing_hugrab_shipping_rate_override.sql`: HUGRAB billing config.
- `drizzle/0054_shipments_selected_rate_cost.sql`: additive nullable selected-rate cost.
- `drizzle/0055_billing_storage_proof.sql`: billing storage proof. Compatibility
  function: `src/db/ensure-billing-storage-proof.ts`.
- `drizzle/0057_store_source_cutovers.sql`: store cutover state.
- `drizzle/0059_billing_finalized_lock.sql`: finalized-billing DB enforcement.
- `drizzle/0060_package_consumption_ledger.sql`: package identity/review schema.
- `drizzle/0061_inventory_ledger_effective_at.sql`: inventory ledger identity/date schema.
- `drizzle/0062_runtime_schema_ownership.sql`: remaining stable sidecars previously
  created on first use: direct-carrier cache, durable rate limiter, billing waiver
  and manual override stores, label purchase locks/intents, print queue job/PDF
  stores, Rate Browser jobs, and worker status events.
- `drizzle/0064_print_queue_merge_jobs.sql`: per-job PDF-merge metadata and its
  updated-at lookup index.

`src/services/rate-browse-job-store.ts` now reads/writes migration-owned
`rate_browse_jobs` and `rate_browse_job_provider_statuses`; no rate request creates
them.

## Safety

Migrations `0062` and `0064` are additive: no `UPDATE`, `DELETE`, table/column drop, or
`ALTER TABLE orders/shipments`. Existing shipped/cancelled guards, label purchase
locks/intents, finalized-billing triggers, rate authority, and inventory idempotency
remain unchanged. The 2026-07-14 user override covers migration-readiness changes
near label/shipment workflows; no data migration or provider action is part of this
patch.

Credential cutover migration `0063` is documented separately in
`IMPORTED_HANDLERS_BOUNDARY_AUDIT.md`; the Audit 3.5 migration `0064` contains
schema-only merge metadata.

Deploy order is mandatory: apply migrations through `0064`, then deploy API/worker.
Rollback reverts application code only; do not drop additive sidecars.

## Guard and Proof

- `npm run test:runtime-ddl`
- `npm run test:audit-runtime-schema-readiness`
- `npm run test:ps-455-runtime-schema-migration` (offline PGlite proof that
  migration `0062` creates every owned relation on an empty database and is a
  schema/data no-op when replayed against existing rows)
- `npm run typecheck`
- `npm run build:web`
- affected historical guards plus mandatory SOT guard pack
