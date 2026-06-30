# PS-346 - Rate/Order Slow Path Findings

## Status

PS-346 has two implemented source-of-truth slices:

- Orders refetch pressure is coalesced in the shared `useOrders` hook.
- Rate Browser live browse now has a backend-owned cache-first partial workflow
  snapshot so the modal can show available cached rates while slow live carriers
  continue.

The card remains In Progress until live high-volume proof confirms the remaining
Print Queue / unavailable-rate patterns under DJ's workflow.

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

## 2026-06-30 Rate Browser Partial Workflow Slice

The Rate Browser slow path was not a rate-ranking bug by itself. The backend
already owns final Best Rate ranking and proof, but the explicit live browse
workflow still behaved like a final-response request: the modal could sit mostly
blank until every slow carrier finished or timed out.

This slice keeps the final backend live result authoritative, but adds a
cache-first partial snapshot before the live provider fanout completes:

- `src/services/rate-browse-workflow-snapshots.ts` builds partial/complete
  workflow snapshots and counts carrier coverage without owning rate ranking.
- `src/services/rate-browse-workflow.ts` can persist a `partial` snapshot from a
  cache-only result, then replace it with the final `complete` live result.
- `src/routes/rates.ts` starts that cache-only preview only for explicit live
  browse workflows and clamps it to read-only cache behavior (`cachedOnly: true`,
  no live force, no strict recalc, no manual estimate).
- `web/src/hooks/useRateBrowseWorkflow.ts` emits each partial backend result once
  while continuing to wait for the final complete snapshot.
- `web/src/components/rate-browser-partial-result.ts` maps the partial backend
  DTO into display state. The modal renders that state only; it does not apply,
  persist, or mint Best Rate truth from a partial result.

New proof:

- `npm run test:ps-346-rate-browse-partial-workflow -- --no-color` - proves
  partial snapshots expose cache-first rates, do not finish the workflow, and
  are replaced by the final live result.

## 2026-06-30 Rate Browser Open Live Workflow Slice

Live QA showed the modal could still open on a cached-only state such as
`7 of 9 carriers checked`, with proofless rows visible and no active workflow.
That was technically safe, but it violated the operator workflow: Rate Browser
should load all scoped carriers when opened.

This slice treats opening Rate Browser as explicit operator intent and starts
the backend live browse workflow immediately:

- `web/src/components/rate-browser-open-workflow.ts` owns the open-time browse
  options and returns `{ forceLive: true }`.
- `web/src/components/RateBrowserModal.tsx` calls that helper from the open
  effect once dimensions, weight, ZIP, and scoped carrier accounts are ready.
- Awaiting page load remains passive; only the opened Rate Browser starts live
  carrier work.
- Selection safety is unchanged: cached/partial rows may display while final
  proof is building, but row apply still requires backend `isComplete` proof.

New proof:

- `npm run test:ps-346-rate-browser-open-live-workflow -- --no-color` - proves
  Rate Browser open requests the backend live workflow and does not stop at a
  cached-only partial preview.

## 2026-06-30 Print Queue Volume Evidence Slice

The Print Queue high-volume slice is still behind the lockdown gate for any
implementation that changes `src/services/print-queue.ts` or
`src/routes/print-queue.ts`. The current safe work is read-only certification:
active backend queue-send jobs are per-run and expose full in-memory
`results`, while durable fallback is intentionally capped to `resultSamples`.

Evidence lives in `docs/ps-tickets/ps-346-print-queue-volume-evidence.md`.
The guard proves selected-run totals are not cumulative, active status returns
full current-run results, and the remaining long-batch durable-proof gap is
documented instead of claimed complete.

New proof:

- `npm run test:ps-346-print-queue-volume-evidence -- --no-color` - proves the
  current safe queue-volume boundary and the remaining locked blocker.

## Safety

No labels, postage, marketplace notifications, billing, inventory, production
data, shipped-order mutations, cancelled-order mutations, or shipment-history
changes were performed. Implementation work that touches Print Queue internals
must respect the shipped/cancelled lockdown in `AGENTS.md`.
