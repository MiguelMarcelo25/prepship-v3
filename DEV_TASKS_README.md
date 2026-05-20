# PrepShip DJ/OpenClaw Dev Task Packet

## Current State

- Branch: `prepshipv4-stable`
- Latest pushed commit before this Orders/Manifests scope batch: `5878e2ed`
- Worktree at last update: clean
- Latest implementation batch tracked here: Phase 13 JWT/session expiration policy
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
| `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md` | Created / active | 94% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, and print queue batch/merge latest-run status moved to documented ownership; inventory truth, label side effects, full job progress/events, artifact storage, and shipment-adjacent DDL cleanup still open |
| `ENTERPRISE_READINESS_AUDIT.md` | Created / active | 95% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, and Manifests now apply explicit JWT client/store claims on key read surfaces; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; marketplace awaiting-count reconciliation and key operational latest-run statuses have guarded paths; still needs label/shipment-sensitive policy, broader runtime audit/reconciliation/alert implementation, DR drills, artifact durability, and authenticated production verification |
| `SECURITY_PATCH_PLAN.md` | Created / mostly implemented | 95% | Needs live auth smoke tests, strict JWT production rollout, label/shipment-sensitive scope review, and broader field-level role/client-scope rollout |
| `RATE_SYSTEM_HARDENING_PLAN.md` | Created / mostly implemented | 78% | Needs browser production verification, duplicate-name UX polish, provider/account metrics, and full backfill progress/events beyond latest-run durability |

## Additional Phase 13 Doc

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `JWT_SESSION_EXPIRATION_PLAN.md` | Created / policy ready | 45% | Repo policy and guard exist; Supabase Auth time-box session setting, staging short-timebox proof, and production verification still require DJ/admin dashboard action |

## Phase Summary

| Phase | Status | Percent | Why Not 100% Yet |
|---|---|---:|---|
| Phase 1 - Runtime Architecture | Complete | 100% | Done |
| Phase 2 - Observability | Good start | 70% | Observability/alerting signal plan now exists; needs runtime emitters, external alerts, p95/p99 dashboards, slow-query dashboard, and status panel |
| Phase 3 - Dashboard + Analysis Cleanup | Mostly complete | 85% | Needs production parity checks, remaining Analysis JSONB audit, and regression tests |
| Phase 4 - `order_items` Normalization | Mostly complete | 83% | Runtime schema bootstrap now checks migrations; needs production trigger/backfill verification and parity tests |
| Phase 5 - Reporting Read Models | Started | 30% | `analytics_cache` exists, but full dashboard/daily/SKU/inventory/billing read models are not complete |
| Phase 6 - Inventory Metrics | Partial | 50% | Needs ledger source-of-truth enforcement, reconciliation, and precomputed sold/velocity/restock metrics |
| Phase 7 - Billing + Packages | Partial/good progress | 64% | Billing read surfaces now have client/store scope and billing reference-rate fetch latest-run durability; needs reconciliation, billing summary read model completion, package usage metrics, and package ledger hardening |
| Phase 8 - Shared Frontend Data Layer | Partial/good progress | 65% | Needs standardized React Query hooks and remaining broad `safe()` fallback cleanup |
| Phase 9 - Lazy Loading + UI Performance | Partial | 55% | Needs more lazy-loaded drawers/modals/charts/export tools and all-tool browser audit |
| Phase 10 - DJ/OpenClaw Security + Failure-State Hardening | Mostly complete | 95% | Unauthenticated production auth smoke checks passed and first runtime permission layer exists; dashboard/analysis/inventory/billing/print-queue/client/init/orders/manifests scoping started; needs authenticated secret checks, deeper raw-error route audit, and label/shipment-sensitive scope review |
| Phase 11 - Source-of-Truth + Duplication Audit | In progress | 94% | Reporting metrics, Walmart selling-fee index, `store_orders`, credential-account DDL, `order_items`/`analytics_cache`, low-risk orders/inventory indexes, durable job strategy, ShipStation Awaiting parity status, rate backfill status, billing reference-rate status, and print queue latest-run status moved to documented ownership; inventory truth, labels, full job events/artifacts, and shipment-adjacent DDL still remain |
| Phase 12 - Enterprise Readiness | Scoped/started | 97% | Dashboard, Analysis, Inventory, Billing, Print Queue, Orders, and Manifests read/action ownership are implemented for explicit client/store JWT claims on key surfaces; `financials:read` now protects Analysis/Dashboard SKU financials, Inventory SKU-order shipping costs, Billing routes, Orders export/list label costs, Manifests label costs, Packages unit costs, and Rate Browser rate-result DTOs; Rate Browser account source metadata requires `credentials:read`; secrets governance, audit logging, reconciliation reporting, observability/alerting, runbook/DR planning, privacy/compliance, and production signoff are mapped; needs label/shipment-sensitive scope review, broader runtime audit/reconciliation/alert implementation, DR drills, and owner signoff evidence |
| Phase 13 - JWT Session Expiration | Policy ready | 45% | 7-day session policy is documented and guarded; Supabase Auth time-box setting, staging expiry proof, and production evidence are still manual/admin verification steps |

## Phase Checklist

### Phase 1 - Runtime Architecture: 100%

- [x] Vercel frontend
- [x] Render API
- [x] Render worker
- [x] Supabase DB/auth
- [x] API/worker runtime split
- [x] Worker owns background sync
- [x] Pg-boss/job queue foundation

### Phase 2 - Observability: 70%

- [x] API timing logs
- [x] `Server-Timing`
- [x] `/sync/status`
- [x] `/worker/status`
- [x] worker heartbeat/status basics
- [x] GitHub scheduled cron noise removed
- [x] `OBSERVABILITY_ALERTING_PLAN.md`
- [x] `npm run test:observability-alerting`
- [~] external alerts
- [~] p95/p99 dashboard
- [~] slow DB query dashboard
- [ ] internal status panel

### Phase 3 - Dashboard + Analysis Cleanup: 85%

- [x] `/dashboard` route
- [x] dashboard summary/trends/top SKUs/inventory-risk endpoints
- [x] panel-level dashboard loading/errors
- [x] dashboard avoids giant raw order pulls
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

### Phase 6 - Inventory Metrics: 50%

- [x] `order_items` used in important inventory paths
- [x] lower-SKU index support started
- [x] inventory page pressure reduced
- [ ] `inventory_ledger` source-of-truth enforcement
- [ ] inventory reconciliation service
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

### Phase 8 - Shared Frontend Data Layer: 65%

- [x] request storm reduced
- [x] hidden-tab/status pressure reduced
- [x] critical fetch guard added
- [x] counts/rates/billing failure-state behavior improved
- [ ] standardize React Query hooks
- [ ] remove remaining broad `safe()` fallbacks
- [ ] visible retry/error states for every tool page

### Phase 9 - Lazy Loading + UI Performance: 55%

- [x] major route/view lazy loading
- [x] Orders side data delayed/lazy-loaded
- [x] Rate Browser cached/progressive direction started
- [ ] lazy-load more drawers/modals/charts/export tools
- [ ] split very large frontend views
- [ ] browser audit all tool pages

### Phase 10 - DJ/OpenClaw Security + Failure-State Hardening: 94%

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
- [~] live production auth smoke tests
- [ ] deeper raw-error route audit
- [ ] formal RBAC/client-scope enforcement

### Phase 11 - Source-of-Truth + Duplication Audit: 94%

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
- [~] runtime DDL migration cleanup
- [ ] inventory source-of-truth cleanup
- [~] full durable job progress/events and artifact storage
- [ ] label side-effect status reporting
- [ ] remaining legacy JWT/CORS copies cleanup
- [ ] carrier/store endpoint policy final verification

### Phase 12 - Enterprise Readiness: 97%

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
- [ ] remaining label/shipment-sensitive route scope review
- [~] secrets governance
- [~] audit logging
- [~] reconciliation reports
- [~] runtime DDL backlog/inventory
- [~] durable jobs
- [~] observability/alerts
- [~] deployment/rollback/DR runbooks
- [~] privacy/compliance checklist
- [~] production readiness signoff checklist

### Phase 13 - JWT Session Expiration: 45%

- [x] Policy chosen: 7-day maximum Supabase session lifetime
- [x] Access JWTs remain short-lived, preferably current/default 1 hour
- [x] `JWT_SESSION_EXPIRATION_PLAN.md`
- [x] `npm run test:jwt-session-policy`
- [x] Backend keeps current JWT `exp` validation through `jose`
- [x] `STRICT_JWT_CLAIMS` stays staged behind env flag
- [ ] Configure Supabase Auth time-box user sessions to 7 days
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
4. Continue Phase 11 with the next safest batch.
   - Apply and smoke-test `drizzle/0030_store_orders.sql` before marketplace order imports rely on it.
   - Apply and smoke-test `drizzle/0031_credential_accounts_rls.sql` before carrier/store credential routes rely on it.
   - Apply and smoke-test `drizzle/0024_order_items_phase2.sql` and `drizzle/0025_order_items_sync_trigger.sql` before order item analytics/backfill rely on them.
   - Confirm existing performance migrations `0021`, `0022`, `0023`, and `0026` are applied before relying on runtime maintenance cleanup.
   - Keep label/outbox/shipment-adjacent DDL deferred to a separate reviewed plan.
   - Inventory source-of-truth cleanup.
   - Review `DURABLE_JOBS_PLAN.md` with DJ/OpenClaw and approve durable job storage target.
   - Durable job state implementation for print queue/rate backfill/ref-rate jobs.
   - Label side-effect status reporting.
5. Continue Phase 12.
   - Review `RBAC_CLIENT_SCOPE_MATRIX.md` with DJ/OpenClaw.
   - Review `SECRETS_GOVERNANCE_MATRIX.md` with DJ/OpenClaw and assign credential owners.
   - Review `AUDIT_LOGGING_MATRIX.md` with DJ/OpenClaw and approve audit event names.
   - Review `RECONCILIATION_REPORTS_PLAN.md` with DJ/OpenClaw and approve report ownership.
   - Review `OBSERVABILITY_ALERTING_PLAN.md` with DJ/OpenClaw and approve alert owners/thresholds.
   - Review `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md` with DJ/OpenClaw and approve runbook owners.
   - Review `PRIVACY_COMPLIANCE_PLAN.md` with DJ/OpenClaw and approve data-class owners.
   - Review `PRODUCTION_READINESS_SIGNOFF.md` with DJ/OpenClaw and approve release gates.
   - Deploy and smoke-test the runtime RBAC, client/init scope, dashboard scope, analysis scope, inventory scope, billing scope, and print-queue list/action scope layer.
   - Implement remaining label/shipment-sensitive route query scoping in a separate reviewed batch.
   - Audit logging.
   - Reconciliation reports.
   - Observability alerts.
   - Runbooks and disaster recovery.
6. Continue Phase 13.
   - Have DJ/admin set Supabase Auth time-box user sessions to 7 days.
   - Keep access JWT expiry short; do not set access JWT lifetime to 7 days.
   - Run staging short-timebox proof before production rollout.
   - Capture production login and expired-session evidence in the signoff checklist.

## Verification Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
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
- `npm run test:secrets-governance`
- `npm run test:audit-logging`
- `npm run test:reconciliation-plan`
- `npm run test:marketplace-reconciliation`
- `npm run test:observability-alerting`
- `npm run test:operational-runbooks`
- `npm run test:privacy-compliance`
- `npm run test:production-signoff`
- `npm run test:durable-jobs-plan`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rate-system-hardening`
- `npm run test:runtime-ddl`
- `npm run test:jwt-session-policy`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`

## Assumptions

- Render worker is the primary scheduler.
- GitHub Actions should stay CI-only.
- Manual GitHub workflow buttons can remain for emergency recovery.
- Browser extension console errors are external and not counted as PrepShip bugs.
- Shipped/cancelled mutation protections remain locked unless the exact override phrase is given again.
- `DUPLICATION_OPTIMIZATION_AUDIT.md` is retained as a legacy pointer only.
- Phase 13 enforces a 7-day login session through Supabase Auth session settings, not through 7-day access JWTs.
