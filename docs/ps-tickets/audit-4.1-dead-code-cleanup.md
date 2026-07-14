# Audit 4.1 — dead-code cleanup placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** This slice removes unreachable poller/tier code and
  obsolete frontend markup/ranking authority. It does not introduce a new rate
  rule: the Rates page must render backend-issued money and best-rate identity.
- **Canonical owner:** `src/services/rates.ts` owns markup application and
  provider-level selection; `src/services/rates-combined.ts` owns the combined
  carrier winner; `src/services/rate-browse-response-producer.ts` emits the
  authoritative browse DTO and selected-rate proof.
- **Current duplicated/unsafe owners removed:** `rates-backfill.ts` contained an
  unreachable service-tier picker. `MarkupsContext` exposed unused frontend
  money/cache functions. `rates-parity.ts` reapplied settings markups and chose a
  local cheapest row even though `/rates/browse` already returned authoritative
  money aliases and `bestRate`.
- **Earliest imperfect-data entry:** The Rates page translated an already marked
  backend response, then independently hydrated settings and recalculated it.
  Deploy skew or alias differences could therefore double-apply or misapply a
  markup and select a different row from the backend.
- **Callers that delegate:** `RatesView` now calls the existing `browseRates`
  transport and passes `response.rates` plus `response.bestRate` to its display
  mapper. The mapper reads `selectedRateCost`, `cShippingRateAmount`,
  `shippingMarginAmount`, and backend `selectedRateKey` identity only.
- **Wrapper/helper logic deleted or forbidden:** No frontend markup lookup,
  markup formula, rate-cost reconstruction, or cheapest-rate reduction may be
  restored in the Rates page. The legacy array adapter remains only for the
  separate New Order compatibility caller and may not rank or mint proof.
- **Frontend role:** Format and render backend DTO values; collect rate-request
  input. It does not own markup, customer price, margin, official Best Rate, or
  selected-rate proof.
- **Backend boundary proof:** Existing rate source-of-truth, PS-313, PS-320,
  PS-339, markup, and combined-rate guards pin the backend owners.
- **Workflow proof:** `test:audit-dead-code-cleanup` behaviorally proves backend
  money pass-through and that a locally cheaper row cannot replace the backend
  best. It statically pins all named deletions and is mandatory in the SOT pack.

No shipped/cancelled path is touched. Verification is offline and performs no
configured database write, provider call, label/postage purchase, marketplace
notification, inventory change, or production data mutation.
