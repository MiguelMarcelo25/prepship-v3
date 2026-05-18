# PrepShip Enterprise Production Readiness Audit

## Executive Summary

PrepShip v4 now has strong production foundations: Vercel frontend, Render API, Render worker, Supabase, protected app routes, client secret redaction, Rate Browser diagnostics, request-pressure reductions, and worker separation. The remaining enterprise gap is not one feature. It is operational maturity: formal RBAC, durable jobs, audit logs, schema governance, reconciliation, monitoring, runbooks, and failure-mode tests.

This audit defines what must be checked and fixed before PrepShip can be considered enterprise-ready.

## Phase 12 Progress Update

Status: first audit-to-implementation batch started.

Implemented:

- Shared Supabase JWT verification with optional strict issuer/audience enforcement.
- Shared CORS origin/header policy for Render and active Vercel compatibility handlers.
- Active carrier/store/direct-carrier/address-validation/Walmart-probe compatibility handlers now use the shared verifier and no longer expose token verification reasons to the browser.
- Client redaction guard added as `npm run test:client-redaction` to block `/clients` and `/init/init-data` regressions that return raw ShipStation credential fields.
- Frontend client consumers now rely on `hasShipStationV1Credentials` / `hasShipStationV2Credentials` booleans instead of raw secret response fields.
- Carrier/store compatibility handlers now share credential-account request parsing, provider/source validation, credential-key extraction, and masked account identifier logging.
- Credential-account parsing drift is now guarded by `npm run test:credential-accounts`.
- Carrier/store compatibility handlers now share credential-account database operations for list, upsert, delete, carrier client assignment, and synthetic store-client maintenance.
- Carrier/store credential handlers now return production-safe generic 500 responses while keeping full details in server logs.
- Critical frontend fetch guard added as `npm run test:frontend-failure-states`; `fetchRates` now surfaces request failures to existing caller error states instead of converting failures to empty rate arrays.

Confirmed gaps from repo search:

- RBAC/client-scope rules are still not fully formalized beyond `requireAuth` and `requireAdmin`.
- Runtime DDL remains in production-capable paths and must be converted into a migration backlog.
- Durable job state is mixed: scheduler protection has improved, but print queue/rate backfill and some compatibility paths still need restart-safe progress guarantees.
- Broad frontend `safe()` fallback usage remains and needs a failure-mode sweep.
- Audit logging and reconciliation are planning items; they are not complete yet.
- Label and marketplace order/fee compatibility handlers still need auth/CORS consolidation, but should be handled in a separately scoped review because they touch `orders`/`shipments` write paths.

Current readiness read:

| Track | Status | Percent |
|---|---|---:|
| Phase 11 duplication/source-of-truth | Auth/CORS, credential-account service, and first frontend failure-state guard implemented | 50% |
| Phase 12 enterprise readiness | Critical gaps confirmed, first security/credential/frontend guard work implemented | 38% |

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| RBAC and client scoping are not fully formalized | Users may access actions or data beyond their role/client scope | Route matrix with role and client-scope enforcement | API tests for admin, operator, warehouse, client user, support/read-only |
| Credential governance is incomplete | Carrier/store/ShipStation secrets can be mishandled, logged, or hard to rotate | Redaction, protected storage, rotation, audit log, last-used tracking | Secret scan, API response tests, credential update audit test |
| Runtime DDL still exists in production paths | Request latency, schema drift, unpredictable deploys | Schema managed by Drizzle migrations | `rg "CREATE TABLE IF NOT EXISTS" src api` review and migration backlog |
| User-visible jobs are not all durable | Restart/multi-instance can lose or duplicate work | DB-backed job state, idempotency, locks, failure state | Restart and dual-worker tests |
| Audit logging is not comprehensive | Cannot prove who changed business-critical data | Append-only audit events for credentials, labels, orders, inventory, billing, settings | Audit table/API/event tests |
| Reconciliation reports are missing | Inventory, billing, label, and fulfillment truth can diverge silently | Scheduled reconciliation reports with repair process | Reconciliation queries and mismatch test data |

## High-Risk Issues

| Area | Current Concern | Enterprise Requirement | Recommended Fix |
|---|---|---|---|
| Access control | `requireAuth` is not enough for all enterprise roles | RBAC/ABAC with client scope and field-level restrictions | Add permission middleware and route matrix |
| Secrets | Multiple credential types exist across clients, carrier accounts, store accounts, direct carriers | Backend-only access, no browser exposure, rotation/audit | Central credential service and audit events |
| External APIs | ShipStation/direct carrier failures affect rates, labels, sync, billing | Per-provider/account resilience and diagnostics | Timeout/retry/circuit metrics per account |
| Jobs | Sync, print queue, rate backfill, fulfillment outbox have different state models | Durable status, retries, dead-letter, cancellation, locks | Shared job runner or pg-boss-only pattern |
| Inventory truth | Ledger, cached stock, effective stock, sold metrics can disagree | Ledger canonical, cache reconciled, metrics precomputed | Inventory reconciliation and reporting metrics |
| Billing truth | Generated line items can exist but summaries may not reflect expected values without explicit generation/backfill | Billing reads generated outputs with clear stale/empty states | Billing generation status and reconciliation |
| Label side effects | Label creation touches shipments, package/inventory deductions, print queue, fulfillment outbox | Side-effect status and recovery workflow | Return and persist side-effect warnings |
| Frontend reliability | Some screens still need full failure-state audit | Visible error, retry, stale-data preservation | Page-by-page failure-mode tests |

## Medium-Risk Issues

| Area | Concern | Recommendation |
|---|---|---|
| CORS and Vercel/Render rewrites | Compatibility paths may drift | Move to shared CORS and thin Vercel adapters |
| Large/unpaginated reads | Current scale may pass, future scale may lag | Add lightweight DTOs and pagination by default |
| Logging | Logs exist but may not be centralized or alertable | Structured logs with request ID and external API tags |
| Frontend bundle/performance | Large views still exist | Continue lazy-loading drawers, modals, charts, export tools |
| Deployment rollback | Manual deploys work, but rollback path needs a runbook | Version compatibility and smoke checklist |
| Compliance/privacy | PII and label PDFs need formal retention/access policy | PII inventory and privacy runbook |

## Enterprise Checklist

### RBAC / Access Control

- [ ] Define roles: admin, operator, warehouse, client user, read-only/support.
- [ ] Create route permission matrix.
- [ ] Add client-scoped access rules for orders, inventory, labels, print queue, billing.
- [ ] Add field-level protection for credentials, costs, margins, billing data.
- [ ] Verify frontend hides restricted actions.
- [ ] Verify backend rejects bypassed restricted actions.
- [ ] Test non-admin access to admin/settings/users endpoints.
- [ ] Test client user access to another client's data.

Deliverable table:

| Route | Required Role | Client Scope Rule | Current Enforcement | Gap | Fix | Test |
|---|---|---|---|---|---|---|
| `/admin`, `/admin/*` | admin | global admin only | `requireAuth` + `requireAdmin` | needs API smoke test with non-admin token | keep middleware, add auth/RBAC tests | non-admin returns `403` |
| `/users`, `/users/*` | admin or support, pending policy | user-management scope | `requireAuth` only | role policy not formalized | add permission middleware once roles are defined | operator/client token denied when policy lands |
| `/orders`, `/orders/*` | admin/operator/warehouse/client user | client/store scoped rows | `requireAuth`; shipped/cancelled mutation guards exist | no formal client-scope middleware | add route-level scope policy and query filters | client user cannot read another client's orders |
| `/inventory`, `/inventory/*` | admin/operator/warehouse/client user | client scoped SKUs | `requireAuth` | no formal client-scope middleware | add scope policy and filtered inventory queries | client user cannot read another client's inventory |
| `/billing`, `/billing/*` | admin/operator/accounting | client scoped billing | `requireAuth` | billing role and field-level margin/cost visibility not formalized | add billing permission and field DTOs | warehouse/client user denied from cost/margin |
| `/carrier-accounts`, `/store-accounts`, `/settings/*` | admin/operator with credential permission | account/client assignment scope | mixed Render/Vercel auth; first shared verifier batch applied | no field-level credential RBAC/audit log | central credential service + audit events | non-credential role cannot read/write credential endpoints |

### Secrets / Credential Management

- [ ] Verify ShipStation keys never return to frontend.
- [ ] Verify carrier/store credentials are protected at rest.
- [ ] Verify Supabase service role is backend-only.
- [ ] Verify direct carrier OAuth tokens never expose to frontend/logs.
- [ ] Add credential change audit events.
- [ ] Add credential rotation process.
- [ ] Add last-used timestamp tracking.
- [ ] Move credential-table DDL to migrations.
- [ ] Scan logs for token/secret output.

Deliverable table:

| Credential Type | Storage Location | Who Can Read | Who Can Write | Frontend Exposure Risk | Rotation Gap | Fix |
|---|---|---|---|---|---|---|

### Database Migrations / Schema Governance

- [~] List all runtime DDL in `src` and `api`.
- [ ] Convert production runtime DDL to Drizzle migrations.
- [ ] Review foreign keys and cascade rules.
- [ ] Review unique constraints for natural keys.
- [ ] Review indexes for common filters/search/sorts.
- [ ] Confirm nullable fields are intentional.
- [ ] Document rollback for each new migration.
- [ ] Test migrations against staging/test database.

Deliverable table:

| Table | Missing Constraint/Index/FK | Runtime DDL Risk | Migration Needed | Rollback Consideration |
|---|---|---|---|---|
| `carrier_accounts` | table/index bootstrap still exists in Vercel/imported compatibility handlers | request-time DDL and route drift | carrier account tables/indexes migration | safe rollback keeps existing table; remove runtime bootstrap after deploy |
| `carrier_account_clients` | junction table/index bootstrap still exists in compatibility handlers | request-time DDL and assignment drift | junction table/index migration | preserve existing assignments before removing bootstrap |
| `store_accounts` | table/index bootstrap and one-time migration still exist in Vercel handler | request latency and migration side effects during API call | store accounts migration plus separate data migration | rollback must not re-copy deleted carrier marketplace rows |
| `store_orders` | marketplace handlers create table/indexes at runtime | first fetch can alter schema under user traffic | store orders migration | keep compatibility read path until migration verified |
| `fulfillment_outbox` | service and label compatibility path ensure table/indexes at runtime | label/outbox request may pay DDL cost | fulfillment outbox migration | rollback keeps table; worker can ignore unused columns |
| `order_items`, `analytics_cache` | maintenance service still creates if missing | safer than request-time but still schema drift | ensure existing migrations fully own schema | rollback should not drop analytics cache during deploy |

### Observability / Monitoring

- [ ] Include request IDs in backend logs.
- [ ] Use structured error logs for API failures.
- [ ] Capture frontend errors.
- [ ] Count external API failures by provider/account.
- [ ] Track ShipStation rate and label failures.
- [ ] Track slow DB queries.
- [ ] Track background job failures.
- [ ] Alert on API 5xx spikes.
- [ ] Alert on label/rate failure spikes.
- [ ] Alert on sync failures.

Deliverable table:

| Signal | Current Visibility | Missing Metric/Log | Alert Needed | Owner |
|---|---|---|---|---|

### Audit Logging

- [ ] User login/logout/admin role changes.
- [ ] Client create/update/delete.
- [ ] Credential create/update/delete.
- [ ] Carrier/store account changes.
- [ ] Label create/void/return.
- [ ] Order manual edits.
- [ ] Shipped/cancelled force overrides.
- [ ] Inventory receive/adjust.
- [ ] Package receive/adjust/delete.
- [ ] Settings changes.
- [ ] Billing changes.
- [ ] Sync/backfill started/stopped.

Deliverable table:

| Action | Audited? | Actor Captured? | Before/After Captured? | Fix |
|---|---|---|---|---|

### Background Jobs / Distributed Safety

- [ ] Rate backfill survives server restart.
- [ ] Print queue jobs survive server restart.
- [ ] Sync scheduler is safe with multiple instances.
- [ ] Jobs have idempotency keys.
- [ ] Jobs have retry limits.
- [ ] Jobs have dead-letter or failure state.
- [ ] Jobs have cancellation or timeout.
- [ ] Job progress is persisted.
- [ ] Advisory lock or lease strategy exists.
- [ ] Duplicate job execution is prevented.

Deliverable table:

| Job | Current State Storage | Restart Behavior | Multi-Instance Risk | Idempotency Risk | Fix |
|---|---|---|---|---|---|

### External API Resilience

- [ ] ShipStation calls have timeouts.
- [ ] Direct carrier calls have timeouts.
- [ ] Retries use exponential backoff.
- [ ] Circuit breakers are per provider/account where practical.
- [ ] Rate-limit responses are handled visibly.
- [ ] Partial carrier failures are surfaced.
- [ ] Webhook signatures are verified where applicable.
- [ ] Raw external errors are redacted before frontend/logs.
- [ ] Sandbox/test mode exists.
- [ ] External outage runbooks exist.

Deliverable table:

| Provider/API | Timeout | Retry | Circuit Breaker | Rate Limit Handling | Frontend Diagnostic | Gap |
|---|---|---|---|---|---|---|

### Data Reconciliation

- [ ] Local orders vs ShipStation orders.
- [ ] Local shipments vs ShipStation shipments.
- [ ] Labels vs billing records.
- [ ] Inventory ledger vs displayed stock.
- [ ] Package ledger vs package stock.
- [ ] Rate cache vs actual label cost.
- [ ] Fulfillment outbox vs sent confirmations.
- [ ] Clients/stores vs ShipStation stores.
- [ ] Carrier accounts vs active credential records.

Deliverable table:

| Reconciliation | Canonical Source | Local Source | Mismatch Detection | Repair Process | Owner |
|---|---|---|---|---|---|

### Frontend Reliability

- [ ] API failures do not show fake empty states.
- [ ] Empty and error states are visually distinct.
- [ ] Retry buttons exist for critical workflows.
- [ ] Stale data warnings exist.
- [ ] Long-running actions show persistent progress.
- [ ] Mutations have disabled/loading state.
- [ ] Double-submit is prevented.
- [ ] Optimistic updates roll back on failure.
- [ ] Role-restricted actions are hidden.
- [ ] Mobile/tablet warehouse flows are usable.
- [ ] Chunk-load/deploy recovery still works.

Critical screens:

- [ ] Orders
- [ ] Rate Browser
- [ ] Label creation
- [ ] Inventory
- [ ] Packages
- [ ] Clients
- [ ] Settings/carrier integrations
- [ ] Print queue
- [ ] Billing
- [ ] Dashboard/Analysis

### Testing Strategy

- [ ] Unit tests for services.
- [ ] API integration tests.
- [ ] DB tests against test Postgres.
- [ ] Playwright critical path tests.
- [ ] Auth/RBAC tests.
- [ ] Mocked ShipStation tests.
- [ ] Direct carrier tests.
- [ ] Migration tests.
- [ ] Load tests for orders/rates/inventory.
- [ ] Chaos tests for external API failures.
- [ ] Regression tests for shipped/cancelled immutability.

Critical workflows:

- [ ] Order sync.
- [ ] Rate shopping.
- [ ] Label creation.
- [ ] Void label.
- [ ] Return label.
- [ ] Print queue.
- [ ] Inventory receive/adjust.
- [ ] Package receive/adjust.
- [ ] Client setup.
- [ ] Carrier account setup.
- [ ] Billing/export.
- [ ] User/admin access.

### Performance / Scale

- [ ] Unpaginated endpoints.
- [ ] N+1 frontend API calls.
- [ ] Slow DB queries.
- [ ] Missing indexes.
- [ ] Large export behavior.
- [ ] Dashboard aggregation performance.
- [ ] Order list performance at high volume.
- [ ] Inventory performance at 10k+ SKUs.
- [ ] Rate Browser carrier fanout behavior.
- [ ] Label batch concurrency.
- [ ] Cache invalidation strategy.

Deliverable table:

| Endpoint/Workflow | Current Bottleneck | Expected Scale | Observed Query/API Pattern | Optimization |
|---|---|---|---|---|

### Deployment / Rollback

- [ ] Staging environment matches production.
- [ ] Migrations are tested before deploy.
- [ ] Rollback process is documented.
- [ ] Feature flags exist for risky features.
- [ ] Post-deploy smoke tests exist.
- [ ] Backend/frontend version compatibility is considered.
- [ ] Render/Vercel rewrite behavior is verified.
- [ ] Health/readiness checks are correct.
- [ ] Env var validation is strict.
- [ ] Emergency rollback owner is assigned.

Deliverable table:

| Deploy Step | Failure Mode | Rollback Step | Owner | Verification |
|---|---|---|---|---|

### Compliance / Privacy

- [ ] PII inventory exists.
- [ ] Customer addresses are protected.
- [ ] Label PDFs are protected.
- [ ] Email/user metadata access is restricted.
- [ ] Data retention policy exists.
- [ ] Access logs are protected.
- [ ] Vendor access is documented.
- [ ] Least-privilege access is enforced.
- [ ] Breach response runbook exists.

### Disaster Recovery

- [ ] Automated DB backups.
- [ ] Point-in-time recovery.
- [ ] Restore test completed.
- [ ] Env var backup process.
- [ ] Object/file storage recovery.
- [ ] Supabase outage runbook.
- [ ] Render outage runbook.
- [ ] Vercel outage runbook.
- [ ] ShipStation outage runbook.
- [ ] Recovery time objective defined.
- [ ] Recovery point objective defined.

## Optimization Opportunities

1. Consolidate Vercel and Render account handlers behind shared services.
2. Move all auth/CORS helpers to shared libraries.
3. Replace remaining critical silent API fallbacks with visible error states.
4. Build durable job state for print queue, rate backfill, sync, and reporting.
5. Add inventory and billing reconciliation reports.
6. Add centralized observability and alerting.
7. Convert remaining runtime DDL to migrations.
8. Continue moving dashboard, inventory, analysis, and billing to read models.

## Required Tests Before Production

- `npm run typecheck`
- `npm run build:web`
- `npm run test:orders-ux`
- Unauthenticated `/users` and `/clients` return `401`.
- Non-admin `/admin/*` returns `403`.
- `/clients` and `/init/init-data` never return ShipStation secrets.
- `npm run test:client-redaction` passes.
- `npm run test:credential-accounts` passes.
- One carrier rate failure shows carrier-level diagnostic.
- Orders, Inventory, Billing, Dashboard, Rate Browser do not show fake empty states on API failure.
- Print queue and sync job status survive restart where user-visible.
- Render logs show no repeated 30s timeouts or request storms.
- Supabase CPU, memory, and connection count stay controlled after deploy.

## Runbooks Needed

- Rates not loading.
- Label creation failing.
- ShipStation outage.
- Direct carrier outage.
- Sync stuck.
- Inventory mismatch.
- Billing totals missing or zero after generation.
- Print queue stuck.
- Frontend white screen.
- User locked out.
- Credential rotation.
- Database restore.
- Rollback deploy.
- Suspicious access/security event.

## Recommended Implementation Order

1. RBAC/client-scope audit and route matrix.
2. Secrets and credential audit, including audit events.
3. Migration/runtime DDL cleanup plan.
4. Durable job status and idempotency plan.
5. External API resilience metrics and diagnostics.
6. Data reconciliation reports.
7. Frontend failure-mode Playwright tests.
8. Observability and alerting integration.
9. Deployment, rollback, and disaster recovery runbooks.
