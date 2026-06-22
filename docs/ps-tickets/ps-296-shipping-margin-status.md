# PS-296 Shipping margin analytics status

Date: 2026-06-20

## Current status

Current completion estimate: PS-296 89%.

PS-296 is Final Review-ready for code/test review, but not fully closed. The backend read model,
Billing API, Dashboard API, API client, and dashboard/billing UI consumers exist and are pinned by
the guard. The remaining work is read-only production confidence and missing-row cleanup, not moving
margin math into the UI or adding frontend calculations.

## Evidence now wired

- `test:ps-296-shipping-margin`
- `test:ps-296-shipping-margin-closeout`

## What is proven

- `src/services/shipping-margin-analytics.ts` owns the backend read model and margin arithmetic.
- Actual cost provenance comes from shipment cost, label cost, and other cost sources.
- Billable provenance prefers frozen billing line item shipping totals, then explicit projected
  billable sources such as house customer rate.
- Summary evidence now separates missing billable proof, missing actual-cost proof, and any missing
  proof so the canary packet can identify exactly why a row is excluded from margin totals.
- Every row now carries backend-owned `missingProofReasons`, so cleanup can distinguish
  `missing_actual_cost`, `missing_billable_shipping`, or both without UI inference.
- Billing and Dashboard routes expose thin scoped readers.
- The web API client consumes both routes and has a dashboard-to-billing fallback for deploy route
  skew.
- BillingView and DashboardView consume returned analytics without recomputing margin totals.
- The guard is offline only: no labels, postage, queue mutation, marketplace notification, or
  shipped/cancelled data mutation.

## Missing before close

- Read-only production canary confirming dashboard and billing views agree for the same date/client
  scope after deploy.
- A short evidence packet with totals, missing-row count, and representative frozen/projected rows.
- Follow-up cleanup for rows reported by `missingProofReasons` if DJ wants those rows included in the
  margin proof.

## Recommendation

Move PS-296 to Final Review - Lawrence once `task update` is approved. It should not be called 100%
until production evidence confirms the backend read model against real data.
