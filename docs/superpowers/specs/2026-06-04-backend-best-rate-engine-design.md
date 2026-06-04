# Backend-owned Best-Rate Engine (v2) — Design Spec

- **Date:** 2026-06-04
- **Status:** Approved design (pre-implementation)
- **Author:** DJ + Claude
- **Scope:** Sub-project A of a two-part modernization. This spec covers the
  **architecture move** (backend-owned best rate behind a runtime switch). The
  **selection-quality improvement** ("cheaper rates" / Ground Saver beating
  ShipStation) is a separate, later spec — see [Non-goals](#non-goals).

---

## 1. Problem & motivation

Today the Awaiting-Shipment best rate is computed **on the client**
(`web/src/components/Views/OrdersView.tsx`, `@ts-nocheck`). The browser:

- fans out N live/cached rate fetches (one per visible awaiting order),
- caches results in `autoBestRateEntries` (React state) keyed by a request
  fingerprint, with a 45s watchdog,
- classifies each cell (`classifyAwaitingRateCellState`) into ready / spinner /
  terminal states.

This architecture is the root of several problems we keep patching:

- **Slow / heavy:** the client orchestrates many fetches; the table waits.
- **Fragile:** a whole class of bugs (PS-071 spinner deadlock, PS-081
  cancelled-fetch strand) lives only because orchestration is client-side and
  racy.
- **Hard to maintain:** the logic is buried in a large `@ts-nocheck` file, so
  the type system can't protect changes (PS-081 shipped a runtime TDZ error
  precisely because the file is unchecked).
- **Churn:** the request fingerprint includes a **UTC-midnight** ship-date
  bucket plus a **6-hour** cache expiry, so rates re-rate at boundaries that
  don't match the operator's ship-day ("it changes randomly").

The fix is to make best-rate **backend-owned**: computed and cached server-side,
returned on the orders payload, with a thin display-only frontend.

### Goals
- **Speed** — table shows rates near-instantly from a warm server cache.
- **Reliability** — remove the client-side orchestration and its entire bug class.
- **Maintainability** — typed, isolated, unit-tested module instead of buried
  `@ts-nocheck` logic.

### Non-goals (separate specs)
- **Cheaper rates / better selection** (Ground Saver beating ShipStation). v2
  ships **behaviorally identical** to today's selection first; making it cheaper
  is its own spec layered on the new `selection.ts` seam.
- **Deleting the legacy engine.** It stays in the repo, one switch away, until
  explicitly removed.

---

## 2. Key decisions (locked)

| Decision | Choice |
|---|---|
| Decomposition | Architecture move first; "cheaper rates" is a separate spec. |
| Compute trigger | **Precompute on sync/import + recompute on input change**, with a background sweep backfilling anything missing. |
| Freshness | Re-rate on input change, on **ship-day rollover at 6 PM CA**, and on manual Browse Rates. **No** UTC-midnight or 6-hour churn. |
| Storage | Reuse `order_overrides.best_rate_json` (+ fingerprint) as canonical. A lightweight **shadow log** records v2's result during rollout. |
| Rollout / revert | A single **runtime config flag** `BEST_RATE_ENGINE = legacy \| v2` (DB-backed, flips with no redeploy). Both engines kept side by side. |

---

## 3. Architecture

One boundary, two engines, one switch.

```
caller ──▶ selectBestRate(order, ctx)
                 │
                 ├── BEST_RATE_ENGINE = legacy ──▶ legacyBestRateEngine  (today's code, untouched)
                 └── BEST_RATE_ENGINE = v2     ──▶ v2BestRateEngine       (new backend-owned logic)
```

- **`selectBestRate(order, ctx)`** — the single seam every caller goes through.
- **`legacyBestRateEngine`** — a thin adapter over today's exact behavior. Not
  rewritten; preserved so a revert is a no-op flip.
- **`v2BestRateEngine`** — computes the best rate server-side using the existing
  carrier connectors / orchestrator and rate cache, then persists it.
- **`BEST_RATE_ENGINE`** — DB-backed runtime setting, default `legacy`.

Under `legacy`, the frontend client-side orchestration runs exactly as today.
Under `v2`, that orchestration is **bypassed**: the table renders the
`order.bestRate` the backend already computed and put on the payload — no client
fetch, no `autoBestRateEntries`, no watchdog, no spinner state machine.

---

## 4. Components

| Module | Responsibility | Depends on |
|---|---|---|
| `src/services/best-rate/engine.ts` | `selectBestRate()` seam + `BEST_RATE_ENGINE` switch | config/settings |
| `src/services/best-rate/v2.ts` | compute the best rate for an order; write `best_rate_json` + fingerprint | orchestrator, rate cache, `selection.ts`, `fingerprint.ts` |
| `src/services/best-rate/legacy.ts` | adapter wrapping current behavior so it's selectable | existing rate path |
| `src/services/best-rate/selection.ts` | **pure** "pick the winning rate from a candidate list" — the future "cheaper rates" plug-in point; v1 replicates current selection | none (pure) |
| `src/services/best-rate/fingerprint.ts` | ship-day-aware request fingerprint (PS-078 authority key) | ship-day util |
| `src/services/best-rate/shadow.ts` | record old-vs-new disagreements while on `legacy` | shadow table/log |
| compute triggers | call `v2` on order sync/import, on input change, and on a ship-day sweep | `order-sync`, import, worker |

Each module has one purpose, a typed interface, and is unit-testable in
isolation. None is `@ts-nocheck`.

---

## 5. Data flow

```
order synced / imported / changed
        │
        ▼
 v2BestRateEngine.compute(order)
        │  (orchestrator: ShipStation + direct carriers, cache-first)
        ▼
 selection.pickBest(candidates)         ← pure; v1 == current selection
        │
        ▼
 persist order_overrides.best_rate_json + requestFingerprint (+ shadow log)
        │
        ▼
 orders payload carries order.bestRate
        │
        ▼
 frontend renders order.bestRate directly  (no client orchestration under v2)
```

---

## 6. Freshness & recompute

A cached best rate is re-rated when:

1. **Inputs change** — dims, weight, ship-to address, or the carrier-account set.
2. **Ship-day rollover** — at **6 PM CA** (matches the board's "shifts at 6 PM
   CA"), a sweep re-rates awaiting orders. Stable all day, fresh each ship-day.
3. **Manual Browse Rates** — the operator forces a live re-quote (PS-082).

The PS-078 request fingerprint is still stamped on the saved rate and is still
**required to match** before the rate is treated as authoritative for a label.
Aligning the time component to the ship-day (not UTC midnight / 6h) removes the
churn while preserving the "re-validate each ship-day" safety intent.

---

## 7. Safety, shadow mode & revert

- **Equivalence first.** v2's `selection.ts` **replicates legacy** in v1. Before
  any cutover, v2 must pass the existing guards (PS-050 accuracy, PS-057 HUGRAB
  Ground-Saver, PS-072 HUGRAB insurance, PS-078 exact-rate authority, PS-099
  cache-first) **and** a new old-vs-new **parity guard**.
- **Shadow mode.** While `BEST_RATE_ENGINE = legacy`, `shadow.ts` computes v2 in
  the background and logs any disagreement (different amount / service /
  account) without affecting what's displayed or sold. We flip only when the
  disagreement rate is ~0.
- **Revert = flip the flag.** Setting `BEST_RATE_ENGINE = legacy` instantly
  restores the old path with no redeploy and no code surgery. The legacy engine
  is never deleted until explicitly approved.
- **No label/postage side effects.** This work changes how the best rate is
  *computed/displayed*, never how labels are purchased. PS-078 label authority
  is unchanged.

---

## 8. Testing

| Guard | Purpose |
|---|---|
| Existing: PS-050 / PS-057 / PS-072 / PS-078 / PS-099 | run against `v2` — the behavioral contract |
| New: `ps-085-bestrate-engine-parity` | legacy vs v2 agree on a fixture set of orders |
| New: `ps-086-bestrate-v2` | unit tests for v2 compute, `selection.ts`, ship-day refresh, fingerprint |

No test fetches or buys a real label; all use fixtures/mocks.

---

## 9. Rollout sequence

1. Land the `selectBestRate` seam + `legacy` adapter (no behavior change; flag
   defaults `legacy`).
2. Build `v2` (compute + persist + fingerprint + ship-day refresh), equivalent
   selection.
3. Wire compute triggers (sync/import, input-change, ship-day sweep).
4. Enable **shadow mode**; watch disagreements until ~0.
5. Flip `BEST_RATE_ENGINE = v2`; frontend bypasses client orchestration.
6. (Later specs) improve selection for cheaper rates; remove legacy engine.

Each step is independently shippable and revertable.

---

## 10. Open questions / verification

- Exact location(s) of the order sync/import entry points to hook precompute
  (candidates: `src/services/order-sync.ts`, `src/services/store-order-import.ts`).
- Shadow-log storage shape (column on `order_overrides` vs a small dedicated
  table) — to be decided in the implementation plan.
- Frontend display path under `v2`: confirm `order.bestRate` already carries
  everything the cells render (amount, carrier, account, service) so no client
  derivation remains.
