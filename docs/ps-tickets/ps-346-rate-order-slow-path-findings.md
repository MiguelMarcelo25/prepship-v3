# PS-346 - Rate/Order Slow Path Findings

## Status

PS-346 is in planning/root-cause mode. No implementation or deletion has been
performed in this slice.

## Backend Owners

- Rate browse request boundary: `src/routes/rates.ts`.
- ShipStation and direct-carrier quote fanout: `src/services/rates.ts`.
- Combined carrier ranking/completeness: `src/services/rates-combined.ts`.
- Backend bulk rate producer: `src/services/rates-backfill.ts`.
- Awaiting row workflow DTO: `src/services/shipping-workflow/best-rate-workflow-dto.ts`.
- Orders list read model and timings: `src/routes/orders.ts`.
- Frontend transport/rendering: `web/src/lib/v2-apiClient.ts`, `web/src/components/RateBrowserModal.tsx`,
  and `web/src/components/Views/OrdersView.tsx`.

## Root-Cause Findings

1. Rate browsing is source-of-truth correct but still final-response blocking.
   `/rates/browse` overlaps ShipStation and direct-carrier work with
   `Promise.all`, and each side is bounded, but the route still returns one final
   payload only after both quote families finish. Existing
   `rateBrowseTiming` diagnostics report duration after the fact; they do not
   provide a backend-owned partial/status contract while slow carriers continue.

2. ShipStation and direct-carrier fanout are already bounded. PS-340 guards
   prove direct carriers use `DIRECT_CARRIER_RATE_FETCH_CONCURRENCY`,
   ShipStation uses the canonical rate limiter, and identical browse requests
   are single-flighted. PS-346 should not be another "lower concurrency" patch.
   The missing contract is cache-first/partial-result job state.

3. Orders has backend timings, but refresh pressure is still spread across the
   frontend. The list route logs slow steps, while `OrdersView.tsx` has multiple
   callers that refetch the full orders list after rate jobs, queue jobs, label
   actions, and settle timers. There is no single latest-wins refresh
   coordinator that dedupes overlapping requests or records reason/count proof.

4. Print Queue batch send already has a backend job with per-order results.
   The current implementation processes orders concurrently, times out each
   order independently, and exposes `queued`, `failed`, and `results`. Live QA
   still showed partial failures that succeeded on retry, so PS-346 needs
   retry/blocked-reason proof under volume, not only faster UI progress.

5. Job snapshot persistence should be standardized before adding more durable
   jobs. Existing settings-backed snapshots are hand-rolled in multiple places.
   Live output showed a multi-row `settings` upsert failure in the print-queue
   batch status path. A focused JSON setting helper should be added before new
   PS-346 workflow snapshots are introduced.

## Baseline Guards

Run on 2026-06-29 from branch `codex/ps-346-slow-paths-plan`:

- `npm run test:ps-340-backend-rate-engine -- --no-color` - PASS
- `npm run test:ps-345-rate-loading-sot -- --no-color` - PASS
- `npm run test:ps-333-hugrab-current-rate-sot -- --no-color` - PASS
- `npm run test:ps-293-awaiting-passive-cap -- --no-color` - PASS
- `npm run test:ps-320-v2-api-client-transport -- --no-color` - PASS
- `npm run test:ps-321-ratebrowsermodal-thin-ui -- --no-color` - PASS
- `npm run test:ps-rate-limiter-priority-behavior -- --no-color` - PASS

## 2026-06-30 Orders Refetch Pressure Slice

The remaining `/orders` pressure root cause was not one single button. It was
the shared hook contract: many existing `OrdersView` workflows call
`refetchOrders()` after rate jobs, label actions, queue actions, row settle
timers, and manual refresh. Before this slice, each caller could ask React Query
for another full Orders read while a same-hook request was already active.

This slice adds `web/src/hooks/orders-refetch-coordinator.ts` and wires
`useOrders.refetch()` through it. The coordinator keeps only one active
`/orders` refetch per `useOrders` hook and collapses any requests that arrive
while it is active into one trailing refresh. That preserves the "latest row
state after the burst" behavior without allowing overlapping full-table reads
from the same Orders surface.

New proof:

- `npm run test:ps-346-orders-refetch-coordinator -- --no-color` - covers
  concurrent request coalescing, no overlapping active requests, one trailing
  refresh for status/settle bursts, and normal later idle refreshes.

## Safety

No labels, postage, marketplace notifications, billing, inventory, production
data, shipped-order mutations, cancelled-order mutations, or shipment-history
changes were performed. Implementation work that touches Print Queue internals
must respect the shipped/cancelled lockdown in `AGENTS.md`.
