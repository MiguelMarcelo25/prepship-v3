# PS-307 Marked Rate Comparison Status

Date: 2026-06-22

## Current Status

Current completion estimate: PS-307 89%.

PS-307 is Final Review-ready for code/test review. The backend combined-rate
owner now ranks by the customer/marked charge, not raw carrier/internal cost.
This keeps Best Rate selection aligned with what the customer is actually
charged and prevents a low internal-cost SHIPP/house rate from winning when its
customer charge is higher than another eligible rate.

## Evidence Now Wired

- `test:ps-307-marked-rate-comparison`
- `test:ps-307-marked-rate-comparison-closeout`

## What Is Proven

- `src/services/rates-combined.ts` owns the combined best-rate comparison and
  `rateTotal()` prefers explicit customer charge fields before raw/internal
  carrier cost.
- `combineCarrierUniverses()` sorts eligible rates by that backend-owned
  customer-charge total.
- SHIPP house `customer_rate` competitor selection uses the same
  customer-charge basis.
- Browse-rate dedupe keeps same carrier/service rates distinct when customer
  charges differ.
- `src/services/rates.ts` delegates local best-rate comparison to the combined
  `rateTotal()` owner instead of maintaining a separate comparison rule.
- Direct-carrier rates preserve both customer amount and raw/internal cost so
  PS-308 Rate Cost display can remain separate from PS-307 ranking.

## Missing Before 100%

- Read-only production spot-check after deploy: verify a mixed carrier/SHIPP
  account rate set where the cheapest raw/internal cost is not the cheapest
  customer charge.
- Trello move/comment only after explicit `task update`.

## Safety

This proof is offline-only. It does not run live carrier calls, buy postage,
print labels, mutate queues, notify marketplaces, update production orders, or
mutate shipped/cancelled data.
