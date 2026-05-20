# PrepShip Source-of-Truth and Duplication Audit

## Executive Summary

This is the canonical boss-facing audit for duplicate logic and source-of-truth drift in PrepShip v4. It supersedes `DUPLICATION_OPTIMIZATION_AUDIT.md`.

The highest-risk duplication remains around inventory stock repair workflows, full durable job event/artifact state, label side effects, and the last runtime DDL surfaces. Phase 11 Batch 1 moved carrier/store credential account PATCH behavior and table bootstrap logic behind shared helpers. Phase 11 Batch 2 moved rate cache diagnostics and exact/approximate bulk lookup semantics behind the canonical rate service/route boundary. Phase 11 Batch 3 added the runtime DDL inventory and static guard so new request-time schema creation cannot slip in undocumented. Phase 11 Batch 4 moved reporting metrics schema ownership into a Drizzle migration. Phase 11 Batch 5 moved the Walmart selling-fee source index fully to migration ownership. Phase 11 Batch 6 moved marketplace `store_orders` schema ownership into a Drizzle migration. Phase 11 Batch 7 removed credential-account request-time DDL and moved RLS readiness into migration ownership. Phase 11 Batch 8 moved `order_items`, `analytics_cache`, and the order item trigger/function to migration-readiness checks. Phase 11 Batch 9 removed duplicate runtime creation for low-risk orders/inventory performance indexes that were already migration-owned. Phase 11 Batch 10 added durable latest-run status for rate backfill. Phase 11 Batch 11 added durable latest-run status for billing reference-rate fetch. Phase 11 Batch 12 added scoped durable latest-run status for print queue batch-send and PDF-merge jobs. Phase 11 Batch 13 added `INVENTORY_SOURCE_OF_TRUTH_PLAN.md` and `npm run test:inventory-source-of-truth` so inventory ownership is explicit before any repair code is added. Phase 11 Batch 14 added `npm run inventory:reconcile:dry-run` and `npm run test:inventory-reconciliation-dry-run` so ledger/cache/effective-stock drift can be reported without mutation. Phase 11 Batch 15 added `INVENTORY_REPAIR_APPLY_PLAN.md` and `npm run test:inventory-repair-plan` so any future repair/apply mode has owner-approval gates before code exists.

Current progress: 97%. This is not 100% because inventory repair/apply implementation, full durable job progress/events, print queue artifact storage, label side-effect status reporting, and remaining shipment-adjacent runtime DDL cleanup still need implementation and production verification. ShipStation Awaiting parity, rate backfill, billing reference-rate fetch, and print queue batch/merge status now have durable last-run checkpoints in `settings`.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Carrier/store account route drift | Save, rename, approve, assignment, or delete can behave differently by route | Shared credential-account service owns all DB behavior | Static guard now covers shared PATCH/assignment parity; live API smoke tests still needed |
| Auth/JWT duplication | One compatibility endpoint can validate weaker tokens than another | Shared verifier is used by every active handler | Unauth, expired, wrong issuer/audience, admin/non-admin tests |
| Client DTO duplication | ShipStation credentials can leak if raw client rows return | `publicClient` is the only mapper for client responses | Secret-redaction guard and live `/clients` smoke test |
| Rate cache/key duplication | UI can show stale/wrong/no rates and retry external APIs too often | One canonical rate cache key and diagnostics shape | `npm run test:rate-system-hardening`; browser Rate Browser verification still needed |
| Job state duplication | Long-running work can disappear on restart or run twice | Durable job status and singleton execution | rate backfill/ref-rate/print-queue durable guards exist; restart and dual-worker tests still needed |

## High-Risk Issues

| Area | Current Duplicate Files/Logic | Canonical Owner To Keep | Risk If Unchanged | Recommended Patch | Test Plan |
|---|---|---|---|---|---|
| Carrier accounts | `api/carrier-accounts.ts`, `src/routes/carrier-accounts.ts`, imported handlers, settings UI | `src/services/credential-accounts.ts` plus Render route | account workflow drift | [x] PATCH rename/approval behavior moved behind service functions | GET/POST/PATCH/DELETE parity tests |
| Store accounts | `api/store-accounts.ts` mirrors carrier account CRUD | shared credential-account service | marketplace credential drift | [x] PATCH source/label behavior added through shared service; remaining provider-specific behavior still needs config cleanup | carrier/store CRUD regression tests |
| JWT/auth | Hono middleware, Vercel handlers, imported handlers | `src/lib/auth/verify-supabase-jwt.ts` | inconsistent token validation | Replace remaining legacy handler copies | auth coverage plus live token tests |
| CORS | Render app, Vercel handlers, imported handlers | `src/lib/http/cors.ts` | origin drift or overexposure | Replace remaining cron/debug/marketplace copies | OPTIONS tests for allowed/disallowed origins |
| Client DTOs | `/clients`, `/init`, frontend client shapes | `src/lib/public-client.ts` | credential leakage | enforce `publicClient` everywhere | `npm run test:client-redaction` |
| Rates/cache | routes, services, backfill, Rate Browser normalization | `src/services/rates.ts` plus `src/routes/rates.ts` for API semantics | wrong/stale rates, API storms | [x] canonical cache key exported, cache diagnostics persisted, exact/rough bulk lookup guarded; [x] rate backfill latest-run status persists | `npm run test:rate-system-hardening`; `npm run test:rate-backfill-durable`; browser rate audit |
| Frontend API wrappers | `api.ts`, `v2-apiClient.ts`, `vercelFunction.ts` | `api.ts` transport and `v2-apiClient` domain facade | failures appear as empty data | remove critical silent fallbacks | forced 500 UI tests |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Product defaults vs inventory defaults | package/dim defaults can diverge | Pick one canonical defaults service and make inventory derived |
| Inventory stock/effective stock | ledger, stock cache, and order-derived sold metrics can disagree | `inventory_ledger` as canonical movement history and `inventory.stockQty` as reconciled cache; exact policy: inventory_ledger as canonical movement history; see `INVENTORY_SOURCE_OF_TRUTH_PLAN.md` |
| Runtime DDL | runtime DDL inventory is documented and guarded; reporting metrics, Walmart selling-fee source index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, and low-risk orders/inventory performance indexes are migration-owned; shipment/label-adjacent compatibility paths still create indexes at request/job time | continue converting request-time DDL to Drizzle migrations in scoped batches |
| Label side effects | label creation touches shipments, packages, inventory, print queue, billing, fulfillment | return and persist side-effect statuses/warnings |
| Legacy compatibility handlers | some Vercel handlers remain near orders/shipments write paths | handle in a separately scoped lockdown-safe review |

## Recommended Patches

- [x] Add shared JWT verifier and CORS helper.
- [x] Add client secret redaction guard.
- [x] Add shared credential-account request helper and DB service.
- [x] Add auth coverage and frontend failure-state guards.
- [x] Move carrier/store PATCH rename/approval behavior behind shared service functions.
- [ ] Replace remaining JWT/CORS copies in legacy/maintenance handlers.
- [x] Add `RUNTIME_DDL_MIGRATION_AUDIT.md` inventory and static guard.
- [x] Move reporting metrics table/index ownership to `drizzle/0029_reporting_metrics.sql`.
- [x] Move Walmart selling-fee source index ownership to `drizzle/0019_selling_fees.sql`.
- [x] Move marketplace `store_orders` table/index ownership to `drizzle/0030_store_orders.sql`.
- [x] Move credential-account runtime table/index/RLS readiness to migrations.
- [x] Move `order_items`, `analytics_cache`, and order item trigger/function readiness to migrations.
- [x] Move low-risk orders/inventory performance index runtime creation to existing migrations.
- [x] Persist ShipStation Awaiting parity dry-run/apply status to `settings` via `shipstation_awaiting_parity.last_run`.
- [~] Move runtime table/index bootstrap into migrations.
- [x] Centralize rate cache key usage, persisted diagnostics, concurrency policy, negative cache, and exact/rough bulk lookup guard.
- [ ] Add inventory reconciliation service.
- [x] Persist rate backfill latest-run status to `settings` with `/rates/backfill-best/latest`.
- [x] Persist billing reference-rate fetch latest-run status to `settings` through `/billing/fetch-ref-rates/status`.
- [x] Move first user-visible print queue status snapshots out of process memory.
- [x] Add `INVENTORY_SOURCE_OF_TRUTH_PLAN.md` to document `inventory_ledger` as canonical movement history and `inventory.stockQty` as materialized/cache stock.
- [x] Add `npm run test:inventory-source-of-truth` to guard the inventory source-of-truth policy.
- [x] Add `npm run inventory:reconcile:dry-run` to compare `inventory.stockQty`, ledger stock, and `effectiveStock` without mutation.
- [x] Add `npm run test:inventory-reconciliation-dry-run` to guard no mutation and no apply mode.
- [x] Add `INVENTORY_REPAIR_APPLY_PLAN.md` to define owner approval, saved artifacts, rollback, and prohibited mutations before repair code exists.
- [x] Add `npm run test:inventory-repair-plan` to guard the inventory repair/apply control plan.
- [ ] Move full print queue progress/events and PDF artifacts to durable storage.
- [ ] Add label side-effect status reporting.

## Detailed Checklist

### Carrier and Store Accounts

- [x] Shared credential-account request normalization helper.
- [x] Drift guard for duplicated provider/source/body parsing.
- [x] Shared service boundary for list/upsert/delete/assignment operations.
- [x] PATCH rename/approval service consolidation.
- [x] `store_accounts` and `carrier_account_clients` added to migration source of truth.
- [ ] Vercel functions kept only as compatibility wrappers.
- [x] Runtime DDL inventory/guard created.
- [x] Reporting metrics runtime DDL moved to migration-owned schema.
- [x] Walmart selling-fee source index runtime DDL removed from compatibility paths.
- [x] `store_orders` runtime DDL removed from eBay/Walmart marketplace order handlers.
- [x] credential-account runtime DDL removed from carrier/store account handlers.
- [x] `order_items` / `analytics_cache` runtime DDL removed from order item analytics/backfill service.
- [x] low-risk orders/inventory performance index runtime DDL removed from maintenance service.
- [~] Runtime DDL moved to migrations.
- [ ] `CarrierIntegrationsCard` endpoint policy confirmed.
- [ ] Regression tests for rename, approve, assignment, delete, pending portal rows.

### Auth and CORS

- [x] Shared JWT verifier with strict-claims option.
- [~] Duplicated verifier replacement in active handlers.
- [x] Shared CORS helper.
- [x] Static guard for protected root/wildcard auth gates.
- [x] Static guard for `/admin` root/wildcard admin gates.
- [ ] Live API tests for unauthenticated paths and non-admin admin denial.

### Rates and Frontend Failures

- [x] Critical frontend methods guarded against `safe()` empty fallbacks.
- [x] `fetchRates` throws request failures to caller error states.
- [x] billing summary rethrows first-load failures while preserving stale cache.
- [x] canonical `rateCacheKey`.
- [x] exact cache lookup when `cacheKey` is supplied; rough weight/ZIP cache hits are marked approximate.
- [x] carrier diagnostics retained through backend cache and Rate Browser client diagnostics.
- [x] `RATE_FETCH_CONCURRENCY` enforcement guarded.
- [x] no-rate negative cache with diagnostics.
- [ ] visible retry/error states for all critical screens.

## Test Plan

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rate-system-hardening`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- Live API smoke tests for `/users`, `/clients`, `/admin/*`
- Settings carrier integration browser audit
- Rate Browser browser audit
- Render log review for duplicated account/rate calls

## Deployment/Rollback Notes

- Deploy documentation-only changes without runtime risk.
- For future code patches, deploy in small batches: auth/CORS, credentials, rates, frontend failures, then jobs/inventory.
- Roll back by reverting the most recent implementation batch if smoke tests fail.
- Do not remove compatibility handlers until frontend routing and Render/Vercel rewrites are verified.
