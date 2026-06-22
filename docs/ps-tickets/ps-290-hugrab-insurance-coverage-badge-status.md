# PS-290 HUGRAB insurance coverage badge status

Date: 2026-06-22

## Current status

Current completion estimate: PS-290 91%.

PS-290 is Final Review-ready after the focused guards pass. The backend owns the
HUGRAB $100 insurance coverage verdict, the order-rate DTO carries the badge
fields, Awaiting rows and Rate Browser rows share the same frontend reader and
renderer, and the purchase-gate indicator consumes the same backend verdict used
by the label purchase preflight.

## Evidence

- `test:ps-290-hugrab-insurance-coverage-badge`
- `test:ps-290-hugrab-insurance-coverage-badge-closeout`
- `test:ps-261-hugrab-label-purchase-gate`
- `test:ps-274-shipp-insurance-certainty`

## What is proven

- HUGRAB ParcelGuard/EasyPost-style positive premium coverage resolves to
  included/green.
- Direct carrier $0 first-$100 declared value resolves to included/green.
- Explicit no-insurance resolves to not_included/red.
- Unproven SHIPP-brokered declared value remains unknown/amber unless the
  provider-specific SHIPP customs-value proof flag/source is intentionally used.
- Non-HUGRAB rows resolve to not_required and render no badge.
- `order-rate-dto.ts` delegates to `resolveInsuranceCoverageStatus()` instead of
  re-deriving the badge verdict.
- `orders-row-display.tsx` and `RateRowItem.tsx` render the backend verdict
  through the same shared reader/renderer.
- The PS-261 purchase-gate display and label preflight consume the PS-290
  verdict, so operator display and purchase blocking stay aligned.
- The proof is offline only: no real labels, postage, provider calls,
  marketplace notifications, production order mutation, or shipped/cancelled
  data mutation.

## Remaining before 100%

Optional next evidence: browser screenshot or read-only operator eyeball showing
the badge on a real HUGRAB row in Awaiting Shipment and Rate Browser. This is not
blocking Final Review because the backend owner and frontend pass-through guards
already pin the behavior.
