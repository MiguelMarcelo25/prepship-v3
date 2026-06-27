# PS-321 RateBrowserModal Thin UI Cleanup

> **For Lawrence:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Keep `RateBrowserModal` as a renderer/action surface over backend-owned rate DTO facts after PS-313/PS-319. The modal must not own canonical best-rate selection, service eligibility, proof freshness, or selected-rate proof construction.

## Source Of Truth

- Canonical owner: backend rate DTO/stamp layer, especially `src/services/order-rate-dto.ts` and `src/services/shipping-workflow/rate-eligibility-stamp.ts`.
- Frontend display helper: `web/src/lib/rate-browser-availability.ts`, a pure reader of backend DTO fields only.
- Thin UI consumer: `web/src/components/RateBrowserModal.tsx`.

## Logic Inventory

- Pure display formatting remains in the modal and row components: carrier labels, totals, badges, row layout, partial-failure diagnostics.
- UI state remains in the modal: selected carrier account, view mode, filters, dimensions, weight, confirmation, insurance dropdowns.
- Action dispatch remains in the modal: apply clicked row, emit backend canonical best, close modal.
- Business truth is delegated: best/recommended rate comes from backend canonical best, eligibility/block reasons come from DTO stamps, proof freshness comes from backend `isComplete`, and selected-rate proof is passed through unchanged.

## Implementation Tasks

- [x] Add `rate-browser-availability.ts` as a pure frontend reader of backend DTO availability facts.
- [x] Remove the modal's local `evaluateShippingServiceEligibility` fallback.
- [x] Gate manual and auto-applied rates through the same backend-availability read before applying.
- [x] Preserve explicitly mocked/test rates as mock-only selectable rows without minting backend proof.
- [x] Add `scripts/ps-321-ratebrowsermodal-thin-ui-guard.ts`.
- [x] Update predecessor guards that still required the older deploy-skew fallback.
- [x] Extend existing mocked browser proof for valid rows, backend-blocked rows, stale/proofless rows, partial carrier diagnostics, and selected proof payload pass-through.
- [x] Addendum 2026-06-27: remove the RateBrowserModal `rateDisplayTotal(markups)` visible amount/rank path.
- [x] Addendum 2026-06-27: add `rate-browser-money.ts` as a pure backend DTO money/rank reader.
- [x] Addendum 2026-06-27: make Rate Browser rows render backend customer/rate-cost amounts and sort through `sortRateRowsByBackendDisplayRank`.

## Verification

- `npm run test:ps-321-ratebrowsermodal-thin-ui`
- `npm run test:ps-135b-eligibility-fragmentation`
- `npm run test:ps-279-backend-eligibility-stamp`
- `npm run test:ps-279-backend-boundary-closeout`
- `npm run test:ps-057-hugrab-ground-saver`
- `npx playwright test web/e2e/site-actions.spec.js -g "Rate Browser partial carrier failures" --reporter=line`

## Safety

- No real labels.
- No postage.
- No voids.
- No marketplace notifications.
- No production shipped/cancelled mutations.
- No customer PII.
