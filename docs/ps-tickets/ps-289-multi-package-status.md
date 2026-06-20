# PS-289 Multi-package shipment groups status

Date: 2026-06-20

## Current status

Current completion estimate: PS-289 18%.

PS-289 is not Final Review-ready. The first backend-owned planning slice exists, but the real
product still needs schema, label-purchase workflow, print queue, marketplace confirmation, and UI
work before any operator should use it.

## Evidence now wired

- `test:ps-289-multi-package-plan`
- `test:ps-289-multi-package-closeout`

## What is proven

- `src/services/shipping-workflow/multi-package-shipment-plan.ts` builds a pure package-group plan.
- The planner marks single-package versus multi-package mode.
- Package keys are normalized and duplicate keys are rejected before any label purchase planning.
- Per-package label idempotency keys are stable.
- The first slice has no DB, provider, label, print queue, marketplace, postage, or shipped/cancelled
  mutation behavior.

## Missing before close

- Shipment group and package-plan persistence model.
- Idempotent per-package label purchase workflow.
- Group-aware print queue and duplicate-label protection.
- Marketplace confirmation planner that can send the correct N tracking numbers.
- UI for defining package groups and reviewing per-package labels.
- Mocked end-to-end workflow proof before any live postage or marketplace notification.

## Recommendation

Keep PS-289 in progress. The current slice is a good foundation, but the card remains mostly net-new
product work and should not move to Final Review.
