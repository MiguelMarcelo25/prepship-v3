# PS-075 — Awaiting Shipment rate cells spin forever (the *error* case)

**Status:** Fixed. PS-071 already gave the Carrier / Shipping Account / Ship
Margin cells bounded states (`add-dims`, `loading-carriers`, `no-carrier-account`,
`unavailable`, `calculating`, `pending`). PS-075 adds the one terminal state
PS-071 left out — **`error`** — which is exactly the live symptom: when passive
rating keeps *failing* (e.g. `/api/carriers/rates` 500ing), the cell stayed an
endless `pending` spinner.

---

## Root cause (file/line refs)

- `web/src/components/Views/OrdersView.tsx` — the passive auto-rating `catch`
  *deleted* the request key (`autoBestRateRequestedRef.current.delete(request.key)`)
  on error and recorded **no entry**. So a persistently-failing fetch looped:
  fetch → error → delete key → re-fetch …, and the order never got a resolved
  `autoBestRateEntries[orderId]`.
- `renderAwaitingRateFallback` — `resolvedNoRate` requires a resolved entry; on
  repeated error there is none.
- `web/src/components/Views/orders-parity.ts` `classifyAwaitingRateCellState` —
  with carrier context present + no resolved entry + not calculating → returns
  **`pending`** → `renderRateCellFallback` renders the spinner. Hence the
  infinite Carrier / Shipping Account spinner the operator saw, only escapable
  via Browse Rates.

The table conflated "rate is loading" with "passive rating failed". A
failed/error result is terminal, not loading.

---

## Implementation

1. **`orders-parity.ts`** — added `'error'` to `AwaitingRateCellState` and a
   `resolvedError` input to `classifyAwaitingRateCellState`. Order: `ready →
   add-dims → error → unavailable → loading-carriers / no-carrier-account →
   calculating → pending`. `awaitingRateCellIsSpinner('error') === false`.
2. **`OrdersView.tsx`**
   - `autoBestRateEntries[orderId]` extended with `error?: string | null`.
   - Passive `catch` now records a **terminal error entry**
     `{ key, rate: null, error: <sanitized> }` (message whitespace-collapsed +
     truncated to 140 chars — no raw provider payload) **instead of deleting the
     key**. The effect's candidate filter (`entry?.key === request.key`) then
     skips it, so it no longer re-fetch-loops.
   - `renderAwaitingRateFallback` computes `resolvedError` and excludes it from
     `resolvedNoRate` (no-rate = resolved AND no rate AND no error).
   - `renderRateCellFallback` renders a terminal **"Rate error · Retry"** (full)
     / red `—` (compact) with the sanitized message in the tooltip; Retry reuses
     PS-071's `retryOrderRate` (clears the entry + re-rates, no force-live).
   - Also captures the carrier-accounts **load error** from
     `useShippingAccounts` (`accountsLoading = isLoading && !error`) so a failed
     accounts fetch can't masquerade as "loading carriers…" forever.
3. **Guard** — `scripts/ps-071-rate-cell-state-guard.ts` extended: explicit
   error cases (error wins over no-rate; error terminal even with carrier
   context; error is not a spinner) + the exhaustive sweep now varies
   `resolvedError` and proves a spinner only appears when the request can still
   complete (`hasCarrierContext && !resolvedNoRate && !resolvedError`).

`renderBestRatePrice` already shows a terminal `--` for a resolved entry with no
rate (error entries have `rate: null`), so the Best Rate cell stays terminal too.

---

## Before / after

| Awaiting row, dims+weight present | Before | After |
|---|---|---|
| Passive rate fetch keeps failing (e.g. carriers/rates 500) | **infinite spinner** in Carrier + Shipping Account | terminal **"Rate error · Retry"** (tooltip has sanitized reason) |
| Carrier accounts fetch errored | could read "loading carriers…" indefinitely | terminal `No carrier account` |
| Passive resolved with no rate | `Rate unavailable · Retry` (PS-071) | unchanged |
| Genuinely in-flight | bounded spinner | unchanged |
| Missing dims/weight | `— add dims` | unchanged |

Retry (and Browse Rates) still work and re-rate the row.

---

## Tests / commands — pass/fail

| Command | Result |
|---|---|
| `npx tsx scripts/ps-071-rate-cell-state-guard.ts` (now incl. error cases + sweep) | ✅ PASS |
| `npm run typecheck` (web) | ✅ PASS |
| `npm run build:web` | ✅ PASS |

## Safety

Display/state only — no auth/RBAC/scope/financial-redaction change, no labels or
postage, no marketplace calls. The stored error message is sanitized
(whitespace-collapsed, truncated, no raw payload). Direct-carrier vs ShipStation
carrier-id handling is unchanged (this is purely the cell terminal-state layer).

## Note

The terminal `error` state is also the correct UI for the *current* production
`/api/carriers/rates` `500`s (being fixed separately): instead of spinning, the
direct-carrier rows will show "Rate error · Retry" until that endpoint returns
rates.
