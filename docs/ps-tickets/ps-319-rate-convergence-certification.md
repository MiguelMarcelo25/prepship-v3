# PS-319 - Rate Convergence Certification

PS-319 is a post-PS-313 convergence certificate. PS-319 does not create a new canonical rate owner,
does not rewrite Best Rate, and does not duplicate the
PS-313 repo law. It proves that the existing PS-313/PS-317 owners are the
shared source for Awaiting Best Rate, Rate Browser, Recalculate, Apply Best
Rate, Create + Print, and Print Queue, or that the remaining production cutover
is explicitly canary-gated.

## Rate convergence SOT owner map

| Boundary | Current owner | Certified responsibility |
| --- | --- | --- |
| Carrier universe and eligibility | `src/services/rates-combined.ts#combineCarrierUniverses` | Combines ShipStation, direct-carrier, markup, HUGRAB, blocked/eligible, and diagnostics into one backend universe. |
| Final best-rate choice | `src/services/rates.ts#pickBestRate` plus PS-313 finalizers | Selects the backend-issued best/recommended rate; frontend consumers may render or pass it through only. |
| Snapshot/ref authority | `src/services/shipping-workflow/rate-quote-snapshot-store.ts` | Stores and resolves backend-owned `rateQuoteId` and `selectedRateKey`, with selected-rate proof validation before purchase. |
| Fingerprint and selected-rate proof | `src/services/shipping-workflow/rate-fingerprint.ts` | Owns request fingerprints, selected-rate authority keys, account binding, retry classification, and purchase proof errors. |
| Rate money/read display | `src/services/shipping-workflow/rate-money.ts` | Keeps rate money display and marked-up customer charge facts backend-owned. |

## Caller convergence matrix

| Caller | Delegation status | Proof |
| --- | --- | --- |
| Awaiting Best Rate | Reads backend DTOs from the best-rate workflow and displays backend truth. It does not choose or mint a best rate in React. | `test:ps-102-best-rate-workflow-dto`, `test:ps-286-awaiting-row-rate-truth`, `test:ps-328-rerate-warning-reason`, `test:rate-source-of-truth`. |
| Rate Browser | Calls backend `/rates/browse`, consumes backend `bestRate`, `secondBestRate`, `rateQuoteId`, `selectedRateKey`, proof metadata, diagnostics, and direct-carrier metadata. `RateBrowserModal` lifts those fields through Apply as pass-through data only. | `test:ps-279-rate-browser-no-fallback-best`, `test:ps-198-rate-quote-proof-passthrough`, `test:ps-302-apply-best-rate-authority`, `test:rate-source-of-truth`. |
| Recalculate | Uses the backend rate/finalization path instead of independently selecting a visible cheapest row. Residual recalculation tests remain the owner proof for strict Best Rate behavior. | `test:ps-124-backend-combined-best-rate`, `test:ps-203-best-rate-universe`, `test:ps-244-rate-finalization-single-owner`, `test:ps-293-canonical-house-tuple`. |
| Apply Best Rate | Delegates the atomic persist command to the backend owner. The frontend sends operator intent and backend-issued proof refs; backend validates the persisted DTO. | `test:ps-302-apply-best-rate-authority`, `test:ps-302-apply-best-rate-behavior`, `test:ps-302-thin-client-apply-delegation`. |
| Create + Print | `src/services/labels.ts#createLabelV2` runs `assertLabelPurchaseRateSelection` before the direct-carrier or ShipStation provider branches. Incomplete snapshots and non-best selections throw proof errors before postage can be purchased. | `test:selected-rate-proof-boundary`, `test:ps-191-retry-eligibility`, `test:ps-098-shipping-purchase-boundary`. |
| Print Queue | `src/routes/print-queue.ts` preserves `selectedRateProof`, `rateQuoteId`, and `selectedRateKey`; `src/services/print-queue.ts` delegates missing-label creation to `createLabelV2` and reports backend retry eligibility structurally. | `test:print-to-queue-selected-rate-proof`, `test:ps-303-print-queue-authority`, `test:ps-303-fe-route-binding`, `test:ps-191-retry-eligibility`. |

## Residual gaps and limits

- Strict snapshot-only enforcement remains canary-gated. In default canary mode,
  unresolved missing/expired refs may still fall through to the legacy carried
  proof, which is also strict. High-risk convergence failures are already hard
  blocks: `snapshot_not_final` and `selected_rate_not_best` throw
  `SelectedRateProofError` before any provider purchase.
- PRINT_QUEUE_BACKEND_ORCHESTRATION remains default-off. The backend route
  plan and direct-via-backend queue path are certified, but production cutover
  remains a DJ canary decision.
- Browser coverage is represented by existing mocked workflow tests and this
  offline workflow guard. PS-319 performs no live browser/provider run by
  itself and does not buy labels.
- HUGRAB insurance proof, SHIPP/house tuple behavior, marked-up customer charge
  ranking, and no-fallback selected-rate law remain covered by their owner
  guards instead of being copied into a new PS-319 owner.

## Workflow proof

The new certification guard is:

- `test:ps-319-rate-convergence-certification`

It composes the behavioral source-of-truth checks above with static boundary
checks that:

- `rate-quote-snapshot-store.ts` blocks `snapshot_not_final` and
  `selected_rate_not_best` before canary fallback.
- `labels.ts#createLabelV2` validates snapshot/proof/account binding before
  direct-carrier and ShipStation purchase branches.
- `print-queue.ts` delegates label creation to `createLabelV2` and surfaces
  `classifyLabelPurchaseRetry` results.
- `print-queue.ts` route validation preserves `selectedRateProof`,
  `rateQuoteId`, and `selectedRateKey`.
- `web/src/lib/rate-proof.ts`, `RateBrowserModal.tsx`, and
  `web/src/lib/v2-apiClient.ts` consume/pass through backend-issued rate
  proof fields and do not mint fingerprints, selected-rate authority keys, or
  local `combined[0]` best-rate authority.

Predecessor guards that remain required evidence:

- `test:rate-source-of-truth`
- `test:ps-302-apply-best-rate-authority`
- `test:ps-303-print-queue-authority`
- `test:selected-rate-proof-boundary`
- `test:print-to-queue-selected-rate-proof`
- `test:ps-191-retry-eligibility`
- `test:ps-198-rate-quote-proof-passthrough`
- `test:ps-328-rerate-warning-reason`
- `test:ps-307-marked-rate-comparison`
- `test:ps-327-hugrab-margin-policy`

## Safety

This certification is offline and read-only. It performs No real label purchases,
No postage, No marketplace notifications, No production order mutations, and
No shipped/cancelled mutations. It does not edit
`src/routes/orders.ts`, `web/src/components/Views/OrdersView.tsx`,
`src/db/schema/orders.ts`, `src/db/schema/shipments.ts`, or shipment history.
