# PS-050 - Make Awaiting Shipment Rates Accurate, Cache-First, and Rate-Limit Safe

Created from DJ handoff on 2026-06-01.

Status: Updated replacement task. Supersedes PS-049 and the earlier PS-050 draft. Use this PS-050 text as source of truth.

Repo: `https://github.com/drprepperusa-org/prepship-v4.git`

Branch: `prepshipv4-stable`

Assignee: `<@714064895963955211>`

## Context

Awaiting Shipment rates can spin for minutes, saved table rates can differ from later live Rate Browser/refetch results, and auto-rating may not start until Rate Browser/manual live fetch loads carrier accounts.

Critical DJ safety clarification: backfilled/cached/saved rates must match the exact current shipment request. Do not use dimensions alone. Matching must account for destination ZIP/location, weight, dimensions, carrier/account eligibility, store/client/source credential context, residential/confirmation, markup/rate-engine version, and ship-date/rate-date policy. If a cached rate is used for a new order, the system must not miss a cheaper rate available for that new order under the current eligible carrier/account set.

Observed evidence:

- Order `#1107` displayed a saved best rate because `order_overrides.best_rate_json` existed and `bestRateDims` matched.
- Saved vs live refetch differed: prior saved UPS SurePost ORION provider `596001`, `$8.31` base, rated May 30 8:10 PM PDT; later live refetch UPS SurePost ROCEL C81F70 provider `607855`, `$10.30` base, rated May 31 12:18 PM PDT; dims were still `12x10x3`.
- Current saved-rate guard is positive amount plus matching dims only. That is unsafe.
- Live ShipStation rate service sends current `ship_date`; yesterday's saved rate can differ from today's live rate.
- Backend cache TTL exists, but persisted order best rates are not automatically expired by that TTL.
- `OrdersView.tsx` gates `useShippingAccounts({ enabled })` behind support UI states, and auto-rate skips normal orders when `carrierIds.length === 0`.
- Current passive auto-rating is serial: `workerCount = Math.min(1, queue.length)`.
- A fresh 50-order Awaiting Shipment page can fan out to about 400 ShipStation `/v2/rates/estimate` calls when 8 carrier accounts are active.
- ShipStation's default allowance is 200 requests/minute; PrepShip's safe target is at most 160 ShipStation requests/minute.
- The old v2 client limiter `TokenBucket(40, 40 / 1500)` allowed about 1600 requests/minute, roughly 8x higher than ShipStation's default allowance.

## Inspect First

- `web/src/components/Views/OrdersView.tsx` - support-data enablement, shipping accounts, auto-rate effect, saved-rate guards, best-rate rendering/persistence.
- `web/src/lib/v2-apiClient.ts` - rates API methods; add/use `POST /rates/cached/bulk` client if missing.
- `src/routes/orders.ts` - order DTO mapping, `bestRateAt`, `bestRateDims`, `PATCH /orders/:id` best-rate persistence.
- `src/routes/rates.ts` - `/rates`, `/rates/browse`, `/rates/cached/bulk`, `/rates/backfill-best`.
- `src/services/rates.ts` - cache key/input resolution/live diagnostics/ship date/cache TTL/rate concurrency.
- `src/services/rates-backfill.ts` - candidate/staleness logic, concurrency, persistence.
- `src/services/sync-scheduler.ts`, `src/lib/env.ts`, `src/lib/shipstation/client.ts` - scheduler/env/limiter/retry behavior.
- Existing Orders/Rate Browser E2E specs, especially `web/e2e/orders-column-integrity.spec.js`.

## Implementation Requirements

### Add A Real Saved-Rate Validity Model

- Dims-only matching is forbidden.
- Persist or derive a full best-rate request fingerprint for saved order rates and cached bulk hits.
- Fingerprint/freshness must cover at minimum: weight, dims, destination ZIP/country/state/city or documented normalized destination key, residential flag, confirmation/signature, sorted eligible carrier/account IDs or account-set hash/version, store ID, client/source-client/source credential context, markup/rate-engine/cache version, and ship date/date bucket.
- Include `bestRateAt` freshness. Do not present old rates as current forever. Choose/document TTL/date policy; align with backend rate cache TTL unless there is a better reason not to.
- Add migration/schema support if needed for fingerprint/request metadata on `order_overrides` or equivalent persisted structure.

### Make Saved-Rate Display Accuracy-Safe

- Display a saved best rate as current only when fingerprint + freshness + completeness match the current request.
- If dims match but fingerprint/freshness/completeness fails, show stale/refreshing or safe placeholder; do not show as clean current best rate.
- Historical/provenance info is fine, but do not confuse historical rates with current rates.

### Make Backfill/Cache Reuse Exact-Match And Complete-Response Only

- Never blindly copy another order's `best_rate_json`.
- A cached/saved hit can hydrate a new/current order only if the full request fingerprint matches exactly, it is fresh, and it represents a complete rate-shopping result for the same eligible carrier/account set.
- `POST /rates/cached/bulk` must return or derive enough safety metadata: `matchType` exact/rough/miss, cache key/fingerprint, cache creation/expiry, eligible carrier-account set hash/list/version, rate count, partial carrier failures, and `isComplete`.
- Missing metadata, rough hit, stale hit, account-set change, credential/store/client change, markup/rate-engine change, ship-date bucket change, or incomplete/partial carrier result must be treated as miss/stale and queued for bounded live refresh, not auto-applied.
- For DJ's "what if another rate is cheaper for the new order?" concern: recompute best rate from all eligible current-equivalent rates for the current order. Do not assume a prior saved best remains best if a new eligible carrier/account, changed account set, changed markup logic, changed ship date, or live/cache refresh exposes a cheaper option.
- Exact cache reuse is acceptable only when the cached response is the complete current-equivalent response. Otherwise refresh.
- Same dims but different ZIP, weight, carrier/account set, store/client/source credential, residential/confirmation, or ship-date/rate-date bucket must miss/invalidate.

### Fix Auto-Rating Trigger

- Awaiting Shipment passive rating must start on plain page load.
- It must not require opening Rate Browser, selecting an order, opening New Order, opening queue, or sorting by customer carrier to load carrier/account set.
- Either enable needed shipping-account data when `currentStatus === 'awaiting_shipment'` and candidate orders exist, or move passive auto-rating to a backend queue that resolves accounts server-side.
- Avoid loading unnecessary support data on unrelated tabs/pages.

### Make Passive Loading Cache-First But Safe

- Use `POST /rates/cached/bulk` before live-rating visible/candidate Awaiting Shipment orders.
- Hydrate only exact, fresh, complete cached/saved rates.
- Keep `forceRefresh: true` only for explicit user actions like manual Rate Browser/Refresh Rates.
- Passive page-load/background refresh must not force-live every order.

### Bounded Observable Refresh

- Enqueue only missing/stale/no-exact-complete-cache orders for live refresh.
- Preserve request-key tracking to avoid repeated loops.
- Show per-row/panel status: rating, stale, refresh failed, ready.
- Persist refreshed best rates with fingerprint/freshness/completeness metadata.

### Concurrency And Rate Limits

- Evaluate safe increase above 1 browser worker, but do not blindly raise without limiter controls.
- Preserve/centralize `RATE_FETCH_CONCURRENCY`; account for backfill order x carrier fanout.
- Add/align a global limiter so passive auto-rating, manual Rate Browser, and backfill cannot exceed safe limits. ShipStation public default is up to 200 requests/minute, but provider `429`s are authoritative.
- Preserve `429`/partial-carrier diagnostics; do not hide provider failures.

### Rate Browser / Manual Behavior

- Manual live Rate Browser/refetch must still force live rates.
- If manual live result differs from saved display, update/persist the new current result with fingerprint/freshness metadata.
- Do not regress partial carrier failure badges/diagnostics.

### Backfill / Scheduler Alignment

- Update rates-backfill candidate/staleness logic to use fingerprint + freshness + completeness, not dims-only.
- Backfill must not overwrite a valid current exact saved rate with older/rough/incomplete data.
- Backfill must not trigger uncontrolled live rate floods on page load.
- Respect `ENABLE_RATE_BACKFILL_SCHEDULER` / `DISABLE_RATE_BACKFILL_SCHEDULER`; do not hard-code production env values.

## Guardrails / Forbidden Changes

- Do not buy postage, create labels, send marketplace notifications, or mutate shipped/cancelled orders.
- Do not weaken auth/RBAC, client/store scope, source-of-truth constraints, financial redaction, credential protections, secret redaction, or production safety policies.
- Do not expose API keys, tokens, raw provider credentials, raw labels, customer PII, or cross-client data in logs/tests/screenshots.
- Do not solve by hiding the spinner only; fix correctness and request flow.
- Do not remove saved-rate reuse; make it safe with fingerprint/freshness/completeness.

## Testing Applicability

This affects a real operator shipping workflow and crosses ShipStation/carrier boundaries. It requires browser/E2E coverage with mocked/intercepted APIs plus lower-level tests for fingerprint/freshness/completeness, cache/backfill exactness, and queue/concurrency. No live label/postage/marketplace mutations. Any live-provider check must be read-only/dry-run and documented.

## Required Tests / Verification

Add/update browser E2E, recommended:

- `web/e2e/orders-rate-accuracy-and-autostart.spec.js`

Must prove:

- Awaiting Shipment rows render immediately.
- Carrier/account data for passive rating loads on plain Awaiting Shipment load without Rate Browser or selected order.
- Auto-rating starts on plain page load.
- Saved rate with matching dims but stale/mismatched/incomplete fingerprint is not shown as clean/current and is queued/refreshed or marked stale.
- Saved rate with matching fingerprint/freshness/completeness displays immediately and is not re-rated.
- Initial passive flow uses `POST /rates/cached/bulk`.
- Passive background refresh does not send `forceRefresh: true` for every order.
- Manual Rate Browser/Refresh can still force live rates.
- Cache misses/stale/incomplete hits refresh with bounded concurrency.

Add lower-level fingerprint/freshness/completeness tests. They must fail against the current dims-only bug. Include cases where dimensions match but weight, ZIP, carrier/account set, confirmation, client/source credential, ship-date bucket, account-set version, markup version, cache age, or completeness changes.

Add backfill/cache exactness tests:

- Same dims but different ZIP must not reuse/apply.
- Same dims + ZIP but different weight must not reuse/apply.
- Same dims + ZIP + weight but different eligible carrier/account set must not reuse/apply.
- Same request but stale cache marks stale/refresh, not final-current.
- Rough/incomplete/unknown metadata must not auto-apply.
- If current-equivalent cached/live response includes a cheaper eligible rate than prior saved best, choose/persist the cheaper current eligible rate.
- Backfill must not overwrite valid current exact saved rate with older/rough/incomplete data.

Add/verify deterministic concurrency tests proving configured limits are respected and not unnecessarily serial when safe concurrency is configured.

Run:

```bash
npm run typecheck
npm run build:web
npm run guard:source-of-truth
npx playwright test web/e2e/orders-rate-accuracy-and-autostart.spec.js --reporter=line
npx playwright test web/e2e/orders-column-integrity.spec.js --reporter=line
```

If migration/schema changes are added, run migration validation/generation checks and include exact command/result.

## Definition Of Done

- Awaiting Shipment no longer displays stale/mismatched saved rates as current accurate rates.
- Saved-rate reuse uses fingerprint + freshness + completeness, not dims-only.
- Backfill/cache reuse is exact-match only and never blindly copies another order's best rate.
- Stale/mismatched/incomplete/rough hits are marked/refreshed safely.
- The app recomputes best rate from all eligible current-equivalent rates and does not miss a cheaper eligible rate for the current/new order.
- Passive auto-rating starts on plain Awaiting Shipment load without Rate Browser/manual fetch.
- Passive flow is cache-first and uses exact bulk cached lookup only when safe.
- Missing/stale rates refresh with bounded concurrency and rate-limit protection.
- Manual Rate Browser live refresh still works and can update saved current rates.
- Backfill scheduler aligns with fingerprint/freshness/completeness policy.
- Required tests pass.

## Return Format

- Files changed.
- Schema/migration changes, if any.
- Before/after behavior for saved/stale rates, cache/backfill reuse, and auto-start rating.
- Evidence that dims-only and same-dims-different-ZIP/weight/carrier-set cases no longer apply as current.
- Evidence that a cheaper current eligible rate replaces prior saved best.
- Evidence auto-rating starts without Rate Browser/manual fetch.
- Effective concurrency/rate-limit settings and why safe vs ShipStation default 200 requests/minute.
- Commands run and pass/fail results.
- Remaining risks/follow-up tasks.
