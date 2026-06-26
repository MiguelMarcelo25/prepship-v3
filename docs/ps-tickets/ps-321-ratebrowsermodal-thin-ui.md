# PS-321 - RateBrowserModal Thin UI Cleanup

RateBrowserModal now reads backend-owned availability and proof facts instead of recomputing rate eligibility locally.

## Backend DTO/SOT Owner Used

- `src/services/order-rate-dto.ts`
- `src/services/shipping-workflow/rate-eligibility-stamp.ts`
- Backend `/rates/browse` DTO facts: `eligibilityBlocked`, `eligibilityBlockReason`, `isComplete`, `rateQuoteId`, `selectedRateKey`, `requestFingerprint`, `proofSource`.

## Frontend Logic Removed/Delegated

- Removed the modal's `evaluateShippingServiceEligibility` fallback.
- Added `web/src/lib/rate-browser-availability.ts` as a display-safe reader only.
- `handleRateClick` and `toAppliedRate` now refuse unavailable rows before apply.

## Wrapper/Mapper Safety

`rate-browser-availability.ts` does not import backend policy, API clients, markups, or block lists. It only reads backend DTO fields already returned by the rate owner.

Explicit `testRate`/`mocked` rows remain selectable for test-order flows, but the helper does not mint `rateQuoteId`, `selectedRateKey`, `requestFingerprint`, or `proofSource`.

## Browser Proof

The mocked `site-actions` Rate Browser proof now covers:

- valid rows with backend proof metadata
- backend-blocked row display
- stale/proofless row display
- partial carrier failure diagnostics
- selected proof payload pass-through into `/orders/:id/apply-best-rate`

## Safety

All proof is offline/mocked. No real labels, postage, voids, marketplace notifications, production shipped/cancelled mutations, or customer PII.
