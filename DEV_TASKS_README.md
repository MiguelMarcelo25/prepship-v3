# PrepShip DJ/OpenClaw Dev Task Packet

## Current State

- Branch: `prepshipv4-stable`
- Latest pushed commit before Phase 11 Batch 3: `0e6294fe`
- Worktree at last update: clean
- Latest completed fix before this batch: GitHub scheduled production crons disabled and DJ/OpenClaw phase tracker updated
- GitHub Actions:
  - `Keep Render API warm`: manual only now
  - `Sync ShipStation orders + shipments`: manual only now
  - `CI`: still runs on push/PR
- Render worker remains the primary background scheduler.

## Four DJ/OpenClaw Docs

| Document | Status | Percent | Why Not 100% |
|---|---|---:|---|
| `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md` | Created / active | 78% | Reporting metrics and Walmart selling-fee index DDL moved to migration ownership; inventory truth, durable jobs, label side effects, and remaining compatibility DDL cleanup still open |
| `ENTERPRISE_READINESS_AUDIT.md` | Created / active | 46% | Two runtime DDL classes are migration-owned now; needs RBAC, audit logs, reconciliation, alerts, DR, runbooks, and authenticated production verification |
| `SECURITY_PATCH_PLAN.md` | Created / mostly implemented | 85% | Needs live auth smoke tests, strict JWT production rollout, `/users` final role policy |
| `RATE_SYSTEM_HARDENING_PLAN.md` | Created / mostly implemented | 72% | Needs browser production verification, duplicate-name UX polish, metrics, durable backfill status |

## Phase Summary

| Phase | Status | Percent | Why Not 100% Yet |
|---|---|---:|---|
| Phase 1 - Runtime Architecture | Complete | 100% | Done |
| Phase 2 - Observability | Good start | 65% | Needs external alerts, p95/p99 dashboards, slow-query dashboard, and status panel |
| Phase 3 - Dashboard + Analysis Cleanup | Mostly complete | 85% | Needs production parity checks, remaining Analysis JSONB audit, and regression tests |
| Phase 4 - `order_items` Normalization | Mostly complete | 80% | Needs production trigger/backfill verification and parity tests |
| Phase 5 - Reporting Read Models | Started | 30% | `analytics_cache` exists, but full dashboard/daily/SKU/inventory/billing read models are not complete |
| Phase 6 - Inventory Metrics | Partial | 50% | Needs ledger source-of-truth enforcement, reconciliation, and precomputed sold/velocity/restock metrics |
| Phase 7 - Billing + Packages | Partial/good progress | 60% | Needs billing reconciliation, billing summary read model, package usage metrics, and package ledger hardening |
| Phase 8 - Shared Frontend Data Layer | Partial/good progress | 65% | Needs standardized React Query hooks and remaining broad `safe()` fallback cleanup |
| Phase 9 - Lazy Loading + UI Performance | Partial | 55% | Needs more lazy-loaded drawers/modals/charts/export tools and all-tool browser audit |
| Phase 10 - DJ/OpenClaw Security + Failure-State Hardening | Mostly complete | 85% | Unauthenticated production auth smoke checks passed; needs authenticated secret checks, deeper raw-error route audit, and formal RBAC/client scoping |
| Phase 11 - Source-of-Truth + Duplication Audit | In progress | 78% | Reporting metrics and Walmart selling-fee index DDL moved to migration ownership; inventory/jobs/labels and remaining compatibility DDL still remain |
| Phase 12 - Enterprise Readiness | Scoped/started | 46% | Runtime DDL backlog is clearer and two low-risk classes are migration-owned; needs RBAC, secrets governance, audit logs, reconciliation, alerts, DR, and runbooks |

## Phase Checklist

### Phase 1 - Runtime Architecture: 100%

- [x] Vercel frontend
- [x] Render API
- [x] Render worker
- [x] Supabase DB/auth
- [x] API/worker runtime split
- [x] Worker owns background sync
- [x] Pg-boss/job queue foundation

### Phase 2 - Observability: 65%

- [x] API timing logs
- [x] `Server-Timing`
- [x] `/sync/status`
- [x] `/worker/status`
- [x] worker heartbeat/status basics
- [x] GitHub scheduled cron noise removed
- [ ] external alerts
- [ ] p95/p99 dashboard
- [ ] slow DB query dashboard
- [ ] internal status panel

### Phase 3 - Dashboard + Analysis Cleanup: 85%

- [x] `/dashboard` route
- [x] dashboard summary/trends/top SKUs/inventory-risk endpoints
- [x] panel-level dashboard loading/errors
- [x] dashboard avoids giant raw order pulls
- [ ] production parity checks
- [ ] remaining Analysis JSONB cleanup
- [ ] dashboard/analysis regression tests

### Phase 4 - `order_items` Normalization: 80%

- [x] `order_items` table
- [x] indexes
- [x] trigger/backfill/repair logic
- [x] dashboard/analysis/inventory hot paths partially moved
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

### Phase 7 - Billing + Packages: 60%

- [x] generated billing line items exist
- [x] billing summary first-load failure no longer fakes `$0.00`
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

### Phase 10 - DJ/OpenClaw Security + Failure-State Hardening: 85%

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
- [~] live production auth smoke tests
- [ ] deeper raw-error route audit
- [ ] formal RBAC/client-scope enforcement

### Phase 11 - Source-of-Truth + Duplication Audit: 78%

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
- [~] runtime DDL migration cleanup
- [ ] inventory source-of-truth cleanup
- [ ] durable job state for print queue/rate backfill
- [ ] label side-effect status reporting
- [ ] remaining legacy JWT/CORS copies cleanup
- [ ] carrier/store endpoint policy final verification

### Phase 12 - Enterprise Readiness: 46%

- [x] `ENTERPRISE_READINESS_AUDIT.md`
- [x] critical/high/medium issue buckets scoped
- [ ] RBAC/client-scope route matrix
- [ ] secrets governance
- [ ] audit logging
- [ ] reconciliation reports
- [~] runtime DDL backlog/inventory
- [ ] durable jobs
- [ ] observability/alerts
- [ ] deployment/rollback/DR runbooks
- [ ] privacy/compliance checklist
- [ ] production readiness signoff checklist

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
   - Add/verify `store_orders` Drizzle migration or confirm existing production schema ownership.
   - Keep label/outbox/shipment-adjacent DDL deferred to a separate reviewed plan.
   - Inventory source-of-truth cleanup.
   - Durable job state for print queue/rate backfill.
   - Label side-effect status reporting.
5. Continue Phase 12.
   - RBAC/client-scope route matrix.
   - Audit logging.
   - Reconciliation reports.
   - Observability alerts.
   - Runbooks and disaster recovery.

## Verification Commands

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:rate-system-hardening`
- `npm run test:runtime-ddl`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`

## Assumptions

- Render worker is the primary scheduler.
- GitHub Actions should stay CI-only.
- Manual GitHub workflow buttons can remain for emergency recovery.
- Browser extension console errors are external and not counted as PrepShip bugs.
- Shipped/cancelled mutation protections remain locked unless the exact override phrase is given again.
- `DUPLICATION_OPTIMIZATION_AUDIT.md` is retained as a legacy pointer only.
