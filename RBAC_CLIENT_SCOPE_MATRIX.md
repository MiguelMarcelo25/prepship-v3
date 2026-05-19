# PrepShip RBAC / Client-Scope Route Matrix

## Executive Summary

This document started as the Phase 12 Batch 1 RBAC planning deliverable. Phase 12 Batch 2 implemented the first narrow runtime permission layer for safer admin/settings/credential surfaces. Phase 12 Batch 3A added low-risk `/clients` and `/init` scoping. Phase 12 Batch 3B started operational aggregate scoping with `/dashboard`. Phase 12 Batch 3C extended explicit client/store read scoping into direct `/analysis` endpoints. Phase 12 Batch 3D extended explicit client/store read scoping into Inventory read endpoints. Phase 12 Batch 3E extended explicit client/store read scoping into Billing read endpoints. Phase 12 Batch 3F starts Print Queue scoping with the read/list endpoint.

This work does not change shipped/cancelled mutation guards, shipment logic, label creation, or fulfillment side effects.

## Current Implementation Status

- [x] Canonical roles are defined in `src/middleware/auth.ts`.
- [x] Canonical permissions are defined in `src/middleware/auth.ts`.
- [x] `requirePermission()` exists.
- [x] Supabase JWT `app_metadata.permissions` is read for explicit permissions.
- [x] `/users` root list requires `users:manage`.
- [x] `/users/me` remains authenticated-self.
- [x] Settings reads require `settings:read`.
- [x] Settings writes require `settings:write`.
- [x] Carrier-account route uses method-aware `credentials:read` / `credentials:write`.
- [x] Carrier verification requires `credentials:write`.
- [x] `npm run test:rbac-permissions` guards the first runtime layer.
- [x] JWT `clientIds` / `storeIds` claims are parsed into auth context.
- [x] Client/store scope helper exists.
- [x] `/clients` list/detail responses are filtered when explicit client/store scopes are present.
- [x] `/init/init-data` client payload is filtered when explicit client/store scopes are present.
- [x] `/init/stores` payload is filtered when explicit client/store scopes are present.
- [x] `npm run test:client-store-scope` guards the first client/store scope layer.
- [x] `/dashboard` summary/daily-counts/SKU panels/inventory-risk filter explicit client/store scopes.
- [x] dashboard cache keys include client/store scope.
- [x] `npm run test:dashboard-client-scope` guards the dashboard scope layer.
- [x] `/analysis` overview/daily-shipments/top-skus/SKU detail/SKU daily endpoints filter explicit client/store scopes.
- [x] `npm run test:analysis-client-scope` guards the analysis scope layer.
- [x] `/inventory` list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders endpoints filter explicit client/store scopes.
- [x] `npm run test:inventory-client-scope` guards the inventory scope layer.
- [x] `/billing` config/summary/details/invoice/package-prices endpoints filter explicit client/store scopes.
- [x] `npm run test:billing-client-scope` guards the billing scope layer.
- [x] `GET /print-queue` filters queued-entry reads by explicit client/store scopes.
- [x] `npm run test:print-queue-client-scope` guards the print-queue list scope layer.
- [ ] Remaining operational route row-scope middleware and query filters.
- [ ] Field-level DTO redaction by role for costs, margins, and billing.
- [ ] Audit events for credential/admin actions.

## Canonical Roles

| Role | Intended User | Default Access Shape |
|---|---|---|
| `admin` | Owner/admin user | Global access to configuration, users, clients, credentials, operations, billing, and support workflows |
| `operator` | Fulfillment operations lead | Operational access to orders, rates, labels, inventory, packages, manifests, dashboard, analysis, and selected settings |
| `warehouse` | Warehouse picker/packer | Operational access to assigned warehouse/client/store orders, inventory, packages, manifests, and print/queue workflows; limited cost/credential visibility |
| `client_user` | External/client-facing user | Read or limited action access only to assigned client/store data; no global settings or credentials |
| `read_only_support` | Support/auditor user | Read-only access to permitted operational data for troubleshooting; no mutation, credential, margin, or admin access |

## Default Scope Rules

- Admin routes are global but require `admin`.
- Operational data routes must be filtered by assigned client/store unless the user is `admin`.
- Credential routes must hide secret values from every browser response, even for admins.
- Cost, margin, billing, and carrier credential fields require explicit permission beyond simple authentication.
- `/users` should become admin-only by default. If `/users/me` is split out later, it may remain authenticated-self.
- `/health` and `/cron` keep their existing special behavior and are not normal app-user routes.

## Route Matrix

| Route group | Required role | Client/store scope rule | Current enforcement | Gap | Required fix | Required test |
|---|---|---|---|---|---|---|
| `/health`, `/health/ready` | public/service health | No client scope | Routed before normal app auth | Confirm readiness endpoint is what Render uses | Keep current behavior; document Render health check target | `/health/ready` returns service-ready status and is used by Render |
| `/cron` | service/scheduler secret policy | No client scope | Routed before normal app auth | Policy is special-case and should stay separate from app-user RBAC | Keep service-only cron behavior documented; do not mix with user roles | Unauthorized public cron mutation cannot run scheduler work |
| `/admin`, `/admin/*` | `admin` | Global admin only | `requireAuth` plus `requireAdmin` | Needs route-level permission tests for every admin sub-area | Keep `requireAdmin`; add explicit admin route tests and audit logging later | Non-admin token returns `403`; unauthenticated returns `401` |
| `/users`, `/users/*` | `admin` / `users:manage`; `/users/me` authenticated-self | Global user-management scope | `requireAuth`; root list now has `requirePermission('users:manage')` | Live non-admin smoke test still needed | Keep root list gated and `/users/me` self-readable | Operator/client/support denied from `/users`; `/users/me` still works |
| `/orders`, `/orders/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Rows filtered to assigned client/store; support read-only; client_user only own client/store | `requireAuth`; shipped/cancelled mutation guards exist | No formal client/store scope middleware | Add scope-aware order query filters and mutation permission checks without weakening locked surfaces | Client user cannot read another client's orders; support cannot mutate; shipped/cancelled guard still passes |
| `/shipments`, `/shipments/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Shipment reads scoped through related order/client/store | `requireAuth` | Shipment table is locked; read scope needs policy, mutation review needs separate human plan | Add read scoping only in a separately reviewed implementation; do not alter locked shipment mutation paths in this batch | Client user cannot read another client's shipments; locked mutation tests remain unchanged |
| `/dashboard`, `/dashboard/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Aggregates filtered to assigned client/store; support read-only | `requireAuth`; summary/daily-counts/SKU panels/inventory-risk filter explicit JWT `clientIds` / `storeIds`; cache keys include scope | production smoke tests and finer dashboard DTO permission policy still needed | Add API tests and keep role-specific DTO policy | Client user dashboard excludes other clients; support sees read-only metrics |
| `/analysis`, `/analysis/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Analytics filtered to assigned client/store; cost/margin fields require explicit permission | `requireAuth`; overview/daily shipments/top SKUs/SKU detail/SKU daily endpoints filter explicit JWT `clientIds` / `storeIds` | Production smoke tests and field-level analytics cost/margin permissions still needed | Add API smoke tests and field-level DTOs for restricted roles | Client user cannot access other-client SKUs; warehouse cannot see restricted margin fields |
| `/inventory`, `/inventory/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Inventory rows filtered to assigned client/store; support read-only | `requireAuth`; list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders endpoints filter explicit JWT `clientIds` / `storeIds` | Production smoke tests and mutation role policy still needed | Add API tests and mutation permission review in a separate batch | Client user cannot read another client's inventory; support cannot adjust stock |
| `/billing`, `/billing/*` | `admin`, `operator` with billing permission, scoped `client_user` if explicitly allowed | Billing rows filtered to assigned client/store; costs/margins protected | `requireAuth`; config/summary/details/invoice/package-prices filter explicit JWT `clientIds` / `storeIds` | Billing mutation/generation permission and field-level visibility are not formalized | Add billing permission and DTO redaction for restricted roles | Warehouse denied billing; client_user only sees own approved billing fields |
| `/manifests`, `/manifests/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Manifest data scoped to assigned client/store/location | `requireAuth` | No formal client/store/location scope middleware | Add scoped manifest queries and mutation role checks | Warehouse cannot access another location/client manifest |
| `/print-queue`, `/print-queue/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Print queue entries scoped by assigned client/store/location; support read-only | `requireAuth`; list reads filter explicit JWT `clientIds` / `storeIds` | Queue mutation, print-job ownership, and location policy are not formalized | Add mutation/job ownership policy in a separate batch | Warehouse cannot delete another location/client queue entry |
| `/clients`, `/clients/*` | `admin`, `operator` with client-management permission, `read_only_support` read-only | Client rows global for admins; scoped users filtered by explicit JWT `clientIds` / `storeIds`; secrets never returned | `requireAuth`; client secret redaction tests; list/detail scope filtering when claims exist | Client-management mutation role and field-level policy not fully formalized | Add mutation permission and safe DTO tests per role | `/clients` never returns secrets; scoped users only see assigned clients |
| `/packages`, `/packages/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Packages scoped to location/client where applicable; cost fields protected | `requireAuth` | Package scope and package-cost visibility not formalized | Add package scope policy and cost DTO guards | Warehouse cannot edit global package settings without permission |
| `/settings`, `/settings/*` | `admin`; selected operator sub-sections by permission | Global settings; credential fields protected | `requireAuth`; reads require `settings:read`; writes require `settings:write` | Settings sections are not yet split into finer-grained permission groups | Add frontend role hiding and finer setting groups if needed | Operator can access allowed settings only; unauthorized role receives `403` |
| `/carrier-accounts`, `/carrier-accounts/*` | `admin`, operator with credential permission | Credential rows scoped by assigned carrier/client/store permissions; secrets masked | `requireAuth`; method-aware credentials permission middleware; shared credential handler and safe 500s exist | Audit logging, last-used policy, and Vercel compatibility parity still need follow-up | Add credential audit events and role-specific DTO tests | Non-credential role denied; response never includes raw secret fields |
| `/carriers`, `/carriers/*` | `admin`, `operator`, `warehouse` for read/rate use; credential mutation requires credential permission | Carrier reads can be scoped to assigned account/store; secret fields protected | `requireAuth`; `/carriers/verify` now requires `credentials:write` | Broader carrier read vs mutation permissions still need route-by-route review | Split carrier read permissions from credential/admin mutations | Warehouse can rate with assigned account but cannot edit credentials |
| `/rates`, `/rates/*` | `admin`, `operator`, `warehouse`; scoped `client_user` only if allowed | Rate requests limited to assigned order/client/store/account; cost/margin display protected | `requireAuth`; rate diagnostics/concurrency/caching improved | Account scope and margin visibility need formal policy | Add rate account-scope checks and field-level result DTOs | Client user cannot rate against another client's account; margin hidden where restricted |
| `/labels`, `/labels/*` | `admin`, `operator`, `warehouse` | Label actions scoped through assigned order/client/store; shipped/cancelled protections preserved | `requireAuth`; `/labels/mock/` has special bypass/signed URL behavior | Label side effects and role policy need separate review | Add label permission tests in a dedicated batch; do not change side-effect paths here | Unauthorized role cannot create/void labels; locked order tests remain unchanged |
| `/sync`, `/sync/*` | `admin`, operator with sync permission | Global/service operational scope | `requireAuth` | Sync permission and visibility not formalized | Add sync permission and audit events | Warehouse/client user denied sync start; status visibility policy documented |
| `/worker`, `/worker/*` | `admin`, operator with operations permission, read-only support for status if allowed | Global worker/job status; no client scope unless job details include client data | `requireAuth` | Worker status role policy not formalized | Add worker status permission and redact sensitive job payloads | Client user denied worker status; support gets read-only safe status if allowed |
| `/locations`, `/locations/*` | `admin`, `operator`, `warehouse` scoped by location | Location rows filtered to assigned warehouse/location where applicable | `requireAuth` | Location scope not formalized | Add location assignment policy | Warehouse cannot access another location if assignments are enabled |
| `/parent-skus`, `/parent-skus/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user` if allowed | SKU rows filtered to assigned client/store | `requireAuth` | SKU/client scope policy not formalized | Add SKU scope filters and mutation role checks | Client user cannot access another client's SKU mappings |
| `/products`, `/products/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user` if allowed | Product/default rows filtered to assigned client/store | `requireAuth` | Product default ownership and scope policy not formalized | Add product scope filters and default-edit permissions | Client user cannot edit unrelated product defaults |
| `/init`, `/init/*` | authenticated app users; data scoped by role | Initial client/store payloads filter by explicit JWT `clientIds` / `storeIds`; secrets redacted | `requireAuth`; client redaction guard; init-data and stores scope filtering when claims exist | counts and other operational init payloads still need row-scope review | Add operational count scoping in a separate reviewed batch | Client user init payload excludes other clients and secrets |

## Field-Level Protection Matrix

| Data class | Default visibility | Required policy |
|---|---|---|
| ShipStation client keys and secrets | Never visible in frontend responses | Continue redaction tests; add role-specific credential DTO tests |
| Carrier/store credential values | Never visible in frontend responses | Credential permission only for create/update/delete; masked IDs for reads |
| Label PDFs and customer addresses | Operational roles only, scoped to assigned order/client/store | Add scoped access tests and audit logs |
| Shipping cost, margin, billing charges | Admin/operator billing roles by default | Add field-level DTOs for warehouse/client/support roles |
| Audit logs | Admin and read-only support by policy | Add immutable audit table and role-gated query route later |

## Required Implementation Order

1. [x] Add shared permission constants and role names.
2. [x] Add a `requirePermission` wrapper around current auth variables.
3. [x] Apply admin-only user-management policy to `/users` while keeping `/users/me` authenticated-self.
4. [x] Apply settings and credential permissions to settings, carrier accounts, and carrier verification.
5. [x] Add a client/store assignment scope helper.
6. [x] Add low-risk client/init payload filters.
7. [x] Add dashboard aggregate read-scope filters.
8. [x] Add analysis read-scope filters for overview, daily shipments, top SKUs, SKU detail, SKU daily, SKU list, and daily sales.
9. [x] Add inventory read-scope filters for list, ledger, stats, alerts, detail, detail ledger, parents, and SKU orders.
10. [x] Add billing read-scope filters for config, summary, details, invoice, and package prices.
11. [x] Add print-queue list read-scope filters.
12. [ ] Add remaining read-scope filters for `/orders` and `/manifests`.
13. [ ] Add print-queue mutation/job ownership checks.
14. [ ] Add field-level DTO tests for credentials, cost, margin, and billing visibility.
15. [ ] Add browser tests for role-restricted UI hiding after backend enforcement exists.

## Required Tests

- Unauthenticated protected route roots and wildcards return `401`.
- Non-admin token returns `403` for `/admin` and future admin-only `/users`.
- Client user cannot read another client's orders, inventory, billing, dashboard, analysis, manifests, labels, or print queue data.
- Read-only support can view allowed data but cannot mutate.
- Warehouse can perform assigned operational workflows but cannot see credential or restricted billing/margin fields.
- `/clients` and `/init/init-data` never return `ssApiKey`, `ssApiSecret`, or `ssApiKeyV2`.
- Credential endpoints never return raw credential secret values.
- Shipped/cancelled immutability tests keep passing.
- `npm run test:rbac-permissions` passes.
- `npm run test:client-store-scope` passes.
- `npm run test:dashboard-client-scope` passes.
- `npm run test:analysis-client-scope` passes.
- `npm run test:inventory-client-scope` passes.
- `npm run test:billing-client-scope` passes.
- `npm run test:print-queue-client-scope` passes.

## Out Of Scope For This Batch

- No additional query filters are changed outside Print Queue in this batch.
- No shipped/cancelled mutation logic is changed.
- No shipment table mutation logic is changed.
- No print mutation, label side-effect, fulfillment outbox, or inventory deduction logic is changed.
