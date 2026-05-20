# PrepShip Enterprise Production Readiness Audit

## Executive Summary

PrepShip v4 now has strong production foundations: Vercel frontend, Render API, Render worker, Supabase, protected app routes, client secret redaction, Rate Browser diagnostics, request-pressure reductions, and worker separation. The remaining enterprise gap is not one feature. It is operational maturity: formal RBAC, durable jobs, audit logs, schema governance, reconciliation, monitoring, runbooks, and failure-mode tests.

This audit defines what must be checked and fixed before PrepShip can be considered enterprise-ready.

Companion DJ/OpenClaw documents:

- `DEV_TASKS_README.md`
- `RBAC_CLIENT_SCOPE_MATRIX.md`
- `SECRETS_GOVERNANCE_MATRIX.md`
- `AUDIT_LOGGING_MATRIX.md`
- `RECONCILIATION_REPORTS_PLAN.md`
- `OBSERVABILITY_ALERTING_PLAN.md`
- `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`
- `PRIVACY_COMPLIANCE_PLAN.md`
- `PRODUCTION_READINESS_SIGNOFF.md`
- `DURABLE_JOBS_PLAN.md`
- `JWT_SESSION_EXPIRATION_PLAN.md`
- `LABEL_SHIPMENT_SCOPE_REVIEW.md`
- `SOURCE_OF_TRUTH_AND_DUPLICATION_AUDIT.md`
- `SECURITY_PATCH_PLAN.md`
- `RATE_SYSTEM_HARDENING_PLAN.md`

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
- `fetchBillingSummary` now preserves stale cached billing rows but rethrows first-load failures, preventing API errors from appearing as generated zero-dollar billing summaries.
- Auth coverage guard added as `npm run test:auth-coverage`; it locks in `/users`, `/worker`, protected root and wildcard route auth, and `/admin` admin enforcement.
- Phase 12 RBAC/client-scope planning matrix added as `RBAC_CLIENT_SCOPE_MATRIX.md`, including canonical roles, route-group policy, scope expectations, current enforcement, gaps, required fixes, and tests.
- First runtime RBAC permission layer added: canonical role/permission constants, JWT `app_metadata.permissions` support, `requirePermission`, method-aware credential-account permission middleware, `/users` root user-management gate, settings read/write gates, carrier-account read/write gates, and carrier verification credential-write gate.
- RBAC permission guard added as `npm run test:rbac-permissions`.
- First client/store scope foundation added: JWT `clientIds` / `storeIds` claim parsing, reusable client/store scope helper, `/clients` list/detail filtering for scoped users, `/init/init-data` client filtering, `/init/stores` store filtering, and `npm run test:client-store-scope`.
- Dashboard aggregate scope layer added: `/dashboard/summary`, `/dashboard/daily-counts`, `/dashboard/sku-trends`, `/dashboard/top-skus`, and `/dashboard/inventory-risk` apply explicit client/store JWT scope, dashboard cache keys include that scope, and `npm run test:dashboard-client-scope` guards the behavior.
- Analysis read scope layer added: `/analysis/overview`, `/analysis/daily-shipments`, `/analysis/top-skus`, `/analysis/sku-daily`, `/analysis/sku-breakdown`, `/analysis/skus`, and `/analysis/daily-sales` apply explicit client/store JWT scope, and `npm run test:analysis-client-scope` guards the behavior.
- Inventory read scope layer added: `/inventory`, `/inventory/ledger`, `/inventory/stats`, `/inventory/alerts`, `/inventory/:id`, `/inventory/:id/ledger`, `/inventory/:id/parents`, and `/inventory/:id/sku-orders` apply explicit client/store JWT scope, and `npm run test:inventory-client-scope` guards the behavior.
- Billing read scope layer added: `/billing/config`, `/billing/summary`, `/billing/details`, `/billing/invoice`, and `/billing/package-prices` apply explicit client/store JWT scope, including billing read-model filtering, and `npm run test:billing-client-scope` guards the behavior.
- Print Queue list scope layer added: `GET /print-queue` applies explicit client/store JWT scope for queued entry reads, and `npm run test:print-queue-client-scope` guards the behavior.
- Print Queue ownership layer added: add, clear, delete, print-job creation/status/download, and batch-send startup/status validate explicit client/store JWT scope, and `npm run test:print-queue-ownership` guards the behavior.
- Orders read scope layer added: list, daily-counts, dashboard-sales compatibility, SKU id lookup, store-counts, daily-stats, picklist, distinct SKUs, by-number, detail, full detail, and export apply explicit client/store JWT scope, and `npm run test:orders-manifests-scope` guards the behavior.
- Manifest generate scope layer added: GET/POST manifest generation applies explicit client/store JWT scope to shipment rows, and `npm run test:orders-manifests-scope` guards the behavior.
- Extended field-level financial guard added: Orders export/list label costs, Manifests label costs, Packages unit costs, and Rate Browser rate-result DTOs redact without `financials:read`; Rate Browser account source metadata requires `credentials:read`; `npm run test:field-level-rbac-extended` guards the behavior.
- Secrets governance matrix added as `SECRETS_GOVERNANCE_MATRIX.md`, covering Supabase, ShipStation, carrier/store, marketplace OAuth, direct carrier, and label URL credential/artifact classes. `npm run test:secrets-governance` guards the deliverable.
- Audit logging matrix added as `AUDIT_LOGGING_MATRIX.md`, covering credentials, admin/user changes, labels, orders, inventory, packages, billing, settings, sync/backfill, and print queue events. `npm run test:audit-logging` guards the deliverable.
- Reconciliation reports plan added as `RECONCILIATION_REPORTS_PLAN.md`, covering order, order-item, shipment, label, billing, inventory, package, rate, fulfillment, client/store, and carrier account reconciliation. `npm run test:reconciliation-plan` guards the deliverable.
- Marketplace order status reconciliation added as a guarded dry-run/apply path for Walmart/eBay awaiting-count drift. `npm run test:marketplace-reconciliation` guards the status mapping, synthetic-row prevention, and apply-safety contract.
- Observability and alerting plan added as `OBSERVABILITY_ALERTING_PLAN.md`, covering API, DB, Supabase, worker, sync, rate, label, billing, reporting, and frontend runtime signals. `npm run test:observability-alerting` guards the deliverable.
- Operational runbooks and disaster recovery plan added as `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`, covering rates, labels, sync, inventory, billing, print queue, frontend, users, credentials, database restore, rollback, suspicious access, deployment, and DR. `npm run test:operational-runbooks` guards the deliverable.
- Privacy and compliance plan added as `PRIVACY_COMPLIANCE_PLAN.md`, covering customer PII, order identifiers, label artifacts, billing data, credentials, logs, user metadata, generated reports, retention, deletion, and access review. `npm run test:privacy-compliance` guards the deliverable.
- Production readiness signoff checklist added as `PRODUCTION_READINESS_SIGNOFF.md`, covering local checks, browser smoke, API auth/security smoke, version parity, Render logs, Supabase health, migration status, reconciliation, alert/runbook readiness, rollback, and owner approval. `npm run test:production-signoff` guards the deliverable.
- Durable jobs plan added as `DURABLE_JOBS_PLAN.md`, covering sync, reporting refresh, rate backfill, billing reference-rate fetch, print queue batch send, print queue PDF merge, and fulfillment outbox durable status strategy. `npm run test:durable-jobs-plan` guards the deliverable.
- JWT/session expiration plan added as `JWT_SESSION_EXPIRATION_PLAN.md`, documenting the 7-day Supabase Auth time-box session policy while keeping access JWTs short-lived. `npm run test:jwt-session-policy` guards the deliverable.
- Label/shipment-sensitive route policy review is completed as `LABEL_SHIPMENT_SCOPE_REVIEW.md`, mapping label create/batch/void/return/retrieve and shipment read/sync routes before any runtime side-effect changes. `npm run test:label-shipment-scope-review` guards the deliverable.

Confirmed gaps from repo search:

- RBAC/client-scope rules are now documented in a route matrix, the first runtime permission middleware is implemented for safer admin/settings/credential surfaces, low-risk client/init payload scoping exists, dashboard/analysis/inventory/billing/print-queue/orders/manifests read/action scoping has started, label/shipment-sensitive route policy review is completed, and `financials:read` now protects key Analysis, Dashboard, Inventory, Billing, Orders, Manifests, Packages, and Rate Browser outputs. Remaining label/shipment runtime enforcement and production smoke evidence are still incomplete.
- Runtime DDL remains in some production-capable paths, but the request/job-time DDL inventory and static guard now exist. Reporting metrics table/index ownership has moved into `drizzle/0029_reporting_metrics.sql`, the Walmart selling-fee source index is owned by `drizzle/0019_selling_fees.sql`, marketplace `store_orders` is owned by `drizzle/0030_store_orders.sql`, credential-account RLS/readiness is owned by `drizzle/0031_credential_accounts_rls.sql`, `order_items` / `analytics_cache` readiness is owned by `drizzle/0024_order_items_phase2.sql` plus `drizzle/0025_order_items_sync_trigger.sql`, and low-risk orders/inventory performance indexes are owned by migrations `0021`, `0022`, `0023`, and `0026`.
- Durable job state is now mapped in `DURABLE_JOBS_PLAN.md`. ShipStation Awaiting parity, rate backfill, billing reference-rate fetch, and print queue send/merge now persist latest-run status; full job progress/events, idempotency, and PDF artifact durability still need runtime restart-safe guarantees.
- Broad frontend `safe()` fallback usage remains and needs a failure-mode sweep.
- Secrets governance is mapped, but rotation, last-used tracking, audit events, and production log/response smoke tests are not complete yet.
- Audit logging is mapped, but the append-only table/service and runtime event writers are not implemented yet.
- Reconciliation reporting is mapped, and marketplace awaiting-count repair now has a dry-run/apply path; broader report queries, scheduled runs, artifacts, and non-marketplace repair dry-runs are not implemented yet.
- Observability and alerting are mapped, but runtime metric emitters, dashboards, thresholds, alert destinations, and runbook links are not implemented yet.
- Operational runbooks and DR are mapped, but dedicated runbook pages, owner approval, restore drills, and rollback drills are not complete yet.
- Privacy and compliance are mapped, but retention/deletion policy, field-level privacy rules, access reviews, and log redaction scans are not complete yet.
- Production signoff gates are mapped, but the checklist has not yet been used against a full manual release with evidence links.
- Label and marketplace order/fee compatibility handlers still need auth/CORS consolidation, but should be handled in a separately scoped review because they touch `orders`/`shipments` write paths.

Current readiness read:

| Track | Status | Percent |
|---|---|---:|
| Phase 11 duplication/source-of-truth | Auth/CORS, credential-account service, auth guard, billing/rates frontend failure-state guards, rate cache diagnostics/bulk semantics, runtime DDL inventory/guard, reporting metrics migration, Walmart selling-fee index cleanup, `store_orders` migration, credential-account DDL cleanup, `order_items` / `analytics_cache` readiness cleanup, low-risk orders/inventory index cleanup, ShipStation Awaiting parity latest-run status, rate backfill latest-run status, billing reference-rate latest-run status, print queue send/merge latest-run status, and durable job strategy documented | 94% |
| Phase 12 enterprise readiness | Critical gaps confirmed, first security/credential/auth/frontend billing guard work implemented, runtime DDL backlog clearer with six low-risk classes migrated, RBAC/client-scope route matrix documented, first runtime permission layer implemented, low-risk client/init payload scoping added, dashboard/analysis/inventory/billing/print-queue/orders/manifests read/action scoping started, label/shipment-sensitive route policy review completed, extended `financials:read` field-level guard added for Orders, Manifests, Packages, and Rate Browser, secrets governance matrix added, audit logging matrix added, reconciliation reports plan added, marketplace awaiting-count reconciliation guarded, observability/alerting plan added, operational runbooks/DR plan added, privacy/compliance plan added, production signoff checklist added, and key operational jobs now persist latest-run status | 98% |
| Phase 13 JWT/session expiration | 7-day maximum login session policy documented and guarded; Supabase time-box set to `168` hours; access JWTs remain short-lived | 65% |

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| RBAC and client scoping are partially enforced | First permission middleware covers `/users`, settings, and credential surfaces; low-risk client/init payload scoping exists; dashboard, analysis, inventory, billing, print-queue, orders, and manifests read/action scoping started; `financials:read` protects expanded financial DTOs; label/shipment policy is reviewed but runtime enforcement and production smoke evidence are still missing | Runtime role and client-scope enforcement based on `RBAC_CLIENT_SCOPE_MATRIX.md` and `LABEL_SHIPMENT_SCOPE_REVIEW.md` | API tests for admin, operator, warehouse, client user, support/read-only |
| Credential governance is incomplete | Carrier/store/ShipStation secrets can be mishandled, logged, or hard to rotate | Redaction, protected storage, rotation, audit log, last-used tracking | Secret scan, API response tests, credential update audit test |
| Runtime DDL still exists in some production paths | Request latency, schema drift, unpredictable deploys | Schema managed by Drizzle migrations | `RUNTIME_DDL_MIGRATION_AUDIT.md`, `npm run test:runtime-ddl`, and migration backlog |
| User-visible jobs are not all durable | Restart/multi-instance can lose or duplicate work | DB-backed job state, idempotency, locks, failure state | Restart and dual-worker tests |
| Audit logging is not comprehensive | Cannot prove who changed business-critical data | Append-only audit events for credentials, labels, orders, inventory, billing, settings | Audit table/API/event tests |
| Reconciliation reports are missing | Inventory, billing, label, and fulfillment truth can diverge silently | Scheduled reconciliation reports with repair process | Reconciliation queries and mismatch test data |
| 7-day session policy requires expired-session proof | Hosted Supabase time-box is set, but forced re-login still needs evidence | Supabase Auth time-box user sessions set to `168` hours / 7 days with short-lived access JWTs | `npm run test:jwt-session-policy` plus staging short-timebox proof and production login smoke |

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

- [x] Define roles: admin, operator, warehouse, client user, read-only/support.
- [x] Create route permission matrix in `RBAC_CLIENT_SCOPE_MATRIX.md`.
- [x] Add first runtime permission middleware for `/users`, settings, carrier accounts, and carrier verification.
- [x] Add first client/store scope helper and low-risk `/clients` + `/init` payload filters.
- [x] Add first dashboard aggregate client/store scope filters.
- [x] Add first Analysis read client/store scope filters.
- [x] Add first Inventory read client/store scope filters.
- [x] Add first Billing read client/store scope filters.
- [x] Add first Print Queue list client/store scope filters.
- [x] Add first Print Queue action/job ownership filters.
- [x] Add first Orders read/list/export client/store scope filters.
- [x] Add first Manifests generate client/store scope filters.
- [x] Review remaining client-scoped access rules for labels/shipments and sensitive mutation paths in `LABEL_SHIPMENT_SCOPE_REVIEW.md`.
- [ ] Implement runtime label/shipment scope enforcement after review.
- [x] Add first field-level protection for financial data via `financials:read`.
- [x] Finish field-level protection review for Orders export/list label costs, Manifests label cost, Packages cost fields, and Rate Browser account/rate-result DTOs.
- [ ] Verify frontend hides restricted actions.
- [ ] Verify backend rejects bypassed restricted actions.
- [ ] Test non-admin access to admin/settings/users endpoints.
- [ ] Test client user access to another client's data.

Deliverable table:

The full route matrix now lives in `RBAC_CLIENT_SCOPE_MATRIX.md`. The condensed enterprise tracker below shows the highest-risk route groups.

| Route | Required Role | Client Scope Rule | Current Enforcement | Gap | Fix | Test |
|---|---|---|---|---|---|---|
| `/admin`, `/admin/*` | admin | global admin only | `requireAuth` + `requireAdmin` | needs API smoke test with non-admin token | keep middleware, add auth/RBAC tests | non-admin returns `403` |
| `/users`, `/users/*` | admin/user-management | user-management scope; `/users/me` authenticated self | `requireAuth` plus `requirePermission('users:manage')` on root list | live non-admin smoke test still needed | keep `/users/me` self-readable; add API behavior tests | operator/client token denied from root list |
| `/clients`, `/clients/*` | admin/operator with client-management permission, scoped support/client users | Explicit JWT `clientIds` / `storeIds` filter scoped users; secrets never returned | `requireAuth`; client secret redaction tests; client/store scope helper filters list/detail when scope claims exist | client-management mutation role and field-level policy not fully formalized | add mutation permission and safe DTO tests per role | scoped users only see assigned clients |
| `/dashboard`, `/dashboard/*` | admin/operator/warehouse/client user/support | client/store scoped aggregate rows | `requireAuth`; dashboard summary/daily/SKU/inventory-risk scope filters for explicit JWT claims | production smoke tests and finer field policy still needed | add API tests and keep extending scope policy | client user dashboard excludes other clients |
| `/analysis`, `/analysis/*` | admin/operator/warehouse/client user/support | client/store scoped analytics rows | `requireAuth`; overview/daily shipments/top SKUs/SKU detail scope filters for explicit JWT claims; `financials:read` redacts shipping and selling-fee totals | production smoke tests still needed | add restricted-role DTO smoke tests | client user analysis excludes other clients; restricted users do not see financial fields |
| `/orders`, `/orders/*` | admin/operator/warehouse/client user | client/store scoped rows; label/best-rate costs require `financials:read` | `requireAuth`; list/daily-counts/dashboard-sales/ids/store-counts/daily-stats/picklist/distinct-skus/by-number/detail/full/export filter explicit JWT `clientIds` / `storeIds`; list/export costs redact without `financials:read`; shipped/cancelled mutation guards exist | mutation permission policy and production smoke tests still needed | add mutation role policy without weakening locked surfaces | client user cannot read another client's orders; shipped/cancelled guard still passes; restricted users cannot see label costs |
| `/shipments`, `/shipments/*` | admin/operator/warehouse/client user/support | shipment reads scoped through related order/client/store | `requireAuth`; `LABEL_SHIPMENT_SCOPE_REVIEW.md` maps shipment read/sync policy | runtime read/sync enforcement still needs reviewed implementation | add `shipments:read` and `shipments:sync` checks without changing locked mutation paths | scoped user cannot read another client's shipments; non-ops user cannot start sync |
| `/inventory`, `/inventory/*` | admin/operator/warehouse/client user | client scoped SKUs | `requireAuth`; list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders scope filters for explicit JWT claims | production smoke tests and mutation permission policy still needed | add API tests and mutation permission review in a separate batch | client user cannot read another client's inventory |
| `/billing`, `/billing/*` | admin/operator/accounting | client scoped billing | `requireAuth`; route requires `financials:read`; config/summary/details/invoice/package-prices scope filters for explicit JWT claims | billing mutation/generation write permission still needs finer split | add billing write permission if needed | warehouse/client user denied from billing unless explicitly granted |
| `/manifests`, `/manifests/*` | admin/operator/warehouse/support | client scoped manifest shipments; label costs require `financials:read` | `requireAuth`; GET/POST generate filter explicit JWT `clientIds` / `storeIds`; labelCost redacts without `financials:read` | location policy and production smoke tests still need review | add location-aware tests if assignments are enabled | scoped user cannot access another client's manifest rows or restricted label costs |
| `/labels`, `/labels/*` | admin/operator/warehouse | label actions scoped through assigned order/client/store; artifacts are PII | `requireAuth`; signed mock labels; `LABEL_SHIPMENT_SCOPE_REVIEW.md` maps create/batch/void/return/retrieve policy | runtime label preflight enforcement still needs side-effect review | add `labels:create`, `labels:void`, `labels:return`, and `labels:read` preflight checks before service calls | scoped user cannot create/retrieve/void/return another client's label |
| `/print-queue`, `/print-queue/*` | admin/operator/warehouse/support | client scoped queue entries and queue jobs | `requireAuth`; list/add/clear/delete/print/status/download and batch-send startup/status scope checks for explicit JWT claims | durable job state, location policy, and production smoke tests still need review | move job progress to durable state and add browser/API smoke tests | client user/support cannot read or mutate another client's queue entries or jobs |
| `/carrier-accounts`, `/store-accounts`, `/settings/*` | admin/operator with credential/settings permission | account/client assignment scope | Render carrier-account route has method-aware credential permission; settings have read/write permission gates | Vercel compatibility and audit logging still need follow-up | central credential service + audit events | non-credential role cannot write credential endpoints |

### JWT Session Expiration

- [x] Create `JWT_SESSION_EXPIRATION_PLAN.md`.
- [x] Add `npm run test:jwt-session-policy`.
- [x] Keep backend JWT `exp` validation through `jose`.
- [x] Keep access JWTs short-lived rather than extending them to 7 days.
- [x] Document that Supabase dashboard value must be `168` hours for 7 days.
- [x] Set Supabase Auth time-box user sessions to `168` hours / 7 days.
- [ ] Verify expired-session behavior in staging with a short temporary time-box.
- [ ] Capture production login and forced re-login evidence.

Deliverable table:

| Control | Current State | Gap | Required Fix | Test |
|---|---|---|---|---|
| Access JWT expiry | verified by `jose`; should remain short-lived | production Auth setting needs review | keep/prefer 1-hour access JWT expiry | auth smoke and Supabase settings review |
| Session max lifetime | production time-box set to `168` hours | expired-session behavior still needs proof | run staging short-timebox and production login smoke | staging short-timebox proof and production signoff |
| Strict issuer/audience | optional env flag exists | not yet enabled in production | test then enable `STRICT_JWT_CLAIMS=true` separately | login/API token compatibility smoke |

### Secrets / Credential Management

- [x] Create `SECRETS_GOVERNANCE_MATRIX.md`.
- [x] Add `npm run test:secrets-governance`.
- [~] Verify ShipStation keys never return to frontend.
- [~] Verify carrier/store credentials are protected at rest.
- [ ] Verify Supabase service role is backend-only.
- [ ] Verify direct carrier OAuth tokens never expose to frontend/logs.
- [ ] Add credential change audit events.
- [ ] Add credential rotation process.
- [ ] Add last-used timestamp tracking.
- [x] Move credential-table DDL to migrations.
- [ ] Scan logs for token/secret output.

Deliverable table:

The detailed matrix now lives in `SECRETS_GOVERNANCE_MATRIX.md`. The condensed tracker below shows the highest-risk credential classes.

| Credential Type | Storage Location | Who Can Read | Who Can Write | Frontend Exposure Risk | Rotation Gap | Fix |
|---|---|---|---|---|---|---|
| Supabase service role/JWT secrets | env only | backend/platform admins | platform admins | critical if copied to frontend env or logs | rotation runbook needed | env/log scan and staged strict-claims rollout |
| Client ShipStation keys | `clients` table | backend services only | admin/operator client-management flow | guarded by public client serializer | rotation history missing | keep redaction tests and add credential audit event |
| Carrier/store credentials | `carrier_accounts` / `store_accounts` | backend credential services only | credential-permission users | shared handlers avoid raw response exposure | last-used and rotation metadata missing | add audit, last-used, and log redaction |
| Marketplace OAuth tokens | `store_accounts.credentials` | marketplace services only | OAuth callback/admin re-auth | token refresh errors can leak provider text if not redacted | re-auth runbook missing | add OAuth audit events and redacted errors |
| Label PDFs/signed URLs | provider/mock signed URLs | authenticated operational users | label/mock services | label PDFs are PII-bearing artifacts | retention policy missing | add label access/retention runbook |

### Database Migrations / Schema Governance

- [x] List all runtime DDL in `src` and `api`.
- [x] Add static guard for new undocumented runtime DDL.
- [x] Move reporting metrics runtime DDL into `drizzle/0029_reporting_metrics.sql`.
- [x] Keep Walmart selling-fee source index owned by `drizzle/0019_selling_fees.sql`.
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
| `carrier_accounts` | resolved: credential handlers verify migration readiness instead of creating table/indexes at runtime | request-time table/index creation removed | `0015_amusing_namorita.sql` plus `0031_credential_accounts_rls.sql` | rollback can temporarily restore runtime ensure if migration is missing |
| `carrier_account_clients` | resolved: credential handlers verify migration readiness instead of creating junction table/index at runtime | request-time table/index creation removed | `0027_credential_accounts_source_of_truth.sql` plus `0031_credential_accounts_rls.sql` | preserve existing assignments before rollback |
| `store_accounts` | resolved: credential handlers verify migration readiness; legacy store row migration still exists as data movement only | request-time table/index creation removed | `0027_credential_accounts_source_of_truth.sql` plus `0031_credential_accounts_rls.sql` | rollback must not re-copy deleted carrier marketplace rows |
| `store_orders` | resolved: marketplace handlers verify migration readiness instead of creating table/indexes at runtime | request-time table/index creation removed | `0030_store_orders.sql` added | rollback can temporarily restore runtime ensure if migration is missing |
| `fulfillment_outbox` | service and label compatibility path ensure table/indexes at runtime | label/outbox request may pay DDL cost | fulfillment outbox migration | rollback keeps table; worker can ignore unused columns |
| `order_items`, `analytics_cache` | resolved: analytics/backfill service verifies migration readiness instead of creating table/index/trigger/function at runtime | runtime schema ownership removed | `0024_order_items_phase2.sql` and `0025_order_items_sync_trigger.sql` own readiness | rollback can temporarily restore runtime ensure if migration is missing |
| orders/inventory performance indexes | resolved: maintenance service no longer creates low-risk orders/inventory indexes at runtime | runtime index ownership removed | `0021_orders_endpoint_performance.sql`, `0022_dashboard_sales_performance.sql`, `0023_inventory_list_performance.sql`, and `0026_inventory_lower_sku_idx.sql` own indexes | rollback can temporarily restore runtime index ensure if migrations are missing |
| reporting metrics tables | resolved: worker service now checks migration readiness instead of creating tables | runtime schema ownership removed | `0029_reporting_metrics.sql` added | rollback keeps tables and can pause refresh worker |
| `orders_selling_fee_source_idx` | resolved: compatibility paths no longer create the index at runtime | request-time index creation removed | `0019_selling_fees.sql` owns it | rollback can temporarily restore runtime ensure if migration is missing |

### Observability / Monitoring

- [x] Create `OBSERVABILITY_ALERTING_PLAN.md`.
- [x] Add `npm run test:observability-alerting`.
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

The detailed signal plan now lives in `OBSERVABILITY_ALERTING_PLAN.md`. The condensed tracker below shows the first signal classes to implement.

| Signal | Current Visibility | Missing Metric/Log | Alert Needed | Owner |
|---|---|---|---|---|
| API 5xx and latency | timing logs and `Server-Timing` | route/status/duration p95/p99 counters | 5xx spike and hot-route latency spike | API |
| API 499/timeouts | Render logs/manual review | request-id and route aggregation | timeout/499 spike | API |
| Slow DB and Supabase pressure | manual Supabase dashboard | slow query, pool saturation, route correlation | slow query and connection saturation | DB |
| Worker/sync/reporting jobs | `/worker/status` and logs | stale heartbeat, failed/stuck job counters | stale heartbeat and failed job | Worker |
| Rate/label provider health | rate diagnostics and provider logs | provider/account success/failure/timeout counters | rate/label failure spike | Fulfillment/Rates |
| Frontend runtime errors | browser console/manual | release-tagged frontend error capture | frontend error spike | Frontend |

### Audit Logging

- [x] Create `AUDIT_LOGGING_MATRIX.md`.
- [x] Add `npm run test:audit-logging`.
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

The full event matrix now lives in `AUDIT_LOGGING_MATRIX.md`. The condensed tracker below shows the first event groups to implement.

| Action | Audited? | Actor Captured? | Before/After Captured? | Fix |
|---|---|---|---|---|
| credential create/update/delete | [ ] | [ ] | [ ] | add audit service and wrap credential service writes |
| admin/user permission change | [ ] | [ ] | [ ] | audit user-management routes |
| billing config/generation/export | [ ] | [ ] | [ ] | audit billing generation and export actions |
| inventory/package receive/adjust | [ ] | [ ] | [ ] | audit operational quantity changes |
| label/order/shipped override actions | [ ] | [ ] | [ ] | handle in separate reviewed operational batch |

### Background Jobs / Distributed Safety

- [x] Create `DURABLE_JOBS_PLAN.md`.
- [x] Add `npm run test:durable-jobs-plan`.
- [ ] Rate backfill survives server restart.
- [~] Print queue latest job summaries survive server restart.
- [ ] Print queue active progress and PDF artifacts survive server restart.
- [ ] Sync scheduler is safe with multiple instances.
- [ ] Jobs have idempotency keys.
- [ ] Jobs have retry limits.
- [ ] Jobs have dead-letter or failure state.
- [ ] Jobs have cancellation or timeout.
- [ ] Job progress is persisted.
- [ ] Advisory lock or lease strategy exists.
- [ ] Duplicate job execution is prevented.

Deliverable table:

The detailed durable jobs plan now lives in `DURABLE_JOBS_PLAN.md`. The condensed tracker below shows the first job classes to implement.

| Job | Current State Storage | Restart Behavior | Multi-Instance Risk | Idempotency Risk | Fix |
|---|---|---|---|---|---|
| rate backfill best rates | in-memory job map plus durable latest snapshot | latest summary survives restart; active progress still process-local | duplicate provider fanout possible | date/window key missing | full durable job row or pg-boss workflow |
| billing reference-rate fetch | in-memory job map plus durable latest snapshot | latest summary survives restart; active progress still process-local | duplicate reference-rate fetch possible | client/date/window key missing | full durable job row and result summary |
| print queue batch send | in-memory job map plus durable latest snapshot | latest summary survives restart; active polling still process-local | duplicate queue entries possible | selected-order/user key needed | durable job row and per-order results |
| print queue PDF merge | in-memory job map + base64 output plus durable latest snapshot | latest summary survives restart; PDF artifact is still memory-only | duplicate merge possible | entry/user key needed | durable job row and artifact pointer |

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

- [x] Create `RECONCILIATION_REPORTS_PLAN.md`.
- [x] Add `npm run test:reconciliation-plan`.
- [x] Add guarded marketplace status reconciliation dry-run/apply script.
- [x] Add `npm run test:marketplace-reconciliation`.
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

The detailed report plan now lives in `RECONCILIATION_REPORTS_PLAN.md`. The condensed tracker below shows the first report classes to implement.

| Reconciliation | Canonical Source | Local Source | Mismatch Detection | Repair Process | Owner |
|---|---|---|---|---|---|
| `orders.items` vs `order_items` | order ingestion payload | normalized `order_items` | count/qty/revenue mismatch | rerun order item repair/backfill | Analytics |
| billing summaries vs billing line items | generated line items | summary/read-model output | totals/order count/client mismatch | rebuild billing summary/read model | Billing |
| inventory ledger vs displayed stock | `inventory_ledger` | `inventory.stockQty` / effective stock | ledger/cache mismatch | dry-run approved cache rebuild | Inventory |
| package ledger vs package stock | package ledger/mutations | package stock/cache | quantity/usage mismatch | package stock rebuild | Packages |
| rate cache vs actual label cost | label purchase cost | `rate_cache` / best-rate fields | cached/best rate differs from paid label cost | mark stale and refresh future rates | Rates |

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
- [x] Production readiness signoff checklist scoped in `PRODUCTION_READINESS_SIGNOFF.md`.

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

- [x] Create `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`.
- [x] Add `npm run test:operational-runbooks`.
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

The detailed deployment/rollback and DR plan now lives in `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`. The condensed tracker below shows the first deploy controls to implement.

| Deploy Step | Failure Mode | Rollback Step | Owner | Verification |
|---|---|---|---|---|
| Vercel frontend deploy | white screen or API mismatch | rollback previous Vercel deployment | Frontend | incognito app load |
| Render API deploy | API 5xx, auth failure, route timeout | rollback API to previous commit | API | `/health/ready`, Orders, Rates smoke |
| Render worker deploy | sync/reporting/rate backfill stuck | rollback worker or pause scheduler | Worker | heartbeat and sync status |
| Drizzle migration | migration failure or slow lock | stop deploy and apply rollback/restore plan | DB | schema version and app smoke |

### Compliance / Privacy

- [x] Create `PRIVACY_COMPLIANCE_PLAN.md`.
- [x] Add `npm run test:privacy-compliance`.
- [ ] PII inventory exists.
- [ ] Customer addresses are protected.
- [ ] Label PDFs are protected.
- [ ] Email/user metadata access is restricted.
- [ ] Data retention policy exists.
- [ ] Access logs are protected.
- [ ] Vendor access is documented.
- [ ] Least-privilege access is enforced.
- [ ] Breach response runbook exists.

Deliverable table:

The detailed privacy/compliance plan now lives in `PRIVACY_COMPLIANCE_PLAN.md`. The condensed tracker below shows the first data classes to govern.

| Data Class | Storage / Surface | Required Control | Test |
|---|---|---|---|
| Customer PII | orders, labels, manifests, exports, UI | client/store scope, masking, audit logs | scoped user cannot see other client PII |
| Label artifacts | provider URLs, print queue, downloads | signed/expiring access and retention | expired URL cannot be reused |
| Billing data | billing APIs, exports, UI | role-based cost/margin/export policy | warehouse/client denied margins |
| Credentials/secrets | env, clients, credential tables | redaction, audit, rotation, last-used | API response has no secrets |
| Logs/telemetry | Render, Vercel, Supabase, observability tools | no secrets/full addresses/tokens | log sample scan |

### Disaster Recovery

- [x] Disaster recovery matrix scoped in `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`.
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

## Recommended Patches

- Add RBAC/client-scope middleware after roles are finalized.
- Add credential governance: audit events, rotation process, last-used tracking, and log redaction.
- Convert remaining runtime DDL to Drizzle migrations.
- Persist user-visible job state for print queue, rate backfill, sync, and reporting.
- Add reconciliation reports for inventory, packages, labels, billing, rate cache, and fulfillment outbox.
- Add production observability, alerts, and runbooks.

## Required Tests Before Production

- `npm run typecheck`
- `npm run build:web`
- `npm run test:orders-ux`
- `npm run test:runtime-ddl`
- `npm run test:rbac-permissions`
- `npm run test:client-store-scope`
- `npm run test:dashboard-client-scope`
- `npm run test:analysis-client-scope`
- `npm run test:inventory-client-scope`
- `npm run test:billing-client-scope`
- `npm run test:print-queue-client-scope`
- `npm run test:print-queue-ownership`
- `npm run test:orders-manifests-scope`
- `npm run test:label-shipment-scope-review`
- `npm run test:secrets-governance`
- `npm run test:audit-logging`
- `npm run test:reconciliation-plan`
- `npm run test:marketplace-reconciliation`
- `npm run test:observability-alerting`
- `npm run test:operational-runbooks`
- `npm run test:privacy-compliance`
- `npm run test:production-signoff`
- `npm run test:durable-jobs-plan`
- `npm run test:jwt-session-policy`
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

## Test Plan

- Run the local verification commands listed in Required Tests Before Production.
- Run API smoke tests for auth, admin denial, client secret redaction, and route root/wildcard protection.
- Run browser checks for Orders, Inventory, Billing, Dashboard, Rate Browser, Settings, and Packages.
- Run production log checks for request storms, 499s, 30s timeouts, slow DB queries, and external API failure spikes.

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

## Deployment/Rollback Notes

- Deploy high-risk fixes in small batches with smoke tests between each batch.
- Keep strict JWT claims disabled until production token compatibility is verified.
- Enforce the 7-day login limit through Supabase Auth time-boxed sessions, not 7-day access JWTs.
- In the Supabase dashboard, use `168` hours for the 7-day time-box value.
- Keep compatibility routes until Vercel/Render rewrite behavior is verified.
- Roll back by reverting the last batch if auth, billing, rates, labels, or inventory smoke tests fail.
- Do not remove runtime DDL until matching migrations have been applied and verified.

## Recommended Implementation Order

1. Smoke-test the runtime RBAC, client/init scope, dashboard scope, analysis scope, inventory scope, billing scope, print-queue list/action scope, orders scope, and manifests scope layer after deploy.
2. Review `SECRETS_GOVERNANCE_MATRIX.md`, assign credential owners, and decide rotation/last-used/audit rollout order.
3. Review `AUDIT_LOGGING_MATRIX.md` and approve event names.
4. Review `RECONCILIATION_REPORTS_PLAN.md` and approve report ownership.
5. Review `OBSERVABILITY_ALERTING_PLAN.md` and approve alert owners/thresholds.
6. Review `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md` and approve runbook owners.
7. Review `PRIVACY_COMPLIANCE_PLAN.md` and approve data-class owners.
8. Review `PRODUCTION_READINESS_SIGNOFF.md` and approve release gates.
9. Implement label/shipment runtime scope enforcement from `LABEL_SHIPMENT_SCOPE_REVIEW.md`.
10. Secrets and credential audit, including audit events.
11. Migration/runtime DDL cleanup plan.
12. Review `DURABLE_JOBS_PLAN.md` and approve durable job storage target.
13. Review `JWT_SESSION_EXPIRATION_PLAN.md` and have DJ/admin set Supabase Auth time-box user sessions to `168` hours / 7 days.
14. Durable job status and idempotency implementation.
15. External API resilience metrics and diagnostics.
16. Data reconciliation reports.
17. Frontend failure-mode Playwright tests.
18. Observability and alerting integration.
19. Deployment, rollback, disaster recovery, privacy, and production signoff runbooks.
