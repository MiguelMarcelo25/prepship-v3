# PS-071 — Awaiting Shipment rate/carrier spinner deadlock (no Browse Rates needed)

**Status:** Fixed. The Carrier / Shipping Account / Best Rate / Ship Margin
cells now resolve to a bounded, actionable state instead of spinning forever
when an awaiting order has dims+weight but no displayable best rate. The
operator no longer has to open Browse Rates to unstick the table. A per-row
"Retry" re-rates in place (cache-first, no force-live).

---

## Summary — root cause confirmed

Two layers combined:

1. **Carrier-account context already loads on page load** — `OrdersView`'s
   `ordersSupportDataEnabled` already includes `passiveRatingAccountsEnabled`
   (`currentStatus === 'awaiting_shipment' && orders.length > 0`), so
   `useShippingAccounts()` fetches on a plain Awaiting load, and the passive
   auto-rating effect already depends on `shippingAccounts` and re-runs once
   accounts arrive (cache-first via `/rates/cached/bulk`, then bounded live).
   That part was sound.

2. **The cells had no terminal state (the real deadlock).** For an awaiting
   order with dims+weight but no displayable best rate, the Carrier and Shipping
   Account cells hit `!hasDisplayableBestRate && !isCalculatingBestRate` →
   `<div className="spin-center"><span className="spin-sm" /></div>` and
   `isCalculatingBestRate` → the same spinner — **with no escape**. So whenever
   accounts were still loading, auto-rating was momentarily skipped, OR a rate
   genuinely came back empty (`entry.rate === null`), the cell spun *forever*.
   The Best Rate **price** cell already degraded to `--`, but Carrier / Account
   did not, and **`renderMargin` read the raw `order`** (not
   `getOrderWithAutoBestRate(order)`), so it kept spinning even after passive
   rating populated the rate.

Opening Browse Rates "fixed" it only incidentally — it forced another rate load
that eventually populated `bestRate`, flipping the cells out of the spinner.

---

## Behavior before vs after

| Situation (awaiting order, dims+weight present) | Before | After |
|---|---|---|
| Carrier accounts still loading | infinite spinner | `Loading carriers…` (bounded) |
| No carrier account connected | infinite spinner | `No carrier account` (button → Browse Rates) |
| Rate request resolved with no rate | infinite spinner | `Rate unavailable · Retry` (re-rates in place) |
| Rate request genuinely in flight / refreshing a stale rate | spinner | spinner **but bounded** — resolves to a rate or to `Rate unavailable` |
| Passive auto-rating populated the rate | Carrier/Account update; **Margin keeps spinning** until manual refetch | all four cells update together (Margin uses `getOrderWithAutoBestRate`) |
| Has a displayable best rate | rate shown | rate shown (unchanged) |

The `pending` / `calculating` spinners are provably bounded: every rateable row
is processed by the passive effect to an `autoBestRateEntries` entry (a rate or
`null`), so it always lands on a terminal state.

---

## Files changed

- `web/src/components/Views/orders-parity.ts`
  - New pure `classifyAwaitingRateCellState(...)` → `ready | add-dims |
    unavailable | loading-carriers | no-carrier-account | calculating | pending`,
    plus `awaitingRateCellIsSpinner(...)`.
- `web/src/components/Views/OrdersView.tsx`
  - Destructure `isLoading: accountsLoading` from `useShippingAccounts`.
  - `renderAwaitingRateFallback(order, displayOrder, variant)` +
    `renderRateCellFallback(...)` render the bounded/actionable state; used by
    the Carrier, Shipping Account, and Ship Margin cells (replacing the
    open-coded infinite spinners).
  - `renderMargin` now consumes `getOrderWithAutoBestRate(order)` — same source
    as the other rate cells.
  - `retryOrderRate(order)` + a `rateRetryNonce` (added to the passive effect's
    deps) re-run cache-first passive rating for one row without Browse Rates and
    without force-live.
- `scripts/ps-099-orders-rate-cache-first-guard.mjs`,
  `scripts/best-rate-dims-guard.mjs`
  - Assertions updated to track the new bounded-state implementation (the old
    ones pinned the exact infinite-spinner source pattern PS-071 removes; intent
    preserved). best-rate-dims also fixed a pre-existing brittle pin
    (`if (!hasDisplayableBestRate)` never matched the real
    `if (!hasDisplayableBestRate &&`).

**New artifact**
- `scripts/ps-071-rate-cell-state-guard.ts` — exercises the real classifier,
  including an exhaustive sweep proving a spinner only appears when a request can
  still resolve (carrier context present AND not yet resolved-no-rate), i.e. no
  Browse Rates is ever required to escape a spinner.

---

## Tests / commands run — pass/fail

The ticket's suggested `npm run lint` / `npm test` do not exist in this repo;
the substitutes are `typecheck` + the repo's focused guard scripts.

| Command | Result |
|---|---|
| `npm run typecheck` (backend + web) | ✅ PASS |
| `npm run build:web` (vite) | ✅ PASS (~13 s) |
| `npx tsx scripts/ps-071-rate-cell-state-guard.ts` | ✅ PASS (incl. exhaustive no-deadlock sweep) |
| `node scripts/ps-099-orders-rate-cache-first-guard.mjs` (cache-first) | ✅ PASS |
| `node scripts/best-rate-dims-guard.mjs` | ✅ PASS |
| `node scripts/frontend-failure-states-guard.mjs` | ✅ PASS |
| `node scripts/orders-startup-requests-guard.mjs` | ✅ PASS |

## Browser / E2E evidence

Deterministic coverage is provided by the pure classifier guard (every no-rate
combination → a bounded/terminal state) plus the static source guards. A live
Playwright mocked-network test (`web/e2e/orders-ux.spec.js` style, intercepting
`/rates/multi`, `/api/carrier-accounts`, `/rates/cached/bulk`) and a screenshot
of the Awaiting table populating without Browse Rates need a running app +
auth + fixtures; recommended as a follow-up E2E once a rate-mock fixture exists.
No live carrier calls were made.

---

## Safety confirmation

- **No labels/postage bought, no marketplace notifications, no live carrier
  calls** — Retry reuses the existing cache-first passive path (`forceRefresh:
  false`); no new force-live rating was added to page load.
- **No shipped/cancelled mutation** — only the awaiting-shipment rate-cell
  *display* changed; the `shipped` branches of every renderer are untouched, and
  CLAUDE.md permits modifying `awaiting_shipment` order code. No `isReadOnly`,
  batch-action, or shipped/cancelled lockdown surface was altered.
- **No auth/RBAC/scope/secret changes** — carrier-account scoping and redaction
  are unchanged; no API keys, tokens, payloads, label URLs, or customer PII are
  exposed in logs/tests.
- **No spinner CSS hidden** — the fix changes state/data flow; spinners remain
  for genuinely in-flight requests and resolve to terminal states.
- **No concurrency increase** — the passive effect's `workerCount` (min 2) and
  cache-first ordering are unchanged.
