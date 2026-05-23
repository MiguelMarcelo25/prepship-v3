# PrepShip Runtime DDL Migration Audit

## Executive Summary

This is the Phase 11 inventory for remaining runtime `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements in production-capable `src` and `api` paths.

Current status: inventory and guard created. Phase 11 Batch 4 moved reporting metrics schema ownership into `drizzle/0029_reporting_metrics.sql` and changed runtime reporting code to a readiness check. Phase 11 Batch 5 removed repeated Walmart selling-fee source index runtime creation and left the index owned by `drizzle/0019_selling_fees.sql`. Phase 11 Batch 6 moved `store_orders` table/index ownership into `drizzle/0030_store_orders.sql` and changed marketplace order handlers to a readiness check. Phase 11 Batch 7 moved credential-account RLS/readiness ownership into migrations and removed credential account request-time table/index creation. Phase 11 Batch 8 moved `order_items`, `analytics_cache`, and the order-items trigger/function to migration-readiness checks. Phase 11 Batch 9 removed duplicate runtime creation for low-risk orders/inventory performance indexes that were already migration-owned. Phase 11 Batch 10 moved fulfillment outbox and direct-label schema ownership to migration-readiness checks, removing the production `source_provider` request-time DDL seen in PS-028 database timing. The remaining runtime DDL is the selling-fee column compatibility fallback and must be handled under a separate shipped-data review because those fields support settled shipped-order fee updates.

## Classification Legend

| Classification | Meaning |
|---|---|
| already covered by migration | A Drizzle migration exists; runtime DDL is a temporary safety net or maintenance path |
| compatibility fallback to keep temporarily | Runtime DDL remains to support older deployments or compatibility handlers until production is verified |
| safe to move to migration now | No locked shipped/cancelled behavior needs to change; next batch can migrate it |
| requires separate shipped/label review | DDL is near shipments, labels, fulfillment, or locked operational surfaces and must be handled separately |

## Runtime DDL Inventory

| File | Runtime DDL Surface | Classification | Next Action |
|---|---|---|---|
| `src/routes/analysis.ts` | selling-fee order columns | requires separate shipped/label review | Move to migration-readiness only after shipped-fee reporting is reviewed |
| `api/_lib/walmart-fees-sync.ts` | selling-fee order columns | requires separate shipped/label review | Move to migration-readiness only after shipped-fee sync is reviewed |
| `api/carriers/walmart/fees.ts` | selling-fee order columns | requires separate shipped/label review | Move to migration-readiness only after shipped-fee sync is reviewed |
| `api/cron/sync-walmart-fees.ts` | selling-fee order columns | requires separate shipped/label review | Move to migration-readiness only after shipped-fee sync is reviewed |
| `src/services/orders-performance-maintenance.ts` | shipment support indexes only | requires separate shipped/label review | Move to migration-readiness only after label/shipment performance paths are reviewed |

## Resolved Runtime DDL

| File | Previous Runtime DDL Surface | Resolution | Verification |
|---|---|---|---|
| `src/services/reporting-metrics.ts` | reporting refresh, daily sales, SKU velocity, inventory risk, billing summary metrics | moved to `drizzle/0029_reporting_metrics.sql`; runtime code now verifies tables are present instead of creating them | `npm run test:runtime-ddl` |
| `src/routes/analysis.ts` | `orders_selling_fee_source_idx` | removed request-time index creation; index remains owned by `drizzle/0019_selling_fees.sql` | `npm run test:runtime-ddl` |
| `api/_lib/walmart-fees-sync.ts` | `orders_selling_fee_source_idx` | removed request-time index creation; helper still leaves column fallback untouched | `npm run test:runtime-ddl` |
| `api/cron/sync-walmart-fees.ts` | `orders_selling_fee_source_idx` | removed request-time index creation; cron compatibility path still leaves column fallback untouched | `npm run test:runtime-ddl` |
| `api/carriers/walmart/fees.ts` | `orders_selling_fee_source_idx` | removed request-time index creation; API compatibility path still leaves column fallback untouched | `npm run test:runtime-ddl` |
| `api/carriers/ebay/orders.ts` | `store_orders` table/indexes | moved to `drizzle/0030_store_orders.sql`; handler now verifies migration readiness instead of creating schema | `npm run test:runtime-ddl` |
| `api/carriers/walmart/orders.ts` | `store_orders` table/indexes | moved to `drizzle/0030_store_orders.sql`; handler now verifies migration readiness instead of creating schema | `npm run test:runtime-ddl` |
| `src/services/credential-account-schema.ts` | `carrier_accounts`, `store_accounts`, `carrier_account_clients`, credential indexes/RLS | carrier/store handlers now verify migration readiness; RLS ownership is in `drizzle/0031_credential_accounts_rls.sql` | `npm run test:runtime-ddl`; `npm run test:credential-accounts` |
| `src/services/order-items.ts` | `order_items`, `analytics_cache`, analytics indexes, `prepship_order_items_refresh` trigger/function | moved to `drizzle/0024_order_items_phase2.sql` and `drizzle/0025_order_items_sync_trigger.sql`; runtime service now verifies readiness instead of creating schema | `npm run test:runtime-ddl`; `npm run typecheck` |
| `src/services/orders-performance-maintenance.ts` | orders/inventory performance indexes | moved to `drizzle/0021_orders_endpoint_performance.sql`, `drizzle/0022_dashboard_sales_performance.sql`, `drizzle/0023_inventory_list_performance.sql`, and `drizzle/0026_inventory_lower_sku_idx.sql`; runtime maintenance now keeps only shipment-adjacent index fallback | `npm run test:runtime-ddl`; `npm run typecheck` |
| `src/services/fulfillment/outbox.ts` | fulfillment outbox and order/shipment support DDL | moved to `drizzle/0020_fulfillment_outbox.sql` and `drizzle/0032_connector_architecture.sql`; runtime code now verifies readiness instead of creating schema | `npm run test:runtime-ddl`; `npm run typecheck` |
| `api/carriers/labels.ts` | fulfillment outbox, order source, and shipment support DDL | moved to `drizzle/0020_fulfillment_outbox.sql` and `drizzle/0032_connector_architecture.sql`; direct-label serverless code now verifies readiness instead of creating schema | `npm run test:runtime-ddl`; `npm run typecheck` |

## Guard Policy

- New runtime table/index DDL in `src` or `api` must be added to this inventory.
- Runtime DDL near shipped, cancelled, shipment, label, fulfillment, or settled-fee side-effect paths must stay out of generic cleanup batches.
- The guard scans `CREATE TABLE/INDEX IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in production-capable `src` and `api` files.
- `scripts/runtime-ddl-guard.mjs` fails if a new runtime DDL file appears without being documented here.

## Recommended Next Patches

- [x] Create this runtime DDL inventory.
- [x] Add static guard for known runtime DDL files.
- [x] Add reporting metrics Drizzle migration.
- [x] Move Walmart selling-fee index ownership fully to migration/shared helper.
- [x] Add `store_orders` Drizzle migration and remove marketplace order request-time DDL.
- [x] Remove credential-account runtime bootstrap and add migration-owned RLS readiness.
- [x] Remove `order_items` / `analytics_cache` runtime bootstrap and add migration-readiness checks.
- [x] Remove duplicate orders/inventory performance index runtime creation already covered by migrations.
- [x] Remove label/outbox/shipment request-time DDL with a label/outbox-specific readiness check.
- [ ] Schedule separate shipped-fee DDL cleanup plan.

## Test Plan

- `npm run test:runtime-ddl`
- `npm run typecheck`
- `npm run build:web`
- Existing guards:
  - `npm run test:auth-coverage`
  - `npm run test:client-redaction`
  - `npm run test:credential-accounts`
  - `npm run test:rate-system-hardening`
  - `npm run test:frontend-failure-states`
  - `npm run test:orders-ux`

## Deployment/Rollback Notes

- Batch 4 includes one schema ownership change: reporting metrics tables now belong to `drizzle/0029_reporting_metrics.sql`.
- Batch 6 includes one schema ownership change: marketplace `store_orders` now belongs to `drizzle/0030_store_orders.sql`.
- Batch 7 includes one schema ownership change: credential account RLS/readiness now belongs to `drizzle/0031_credential_accounts_rls.sql` plus earlier credential migrations.
- Batch 8 includes one schema ownership change: `order_items`, `analytics_cache`, and order item trigger/function readiness now belongs to `drizzle/0024_order_items_phase2.sql` and `drizzle/0025_order_items_sync_trigger.sql`.
- Batch 9 includes one schema ownership cleanup: low-risk orders/inventory performance indexes are no longer created by runtime maintenance and remain owned by existing migrations.
- Roll back by reverting the relevant migration/readiness-check changes if the migration is not ready for the deployment path.
- Do not remove runtime DDL from production paths until matching migrations are applied and smoke-tested.
