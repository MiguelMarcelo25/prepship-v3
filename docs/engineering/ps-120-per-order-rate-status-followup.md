# PS-120 — Per-Order Backend Rate-Job Status (`pending` / `rating`)

> Follow-up carved out of **PS-111** (the remaining ~15%). PS-111 shipped backend-owned
> completeness, enqueue-on-sync pre-rating, and the HUGRAB insured-total cert. This
> ticket adds the two **in-progress** states the enterprise model wants so the Orders
> table can distinguish "queued for backend rating" from "actively rating" from the
> terminal states — instead of a single generic spinner.

**Repo:** `drprepperusa-org/prepship-v4` · **Base branch:** `prepshipv4-stable`
**Suggested branch:** `ps-120-per-order-rate-status`

## Context

After an order sync, eligible Awaiting orders are pre-rated by the backend
(`runOrderSync → runBackfillTick`, gated by `ENABLE_RATE_BACKFILL_SCHEDULER`). Today the
backfill tracks only **job-level** progress (`processed/total`, via `getActiveBackfillJob`)
— not which order is queued vs in-flight. So the Orders table shows a generic spinner
(`pending`/`calculating`) for any un-rated order, and a row with no saved rate reads as
`missing` even when a backend job will rate it shortly.

DJ's expected behavior: Best Rate is not shown as final until eligible carriers are
analyzed **or** the system clearly marks the result `pending` / `rating` / `partial` /
`error` / `no_rate` / `stale`. The terminal states exist
(`best-rate-workflow-dto.ts`: `fresh`/`stale`/`partial_carrier_failure`/`blocked`/
`missing`). The **in-progress** states (`pending`, `rating`) are missing.

## Files to inspect first

- `src/services/rates-backfill.ts` — the backfill job; where per-order state would be set.
- `src/services/sync-scheduler.ts` — `runOrderSync` / `runBackfillTick` enqueue point.
- `src/services/shipping-workflow/best-rate-workflow-dto.ts` — `BestRateWorkflowState`.
- `src/services/order-rate-dto.ts` — the DTO surfaced to the Orders payload.
- `src/routes/orders.ts` / the orders list payload builder — where per-order workflow state is attached.
- `web/src/components/Views/orders-parity.ts` — `classifyAwaitingRateCellStateWithWorkflow` + `AwaitingRateCellState`.
- `web/src/components/Views/OrdersView.tsx` — the awaiting rate-cell renderer.
- Guards: `scripts/ps-111-backend-rate-authority-guard.ts`, `scripts/ps-081-rate-sync-guard.ts`.

## Architecture placement

- **Business rule:** "what is the backend doing about this order's rate right now?" The
  **backend owns** per-order rate-job status; the UI **displays** it. The frontend must
  not invent the status or decide a rate is final.
- **Canonical owner:** the backend rate-backfill / rate-status service is the source of
  truth for `pending`/`rating`. Persist a small per-order rate-job state (e.g. on
  `order_overrides` or a dedicated `order_rate_jobs` table) keyed by orderId + request
  fingerprint, and surface it in the orders payload DTO. The UI classifier maps it to a
  bounded cell state. Routes stay thin.

## Implementation requirements

1. **Backend per-order rate-job state.** Add `pending` and `rating` to a backend-owned
   per-order status (set when an order is enqueued for backfill / picked up by the job;
   cleared to a terminal state when the job resolves it). Keyed by orderId **and the
   current request fingerprint** so a stale dims/weight change invalidates it.
2. **Expose via DTO.** Surface the status on the order's best-rate workflow DTO
   (`order-rate-dto.ts` / `best-rate-workflow-dto.ts`) so the orders payload carries it.
   Extend `BestRateWorkflowState` (or an adjacent field) with `pending` | `rating`.
3. **Classifier mapping.** `classifyAwaitingRateCellStateWithWorkflow` maps `pending` →
   a queued/"rating soon" state and `rating` → an in-progress state — bounded (a watchdog
   timeout flips a stuck `rating` to a terminal retryable state; never an infinite
   spinner). Missing dims/weight still wins (`add-dims`), per PS-119.
4. **No browser dependence.** The status reflects the **backend** job, so an order shows
   `rating` even with nobody logged in. The frontend remains display-only.
5. **Bounded + safe.** Reuse the existing concurrency/rate-limiter; a `rating` state must
   time out to `error`/`stale` if the job dies. No unbounded fanout, no hammering.

## Guardrails / forbidden changes

- Frontend must not own rate authority or mint proofs; backend stays source of truth.
- Do not weaken auth/RBAC, client/store scope, selected-rate proof, shipped/cancelled
  lockdown, or eligibility.
- No real postage/labels/marketplace notifications. Awaiting-order updates only.
- No raw provider payloads/secrets in user-facing status.

## Verification commands

```
npm run typecheck
npm run build:web
npm run test:ps-111-backend-rate-authority   # extend with pending/rating coverage
npm run test:ps-081-rate-sync                # no regress (bounded, no infinite spinner)
# new focused guard: pending/rating set by backend, classifier maps them, watchdog bounds rating
```

## Definition of done

- Backend sets/clears a per-order `pending`/`rating` status (fingerprint-scoped) without a
  browser; it is exposed on the orders DTO.
- The Orders table distinguishes `pending`/`rating` from `complete`/`partial`/`no_rate`/
  `error`/`stale`; missing dims/weight still shows `add-dims`.
- `rating` is bounded (watchdog → terminal retryable state), never an infinite spinner.
- Guards added/updated and passing; PS-081/PS-111 not regressed.
- No backend/proof/lockdown/scope weakening; no live label/postage/marketplace/shipped
  mutation.
- PR opened against `prepshipv4-stable` from `ps-120-per-order-rate-status`.

## Return format

Root cause/why-now · files changed · architecture placement notes · before/after for one
order transitioning pending → rating → fresh · verification commands + results · bounded-
ness proof (watchdog) · confirmation no live mutations occurred.
