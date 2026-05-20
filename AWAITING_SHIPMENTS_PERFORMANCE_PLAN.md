# Awaiting Shipments Performance Plan

## Executive Summary

PrepShip should not jump straight to AWS migration or order archiving until the Awaiting Shipment delay is traced from browser to API to Supabase. The immediate goal is to prove where the page stalls, then fix the confirmed hot path.

Current status: investigation scoped. Browser API calls now send `X-Request-Id`, and that same ID flows through the response header, `[api:timing]` / `[api:error]` logs, and detailed `[orders:list]` logs so Network requests and console errors can be correlated with Render route and segment timings. When debugging a slow browser, enable opt-in timing logs with `localStorage.setItem('prepship:apiTiming', '1')` and reload.

DJ/OpenClaw escalation added on May 20, 2026: the site was fast earlier the same day, so this must be treated as a live incident investigation before any AWS migration or broad archive plan. The key question is what changed or overlapped: Render restart/deploy, Supabase pressure, worker/sync overlap, exact count slowdown, startup maintenance/backfill/analyze work, or frontend boot overfetching.

Phase 9 follow-up: the first low-risk startup guard now prevents Orders from fetching locations and carrier accounts until an order action, drawer, queue, rate browser, new-order flow, or shipping-account sort actually needs those shared records. The first Orders page can skip the expensive exact count and show an approximate `+` total until the delayed exact count refresh completes. The legacy sidebar count path waits until after first paint, slows polling, and skips hidden tabs. Orders sync and worker status polling are delayed and hidden-tab gated. Global markups/settings hydration is delayed on Orders routes while Settings/Rates direct visits stay immediate. The New Order modal, order-detail drawer, and tracking modal are now code-split and only load after the operator asks for them. Orders performance maintenance is now explicit opt-in with `RUN_ORDERS_PERFORMANCE_MAINTENANCE=true`; it must stay disabled on the user-facing API unless an operator intentionally runs a maintenance window.

## Critical Blockers

- [ ] Browser Network timing for Awaiting Shipment first load is not yet captured.
- [x] Render `[api:timing]` and `[orders:list]` logs now carry the request ID needed for browser-to-backend correlation.
- [ ] Supabase slow-query logs are not yet correlated to the same timestamp.
- [ ] Render logs have not yet been checked for `[orders:maintenance]` overlap during the slowdown window.
- [x] Startup orders performance maintenance now requires explicit opt-in instead of inheriting from `RUN_SYNC_SCHEDULER`.
- [ ] Production env ownership for `RUN_ORDERS_PERFORMANCE_MAINTENANCE` and `RUN_SYNC_SCHEDULER` still needs confirmation.
- [ ] p95/p99 visibility for the hot routes is not yet available.

## High-Risk Issues

- `/orders` can spend time in `ordersPage`, `ordersCount`, and shipment enrichment before the table can finish loading.
- `/init/counts` may compete with the main table request if sidebar counts scan large order sets. Initial legacy sidebar counts are now delayed, but the endpoint still needs timing/caching evidence before deeper changes.
- `/orders/daily-stats` and `/orders/distinct-skus` can add avoidable pressure if they run before user intent or before the table paints.
- Global boot reads such as settings, locations, packages, sync status, and worker status can make the app feel stuck when Supabase is under memory pressure.
- Locations, carrier accounts, exact first-page counts, legacy sidebar counts, status polling, worker polling, markup settings hydration, New Order modal code, order-detail drawer code, and tracking modal code are now guarded on Orders startup, but daily stats still need timing evidence before deeper changes.
- Worker sync/reporting jobs can overlap with user-facing reads unless logs prove they are quiet during the incident window.
- Startup/redeploy maintenance can also overlap user traffic if enabled for the running process. The runtime now requires explicit opt-in with `RUN_ORDERS_PERFORMANCE_MAINTENANCE=true`; it no longer inherits from `RUN_SYNC_SCHEDULER`. If that flag is enabled, the maintenance path runs concurrent index checks, `order_items` backfill/repair, and `ANALYZE` on hot tables. Check for `[orders:maintenance] ensured index`, `backfilled`, `repaired`, and `refreshed planner stats` log lines during any slowdown.

## Medium-Risk Issues

- Exact historical order counts may be less important than getting the first operational page visible.
- Archiving older orders can help if historical scans are confirmed, but it should be a second step after query timing is known.
- Supabase memory usage may be cache pressure rather than the root cause; slow queries and connection saturation are the signals that matter.

## Root-Cause Workflow

1. Capture the browser Network waterfall for a cold Awaiting Shipment load.
2. Record the exact timestamp, active status, store filter, date range, page size, and whether DevTools cache is disabled.
3. Copy the browser `X-Request-Id` request or response header for the slow `/orders` request.
4. If needed, enable browser console timing with `localStorage.setItem('prepship:apiTiming', '1')` and reload to collect `[api:client-timing]` lines.
5. Pull Render logs for the same timestamp/request ID and compare route durations for:
   - `/orders`
   - `/init/counts`
   - `/orders/daily-stats`
   - `/orders/distinct-skus`
   - `/settings`
   - `/locations`
   - `/packages`
   - `/orders/sync/status`
   - `/worker/status`
6. Check `[orders:list]` timings with the same request ID for `ordersPage`, `ordersCount`, `shipmentsByOrderId`, `shipmentsByOrderNumber`, and total route time.
7. Search Render logs for `[orders:maintenance]` during the slowdown window:
   - `ensured index`
   - `backfilled`
   - `repaired`
   - `refreshed planner stats`
8. Confirm production env values for `RUN_ORDERS_PERFORMANCE_MAINTENANCE`, `RUN_SYNC_SCHEDULER`, API pool limits, and worker pool limits.
9. Check Supabase slow-query and connection/pool pressure for the same timestamp.
10. Check worker logs for overlapping sync, reporting refresh, rate backfill, or reconciliation jobs.
11. Classify the blocker as browser, API, database, startup maintenance, worker overlap, or frontend render.

## Startup Requests To Inspect

- `/orders?status=awaiting_shipment...`
- `/init/counts`
- `/init/stores`
- `/settings`
- `/orders/distinct-skus`
- `/orders/daily-stats`
- `/clients?activeOnly=true`
- `/locations`
- `/packages`
- shipping accounts / carrier endpoints
- `/orders/sync/status`
- `/worker/status`

## Immediate Investigation Task

Task for Lawrence:

1. Capture the browser Network waterfall for a cold Awaiting Shipment load.
2. Identify the slowest startup request and copy its `X-Request-Id`.
3. Search Render logs for `[api:timing]`, `[orders:list] completed`, and `[orders:list] failed`.
4. For `/orders`, identify whether the slow segment is `ordersPage`, `ordersCount`, `shipmentsByOrderId`, `shipmentsByOrderNumber`, or total request time.
5. Search Render logs for `[orders:maintenance]` during the same window.
6. Check Supabase memory, CPU, active connections, slow queries, long-running queries, blocked queries, and locks.
7. Check whether a sync/import/reporting job ran, got stuck, or overlapped with user traffic.
8. Confirm whether a deploy/restart happened shortly before the slowdown.
9. Apply the smallest safe fix after the bottleneck is confirmed.

## Recommended Patches

- If `/orders` count is slow, keep delayed exact total count enabled so page rows return first and the exact total refreshes after table paint.
- If sidebar counts are slow, cache `/init/counts`, keep it after table paint, and preserve stale count data on refresh failures.
- If daily stats or SKU lists are slow, fetch them only after first paint or user interaction.
- If settings/locations/packages are competing, defer them until the order panel, rate browser, label action, or package control needs them.
- If Supabase slow queries show historical scans, add a configurable hot window before moving data to archive tables.
- If worker overlap is present, add job throttles, queue visibility, or user-traffic quiet windows before scaling infrastructure.
- If startup maintenance overlaps user traffic, keep the explicit opt-in flag disabled on the user-facing API and move the backfill/analyze path to an explicit worker/admin job with visible status.

## Test Plan

- Browser first-load audit:
  - Awaiting table becomes visible before noncritical panels finish loading.
  - Network waterfall shows only table-critical requests block first paint.
  - Hidden tabs do not poll.

- Log audit:
  - Render route logs identify the slowest route and timing segment.
  - Supabase slow-query logs match or clear the suspected route.
  - Worker logs confirm whether background work overlaps.

- Existing checks after any runtime fix:
  - `npm run typecheck`
  - `npm run build:web`
  - `npm run test:orders-ux`
  - `npm run test:frontend-failure-states`

## Deployment / Rollback Notes

- Start with instrumentation and request-order changes before archive-table work.
- Keep archiving configurable and reversible.
- Do not delete order history.
- Keep old orders searchable/exportable if a hot/cold split is added later.
- Do not touch shipped/cancelled mutation protections in this investigation.
