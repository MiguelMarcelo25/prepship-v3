# PrepShip DJ/OpenClaw Dev Task Packet

## Current State

- Branch: `prepshipv4-stable`
- Latest pushed commit before this inventory classification batch: `fe86fb5f`
- Worktree at last update: clean
- Latest implementation batch tracked here: Phase 9 table-first/lazy-load pass for Orders, Analysis, Inventory, Billing, and Packages
- Latest production read from user: Rate Browser and live app behavior look healthy after the recent deploys
- GitHub Actions:
  - `Keep Render API warm`: manual only now
  - `Sync ShipStation orders + shipments`: manual only now
  - `CI`: still runs on push/PR
- Render worker remains the primary background scheduler.
- New Phase 13 tracks the Supabase Auth 7-day maximum login session policy.

## Four DJ/OpenClaw Docs

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md` | Created / active | 98% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, print queue batch/merge latest-run status, inventory source-of-truth policy, inventory dry-run reconciliation, dry-run artifact persistence, mismatch classification, and inventory repair/apply policy moved to documented ownership; actual owner-approved inventory repair implementation, label side effects, full job progress/events, artifact storage, and shipment-adjacent DDL cleanup still open |
| `ENTERPRISE_READINESS_AUDIT.md` | Created / active | 96% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, Manifests, and label/shipment-sensitive route policy are now mapped; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; marketplace awaiting-count reconciliation and key operational latest-run statuses have guarded paths; still needs label/shipment runtime enforcement, broader runtime audit/reconciliation/alert implementation, DR drills, artifact durability, and authenticated production verification |
| `SECURITY_PATCH_PLAN.md` | Created / mostly implemented | 95% | Needs live auth smoke tests, strict JWT production rollout, label/shipment runtime enforcement after review, and broader field-level role/client-scope rollout |
| `RATE_SYSTEM_HARDENING_PLAN.md` | Created / mostly implemented | 78% | Needs browser production verification, duplicate-name UX polish, provider/account metrics, and full backfill progress/events beyond latest-run durability |

## Additional Phase 13 Doc

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `JWT_SESSION_EXPIRATION_PLAN.md` | Created / production setting applied | 75% | Repo policy and guard exist, production Supabase dashboard evidence shows `168` hours, and production logout/login smoke passed; staging short-timebox proof and expired-session verification remain open |

## Phase Summary

| Phase | Status | Percent | Why Not 100% Yet |
|---|---|---:|---|
| Phase 1 - Runtime Architecture | Complete | 100% | Done |
| Phase 2 - Observability | Good start | 86% | Observability/alerting signal plan exists, Awaiting Shipment lag investigation is scoped, browser/API request IDs now flow through request headers, response headers, timing/error logs, detailed Orders list logs, opt-in browser API timing diagnostics, admin-only `/observability/api-timing` p95/p99 snapshots, an admin `/observability/status` status payload, and a Settings System Status panel; needs external alerts, slow-query dashboard, and broader worker/DB/rate/label health widgets |
| Phase 3 - Dashboard + Analysis Cleanup | Mostly complete | 86% | Dashboard Orders / Units KPI guard exists; needs production parity checks, remaining Analysis JSONB audit, and broader regression tests |
| Phase 4 - `order_items` Normalization | Mostly complete | 83% | Runtime schema bootstrap now checks migrations; needs production trigger/backfill verification and parity tests |
| Phase 5 - Reporting Read Models | Started | 30% | `analytics_cache` exists, but full dashboard/daily/SKU/inventory/billing read models are not complete |
| Phase 6 - Inventory Metrics | Partial | 65% | Inventory source-of-truth policy, read-only dry-run reconciliation, JSON/CSV artifact persistence, mismatch classification, and repair/apply control plan are documented and guarded; needs owner-approved repair implementation and precomputed sold/velocity/restock metrics |
| Phase 7 - Billing + Packages | Partial/good progress | 64% | Billing read surfaces now have client/store scope and billing reference-rate fetch latest-run durability; needs reconciliation, billing summary read model completion, package usage metrics, and package ledger hardening |
| Phase 8 - Shared Frontend Data Layer | Partial/good progress | 68% | Fresh-browser Inventory now defaults to active stock rows, and Receive Inventory loads the full selected-client SKU set with a guarded wide picker; needs standardized React Query hooks and remaining broad `safe()` fallback cleanup |
| Phase 9 - Lazy Loading + UI Performance | Partial | 74% | Awaiting Shipment startup-load risks are scoped, Orders support data is gated by user intent, global SKU lookup and daily stats are noncritical/lazy, first-page exact order counts are delayed until after the table paints, legacy sidebar counts no longer block first paint, Orders sync/worker polling is delayed and hidden-tab gated, global markups/settings hydration is delayed on Orders routes, New Order/order detail/tracking modal code loads only after user intent, Analysis table code is split into an on-demand chunk, Analysis rows paint before chart hydration, and Orders/Inventory/Analysis/Billing/Packages order-detail drawers lazy-load after user intent; needs fuller table-first loading, more lazy-loaded charts/export tools, remaining request timing evidence, and all-tool browser audit |
| Phase 10 - DJ/OpenClaw Security + Failure-State Hardening | Mostly complete | 97% | Unauthenticated production auth smoke checks passed and first runtime permission layer exists; dashboard/analysis/inventory/billing/print-queue/client/init/orders/manifests scoping started; raw-error response audit is mapped and guarded; first non-shipment raw-error route batch is patched; needs authenticated secret checks, label/shipment raw-error review, and label/shipment runtime enforcement after review |
| Phase 11 - Source-of-Truth + Duplication Audit | In progress | 98% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, print queue latest-run status, inventory source-of-truth policy, inventory dry-run reconciliation, dry-run artifact persistence, mismatch classification, and inventory repair/apply policy moved to documented ownership; actual inventory repair implementation, labels, full job events/artifacts, and shipment-adjacent DDL still remain |
| Phase 12 - Enterprise Readiness | Scoped/started | 98% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, Manifests, and label/shipment-sensitive route policy are mapped; read/action ownership is implemented for explicit client/store JWT claims on key surfaces; `financials:read` now protects Analysis/Dashboard SKU financials, Inventory SKU-order shipping costs, Billing routes, Orders export/list label costs, Manifests label costs, Packages unit costs, and Rate Browser rate-result DTOs; Rate Browser account source metadata requires `credentials:read`; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; needs label/shipment runtime enforcement, broader runtime audit/reconciliation/alert implementation, DR drills, and owner signoff evidence |
| Phase 13 - JWT Session Expiration | Production setting applied | 75% | 7-day session policy is documented and guarded, Supabase Auth time-box is set to `168` hours, and production logout/login smoke passed; staging expiry proof and forced re-login evidence remain open |

## Phase Checklist

### Phase 1 - Runtime Architecture: 100%

- [x] Vercel frontend
- [x] Render API
- [x] Render worker
- [x] Supabase DB/auth
- [x] API/worker runtime split
- [x] Worker owns background sync
- [x] Pg-boss/job queue foundation

### Phase 2 - Observability: 86%

- [x] API timing logs
- [x] `Server-Timing`
- [x] `/sync/status`
- [x] `/worker/status`
- [x] worker heartbeat/status basics
- [x] GitHub scheduled cron noise removed
- [x] `OBSERVABILITY_ALERTING_PLAN.md`
- [x] `npm run test:observability-alerting`
- [x] Admin-only `/observability/api-timing` p95/p99 API timing snapshot
- [x] Admin-only `/observability/status` runtime/API status payload
- [x] Settings System Status panel reads `/observability/status` lazily
- [x] `npm run test:api-observability-metrics`
- [x] Awaiting Shipment lag investigation scoped
- [x] `AWAITING_SHIPMENTS_PERFORMANCE_PLAN.md`
- [x] Render restart/startup maintenance bottleneck hypothesis added to the Awaiting plan
- [x] Startup orders performance maintenance no longer inherits from `RUN_SYNC_SCHEDULER`
- [x] `RUN_ORDERS_PERFORMANCE_MAINTENANCE=true` is required to run orders performance maintenance
- [x] `npm run test:orders-maintenance-startup`
- [x] `X-Request-Id` response header and timing/error log correlation
- [x] Request ID correlation for detailed `[orders:list]` segment timings
- [x] Browser API calls send request IDs and failed API errors include them
- [x] Opt-in browser `[api:client-timing]` diagnostics for slow/failed requests
- [ ] Check Render logs for `[orders:maintenance] ensured index`, `backfilled`, `repaired`, and `refreshed planner stats`
- [ ] Confirm `RUN_ORDERS_PERFORMANCE_MAINTENANCE` / `RUN_SYNC_SCHEDULER` production env ownership for API vs worker
- [ ] Capture browser Network timing for Awaiting page
- [~] Correlate Render `[api:timing]` and `[orders:list]` logs
- [ ] Correlate Supabase slow-query logs for the same timestamps
- [x] Add p95/p99 visibility for `/orders`, `/init/counts`, `/orders/daily-stats`, and `/orders/distinct-skus`
- [~] external alerts
- [x] p95/p99 API timing snapshot
- [~] slow DB query dashboard
- [x] Settings System Status panel
- [ ] Broader internal status panel for worker, DB, sync, queue, rates, labels, billing, and reporting health

### Phase 3 - Dashboard + Analysis Cleanup: 86%

- [x] `/dashboard` route
- [x] dashboard summary/trends/top SKUs/inventory-risk endpoints
- [x] panel-level dashboard loading/errors
- [x] dashboard avoids giant raw order pulls
- [x] dashboard KPI cards show Orders / Units and have regression guard
- [ ] production parity checks
- [ ] remaining Analysis JSONB cleanup
- [ ] dashboard/analysis regression tests

### Phase 4 - `order_items` Normalization: 83%

- [x] `order_items` table
- [x] indexes
- [x] trigger/backfill/repair logic
- [x] dashboard/analysis/inventory hot paths partially moved
- [x] runtime schema bootstrap replaced with migration-readiness checks
- [ ] production trigger verification
- [ ] production backfill verification
- [ ] parity tests
- [ ] remaining JSONB analytics audit

### Phase 5 - Reporting Read Models: 30%

- [x] `analytics_cache`
- [x] reporting/read-model direction started
- [ ] dashboard summary metrics
- [ ] daily sales metrics
- [ ] SKU velocity metrics
- [ ] inventory risk metrics
- [ ] billing summary metrics

### Phase 6 - Inventory Metrics: 65%

- [x] `order_items` used in important inventory paths
- [x] lower-SKU index support started
- [x] inventory page pressure reduced
- [x] `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`
- [x] `inventory_ledger` source-of-truth ownership documented
- [x] `inventory.stockQty` documented as materialized/cache balance
- [x] `npm run test:inventory-source-of-truth`
- [x] `inventory:reconcile:dry-run`
- [x] `npm run test:inventory-reconciliation-dry-run`
- [x] read-only ledger/cache/effective-stock reconciliation report
- [x] `INVENTORY_REPAIR_APPLY_PLAN.md`
- [x] `npm run test:inventory-repair-plan`
- [x] owner-approved repair/apply policy documented
- [x] dry-run mismatch classifications
- [x] `classificationCounts`, `recommendedAction`, and `safeToAutoRepair=false`
- [x] dry-run JSON/CSV artifact persistence
- [~] `inventory_ledger` source-of-truth enforcement
- [~] inventory reconciliation service
- [ ] owner-approved inventory repair/apply implementation
- [ ] precomputed sold/velocity/days-supply/restock metrics

### Phase 7 - Billing + Packages: 64%

- [x] generated billing line items exist
- [x] billing summary first-load failure no longer fakes `$0.00`
- [x] billing read endpoints apply explicit client/store scope claims
- [x] billing reference-rate fetch latest-run status persists to `settings`
- [x] `/packages` lightweight/paginated support
- [ ] billing reconciliation report
- [ ] billing summary read model
- [ ] package usage metrics
- [ ] package ledger/reporting hardening

### Phase 8 - Shared Frontend Data Layer: 68%

- [x] request storm reduced
- [x] hidden-tab/status pressure reduced
- [x] critical fetch guard added
- [x] counts/rates/billing failure-state behavior improved
- [x] fresh-browser Inventory Stock Levels defaults to active rows
- [x] Receive Inventory SKU picker loads all selected-client SKUs
- [x] Receive Inventory SKU picker widened for operator scanning
- [x] `npm run test:receive-sku-picker`
- [ ] standardize React Query hooks
- [ ] remove remaining broad `safe()` fallbacks
- [ ] visible retry/error states for every tool page

### Phase 9 - Lazy Loading + UI Performance: 74%

- [x] major route/view lazy loading
- [x] Orders side data delayed/lazy-loaded
- [x] Rate Browser cached/progressive direction started
- [x] Awaiting Shipment startup request audit scoped
- [x] Orders startup request guard added
- [x] Confirm `/orders/distinct-skus` is not required for initial Awaiting table paint
- [x] Confirm `/orders/daily-stats` is not blocking initial Awaiting table paint
- [x] Orders locations/carrier-account support data deferred until user intent
- [x] Legacy SidebarOrders initial counts delayed until after first paint
- [x] Legacy SidebarOrders count polling slowed and hidden-tab gated
- [x] Orders sync and worker status polling startup delays guarded
- [x] Orders route delays global markups/settings hydration
- [x] First-page exact order count delayed until after table paint
- [x] New Order modal lazy-loaded behind user intent
- [x] Order detail drawer lazy-loaded behind order-number intent
- [x] Tracking modal lazy-loaded behind tracking-number intent
- [x] Analysis data table lazy-loaded into its own chunk
- [x] Analysis table rows load before chart hydration
- [x] Billing and Packages order-detail drawers lazy-loaded behind user intent
- [x] Inventory and Analysis order-detail drawers lazy-loaded behind user intent
- [ ] Make Awaiting page table load first
- [~] Defer sidebar counts, daily stats, sync status, settings, locations, and packages until after first paint or user intent
- [x] Make exact order count delayed or optional when slow
- [x] Add startup request guard for Orders page
- [ ] lazy-load more drawers/modals/charts/export tools
- [ ] split very large frontend views
- [ ] browser audit all tool pages

### Phase 10 - DJ/OpenClaw Security + Failure-State Hardening: 97%

- [x] `/users` gated
- [x] protected root + wildcard route gates
- [x] `/admin` requires admin
- [x] optional strict JWT claims
- [x] client ShipStation secret redaction
- [x] `/aws-api` removed
- [x] mock label URLs signed/expiring
- [x] safer credential-handler 500s
- [x] auth/client/credential/frontend/orders guard tests
- [x] GitHub scheduled production crons disabled
- [x] first runtime RBAC permission guard for `/users`, settings, and credential surfaces
- [x] first dashboard aggregate client/store scope guard
- [x] first Analysis read client/store scope guard
- [x] first Inventory read client/store scope guard
- [x] first Billing read client/store scope guard
- [x] first Print Queue list client/store scope guard
- [x] first Print Queue action/job ownership guard
- [x] first Orders read/list/export client/store scope guard
- [x] first Manifests generate client/store scope guard
- [x] `RAW_ERROR_RESPONSE_AUDIT.md`
- [x] `npm run test:raw-error-response-audit`
- [x] first non-shipment raw-error route patch batch
- [~] live production auth smoke tests
- [x] deeper raw-error route audit
- [~] route-by-route raw-error response patches
- [ ] formal RBAC/client-scope enforcement

### Phase 11 - Source-of-Truth + Duplication Audit: 98%

- [x] `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
- [x] shared JWT verifier
- [x] shared CORS helper
- [x] shared credential-account helper/service
- [x] auth coverage guard
- [x] frontend failure-state guard
- [x] carrier/store PATCH rename/approval consolidation
- [x] centralized rate cache key
- [x] persisted rate cache diagnostics
- [x] exact-or-approximate `/rates/cached/bulk`
- [x] normalized Rate Browser diagnostics
- [x] `RUNTIME_DDL_MIGRATION_AUDIT.md`
- [x] static runtime DDL guard
- [x] reporting metrics Drizzle migration
- [x] Walmart selling-fee source index moved to migration ownership
- [x] `store_orders` Drizzle migration
- [x] eBay/Walmart marketplace order handlers verify `store_orders` migration readiness instead of creating schema at request time
- [x] credential-account runtime DDL removed
- [x] credential-account RLS/readiness migration added
- [x] `order_items` / `analytics_cache` runtime DDL removed
- [x] order item trigger/function readiness moved to migration checks
- [x] low-risk orders/inventory performance index runtime DDL removed
- [x] remaining maintenance DDL narrowed to shipment-adjacent index fallback
- [x] `DURABLE_JOBS_PLAN.md`
- [x] `npm run test:durable-jobs-plan`
- [x] ShipStation Awaiting parity durable last-run status in `settings`
- [x] Rate backfill durable latest-run status in `settings`
- [x] `/rates/backfill-best/latest`
- [x] `npm run test:rate-backfill-durable`
- [x] Billing reference-rate durable latest-run status in `settings`
- [x] `/billing/fetch-ref-rates/status` includes `durableJob`
- [x] `npm run test:ref-rates-durable`
- [x] Print queue batch-send durable latest-run status in `settings`
- [x] Print queue PDF-merge durable latest-run status in `settings`
- [x] `/print-queue/batch-send/status/:jobId` includes scoped matching `durableJob`
- [x] `/print-queue/print/status/:jobId` includes scoped matching `durableJob`
- [x] `npm run test:print-queue-durable`
- [x] `INVENTORY_SOURCE_OF_TRUTH_PLAN.md`
- [x] inventory source-of-truth policy and guard
- [x] `npm run test:inventory-source-of-truth`
- [x] `inventory:reconcile:dry-run`
- [x] `npm run test:inventory-reconciliation-dry-run`
- [x] `INVENTORY_REPAIR_APPLY_PLAN.md`
- [x] `npm run test:inventory-repair-plan`
- [x] classified inventory reconciliation mismatches
- [x] dry-run classification counts and row-level recommended actions
- [x] Walmart/eBay marketplace order pullers use shared JWT/CORS helpers
- [x] `npm run test:marketplace-order-auth-cors`
- [~] runtime DDL migration cleanup
- [~] inventory source-of-truth cleanup
- [~] full durable job progress/events and artifact storage
- [ ] label side-effect status reporting
- [ ] remaining legacy JWT/CORS copies cleanup
- [ ] carrier/store endpoint policy final verification

### Phase 12 - Enterprise Readiness: 98%

- [x] `ENTERPRISE_READINESS_AUDIT.md`
- [x] critical/high/medium issue buckets scoped
- [x] `RBAC_CLIENT_SCOPE_MATRIX.md`
- [x] canonical enterprise role names defined
- [x] RBAC/client-scope route matrix completed for planning
- [x] first runtime RBAC permission middleware for `/users`, settings, carrier accounts, and carrier verification
- [x] `npm run test:rbac-permissions`
- [x] first client/store scope helper for explicit JWT `clientIds` / `storeIds`
- [x] `/clients` list/detail scope filtering for scoped users
- [x] `/init/init-data` and `/init/stores` client/store payload scope filtering
- [x] `npm run test:client-store-scope`
- [x] `/dashboard` summary/daily-counts/SKU panels/inventory-risk scope filtering for scoped users
- [x] dashboard cache keys include client/store scope
- [x] `npm run test:dashboard-client-scope`
- [x] `/analysis` overview/daily-shipments/top-skus/SKU breakdown/SKU daily scope filtering for scoped users
- [x] `npm run test:analysis-client-scope`
- [x] `/inventory` list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders scope filtering for scoped users
- [x] `npm run test:inventory-client-scope`
- [x] `/billing` config/summary/details/invoice/package-prices scope filtering for scoped users
- [x] `npm run test:billing-client-scope`
- [x] `/print-queue` list scope filtering for scoped users
- [x] `npm run test:print-queue-client-scope`
- [x] `/print-queue` add/clear/delete/print/status/download ownership checks for scoped users
- [x] `npm run test:print-queue-ownership`
- [x] `/orders` list/daily-counts/dashboard-sales/ids/store-counts/daily-stats/picklist/distinct-skus/by-number/detail/full/export scope filtering for scoped users
- [x] `/manifests/generate` GET/POST scope filtering for scoped users
- [x] `npm run test:orders-manifests-scope`
- [x] `financials:read` permission added for financial field visibility
- [x] Analysis/Dashboard top-SKU financial fields redact without `financials:read`
- [x] Inventory SKU-order shipping-cost fields redact without `financials:read`
- [x] Billing routes require `financials:read`
- [x] `npm run test:field-level-rbac`
- [x] Orders export/list label costs redact without `financials:read`
- [x] Manifests label costs redact without `financials:read`
- [x] Packages unit costs redact without `financials:read`
- [x] Rate Browser rate money fields redact without `financials:read`
- [x] Rate Browser account source metadata requires `credentials:read`
- [x] `npm run test:field-level-rbac-extended`
- [x] `LABEL_SHIPMENT_SCOPE_REVIEW.md`
- [x] `npm run test:label-shipment-scope-review`
- [x] `SECRETS_GOVERNANCE_MATRIX.md`
- [x] `npm run test:secrets-governance`
- [x] `AUDIT_LOGGING_MATRIX.md`
- [x] `npm run test:audit-logging`
- [x] `RECONCILIATION_REPORTS_PLAN.md`
- [x] `npm run test:reconciliation-plan`
- [x] marketplace status reconciliation dry-run/apply script
- [x] `npm run test:marketplace-reconciliation`
- [x] `OBSERVABILITY_ALERTING_PLAN.md`
- [x] `npm run test:observability-alerting`
- [x] `/observability/api-timing` API timing snapshot
- [x] `/observability/status` runtime/API status payload
- [x] `npm run test:api-observability-metrics`
- [x] `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`
- [x] `npm run test:operational-runbooks`
- [x] `PRIVACY_COMPLIANCE_PLAN.md`
- [x] `npm run test:privacy-compliance`
- [x] `PRODUCTION_READINESS_SIGNOFF.md`
- [x] `npm run test:production-signoff`
- [x] `DURABLE_JOBS_PLAN.md`
- [x] `npm run test:durable-jobs-plan`
- [x] `npm run test:ref-rates-durable`
- [x] Print queue latest-run durable status in `settings`
- [x] `npm run test:print-queue-durable`
- [ ] label/shipment runtime scope enforcement after review
- [~] secrets governance
- [~] audit logging
- [~] reconciliation reports
- [~] runtime DDL backlog/inventory
- [~] durable jobs
- [~] observability/alerts
- [~] deployment/rollback/DR runbooks
- [~] privacy/compliance checklist
- [~] production readiness signoff checklist

### Phase 13 - JWT Session Expiration: 75%

- [x] Policy chosen: 7-day maximum Supabase session lifetime
- [x] Access JWTs remain short-lived, preferably current/default 1 hour
- [x] `JWT_SESSION_EXPIRATION_PLAN.md`
- [x] `npm run test:jwt-session-policy`
- [x] Backend keeps current JWT `exp` validation through `jose`
- [x] `STRICT_JWT_CLAIMS` stays staged behind env flag
- [x] Supabase dashboard value documented as `168` hours for 7 days
- [x] Configure Supabase Auth time-box user sessions to `168` hours / 7 days
- [x] Production logout/login smoke passed after setting change
- [ ] Verify expired-session behavior in staging with a short temporary time-box
- [ ] Verify production login and forced re-login behavior after rollout
- [ ] Add production evidence to `PRODUCTION_READINESS_SIGNOFF.md`

## Recommended Next Order

1. Finish production verification after this batch deploys.
   - Confirm GitHub no longer creates new scheduled cron failures.
   - Confirm Render API and worker are deployed on the latest pushed commit.
   - Confirm Rate Browser stays healthy across several awaiting-shipment orders.
2. Finish auth/security smoke tests.
   - [x] `/users` unauthenticated returns `401`.
   - [x] `/clients` unauthenticated returns `401`.
   - [ ] non-admin `/admin/*` returns `403`.
   - [ ] `/clients` and `/init/init-data` with a valid token do not expose ShipStation secrets.
3. Browser-audit all tools.
   - Orders, Dashboard, Inventory, Clients, Packages, Rate Shop, Analysis, Settings, Billing, Manifests.
4. Run the Awaiting Shipment performance investigation before any AWS or archive decision.
   - Capture Browser Network timing for first load.
   - Correlate Render `[api:timing]` and `[orders:list]` logs.
   - Search Render logs for `[orders:maintenance]` during the slowdown window and confirm whether startup index/backfill/analyze work overlapped user traffic.
   - Confirm API `RUN_ORDERS_PERFORMANCE_MAINTENANCE` is not enabled unless a maintenance window is intended.
   - Correlate Supabase slow-query logs for the same timestamp.
   - Confirm whether the blocker is `/orders`, `/init/counts`, `/orders/daily-stats`, `/orders/distinct-skus`, settings/locations/packages, worker pressure, or frontend render.
   - Only implement table-first loading, delayed exact counts, or archive/hot-window changes after the confirmed bottleneck is known.
5. Continue Phase 11 with the next safest batch.
   - Apply and smoke-test `drizzle/0030_store_orders.sql` before marketplace order imports rely on it.
   - Apply and smoke-test `drizzle/0031_credential_accounts_rls.sql` before carrier/store credential routes rely on it.
   - Apply and smoke-test `drizzle/0024_order_items_phase2.sql` and `drizzle/0025_order_items_sync_trigger.sql` before order item analytics/backfill rely on them.
   - Confirm existing performance migrations `0021`, `0022`, `0023`, and `0026` are applied before relying on runtime maintenance cleanup.
   - Keep label/outbox/shipment-adjacent DDL deferred to a separate reviewed plan.
   - Review `INVENTORY_REPAIR_APPLY_PLAN.md` and the classified inventory dry-run output with DJ/OpenClaw before implementing any repair/apply mode.
   - Add JSON/CSV dry-run artifact persistence before any owner-approved inventory repair/apply command.
   - Review `DURABLE_JOBS_PLAN.md` with DJ/OpenClaw and approve durable job storage target.
   - Durable job state implementation for print queue/rate backfill/ref-rate jobs.
   - Label side-effect status reporting.
6. Continue Phase 12.
   - Review `RBAC_CLIENT_SCOPE_MATRIX.md` with DJ/OpenClaw.
   - Review `SECRETS_GOVERNANCE_MATRIX.md` with DJ/OpenClaw and assign credential owners.
   - Review `AUDIT_LOGGING_MATRIX.md` with DJ/OpenClaw and approve audit event names.
   - Review `RECONCILIATION_REPORTS_PLAN.md` with DJ/OpenClaw and approve report ownership.
   - Review `OBSERVABILITY_ALERTING_PLAN.md` with DJ/OpenClaw and approve alert owners/thresholds.
   - Review `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md` with DJ/OpenClaw and approve runbook owners.
   - Review `PRIVACY_COMPLIANCE_PLAN.md` with DJ/OpenClaw and approve data-class owners.
   - Review `PRODUCTION_READINESS_SIGNOFF.md` with DJ/OpenClaw and approve release gates.
   - Deploy and smoke-test the runtime RBAC, client/init scope, dashboard scope, analysis scope, inventory scope, billing scope, and print-queue list/action scope layer.
   - Implement remaining label/shipment runtime scope enforcement in a separate reviewed batch.
   - Audit logging.
   - Reconciliation reports.
   - Observability alerts.
   - Runbooks and disaster recovery.
7. Continue Phase 13.
   - Production Supabase Auth time-box is set to `168` hours / 7 days.
   - Keep access JWT expiry short; do not set access JWT lifetime to 7 days.
   - Run staging short-timebox proof before production rollout.
   - Capture production login and expired-session evidence in the signoff checklist.

## Verification Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:raw-error-response-audit`
- `npm run test:rbac-permissions`
- `npm run test:client-store-scope`
- `npm run test:dashboard-client-scope`
- `npm run test:analysis-client-scope`
- `npm run test:inventory-client-scope`
- `npm run test:billing-client-scope`
- `npm run test:print-queue-client-scope`
- `npm run test:print-queue-ownership`
- `npm run test:orders-manifests-scope`
- `npm run test:field-level-rbac`
- `npm run test:field-level-rbac-extended`
- `npm run test:label-shipment-scope-review`
- `npm run test:secrets-governance`
- `npm run test:audit-logging`
- `npm run test:reconciliation-plan`
- `npm run test:marketplace-reconciliation`
- `npm run test:observability-alerting`
- `npm run test:api-observability-metrics`
- `npm run test:operational-runbooks`
- `npm run test:privacy-compliance`
- `npm run test:production-signoff`
- `npm run test:durable-jobs-plan`
- `npm run test:inventory-source-of-truth`
- `npm run test:inventory-reconciliation-dry-run`
- `npm run test:inventory-repair-plan`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rate-system-hardening`
- `npm run test:runtime-ddl`
- `npm run test:jwt-session-policy`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- `npm run test:orders-startup-requests`

## Assumptions

- Render worker is the primary scheduler.
- GitHub Actions should stay CI-only.
- Manual GitHub workflow buttons can remain for emergency recovery.
- Browser extension console errors are external and not counted as PrepShip bugs.
- Shipped/cancelled mutation protections remain locked unless the exact override phrase is given again.
- `DUPLICATION_OPTIMIZATION_AUDIT.md` is retained as a legacy pointer only.
- Phase 13 enforces a 7-day login session through Supabase Auth session settings, not through 7-day access JWTs.
