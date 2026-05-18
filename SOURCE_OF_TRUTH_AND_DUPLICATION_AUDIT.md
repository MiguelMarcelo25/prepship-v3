# PrepShip Source-of-Truth and Duplication Audit

## Executive Summary

This is the canonical boss-facing audit for duplicate logic and source-of-truth drift in PrepShip v4. It supersedes `DUPLICATION_OPTIMIZATION_AUDIT.md`.

The highest-risk duplication remains around rate fetching/cache behavior, frontend API error handling, inventory stock calculations, and user-visible job state. Phase 11 Batch 1 moved carrier/store credential account PATCH behavior and table bootstrap logic behind shared helpers, while keeping Render/Hono as the preferred canonical API and Vercel functions as compatibility adapters.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Carrier/store account route drift | Save, rename, approve, assignment, or delete can behave differently by route | Shared credential-account service owns all DB behavior | Static guard now covers shared PATCH/assignment parity; live API smoke tests still needed |
| Auth/JWT duplication | One compatibility endpoint can validate weaker tokens than another | Shared verifier is used by every active handler | Unauth, expired, wrong issuer/audience, admin/non-admin tests |
| Client DTO duplication | ShipStation credentials can leak if raw client rows return | `publicClient` is the only mapper for client responses | Secret-redaction guard and live `/clients` smoke test |
| Rate cache/key duplication | UI can show stale/wrong/no rates and retry external APIs too often | One canonical rate cache key and diagnostics shape | cache hit/miss, one-carrier failure, all-carriers-empty tests |
| Job state duplication | Long-running work can disappear on restart or run twice | Durable job status and singleton execution | restart and dual-worker tests |

## High-Risk Issues

| Area | Current Duplicate Files/Logic | Canonical Owner To Keep | Risk If Unchanged | Recommended Patch | Test Plan |
|---|---|---|---|---|---|
| Carrier accounts | `api/carrier-accounts.ts`, `src/routes/carrier-accounts.ts`, imported handlers, settings UI | `src/services/credential-accounts.ts` plus Render route | account workflow drift | [x] PATCH rename/approval behavior moved behind service functions | GET/POST/PATCH/DELETE parity tests |
| Store accounts | `api/store-accounts.ts` mirrors carrier account CRUD | shared credential-account service | marketplace credential drift | [x] PATCH source/label behavior added through shared service; remaining provider-specific behavior still needs config cleanup | carrier/store CRUD regression tests |
| JWT/auth | Hono middleware, Vercel handlers, imported handlers | `src/lib/auth/verify-supabase-jwt.ts` | inconsistent token validation | Replace remaining legacy handler copies | auth coverage plus live token tests |
| CORS | Render app, Vercel handlers, imported handlers | `src/lib/http/cors.ts` | origin drift or overexposure | Replace remaining cron/debug/marketplace copies | OPTIONS tests for allowed/disallowed origins |
| Client DTOs | `/clients`, `/init`, frontend client shapes | `src/lib/public-client.ts` | credential leakage | enforce `publicClient` everywhere | `npm run test:client-redaction` |
| Rates/cache | routes, services, backfill, Rate Browser normalization | `src/services/rates.ts` | wrong/stale rates, API storms | centralize cache key and diagnostics | rate cache and carrier failure tests |
| Frontend API wrappers | `api.ts`, `v2-apiClient.ts`, `vercelFunction.ts` | `api.ts` transport and `v2-apiClient` domain facade | failures appear as empty data | remove critical silent fallbacks | forced 500 UI tests |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Product defaults vs inventory defaults | package/dim defaults can diverge | Pick one canonical defaults service and make inventory derived |
| Inventory stock/effective stock | ledger, stock cache, and order-derived sold metrics can disagree | `inventory_ledger` as movement history and `inventory.stockQty` as reconciled cache |
| Runtime DDL | centralized compatibility fallback still creates credential-account tables for older deployments | continue converting request-time DDL to Drizzle migrations |
| Label side effects | label creation touches shipments, packages, inventory, print queue, billing, fulfillment | return and persist side-effect statuses/warnings |
| Legacy compatibility handlers | some Vercel handlers remain near orders/shipments write paths | handle in a separately scoped lockdown-safe review |

## Recommended Patches

- [x] Add shared JWT verifier and CORS helper.
- [x] Add client secret redaction guard.
- [x] Add shared credential-account request helper and DB service.
- [x] Add auth coverage and frontend failure-state guards.
- [x] Move carrier/store PATCH rename/approval behavior behind shared service functions.
- [ ] Replace remaining JWT/CORS copies in legacy/maintenance handlers.
- [~] Move runtime table/index bootstrap into migrations.
- [ ] Centralize rate cache key, diagnostics DTO, concurrency policy, and negative cache.
- [ ] Add inventory reconciliation service.
- [ ] Move user-visible print queue/rate backfill status out of process memory.
- [ ] Add label side-effect status reporting.

## Detailed Checklist

### Carrier and Store Accounts

- [x] Shared credential-account request normalization helper.
- [x] Drift guard for duplicated provider/source/body parsing.
- [x] Shared service boundary for list/upsert/delete/assignment operations.
- [x] PATCH rename/approval service consolidation.
- [x] `store_accounts` and `carrier_account_clients` added to migration source of truth.
- [ ] Vercel functions kept only as compatibility wrappers.
- [~] Runtime DDL moved to migrations.
- [ ] `CarrierIntegrationsCard` endpoint policy confirmed.
- [ ] Regression tests for rename, approve, assignment, delete, pending portal rows.

### Auth and CORS

- [x] Shared JWT verifier with strict-claims option.
- [~] Duplicated verifier replacement in active handlers.
- [x] Shared CORS helper.
- [x] Static guard for protected root/wildcard auth gates.
- [x] Static guard for `/admin` root/wildcard admin gates.
- [ ] Live API tests for unauthenticated paths and non-admin admin denial.

### Rates and Frontend Failures

- [x] Critical frontend methods guarded against `safe()` empty fallbacks.
- [x] `fetchRates` throws request failures to caller error states.
- [x] billing summary rethrows first-load failures while preserving stale cache.
- [ ] canonical `rateCacheKey`.
- [ ] approximate bulk cache marking.
- [ ] carrier diagnostics retained through backend and UI.
- [ ] `RATE_FETCH_CONCURRENCY` enforcement verified.
- [ ] no-rate negative cache with diagnostics.
- [ ] visible retry/error states for all critical screens.

## Test Plan

- `npm run typecheck`
- `npm run build:web`
- `npm run test:auth-coverage`
- `npm run test:client-redaction`
- `npm run test:credential-accounts`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- Live API smoke tests for `/users`, `/clients`, `/admin/*`
- Settings carrier integration browser audit
- Rate Browser browser audit
- Render log review for duplicated account/rate calls

## Deployment/Rollback Notes

- Deploy documentation-only changes without runtime risk.
- For future code patches, deploy in small batches: auth/CORS, credentials, rates, frontend failures, then jobs/inventory.
- Roll back by reverting the most recent implementation batch if smoke tests fail.
- Do not remove compatibility handlers until frontend routing and Render/Vercel rewrites are verified.
