# PS-289 Multi-package shipment groups status

Date: 2026-06-20

## Current status

Current completion estimate: PS-289 35%.

PS-289 is not Final Review-ready. The backend-owned planning slice, additive persistence
foundation, and mocked per-package label identity workflow exist, but the real product still needs
DB-backed orchestration, print queue, marketplace confirmation, and UI work before any operator
should use it.

## Evidence now wired

- `test:ps-289-multi-package-plan`
- `test:ps-289-multi-package-schema`
- `test:ps-289-multi-package-mock-label-flow`
- `test:ps-289-multi-package-closeout`

## What is proven

- `src/services/shipping-workflow/multi-package-shipment-plan.ts` builds a pure package-group plan.
- The planner marks single-package versus multi-package mode.
- Package keys are normalized and duplicate keys are rejected before any label purchase planning.
- Per-package label idempotency keys are stable.
- `shipment_groups` and `shipment_group_packages` are additive sidecar tables.
- The persistence draft maps a plan into one group row plus one row per package without writing to DB.
- The mocked label flow emits one deterministic non-live label result per package.
- Existing package label idempotency keys block duplicate mocked labels.
- The current slices have no provider, real label, print queue, marketplace, postage, or
  shipped/cancelled mutation behavior.

## Missing before close

- DB-backed orchestration that writes group/package status transitions safely.
- Real idempotent per-package label purchase workflow behind mocked proof.
- Group-aware print queue and duplicate-label protection.
- Marketplace confirmation planner that can send the correct N tracking numbers.
- UI for defining package groups and reviewing per-package labels.
- End-to-end mocked workflow proof before any live postage or marketplace notification.

## Recommendation

Keep PS-289 in progress. The current foundation is now stronger, but the card remains substantial
net-new product work and should not move to Final Review.
