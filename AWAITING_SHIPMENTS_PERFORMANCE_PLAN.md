# Awaiting Shipments Performance Plan

## Executive Summary

PrepShip should not jump straight to AWS migration or order archiving until the Awaiting Shipment delay is traced from browser to API to Supabase. The immediate goal is to prove where the page stalls, then fix the confirmed hot path.

Current status: investigation scoped. No runtime behavior changes are included in this document.

Phase 9 follow-up: the first low-risk startup guard now prevents Orders from fetching locations and carrier accounts until an order action, drawer, queue, rate browser, new-order flow, or shipping-account sort actually needs those shared records.

## Critical Blockers

- [ ] Browser Network timing for Awaiting Shipment first load is not yet captured.
- [ ] Render `[api:timing]` and `[orders:list]` logs are not yet correlated to the slow browser load.
- [ ] Supabase slow-query logs are not yet correlated to the same timestamp.
- [ ] p95/p99 visibility for the hot routes is not yet available.

## High-Risk Issues

- `/orders` can spend time in `ordersPage`, `ordersCount`, and shipment enrichment before the table can finish loading.
- `/init/counts` may compete with the main table request if sidebar counts scan large order sets.
- `/orders/daily-stats` and `/orders/distinct-skus` can add avoidable pressure if they run before user intent or before the table paints.
- Global boot reads such as settings, locations, packages, sync status, and worker status can make the app feel stuck when Supabase is under memory pressure.
- Locations and carrier accounts are now guarded on Orders startup, but settings, sidebar counts, status polling, and daily stats still need timing evidence before deeper changes.
- Worker sync/reporting jobs can overlap with user-facing reads unless logs prove they are quiet during the incident window.

## Medium-Risk Issues

- Exact historical order counts may be less important than getting the first operational page visible.
- Archiving older orders can help if historical scans are confirmed, but it should be a second step after query timing is known.
- Supabase memory usage may be cache pressure rather than the root cause; slow queries and connection saturation are the signals that matter.

## Root-Cause Workflow

1. Capture the browser Network waterfall for a cold Awaiting Shipment load.
2. Record the exact timestamp, active status, store filter, date range, page size, and whether DevTools cache is disabled.
3. Pull Render logs for the same timestamp and compare route durations for:
   - `/orders`
   - `/init/counts`
   - `/orders/daily-stats`
   - `/orders/distinct-skus`
   - `/settings`
   - `/locations`
   - `/packages`
   - `/orders/sync/status`
   - `/worker/status`
4. Check `[orders:list]` timings for `ordersPage`, `ordersCount`, `shipmentsByOrderId`, `shipmentsByOrderNumber`, and total route time.
5. Check Supabase slow-query and connection/pool pressure for the same timestamp.
6. Check worker logs for overlapping sync, reporting refresh, rate backfill, or reconciliation jobs.
7. Classify the blocker as browser, API, database, worker overlap, or frontend render.

## Recommended Patches

- If `/orders` count is slow, delay exact total count and return page data first with `hasMore`.
- If sidebar counts are slow, cache `/init/counts` and load it after the table paints.
- If daily stats or SKU lists are slow, fetch them only after first paint or user interaction.
- If settings/locations/packages are competing, defer them until the order panel, rate browser, label action, or package control needs them.
- If Supabase slow queries show historical scans, add a configurable hot window before moving data to archive tables.
- If worker overlap is present, add job throttles, queue visibility, or user-traffic quiet windows before scaling infrastructure.

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
