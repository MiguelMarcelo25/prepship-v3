# PS-323 — Billing source-of-truth gap map

**Card:** PS-323 — Billing read-model gap audit/cleanup over existing PS-310/311/312/296 work
([trello.com/c/ACyTW3Qk](https://trello.com/c/ACyTW3Qk)) · Baseline: `origin/prepshipv4-stable`.

**Mandate:** *audit*, not rewrite. Verify whether any billing money value is still computed in the
frontend or an export helper by a formula that could diverge from the canonical backend billing
DTO. Fix only genuine residual recompute / stale-generated-state drift; do not redo PS-310 / 311 /
312 / 275 / 296 / 207 / 208 / 217.

## Conclusion

**No residual money-recompute drift remains.** Every billed value is owned by the backend generator
and frozen into `billing_line_items.total_cost` at generate time; the on-screen summary/detail and
the three invoice exports all read the **same** read model. The prior cards already closed the
billing source-of-truth. The one candidate (a summary-cache staleness window) was investigated and
**refuted**. The audit conclusion is locked by a new focused guard so it cannot regress.

## Surface map

| Surface | Classification | Owner / why |
|---|---|---|
| Summary table | display aggregation | `billingSummary()` returns `pickPackFeeTotal` / `fulfillmentFeeTotal` / `grandTotal` as `sum(total_cost)` over `billing_line_items`; FE `buildBillingSummaryTotals` only reduces those across rows. |
| Detail table | display aggregation | `billingDetails()` returns per-line `total_cost` verbatim; FE `computeBillingDetailMetrics` / `aggregateBillingDetailRowsByOrder` route + sum the same backend dollars (resets `totalCost:0` to avoid double-count). |
| HTML / PDF invoice | display aggregation | `renderInvoiceHtml` formats `billingInvoiceData`. |
| XLSX invoice | display aggregation | `renderInvoiceXlsx` formats the same `billingInvoiceData`. |
| CSV invoice | display aggregation | `renderInvoiceCsv` (extracted) formats the same `billingInvoiceData`; per-row Total expression identical to HTML/XLSX. |
| Box / package cost | backend owned | `decidePackageCostLine` (billing-box-policy.ts) applies configured price × (1+markup) or operator override, frozen into the `package_cost` line. |
| Shipping + margin | backend owned | `decideShippingLineBilling` owns billed shipping; PS-296 margin fetched verbatim (FE never computes billable−actual as a billed value). |
| Bundle primary/child | backend owned | `decideBundleBillingTreatment` zeroes child shipping/box in the generator (bill-once). |
| Fee waiver ($0 prep) | backend owned | `applyPrepFeeWaiver` zeroes prep lines in the generator; one shared waiver-indicator owner feeds all 3 exports. |
| Generated/frozen/stale state | backend owned | `stalePackagePrice` and frozen/projected are backend flags rendered by the FE; the summary cache is invalidated by `refreshBillingSummaryMetrics()` inside `generateLineItems()` on every regenerate. |

## Refuted candidate

> *Summary cache (`billing_summary_metrics`) can lag Details/Invoice for up to 45 min after a
> regenerate.* **False positive.** `generateLineItems()` (`src/services/billing.ts`) synchronously
> calls `refreshBillingSummaryMetrics(from, to)` after writing the line items, which deletes + re-inserts
> the exact period window as a fresh `sum(total_cost)` over the same `billing_line_items`. Every
> regenerate path (`/generate`, box-cost bulk/by-dims apply, by-dims revert) calls `generateLineItems`,
> so the cache is refreshed. The 45-min TTL is a read-side rescue ceiling, not the invalidation
> mechanism. Same formula, same source column, refreshed on every write — no real divergence.

## Single source of truth

`billing_line_items.total_cost` (written once by the generator with markup/price/fees applied and
frozen). Read live by `billingDetails()` and `billingInvoiceData()`; pre-aggregated (same `sum`) into
`billing_summary_metrics` for the summary. The three exports all consume `billingInvoiceData`; their
per-order Total is `row_total > 0 ? row_total : pickPackFee + shipping + storage`, identical across
HTML / XLSX / CSV, where `row_total = sum(b.total_cost)`.

## Regression lock

`scripts/ps-323-billing-sot-parity-guard.ts` (`npm run test:ps-323-billing-sot-parity`) fails if:
- the CSV serializer stops reading the backend `row_total` verbatim or changes the fallback formula;
- the HTML / XLSX / CSV per-order Total expressions stop matching each other;
- an export route stops feeding off `billingInvoiceData`, or an export starts applying its own markup;
- the FE billing math stops preferring the backend `fulfillmentFeeTotal` / `grandTotal` and invents a
  divergent total.
