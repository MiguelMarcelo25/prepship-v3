# PS-069 — Billing Summary shows orders but Details is empty

**Status:** Fixed. Frontend stops hiding `/billing/details` failures as empty,
and the Line Items panel now shows an explicit mismatch warning (with an
operator next step) when Summary claims orders but no detail rows load —
instead of a silent "No line items found." Pure-logic guard + read-only
diagnostic added.

**Reported:** Billing → Generate & Summary showed HUGRAB with 158 orders and
nonzero totals, but clicking the row opened "Line Items — HUGRAB · showing 158
orders" while the table said **"No line items found."**

---

## Summary — root cause

Two-source-of-truth + error-hiding, not a data bug:

1. **Details swallowed every error as empty.** `fetchBillingDetails()` in
   `web/src/lib/v2-apiClient.ts` wrapped the request in `safe(..., [])`, which
   catches **any** failure (500 / 403 / timeout) and returns `[]`. The
   component's own `try/catch` in `handleLoadDetails` was therefore **dead
   code** — a failed details fetch arrived as `rows: [], error: null` and
   rendered the normal empty state.
2. **Summary is cached, Details is live.** `fetchBillingSummary()` uses
   `cachedSafe(..., { throwOnError: true })` (60 s client cache, 10 min stale)
   on top of the backend `billing_summary_metrics` 45-min TTL, while Details
   reads `billing_line_items` live. So a **stale summary window** — or the
   **delete→insert window inside `generateLineItems`** (it deletes the range
   then batch-inserts, *not* in one transaction) — shows "158 orders" up top
   while a details load in that moment returns zero rows.

Either trigger produces the exact report. The live data is currently consistent
(HUGRAB 190 orders = 190 detail rows for the range), i.e. a regenerate has since
healed it — which is why this is a *defensive* fix per the ticket DoD: the UI
must never present a Summary/Details mismatch as a normal empty state, and must
never hide a details API error.

---

## Behavior changed

- **`fetchBillingDetails` no longer hides errors.** A real `/billing/details`
  failure now **rejects**, so `handleLoadDetails`'s catch sets
  `detailState.error` and the panel shows a red **"Billing details failed to
  load"** banner (with the underlying message + an Update-Billing hint). A
  genuine `200 {data: []}` still resolves to `[]` (legitimate empty state).
- **Summary/Details mismatch is now explicit.** New pure classifier
  `classifyBillingDetailPanel` (in `billing-parity.ts`) decides the panel state:
  `loading | error | rows | mismatch | empty`. When Details returns zero rows
  **but** the open client's Summary row claims orders/totals, the panel renders
  an amber **"Summary / line-item mismatch"** warning naming the order count and
  pointing the operator at **Update Billing / Regenerate Range** — instead of
  "No line items found."
- **Error always beats empty** — even when Summary claims orders, an API error
  shows the error banner, never the mismatch/empty state.

---

## Files changed

- `web/src/lib/v2-apiClient.ts` — `fetchBillingDetails` no longer wrapped in
  `safe(...,[])`; errors propagate, true-empty still returns `[]`.
- `web/src/components/Views/billing-parity.ts` — new pure
  `classifyBillingDetailPanel(...)` + `BillingDetailPanelState` type.
- `web/src/components/Views/BillingView.tsx` — derive panel state from the open
  client's Summary row; render error banner / mismatch warning / table
  accordingly (replaces the bare `detailState.error` div and unconditional
  empty message).

**New artifacts**
- `scripts/ps-069-billing-detail-consistency-guard.ts` — 7 pure-logic
  assertions over the real `classifyBillingDetailPanel` (error beats empty,
  summary-nonzero + zero rows ⇒ mismatch, genuine empty stays empty, etc.).
- `scripts/ps-069-billing-summary-details-diagnostic.ts` — read-only, redacted:
  for a client/range it reports the summary cache row (+ freshness), the live
  `billing_line_items` aggregate, the Details row population, and a verdict
  (agree / stale-cache mismatch / hidden-error). Run:
  `npx tsx scripts/ps-069-billing-summary-details-diagnostic.ts [clientId] [dateFrom] [dateTo]`.

---

## Tests / commands run — pass/fail

| Command | Result |
|---|---|
| `npm run typecheck` (backend + web) | ✅ PASS (clean) |
| `npm run build:web` (vite) | ✅ PASS (built ~10 s) |
| `scripts/ps-069-billing-detail-consistency-guard.ts` (7) | ✅ PASS |
| `scripts/billing-formula-guard.ts` | ✅ PASS (no regression) |
| `scripts/billing-detail-ps040-guard.ts` | ✅ PASS |
| `scripts/ps-068-billing-pricing-guard.ts` | ✅ PASS |
| Live PS-069 diagnostic (HUGRAB, Mar4–Jun2, read-only) | ✅ ran — see below |

## HUGRAB summary/details diagnostic — redacted

| | Value |
|---|---|
| Coerced range | `2026-03-04T08:00Z` … `2026-06-03T06:59Z` (cache key `2026-03-04`/`2026-06-03`) |
| Summary cache row for exact range key | none (Summary falls to LIVE aggregation) |
| LIVE `billing_line_items` | **190 orders**, 673 line rows, grand $2433.73 |
| Details query population | **673 rows (190 orders)** |
| Verdict | **OK — Summary and Details agree** |

The mismatch is not reproducing live (data healed by a regenerate). The fix
guarantees that if it recurs (stale cache, regenerate race, or details API
error), the operator sees an explicit warning/error with a next step rather than
a misleading empty table.

---

## Remaining / follow-ups

- **Race window in `generateLineItems`** — it `DELETE`s the range then
  batch-inserts outside a single transaction, so a details load mid-generate can
  legitimately see zero rows. PS-069 makes this *visible/safe* (mismatch
  warning). Wrapping the delete+insert in one transaction would remove the
  window entirely; tracked as a separate hardening item (touches the shipped
  billing-generation path).
- **Summary stale window** — bounded by the 45-min metrics TTL and the 60 s
  client cache; already self-heals on read and is GC'd (see PS-068 follow-up).

---

## Safety confirmation

- **No live side effects** — no labels, postage, or marketplace calls. Guard is
  pure logic; diagnostic is read-only/redacted; no DB mutations.
- **Auth/RBAC/scope untouched** — `/billing/details` still runs under
  `requirePermission('financials:read')` and the same client/store scope
  predicate; the fix only changes client-side error handling + presentation.
- **No PII/secrets** — diagnostic emits counts, totals, ids, and dates only.
- **Lockdown respected** — no shipped/cancelled order or `shipments` changes; no
  schema changes; billing-generation logic not modified.
