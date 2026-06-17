# PS-279 — Print-queue backend orchestration (Send-to-Queue route owner moves to `src/`)

Status: **Steps 1–4 of the build plan (additive, default-OFF). The FE buy-path
cutover is DEFERRED to a DJ canary** (see "Deferred" below). Nothing in this
slice changes production behavior: the new code is unreachable until the
`PRINT_QUEUE_BACKEND_ORCHESTRATION` env flag is turned on, and the existing
`/print-queue/batch-send` route is left byte-identical.

---

## Problem / source of truth

The Send-to-Queue decision — *for an order the operator wants queued, do we
(a) queue an existing label as-is, (b) force a backend mock for a test order,
(c) buy a label via the direct-carrier client flow then queue it, or
(d) hand the order to the backend create/recover job* — is a **money-path
decision** (rung (c) buys real postage). Today the *decision* is computed in
the **frontend** by `web/src/lib/shipping-routes.ts → classifyQueueOrderRoute`,
and the FE then either calls `apiClient.createLabel` (direct buy) or
`apiClient.startQueueSendJob` (backend job).

Per ARCHITECTURE.md, a money-path decision must be owned at the **backend
source-of-truth layer**, with the FE as a thin consumer. PS-279 moves the
*pure never-buy ladder* into `src/` so the server can compute the route, and
adds an INERT backend entrypoint behind a default-OFF flag. The FE buy-path is
NOT yet rewired — that cutover ships later under a DJ-flipped canary so a live
order can prove parity before the FE stops owning the decision.

## What this slice ships (Steps 1–4)

1. **This doc.**
2. **`src/services/print-queue/queue-route-orchestrator.ts`** — a NEW pure
   module that PORTS the never-buy ladder out of
   `web/src/lib/shipping-routes.ts` into `src/` (re-implemented; `src/` does NOT
   import `web/`). It exposes:
   - `classifyQueueOrderRouteServer(input, options)` — the same pure decision,
     same rung order, returning `'direct-create' | 'backend'`.
   - `planQueueRouteForOrders(orders)` — a create/recover/queue entrypoint that
     classifies a batch server-side and splits it into the orders the backend
     create/recover job owns vs the direct-create orders the FE still buys
     (until the deferred cutover). It NEVER buys postage and NEVER calls a
     provider; it only computes the route plan.
   - It reuses the canonical synthetic-direct floor
     (`DIRECT_SYNTHETIC_PROVIDER_ID_FLOOR` from
     `src/services/shipping-workflow/rate-fingerprint.ts`) rather than
     re-hardcoding `10_000_000`.
3. **`PRINT_QUEUE_BACKEND_ORCHESTRATION`** env flag (default OFF) in
   `src/lib/env.ts`, plus a NEW route `POST /print-queue/route-plan` in
   `src/routes/print-queue.ts` that is **inert unless the flag is ON** (returns
   503 `FEATURE_DISABLED` when OFF — it makes no DB call, buys nothing, and the
   existing `/batch-send` route is untouched, so prod is byte-identical OFF).
   When ON, the route only RETURNS the computed plan (it does not start a job).
4. **`scripts/ps-279-backend-orchestration-guard.ts`** — an offline guard that
   pins the ported ladder's never-buy rungs and the OFF-path inertness.

## Never-buy ladder (ported, unchanged order)

In priority order, the server-side classifier returns `'backend'` (never
`'direct-create'`, i.e. never the buy-then-queue client flow) when:

1. `options.existingLabelOnly` — caller only wants existing labels queued.
2. `options.batchTestMode` — test run → backend mock, no real postage.
3. `input.isTest` — test-client order → backend mock.
4. `input.hasQueueableLabel` — already bought → backend queues it as-is.

Only AFTER those rungs does it consult the residual direct-vs-backend question:

5. an explicit live-panel `explicitPayloadProviderId` (the operator's current
   purchase account) — `'direct-create'` iff it is a synthetic-direct id.
6. else the backend's own `backendQueueRoute` policy when it spoke.
7. else `'direct-create'` for a direct-carrier order that still needs a label.
8. else `'backend'` (ShipStation provider → backend `createLabelV2`).

This is identical to the FE `classifyQueueOrderRoute` so the deferred FE
cutover can delegate to the backend plan with zero behavior change.

## OFF-path safety (default)

- `PRINT_QUEUE_BACKEND_ORCHESTRATION` defaults to `false`.
- `POST /print-queue/route-plan` short-circuits to a 503 `FEATURE_DISABLED`
  before any work when the flag is OFF. No DB, no provider call, no postage.
- `/print-queue/batch-send` and every other existing route are unchanged.
- The orchestrator is pure: no DB, no network, no provider, no postage. It
  decides a route only.

## Deferred (NOT in this slice — DJ canary)

- Rewiring `web/src/components/Views/OrdersView.tsx` to call the backend
  `route-plan` (and removing the FE-owned `classifyQueueOrderRoute` call) is
  DEFERRED. **No `apiClient.createLabel` call is deleted in this slice.**
- Flipping `PRINT_QUEUE_BACKEND_ORCHESTRATION=true` on Render is a DJ action
  after the route-plan reads parity-equal to the FE decision on a live order.

## Verification

`npx tsx scripts/ps-279-backend-orchestration-guard.ts` (offline, no DB/network)
pins:
- the server-side ladder exists in `src/services/print-queue/`;
- the new route is registered and inert when the flag is OFF;
- the never-buy rungs (existing label → queue as-is; test order → mock;
  no FE re-derivation needed because the server owns the decision).
