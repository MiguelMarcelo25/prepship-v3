# PS-068 — Recalculate billing when client package prices change

**Status:** Core fix committed (`a253fffc`); per-client staleness
detection, operator save-prompt, per-line stale flag, diagnostic, and
guards completed on top. This packet documents the root cause, behavior
change, operator runbook, and follow-ups.

**Scope:** Client package (box) pricing must flow through to billing.
Editing a client's package price (or billing-config markup) must mark
billing stale so **Update Billing** rebuilds and re-prices, instead of
silently no-op'ing or wiping the client's billing.

---

## Summary — root cause

Two independent bugs combined to make billing both **wrong** and
**dangerously silent**:

1. **shipDate string→Date generation failure (the data-loss bug).**
   `generateLineItems` built each row's `shipDate` from a raw `sql<>`
   expression (`billingShipDateSql`). Drizzle returns that as a
   **string**, but the timestamp insert path calls `.toISOString()` on
   the value → `"value.toISOString is not a function"`. The throw was
   swallowed (`catch { skipped++ }`), so generate **reported success
   while inserting nothing**. Because generate **DELETEs the range then
   rebuilds**, this wiped a client's billing — HUGRAB dropped to **0
   line items** — while the cached summary kept serving the old box
   price. **Fix:** coerce to a real Date at the source
   (`shipDate: row.billingShipDate ? new Date(row.billingShipDate) : null`).

2. **Freshness check ignored price/config changes (the stale bug).**
   `billingGenerationStatus` only compared **shipment recency**, so
   editing a package price never marked billing stale and **Update
   Billing** no-op'd — the new price never reached billing.

3. **Errors were swallowed.** The silent `catch` let bug #1 masquerade
   as success and hid the whole failure class.

---

## Behavior changed (committed)

- **Generation works.** Rows insert with a real `Date` ship date; no
  more silent wipe on regenerate.
- **Update Billing is price-aware — PER CLIENT.** `billingGenerationStatus`
  flags the range stale when **any scoped client that already has billing
  in the range** had a `client_package_prices` / `billing_config` change
  **after that client's own newest billing line was generated** (an
  `EXISTS` over each client comparing its `greatest(price.updated_at,
  config.updated_at)` to its `max(billing_line_items.created_at)`).
  - This is computed **per client, not as two global maxima**, so the
    all-clients "Update Billing" path cannot mask one client's stale
    price behind another client's later (re)bill (the high-priority gap
    from review).
  - When stale it returns `upToDate: false` with `missingFrom` = full
    range start, so Update Billing **rebuilds the full range and
    re-prices**. The pure rule is unit-tested via the exported
    `billingNeedsRepriceForPriceChange(...)` helper.
- **Operator prompt on price save.** Saving package prices in
  `BillingView` now shows a follow-up toast: *"Existing billing for this
  client is now out of date — run Update Billing for the affected date
  range."* — so the operator never has to guess a regenerate is needed.
- **Per-line stale flag in Billing Details (API).** `billingDetails`
  now returns `stalePackagePrice` (+ `stale_package_price`) on
  `package_cost` rows whose `created_at` predates the client's latest
  price/config change — ready for a visible badge.
- **Insert errors are logged** (chunk + per-row) — this bug class can
  no longer hide.
- **Caches refresh on regeneration.** A full-range rebuild re-runs
  `refreshBillingSummaryMetrics(from, to)`, which deletes+reinserts
  `package_total = SUM(total_cost WHERE line_type='package_cost')` in
  `billing_summary_metrics`, so the cached `billingSummary` reflects the
  new box price (no longer pinned by the 45-min TTL).

---

## Operator runbook

### How a box-price change now flows to billing

1. Operator edits a client's package price (e.g. HUGRAB `12x10x3`
   `1.12 → 1.17`), or changes that client's
   `billing_config.package_cost_markup`. This bumps
   `client_package_prices.updated_at` / `billing_config.updated_at`.
2. `billingGenerationStatus` sees `pricingChangedAt > billingGeneratedAt`
   and marks the range **stale** (`upToDate: false`,
   `missingFrom` = range start).
3. Operator clicks **Update Billing**. The full range is rebuilt and
   re-priced; effective box price =
   `basePrice * (1 + packageCostMarkup/100)`, stored on each
   `line_type='package_cost'` row's `unit_cost`/`total_cost` with
   description `Box (<pkgName>)`.
4. The summary cache is refreshed in the same pass, so the Billing
   summary and Billing Details both show the new price.

### When a Regenerate is still needed

- **No automatic re-pricing on price save.** Staleness is detected, but
  the operator must still click **Update Billing** to apply it. Nothing
  re-prices in the background.
- **Past closed/exported invoices** are not retroactively changed by a
  price edit unless that range is explicitly regenerated.
- If a price was changed while billing was already shown, refresh the
  Billing view so the stale flag is fetched before clicking Update.
- A regenerate re-prices the **entire range** for the scoped client
  (delete-then-rebuild), so expect all `package_cost` lines in range to
  move to the new price — this is intended.

---

## Files changed + new artifacts

**Changed**
- `src/services/billing.ts`
  - `generateLineItems`: coerce `shipDate` to a real `Date`.
  - `billingGenerationStatus`: per-client `EXISTS` staleness on
    price/config change (returns stale + full-range `missingFrom`).
  - `billingDetails`: per-line `stalePackagePrice` flag.
  - New exported pure helper `billingNeedsRepriceForPriceChange(...)`.
  - Insert errors logged instead of swallowed.
- `web/src/components/Views/BillingView.tsx`
  - Operator "billing is now out of date — run Update Billing" toast
    after a successful package-price save.

**New artifacts**
- `scripts/ps-billing-reprice-staleness-guard.ts` — pure-logic guard
  over `billingNeedsRepriceForPriceChange` (passes; no DB mutation).
- `scripts/ps-068-billing-pricing-guard.ts` — 12 pure-logic assertions:
  effective-price math, custom-vs-default rule, stale detection,
  summary/detail invariant (passes).
- `scripts/ps-068-billing-pricing-diagnostic.ts` — read-only, redacted
  diagnostic: effective price, rows at old vs new price, regenerate
  delta, summary/detail consistency, dims-collision check.
  Run: `npx tsx scripts/ps-068-billing-pricing-diagnostic.ts [clientId] [packageId]`.

**Read-only references (not modified)**
- `src/services/reporting-metrics.ts` — `refreshBillingSummaryMetrics`,
  `getFreshBillingSummaryMetrics` (45-min TTL cache).
- `billingDetails` (~`src/services/billing.ts:1271`) reads
  `billing_line_items` directly for the per-order display.
- `resolvePackageId()` package-resolution order: SKU/inventory package →
  shipment dims → rate dims → selected package → rounded dims.

---

## Remaining / follow-ups

- **Visible per-line stale badge** — the API now returns
  `stalePackagePrice` on `package_cost` detail rows; the remaining work
  is purely cosmetic: thread it through `aggregateBillingDetailRowsByOrder`
  and render a small "stale — regenerate" badge on the Box Cost cell in
  `BillingView`. Lower value now that price-save prompts the operator and
  Update Billing correctly re-prices.
- **Summary cache windowing — RESOLVED.** `billing_summary_metrics`
  stores overlapping period windows keyed `(client_id, period_from,
  period_to)`. The read path (`getFreshBillingSummaryMetrics`) already
  matches one **exact** window + a 45-min TTL, so the app never sums
  across windows — the window it serves for a given range is correct, and
  a window older than the TTL is ignored and rebuilt on read.
  - **GC is now wired** (commit `e061499b`):
    `pruneBillingSummaryMetrics` removes orphaned (no active/non-system
    client) and stale (`updated_at` older than retention, default 45 d)
    windows. It runs periodically via `runReportingRefreshTick`
    → `refreshReportingMetrics`, and on demand via
    `scripts/prune-billing-summary-metrics.ts [--apply] [--days N]`.
    So old/overlapping windows no longer accumulate unbounded.
  - **Diagnostic corrected.** `ps-068-billing-pricing-diagnostic.ts`
    previously compared the SUM of `package_total` across **all** windows
    against the live detail SUM — a structurally guaranteed "MISMATCH"
    because overlapping windows double-count. It now checks **per
    window** (each cached `package_total` vs the live `package_cost` SUM
    over that window's day range) and reports only **fresh-window**
    mismatches as actionable; stale windows are labelled "rebuilds on
    read". Verified on HUGRAB: all fresh served windows OK.
  - The pure per-window invariant and the override exclusion (below) are
    locked in `scripts/ps-068-billing-pricing-guard.ts`.

- **Diagnostic no longer mistakes manual box overrides for stale prices.**
  A `package_cost` row carrying a manual `billing_line_items.package_id`
  override (set via the Edit Billing Detail modal) holds a deliberate
  operator cost, not a generated price. The diagnostic now **excludes**
  these from the "rows at old price" count and reports them separately,
  so an intentional edit is never flagged as stale (real case: HUGRAB
  order 1144598 overridden to pkg 212 "14x10x8" at $1.47). A blind
  regenerate would *discard* such an override, so it is intentionally
  left out of the staleness/regenerate path.
- **Deactivated-client / price-row-deletion edge cases** — staleness
  detection filters `clients.active = true` (deactivated clients aren't
  regenerated anyway) and keys on `updated_at`, so *deleting* a custom
  price row (to fall back to default) bumps no timestamp and isn't
  flagged. Narrow; documented limitation.
- **Walmart-DJC missing-shipping-cost data gap** — Walmart-DJC orders
  lack a captured shipping cost upstream, so their billing lines can be
  incomplete. This is a **data-availability gap, separate from PS-068**
  (price recalc) and should be tracked on its own ticket.

---

## Safety confirmation

- **No live side effects.** No labels purchased, no postage spent, no
  marketplace notifications sent. Diagnostics/guard are read-only / pure
  logic.
- **No PII or secrets.** No customer names, full addresses, raw provider
  payloads, raw label URLs, or credentials in this packet or artifacts.
- **Lockdown respected.** No changes to shipped/cancelled lockdown
  surfaces (`src/routes/orders.ts`, `src/services/fulfillment-deductions.ts`,
  `src/db/schema/orders.ts`, `src/db/schema/shipments.ts`); no SQL
  UPDATE/DELETE against shipped/cancelled orders or the `shipments`
  table. HUGRAB / PS-057 protections not weakened.
- **Type-safe.** Backend + web `typecheck` pass.
