# PrepShip DJ/OpenClaw Dev Task Packet

## Purpose

This README is the boss-facing index for the PrepShip v4 production-hardening work. It connects the phase tracker with the four DJ/OpenClaw deliverables and shows what is complete, partial, and still open.

Current repo state:

- Branch: `prepshipv4-stable`
- Last confirmed pushed commit when this packet was prepared: `ea586c6c`
- Scope of this packet: documentation and planning only
- Runtime code changes in this batch: none

## Four Required Deliverables

- [x] `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
  - Canonical source-of-truth and duplication map.
  - Replaces `DUPLICATION_OPTIMIZATION_AUDIT.md` as the boss-facing document.

- [x] `ENTERPRISE_READINESS_AUDIT.md`
  - Enterprise readiness audit for RBAC, credentials, migrations, jobs, observability, audit logs, reconciliation, testing, deployment, privacy, and disaster recovery.

- [x] `SECURITY_PATCH_PLAN.md`
  - Immediate security patch plan for auth coverage, admin enforcement, secret redaction, safe errors, strict JWT claims, unsafe routes, and production auth smoke tests.

- [x] `RATE_SYSTEM_HARDENING_PLAN.md`
  - Rate system plan for carrier diagnostics, concurrency, negative caching, cache-key correctness, duplicate carrier names, and Rate Browser behavior.

## Phase Status

### Phase 1 - Runtime Architecture

- [x] Vercel frontend
- [x] Render API
- [x] Render worker
- [x] Supabase DB/auth
- [x] API/worker runtime split
- [x] Worker owns background sync
- [x] Pg-boss/job queue foundation

### Phase 2 - Observability

- [x] API timing logs
- [x] `Server-Timing`
- [x] `/sync/status`
- [x] `/worker/status`
- [x] worker heartbeat/status basics
- [ ] external alerts
- [ ] p95/p99 dashboard
- [ ] slow DB query dashboard
- [ ] status panel

### Phase 3 - Dashboard + Analysis Cleanup

- [x] `/dashboard` route
- [x] dashboard summary/trends/top SKUs/inventory-risk endpoints
- [x] panel-level dashboard loading/errors
- [x] dashboard avoids giant raw order pulls
- [ ] production parity checks
- [ ] remaining Analysis JSONB cleanup
- [ ] dashboard/analysis regression tests

### Phase 4 - `order_items` Normalization

- [x] `order_items` table
- [x] indexes
- [x] trigger/backfill/repair logic
- [x] dashboard/analysis/inventory hot paths partially moved
- [ ] production trigger verification
- [ ] production backfill verification
- [ ] parity tests
- [ ] remaining JSONB analytics audit

### Phase 5 - Reporting Read Models

- [x] `analytics_cache`
- [x] reporting/read-model direction started
- [ ] dashboard summary metrics
- [ ] daily sales metrics
- [ ] SKU velocity metrics
- [ ] inventory risk metrics
- [ ] billing summary metrics

### Phase 6 - Inventory Metrics

- [x] `order_items` used in important inventory paths
- [x] lower-SKU index support started
- [x] inventory page pressure reduced
- [ ] `inventory_ledger` source-of-truth enforcement
- [ ] inventory reconciliation service
- [ ] precomputed sold/velocity/days-supply/restock metrics

### Phase 7 - Billing + Packages

- [x] generated billing line items exist
- [x] billing summary first-load failure no longer fakes `$0.00`
- [x] `/packages` lightweight/paginated support
- [ ] billing reconciliation report
- [ ] billing summary read model
- [ ] package usage metrics
- [ ] package ledger/reporting hardening

### Phase 8 - Shared Frontend Data Layer

- [x] request storm reduced
- [x] hidden-tab/status pressure reduced
- [x] critical fetch guard added
- [x] counts/rates/billing failure-state behavior improved
- [ ] standardize React Query hooks
- [ ] remove remaining broad `safe()` fallbacks
- [ ] visible retry/error states for every tool page

### Phase 9 - Lazy Loading + UI Performance

- [x] major route/view lazy loading
- [x] Orders side data delayed/lazy-loaded
- [x] Rate Browser cached/progressive direction started
- [ ] lazy-load more drawers/modals/charts/export tools
- [ ] split very large frontend views
- [ ] browser audit all tool pages

### Phase 10 - DJ/OpenClaw Security + Failure-State Hardening

- [x] `/users` gated
- [x] protected root + wildcard route gates
- [x] `/admin` requires admin
- [x] optional strict JWT claims
- [x] client ShipStation secret redaction
- [x] `/aws-api` removed
- [x] mock label URLs signed/expiring
- [x] safer credential-handler 500s
- [x] auth/client/credential/frontend/orders guard tests
- [ ] live production auth smoke tests
- [ ] deeper raw-error route audit
- [ ] formal RBAC/client-scope enforcement

### Phase 11 - Source-of-Truth + Duplication Audit

- [x] source-of-truth audit content
- [x] shared JWT verifier
- [x] shared CORS helper
- [x] shared credential-account helper/service
- [x] auth coverage guard
- [x] frontend failure-state guard
- [x] exact `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
- [ ] finish carrier/store PATCH rename/approval consolidation
- [ ] move runtime DDL into migrations
- [ ] centralize rate cache key/diagnostics further
- [ ] inventory source-of-truth cleanup
- [ ] durable job state for print queue/rate backfill
- [ ] label side-effect status reporting

### Phase 12 - Enterprise Readiness

- [x] `ENTERPRISE_READINESS_AUDIT.md`
- [x] critical/high/medium issue buckets scoped
- [ ] RBAC/client-scope route matrix
- [ ] secrets governance
- [ ] audit logging
- [ ] reconciliation reports
- [ ] durable jobs
- [ ] observability/alerts
- [ ] deployment/rollback/DR runbooks

## Implementation Priority

1. Production auth smoke tests for `/users`, `/clients`, and `/admin/*`.
2. Security patch follow-through for strict JWT rollout, safe errors, and credential governance.
3. Source-of-truth consolidation for carrier/store account route ownership.
4. Rate cache key, diagnostics, concurrency, and no-rate behavior hardening.
5. Frontend failure-state cleanup for remaining broad `safe()` fallback paths.
6. Runtime DDL to Drizzle migration backlog.
7. Durable job state for print queue, rate backfill, sync, and reporting.
8. Inventory and billing reconciliation reports.
9. Observability, alerts, runbooks, rollback, and disaster recovery.

## Required Verification Before Deploy

- [ ] `npm run typecheck`
- [ ] `npm run build:web`
- [ ] `npm run test:auth-coverage`
- [ ] `npm run test:client-redaction`
- [ ] `npm run test:credential-accounts`
- [ ] `npm run test:frontend-failure-states`
- [ ] `npm run test:orders-ux`
- [ ] Browser audit: Orders, Dashboard, Inventory, Clients, Packages, Rate Shop, Analysis, Settings, Billing, Manifests
- [ ] Render logs show no repeated 30s timeouts or request storms
- [ ] Supabase CPU, memory, and connection count remain controlled

## Notes

- `DUPLICATION_OPTIMIZATION_AUDIT.md` is retained as a legacy pointer only.
- Completed items stay marked `[x]`.
- Partially scoped items use `[~]`.
- Open work stays `[ ]` until implemented, tested, and production-verified.
