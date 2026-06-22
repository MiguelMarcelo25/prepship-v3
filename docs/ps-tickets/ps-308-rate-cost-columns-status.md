# PS-308 Rate Cost Columns Status

Date: 2026-06-22

## Current Status

Current completion estimate: PS-308 89%.

PS-308 is Final Review-ready for code/test review. The rate money model now
separates the customer-facing Best/Selected Rate from internal Rate Cost and
Shipping Margin. Backend owners compute the amounts, backend redaction hides
internal cost/margin fields from non-financial viewers, and frontend surfaces
render the returned fields instead of calculating the business truth.

PS-308 supersedes the old PS-292 stacked SHIPP tuple direction. PS-292 can stay
focused on proving the legacy tuple did not leak or regress, while PS-308 owns
the final separated-column direction.

## Evidence Now Wired

- `test:ps-308-rate-cost-columns`
- `test:ps-308-rate-cost-columns-closeout`

## What Is Proven

- `src/services/shipping-workflow/rate-money.ts` emits explicit
  `customerRateAmount`, `rateCostAmount`, `shippingMarginAmount`, and
  `shippingMarginPct` fields.
- House awaiting rows use projected `customer_rate` against SHIPP internal cost.
- House shipped rows use realized `customer_rate` against actual SHIPP cost.
- Normal awaiting rows keep marked customer charge separate from carrier cost.
- `src/services/rates-combined.ts` ranks by customer charge while exposing
  `rateCostTotal()` as a separate internal cost helper.
- `src/services/order-rate-dto.ts` preserves and derives the separated fields
  for current and older house rows.
- Order and Rate Browser redaction hide Rate Cost, margin, and source fields
  for non-financial/client viewers.
- `web/src/components/RateRowItem.tsx` no longer renders SHIPP House as a
  stacked customer-rate-over-DRP-cost tuple; it renders explicit Rate Cost,
  Margin, and House badge display from returned fields.

## Missing Before 100%

- Read-only production/admin spot-check after deploy confirming financial users
  see Rate Cost and Shipping Margin while non-financial/client viewers do not.
- Trello move/comment only after explicit `task update`.

## Safety

This proof is offline-only. It does not run live carrier calls, buy postage,
print labels, mutate queues, notify marketplaces, update production orders, or
mutate shipped/cancelled data.
