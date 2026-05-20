# PrepShip RBAC / Client-Scope Route Matrix

## Executive Summary

This document started as the Phase 12 Batch 1 RBAC planning deliverable. Phase 12 Batch 2 implemented the first narrow runtime permission layer for safer admin/settings/credential surfaces. Phase 12 Batch 3A added low-risk `/clients` and `/init` scoping. Phase 12 Batch 3B started operational aggregate scoping with `/dashboard`. Phase 12 Batch 3C extended explicit client/store read scoping into direct `/analysis` endpoints. Phase 12 Batch 3D extended explicit client/store read scoping into Inventory read endpoints. Phase 12 Batch 3E extended explicit client/store read scoping into Billing read endpoints. Phase 12 Batch 3F added Print Queue list and action/job ownership checks for scoped users. Phase 12 Batch 3G added Orders and Manifests read-surface scoping. Phase 12 Batch 3H added the first field-level financial visibility guard for Analysis, Dashboard top-SKUs, Inventory SKU order analytics, and Billing. Phase 12 Batch 3I extended the field-level financial guard to Orders export/list label costs, Manifests label costs, Packages unit costs, and Rate Browser rate/account DTOs. Phase 12 Batch 3J completed the label/shipment-sensitive route policy review as `LABEL_SHIPMENT_SCOPE_REVIEW.md`.

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
- [x] `/print-queue` add/clear/delete/print/status/download and batch-send startup/status protect explicit client/store scopes.
- [x] `npm run test:print-queue-ownership` guards the print-queue action/job ownership layer.
- [x] `/orders` list/daily-counts/dashboard-sales/ids/store-counts/daily-stats/picklist/distinct-skus/by-number/detail/full/export endpoints filter explicit client/store scopes.
- [x] `/manifests/generate` GET/POST filters manifest shipments by explicit client/store scopes.
- [x] `npm run test:orders-manifests-scope` guards the orders/manifests scope layer.
- [x] Field-level DTO guard added for financial visibility: `npm run test:field-level-rbac`.
- [x] `financials:read` protects Analysis/Dashboard SKU financial fields, Inventory SKU-order shipping-cost fields, and Billing routes.
- [x] Extended field-level financial guard: Orders export/list, Manifests label cost, Packages unit cost, Rate Browser rate/account DTOs.
- [x] `npm run test:field-level-rbac-extended` guards the extended field-level policy.
- [x] Label/shipment-sensitive route policy review completed as `LABEL_SHIPMENT_SCOPE_REVIEW.md`.
- [x] `npm run test:label-shipment-scope-review` guards the label/shipment policy review.
- [ ] Runtime label/shipment scope enforcement after review.
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
| `/orders`, `/orders/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Rows filtered to assigned client/store; support read-only; client_user only own client/store; label/best-rate costs require `financials:read` | `requireAuth`; list/daily-counts/dashboard-sales/ids/store-counts/daily-stats/picklist/distinct-skus/by-number/detail/full/export filter explicit JWT `clientIds` / `storeIds`; list/export label-cost and best-rate fields redact without `financials:read`; shipped/cancelled mutation guards exist | Mutation role policy and production smoke tests still needed | Add mutation permission checks without weakening locked surfaces | Client user cannot read another client's orders; support cannot mutate; restricted users cannot see label costs; shipped/cancelled guard still passes |
| `/shipments`, `/shipments/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Shipment reads scoped through related order/client/store | `requireAuth`; `LABEL_SHIPMENT_SCOPE_REVIEW.md` maps required shipment read/sync permissions and tests | Shipment table is locked; runtime read scope still needs separately reviewed implementation | Add read scoping only in a separately reviewed implementation; do not alter locked shipment mutation paths in this batch | Client user cannot read another client's shipments; locked mutation tests remain unchanged |
| `/dashboard`, `/dashboard/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Aggregates filtered to assigned client/store; support read-only | `requireAuth`; summary/daily-counts/SKU panels/inventory-risk filter explicit JWT `clientIds` / `storeIds`; cache keys include scope and financial visibility for top-SKU results | production smoke tests and broader dashboard DTO permission review still needed | Add API tests and keep role-specific DTO policy | Client user dashboard excludes other clients; support sees read-only metrics; no cost/margin fields without `financials:read` |
| `/analysis`, `/analysis/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Analytics filtered to assigned client/store; cost/margin fields require explicit permission | `requireAuth`; overview/daily shipments/top SKUs/SKU detail/SKU daily endpoints filter explicit JWT `clientIds` / `storeIds`; `financials:read` redacts shipping and selling-fee totals | Production smoke tests still needed | Add API smoke tests for restricted-role DTOs | Client user cannot access other-client SKUs; warehouse cannot see restricted margin fields |
| `/inventory`, `/inventory/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Inventory rows filtered to assigned client/store; support read-only | `requireAuth`; list/ledger/stats/alerts/detail/detail-ledger/parents/SKU-orders endpoints filter explicit JWT `clientIds` / `storeIds`; SKU-order shipping-cost fields require `financials:read` | Production smoke tests and mutation role policy still needed | Add API tests and mutation permission review in a separate batch | Client user cannot read another client's inventory; support cannot see restricted shipping-cost fields or adjust stock |
| `/billing`, `/billing/*` | `admin`, `operator` with `financials:read`, scoped user only if explicitly granted | Billing rows filtered to assigned client/store; costs/margins protected | `requireAuth`; route requires `financials:read`; config/summary/details/invoice/package-prices filter explicit JWT `clientIds` / `storeIds` | Billing mutation/generation write permission still needs finer split | Add billing write permission if needed | Warehouse denied billing; client_user only sees billing if explicitly granted |
| `/manifests`, `/manifests/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Manifest data scoped to assigned client/store/location; label costs require `financials:read` | `requireAuth`; GET/POST generate filters explicit JWT `clientIds` / `storeIds`; manifest labelCost redacts without `financials:read` | Location policy and production smoke tests still needed | Add location-aware tests if warehouse assignments are enabled | Warehouse cannot access another client manifest or restricted label cost |
| `/print-queue`, `/print-queue/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Print queue entries and queue jobs scoped by assigned client/store/location; support read-only | `requireAuth`; list/add/clear/delete/print/status/download and batch-send startup/status filter explicit JWT `clientIds` / `storeIds` | Durable job persistence, location policy, and label side-effect ownership still need review | Move visible job state to durable storage and add production smoke tests | Warehouse cannot delete another location/client queue entry or view another client's queue job |
| `/clients`, `/clients/*` | `admin`, `operator` with client-management permission, `read_only_support` read-only | Client rows global for admins; scoped users filtered by explicit JWT `clientIds` / `storeIds`; secrets never returned | `requireAuth`; client secret redaction tests; list/detail scope filtering when claims exist | Client-management mutation role and field-level policy not fully formalized | Add mutation permission and safe DTO tests per role | `/clients` never returns secrets; scoped users only see assigned clients |
| `/packages`, `/packages/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Packages scoped to location/client where applicable; unit cost requires `financials:read` | `requireAuth`; package list/detail/mutation/ledger DTOs redact unitCost without `financials:read` | Package scope and mutation role policy not fully formalized | Add package scope policy and mutation permission review | Warehouse cannot edit global package settings or see unit cost without permission |
| `/settings`, `/settings/*` | `admin`; selected operator sub-sections by permission | Global settings; credential fields protected | `requireAuth`; reads require `settings:read`; writes require `settings:write` | Settings sections are not yet split into finer-grained permission groups | Add frontend role hiding and finer setting groups if needed | Operator can access allowed settings only; unauthorized role receives `403` |
| `/carrier-accounts`, `/carrier-accounts/*` | `admin`, operator with credential permission | Credential rows scoped by assigned carrier/client/store permissions; secrets masked | `requireAuth`; method-aware credentials permission middleware; shared credential handler and safe 500s exist | Audit logging, last-used policy, and Vercel compatibility parity still need follow-up | Add credential audit events and role-specific DTO tests | Non-credential role denied; response never includes raw secret fields |
| `/carriers`, `/carriers/*` | `admin`, `operator`, `warehouse` for read/rate use; credential mutation requires credential permission | Carrier reads can be scoped to assigned account/store; secret fields protected | `requireAuth`; `/carriers/verify` now requires `credentials:write` | Broader carrier read vs mutation permissions still need route-by-route review | Split carrier read permissions from credential/admin mutations | Warehouse can rate with assigned account but cannot edit credentials |
| `/rates`, `/rates/*` | `admin`, `operator`, `warehouse`; scoped `client_user` only if allowed | Rate requests limited to assigned order/client/store/account; rate money fields require `financials:read`; account source metadata requires `credentials:read` | `requireAuth`; rate diagnostics/concurrency/caching improved; live/cached/bulk rate money fields redact without `financials:read`; carrier source client metadata redacts without `credentials:read` | Account scope still needs formal enforcement | Add rate account-scope checks | Client user cannot rate against another client's account; rate amounts and account source metadata hide where restricted |
| `/labels`, `/labels/*` | `admin`, `operator`, `warehouse` | Label actions scoped through assigned order/client/store; shipped/cancelled protections preserved | `requireAuth`; `/labels/mock/` has signed/expiring URL behavior; `LABEL_SHIPMENT_SCOPE_REVIEW.md` maps required label permissions and tests | Runtime label scope enforcement still needs a dedicated side-effect review | Add label permission tests in a dedicated batch; do not change side-effect paths here | Unauthorized role cannot create/void labels; locked order tests remain unchanged |
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
| Shipping cost, margin, billing charges | `financials:read` only | First guard covers Analysis, Dashboard top-SKUs, Inventory SKU orders, Billing, Orders export/list label costs, Manifests label cost, Packages unit cost, and Rate Browser rate-result DTOs |
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
12. [x] Add print-queue mutation/job ownership checks.
13. [x] Add remaining read-scope filters for `/orders` and `/manifests`.
14. [x] Add label/shipment-sensitive route policy review.
15. [x] Add field-level DTO tests for credentials, cost, margin, and billing visibility.
16. [x] Extend field-level financial review to Orders export/list, Manifests, Packages, and Rate Browser result DTOs.
17. [ ] Add browser tests for role-restricted UI hiding after backend enforcement exists.

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
- `npm run test:print-queue-ownership` passes.
- `npm run test:orders-manifests-scope` passes.
- `npm run test:field-level-rbac` passes.
- `npm run test:field-level-rbac-extended` passes.
- `npm run test:label-shipment-scope-review` passes.

## Out Of Scope For This Batch

- No additional query filters are changed outside Orders and Manifests in this batch.
- No shipped/cancelled mutation logic is changed.
- No shipment table mutation logic is changed.
- No label side-effect, fulfillment outbox, or inventory deduction logic is changed.
