# PrepShip Duplication and Optimization Audit

## Executive Summary

This audit maps duplicate logic and source-of-truth drift in PrepShip v4. The highest-risk duplication is around credential/account handlers, JWT/CORS verification, rate fetching/cache logic, frontend API error handling, inventory stock calculations, and job state.

The recommended direction is to keep Render/Hono as the canonical app API, move shared behavior into `src/services/*` or `src/lib/*`, and leave Vercel serverless handlers as thin compatibility adapters only where they still must exist.

## Phase 11 Progress Update

Status: first implementation batches completed; credential-account database consolidation is now in progress.

Completed in this batch:

- Added canonical Supabase JWT verifier: `src/lib/auth/verify-supabase-jwt.ts`.
- Added canonical CORS helper: `src/lib/http/cors.ts`.
- Moved Hono `requireAuth` to the shared verifier.
- Moved `src/main.ts` to the shared CORS allowlist helper.
- Replaced duplicated JWT/CORS helpers in the active compatibility handlers:
  - `api/carrier-accounts.ts`
  - `api/store-accounts.ts`
  - `api/carriers/rates.ts`
  - `api/carriers/verify.ts`
  - `api/carriers/validate-address.ts`
  - `api/carriers/walmart/probe-carriers.ts`
  - `src/lib/imported-handlers/carrier-accounts.ts`
  - `src/lib/imported-handlers/rates-multi.ts`
  - `src/lib/imported-handlers/carriers-verify.ts`
- Stopped those handlers from returning JWT verifier internals to the browser.
- Added client DTO redaction guard: `npm run test:client-redaction`.
- Removed frontend credential-presence inference from raw client secret response fields.
- Added shared credential-account request helper: `src/lib/credential-accounts.ts`.
- Moved carrier/store compatibility handlers onto the shared provider/source/body parsing helper.
- Added credential-account drift guard: `npm run test:credential-accounts`.
- Added shared credential-account database service: `src/services/credential-accounts.ts`.
- Moved active carrier/store compatibility handlers onto shared list/upsert/delete/client-assignment operations:
  - `api/carrier-accounts.ts`
  - `api/store-accounts.ts`
  - `src/lib/imported-handlers/carrier-accounts.ts`
- Added guard coverage that prevents those handlers from returning raw internal 500 error text to the browser.

Still duplicated and tracked for the next batch:

- Legacy/maintenance Vercel handlers still contain local JWT/CORS copies: `api/migrate-from.ts`, `api/admin/fix-marketplace-timestamps.ts`, `api/carriers/labels.ts`, `api/carriers/ebay/orders.ts`, `api/carriers/walmart/orders.ts`, `api/carriers/walmart/fees.ts`, and cron/debug handlers.
- Label, marketplace order, and fee-fix handlers are intentionally deferred because they sit close to `orders`/`shipments` write paths and need a separately scoped lockdown-safe review.
- Runtime DDL remains in carrier/store compatibility handlers, marketplace order handlers, fulfillment outbox setup, label compatibility code, and orders maintenance.
- `web/src/lib/v2-apiClient.ts` still has broad `safe()` fallback usage; critical workflows need a second pass after the auth/CORS consolidation.

## Source-of-Truth Map

| Area | Current Duplicate Files/Logic | Canonical Owner To Keep | Files/Routes To Replace | Risk If Unchanged | Optimization | Test Plan |
|---|---|---|---|---|---|---|
| Carrier accounts | `api/carrier-accounts.ts`, `src/routes/carrier-accounts.ts`, `src/lib/imported-handlers/carrier-accounts.ts`, `web/src/lib/vercelFunction.ts`, settings cards | `src/services/credential-accounts.ts` for shared DB behavior plus `src/routes/carrier-accounts.ts` as canonical Render route | Active compatibility handlers now use shared request parsing plus shared list/upsert/delete/client-assignment operations. Remaining: PATCH rename/approval-specific behavior and runtime DDL migration backlog. | High: account create/rename/approve/delete can drift by route | Continue moving route-specific behavior behind service functions; route adapters only parse HTTP | Guard tests plus API tests for GET/POST/PATCH/DELETE through Render and retained Vercel adapter |
| Store accounts | `api/store-accounts.ts` mirrors carrier account CRUD and bootstrap logic | Shared `src/services/credential-accounts.ts` with provider/table config | Active handler now uses shared request parsing, list/upsert/delete, and synthetic client helpers. Remaining: one-time data migration and runtime DDL need formal migrations. | High: marketplace credentials can diverge from carrier credential behavior | Config-driven service for `carrier_accounts` and `store_accounts` | Integration tests for store and carrier CRUD using the same service expectations |
| Supabase JWT/auth verification | `src/middleware/auth.ts`, `api/*`, `api/carriers/*`, `src/lib/imported-handlers/*` | `src/lib/auth/verify-supabase-jwt.ts` | First batches replaced Hono auth, carrier/store accounts, direct carrier rates/verify, address validation, Walmart carrier probe, and imported active handlers. Remaining legacy/maintenance Vercel handlers still need migration. | Critical: one endpoint may accept weaker tokens than another | One verifier with optional strict issuer/audience and role extraction | Unauth, expired token, wrong issuer, wrong audience, admin/non-admin route tests |
| CORS allowlists | `src/main.ts`, `api/*`, imported handlers | `src/lib/http/cors.ts` | First batches replaced Hono app CORS, carrier/store accounts, direct carrier rates/verify, address validation, Walmart carrier probe, and imported active handlers. Remaining cron/debug/marketplace compatibility handlers still need migration. | Medium/high: production origin can fail on one path or overly broad CORS can expose APIs | Shared allowlist from env plus local dev defaults | OPTIONS tests for Vercel and Render paths with allowed and disallowed origins |
| Client DTO and secret redaction | `src/routes/clients.ts`, `src/routes/init.ts`, frontend client shapes | `src/lib/public-client.ts` | Replace any raw client returns | Critical: ShipStation keys can leak to browser | All client responses go through `publicClient` | Curl/API tests assert no `ssApiKey`, `ssApiSecret`, or `ssApiKeyV2` in JSON |
| Rates/cache/browser/backfill | `src/services/rates.ts`, `src/routes/rates.ts`, `src/services/rates-backfill.ts`, `web/src/lib/v2-apiClient.ts`, `RateBrowserModal` | `src/services/rates.ts` for cache keys, diagnostics, fetch policy | Replace weak cache matching and duplicated frontend normalization | High: wrong/stale rates, repeated carrier API calls, misleading "no rates" UI | Shared cache key builder, diagnostics DTO, bounded concurrency, negative cache | Tests for cache hit, cache miss, one carrier fail, all carriers empty, duplicate nickname |
| Frontend API wrappers | `web/src/lib/api.ts`, `web/src/lib/v2-apiClient.ts`, `web/src/lib/vercelFunction.ts` | `web/src/lib/api.ts` as low-level transport; `v2-apiClient` as typed domain facade | Remove silent fallback behavior from critical workflows | High: API 500/auth failures appear as empty data | One normalized error policy; preserve stale data instead of fake empty arrays | Forced 500 tests for orders, inventory, counts, rates, billing summary |
| Product defaults and inventory defaults | `src/routes/products.ts`, `src/routes/inventory.ts`, `product_defaults`, inventory SKU fields, frontend save defaults | Product/default service as canonical source; inventory consumes derived values | Replace warning-only mirror writes | Medium/high: labels/rates can use stale dims/package | One write path updates canonical defaults and invalidates derived inventory cache | Save default package/dims, reload order drawer, verify rate/label uses same defaults |
| Inventory stock/effective stock | `src/routes/inventory.ts`, `src/services/fulfillment-deductions.ts`, `src/routes/admin.ts`, `inventory.stockQty`, `inventory_ledger`, `order_items` | `inventory_ledger` as movement history; `inventory.stockQty` as materialized cache | Replace repeated live recompute patterns with reconciliation service | High: stock table, billing, and warehouse operations can disagree | `src/services/inventory-reconciliation.ts` to rebuild/check cache | Reconcile ledger vs stock, receive/adjust/ship flows, negative-stock checks |
| Jobs/scheduler/print queue/sync state | `src/services/rates-backfill.ts`, `src/services/print-queue.ts`, `src/services/sync-scheduler.ts`, `sync-job-queue.ts` | DB-backed jobs/leases using pg-boss or a shared jobs table | Replace process-local progress/status where user-visible or long-running | Medium/high: restart loses status; multi-instance duplicates work | Shared durable job runner with locks, progress, retries, failure state | Restart worker during job, verify status survives; run two workers, verify singleton |
| Label creation side effects | `src/routes/labels.ts`, `src/services/labels.ts`, `fulfillment-deductions.ts`, print queue, fulfillment outbox, billing lines | `src/services/labels.ts` orchestrates and reports side effects | Replace fire-and-forget side effects without visible warnings | High: label exists but inventory/package/billing/fulfillment diverges | Response includes side-effect statuses and warnings | Create label with deduction failure, outbox failure, print queue failure; verify UI warning |

## Detailed Checklist

### Carrier and Store Accounts

- [x] Create shared credential-account request normalization helper.
- [x] Add automated drift guard for duplicated provider/source/body parsing.
- [x] Create a shared account service boundary for carrier and store list/upsert/delete/assignment operations.
- [ ] Move remaining PATCH rename/approval behavior behind service functions where safe.
- [ ] Keep Vercel functions only as compatibility wrappers while frontend rewrites remain.
- [ ] Move runtime table/index bootstrap into migrations.
- [ ] Confirm `CarrierIntegrationsCard` uses one endpoint policy per account type.
- [ ] Add regression tests for rename, approve, assignment, delete, and pending portal rows.

### Auth and CORS

- [x] Extract shared JWT verifier with strict-claims option.
- [~] Replace duplicated verifier functions in Vercel and imported handlers.
- [x] Extract shared CORS header/allowlist helper.
- [ ] Add tests for unauthenticated root paths and wildcard paths.
- [ ] Confirm admin-only routes reject non-admin tokens.

### DTOs and Secrets

- [x] Use `publicClient` for every endpoint returning client rows in `/clients` and `/init/init-data`.
- [x] Add automated assertions that client responses do not expose ShipStation secrets (`npm run test:client-redaction`).
- [x] Track credential presence with booleans only in client response consumers.
- [x] Confirm frontend update payloads do not overwrite existing secrets with blank redacted values.

### Rates

- [ ] Treat `rateCacheKey` as the only canonical rate cache key.
- [ ] Mark weight/zip-only bulk cache reads as approximate unless exact keys are available.
- [ ] Keep carrier diagnostics in route and UI responses.
- [ ] Limit ShipStation fanout with `RATE_FETCH_CONCURRENCY`.
- [ ] Cache no-rate results for a short TTL with diagnostics.

### Frontend API Layer

- [ ] Identify all critical methods still using silent fallback.
- [ ] Preserve stale data on refresh failure.
- [ ] Add visible retry/error state for orders, inventory, billing, rate browser, counts, and init data.
- [ ] Keep true empty state visually different from request failure.

### Inventory and Jobs

- [ ] Document inventory ledger as canonical movement history.
- [ ] Add a reconciliation service for `inventory.stockQty`.
- [ ] Move user-visible job state out of process memory.
- [ ] Keep scheduler jobs protected by advisory lock or pg-boss singleton.
- [ ] Add job restart and duplicate-worker tests.

## Recommended Implementation Order

1. Shared JWT/CORS utilities.
2. Client DTO redaction enforcement tests.
3. Carrier/store account service consolidation.
4. Frontend API error policy cleanup.
5. Rate cache/diagnostics consolidation.
6. Durable jobs and scheduler state.
7. Inventory reconciliation service.
8. Label side-effect status reporting.

## Required Verification

- `npm run typecheck`
- `npm run build:web`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:orders-ux`
- API auth smoke tests for `/users`, `/clients`, `/admin/*`
- Secret redaction smoke tests for `/clients` and `/init/init-data`
- Browser audit of Settings carrier integrations and Rate Browser
- Render log check for duplicated account/rate calls
