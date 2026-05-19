# PrepShip RBAC / Client-Scope Route Matrix

## Executive Summary

This document is the Phase 12 Batch 1 RBAC planning deliverable. It defines the canonical role names, route-group access expectations, client/store scoping rules, current enforcement, gaps, required fixes, and tests needed before runtime permission middleware is implemented.

This batch is documentation/control work only. It does not change runtime behavior, shipped/cancelled mutation guards, shipment logic, label creation, or fulfillment side effects.

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
| `/users`, `/users/*` | `admin` by default; future `/users/me` can be authenticated-self | Global user-management scope | `requireAuth` | User-management role policy not fully formalized | Add user-management permission middleware; split `/users/me` if needed | Operator/client/support denied from `/users`; self endpoint still works if created |
| `/orders`, `/orders/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Rows filtered to assigned client/store; support read-only; client_user only own client/store | `requireAuth`; shipped/cancelled mutation guards exist | No formal client/store scope middleware | Add scope-aware order query filters and mutation permission checks without weakening locked surfaces | Client user cannot read another client's orders; support cannot mutate; shipped/cancelled guard still passes |
| `/shipments`, `/shipments/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Shipment reads scoped through related order/client/store | `requireAuth` | Shipment table is locked; read scope needs policy, mutation review needs separate human plan | Add read scoping only in a separately reviewed implementation; do not alter locked shipment mutation paths in this batch | Client user cannot read another client's shipments; locked mutation tests remain unchanged |
| `/dashboard`, `/dashboard/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Aggregates filtered to assigned client/store; support read-only | `requireAuth` | Dashboard metrics currently rely on auth, not formal scope policy | Add scoped aggregate filters and dashboard DTO permission policy | Client user dashboard excludes other clients; support sees read-only metrics |
| `/analysis`, `/analysis/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user`, scoped `read_only_support` | Analytics filtered to assigned client/store; cost/margin fields require explicit permission | `requireAuth` | Scope and field-level analytics permissions are not formalized | Add scoped analysis filters and field-level DTOs | Client user cannot access other-client SKUs; warehouse cannot see restricted margin fields |
| `/inventory`, `/inventory/*` | `admin`, `operator`, `warehouse`, scoped `client_user`, scoped `read_only_support` | Inventory rows filtered to assigned client/store; support read-only | `requireAuth` | No formal client/store scope middleware | Add inventory scope filter and mutation role checks | Client user cannot read another client's inventory; support cannot adjust stock |
| `/billing`, `/billing/*` | `admin`, `operator` with billing permission, scoped `client_user` if explicitly allowed | Billing rows filtered to assigned client/store; costs/margins protected | `requireAuth` | Billing role and field-level visibility are not formalized | Add billing permission and DTO redaction for restricted roles | Warehouse denied billing; client_user only sees own approved billing fields |
| `/manifests`, `/manifests/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Manifest data scoped to assigned client/store/location | `requireAuth` | No formal client/store/location scope middleware | Add scoped manifest queries and mutation role checks | Warehouse cannot access another location/client manifest |
| `/print-queue`, `/print-queue/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Print queue entries scoped by assigned client/store/location; support read-only | `requireAuth` | Queue entry ownership and role policy not formalized | Add scoped queue reads and mutation permissions | Warehouse cannot delete another location/client queue entry |
| `/clients`, `/clients/*` | `admin`, `operator` with client-management permission, `read_only_support` read-only | Client rows global for admins; scoped/read-only for support/client_user if enabled; secrets never returned | `requireAuth`; client secret redaction tests exist | Client-management role and field-level policy not formalized | Add client-management permission and safe DTO tests per role | `/clients` never returns secrets; non-client-management roles denied or scoped |
| `/packages`, `/packages/*` | `admin`, `operator`, `warehouse`, scoped `read_only_support` | Packages scoped to location/client where applicable; cost fields protected | `requireAuth` | Package scope and package-cost visibility not formalized | Add package scope policy and cost DTO guards | Warehouse cannot edit global package settings without permission |
| `/settings`, `/settings/*` | `admin`; selected operator sub-sections by permission | Global settings; credential fields protected | `requireAuth` | Settings sections are not split by permission | Add settings permission groups and frontend/backend enforcement | Operator can access allowed settings only; credential settings require permission |
| `/carrier-accounts`, `/carrier-accounts/*` | `admin`, operator with credential permission | Credential rows scoped by assigned carrier/client/store permissions; secrets masked | `requireAuth`; shared credential-account handler and safe 500s exist | Credential RBAC, audit logging, and last-used policy incomplete | Add credential permission middleware, audit events, and role-specific DTOs | Non-credential role denied; response never includes raw secret fields |
| `/carriers`, `/carriers/*` | `admin`, `operator`, `warehouse` for read/rate use; credential mutation requires credential permission | Carrier reads can be scoped to assigned account/store; secret fields protected | `requireAuth`; shared verifier on active compatibility handlers | Read vs credential mutation permission is not formalized | Split carrier read permissions from credential/admin mutations | Warehouse can rate with assigned account but cannot edit credentials |
| `/rates`, `/rates/*` | `admin`, `operator`, `warehouse`; scoped `client_user` only if allowed | Rate requests limited to assigned order/client/store/account; cost/margin display protected | `requireAuth`; rate diagnostics/concurrency/caching improved | Account scope and margin visibility need formal policy | Add rate account-scope checks and field-level result DTOs | Client user cannot rate against another client's account; margin hidden where restricted |
| `/labels`, `/labels/*` | `admin`, `operator`, `warehouse` | Label actions scoped through assigned order/client/store; shipped/cancelled protections preserved | `requireAuth`; `/labels/mock/` has special bypass/signed URL behavior | Label side effects and role policy need separate review | Add label permission tests in a dedicated batch; do not change side-effect paths here | Unauthorized role cannot create/void labels; locked order tests remain unchanged |
| `/sync`, `/sync/*` | `admin`, operator with sync permission | Global/service operational scope | `requireAuth` | Sync permission and visibility not formalized | Add sync permission and audit events | Warehouse/client user denied sync start; status visibility policy documented |
| `/worker`, `/worker/*` | `admin`, operator with operations permission, read-only support for status if allowed | Global worker/job status; no client scope unless job details include client data | `requireAuth` | Worker status role policy not formalized | Add worker status permission and redact sensitive job payloads | Client user denied worker status; support gets read-only safe status if allowed |
| `/locations`, `/locations/*` | `admin`, `operator`, `warehouse` scoped by location | Location rows filtered to assigned warehouse/location where applicable | `requireAuth` | Location scope not formalized | Add location assignment policy | Warehouse cannot access another location if assignments are enabled |
| `/parent-skus`, `/parent-skus/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user` if allowed | SKU rows filtered to assigned client/store | `requireAuth` | SKU/client scope policy not formalized | Add SKU scope filters and mutation role checks | Client user cannot access another client's SKU mappings |
| `/products`, `/products/*` | `admin`, `operator`, scoped `warehouse`, scoped `client_user` if allowed | Product/default rows filtered to assigned client/store | `requireAuth` | Product default ownership and scope policy not formalized | Add product scope filters and default-edit permissions | Client user cannot edit unrelated product defaults |
| `/init`, `/init/*` | authenticated app users; data scoped by role | Initial payload must include only role/client/store-allowed data; secrets redacted | `requireAuth`; client redaction guard exists | Role-based init payloads are not formalized | Add role-aware init DTOs and assignment filters | Client user init payload excludes other clients and secrets |

## Field-Level Protection Matrix

| Data class | Default visibility | Required policy |
|---|---|---|
| ShipStation client keys and secrets | Never visible in frontend responses | Continue redaction tests; add role-specific credential DTO tests |
| Carrier/store credential values | Never visible in frontend responses | Credential permission only for create/update/delete; masked IDs for reads |
| Label PDFs and customer addresses | Operational roles only, scoped to assigned order/client/store | Add scoped access tests and audit logs |
| Shipping cost, margin, billing charges | Admin/operator billing roles by default | Add field-level DTOs for warehouse/client/support roles |
| Audit logs | Admin and read-only support by policy | Add immutable audit table and role-gated query route later |

## Required Implementation Order

1. Add shared permission constants and role names.
2. Add a `requirePermission` / `requireRole` wrapper around current auth variables.
3. Add a client/store assignment scope helper.
4. Apply admin-only policy to `/users` and keep `/admin` covered.
5. Apply credential permissions to `/settings`, `/carrier-accounts`, `/carriers`, and credential mutations.
6. Add read-scope filters for `/orders`, `/dashboard`, `/analysis`, `/inventory`, `/billing`, and `/manifests`.
7. Add field-level DTO tests for credentials, cost, margin, and billing visibility.
8. Add browser tests for role-restricted UI hiding after backend enforcement exists.

## Required Tests

- Unauthenticated protected route roots and wildcards return `401`.
- Non-admin token returns `403` for `/admin` and future admin-only `/users`.
- Client user cannot read another client's orders, inventory, billing, dashboard, analysis, manifests, labels, or print queue data.
- Read-only support can view allowed data but cannot mutate.
- Warehouse can perform assigned operational workflows but cannot see credential or restricted billing/margin fields.
- `/clients` and `/init/init-data` never return `ssApiKey`, `ssApiSecret`, or `ssApiKeyV2`.
- Credential endpoints never return raw credential secret values.
- Shipped/cancelled immutability tests keep passing.

## Out Of Scope For This Batch

- No runtime permission middleware is implemented in this batch.
- No query filters are changed in this batch.
- No shipped/cancelled mutation logic is changed.
- No shipment table mutation logic is changed.
- No label side-effect, fulfillment outbox, or inventory deduction logic is changed.
