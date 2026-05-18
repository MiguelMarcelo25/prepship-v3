# PrepShip Runtime DDL Migration Audit

## Executive Summary

This is the Phase 11 inventory for remaining runtime `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements in production-capable `src` and `api` paths.

Current status: inventory and guard created. Phase 11 Batch 4 moved reporting metrics schema ownership into `drizzle/0029_reporting_metrics.sql` and changed runtime reporting code to a readiness check. The remaining work is to keep temporary compatibility fallbacks only where needed and defer shipped/label-adjacent cleanup to separately reviewed batches.

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
| `src/services/credential-account-schema.ts` | `store_accounts`, `carrier_account_clients`, credential indexes | already covered by migration | Keep fallback until Vercel/Render credential routes are production-smoke tested, then remove runtime bootstrap |
| `src/services/order-items.ts` | `order_items`, `analytics_cache`, analytics index | already covered by migration | Keep as temporary self-heal until production trigger/backfill verification is complete |
| `src/services/orders-performance-maintenance.ts` | `order_items`, `analytics_cache`, performance indexes | already covered by migration | Convert any missing index-only statements to migrations before removing maintenance DDL |
| `src/services/fulfillment/outbox.ts` | fulfillment outbox and order/shipment support indexes | requires separate shipped/label review | Do not refactor in this batch; migrate only with label/outbox recovery tests |
| `src/routes/analysis.ts` | `orders_selling_fee_source_idx` | compatibility fallback to keep temporarily | Move index ownership to selling-fees migration path and remove request-time ensure after verification |
| `api/_lib/walmart-fees-sync.ts` | `orders_selling_fee_source_idx` | compatibility fallback to keep temporarily | Keep until all Walmart fee entrypoints use one shared migration-owned index policy |
| `api/cron/sync-walmart-fees.ts` | `orders_selling_fee_source_idx` | compatibility fallback to keep temporarily | Same as Walmart fee shared helper; remove after production smoke |
| `api/carriers/walmart/fees.ts` | `orders_selling_fee_source_idx` | compatibility fallback to keep temporarily | Same as Walmart fee shared helper; remove after production smoke |
| `api/carriers/ebay/orders.ts` | `store_orders` table/indexes | compatibility fallback to keep temporarily | Add/verify store order migration, then keep handler as read/write compatibility only |
| `api/carriers/walmart/orders.ts` | `store_orders` table/indexes | compatibility fallback to keep temporarily | Share store order migration ownership with eBay order handler |
| `api/carriers/labels.ts` | fulfillment outbox, shipment support indexes, compatibility `shipments` table ensure | requires separate shipped/label review | Do not change without a label/shipment-specific plan and locked-surface review |

## Resolved Runtime DDL

| File | Previous Runtime DDL Surface | Resolution | Verification |
|---|---|---|---|
| `src/services/reporting-metrics.ts` | reporting refresh, daily sales, SKU velocity, inventory risk, billing summary metrics | moved to `drizzle/0029_reporting_metrics.sql`; runtime code now verifies tables are present instead of creating them | `npm run test:runtime-ddl` |

## Guard Policy

- New runtime table/index DDL in `src` or `api` must be added to this inventory.
- Runtime DDL near shipped, cancelled, shipment, label, or fulfillment side-effect paths must stay out of generic cleanup batches.
- `scripts/runtime-ddl-guard.mjs` fails if a new runtime DDL file appears without being documented here.

## Recommended Next Patches

- [x] Create this runtime DDL inventory.
- [x] Add static guard for known runtime DDL files.
- [x] Add reporting metrics Drizzle migration.
- [ ] Move Walmart selling-fee index ownership fully to migration/shared helper.
- [ ] Add `store_orders` Drizzle migration or confirm existing production schema ownership.
- [ ] Remove credential-account runtime bootstrap after live credential route smoke tests.
- [ ] Schedule separate label/outbox/shipment DDL cleanup plan.

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
- Roll back by reverting the reporting migration/readiness-check changes if the migration is not ready for the deployment path.
- Do not remove runtime DDL from production paths until matching migrations are applied and smoke-tested.
