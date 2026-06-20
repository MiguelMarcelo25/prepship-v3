# PS-289 Multi-package shipment groups status

Date: 2026-06-20

## Current status

Current completion estimate: PS-289 78%.

PS-289 is not Final Review-ready. The backend-owned planning slice, additive persistence
foundation, mocked per-package label identity workflow, and DB-backed mocked status orchestration
exist. Group-aware print queue planning also exists. Marketplace confirmation planning now exists,
end-to-end mocked workflow proof now exists, and a test-gated per-package label purchase boundary now
exists. Purchased-label sidecar orchestration now exists. The real product still needs real carrier
adapter wiring, print queue persistence/integration, marketplace confirmation persistence/integration,
and UI work before any operator should use it.

## Evidence now wired

- `test:ps-289-multi-package-plan`
- `test:ps-289-multi-package-schema`
- `test:ps-289-multi-package-mock-label-flow`
- `test:ps-289-multi-package-db-orchestration`
- `test:ps-289-multi-package-print-queue-plan`
- `test:ps-289-multi-package-marketplace-confirmation-plan`
- `test:ps-289-multi-package-mocked-workflow`
- `test:ps-289-multi-package-label-purchase-boundary`
- `test:ps-289-multi-package-purchased-label-orchestration`
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
- The DB-backed orchestration owner writes planned group/package rows, applies mocked package label
  transitions, and marks the group as `mock_labels_created`.
- Duplicate package label idempotency is checked before any sidecar writes.
- The print queue planner emits one deterministic queue candidate per package label.
- Print queue candidates use package-aware queue IDs and block duplicate queued label idempotency.
- The marketplace confirmation planner emits one deterministic confirmation candidate per package
  tracking number.
- Marketplace confirmation candidates preserve package order, group identity, and all tracking
  numbers without calling a marketplace API.
- The mocked workflow owner composes planning, mocked labels, print queue candidates, and
  marketplace confirmation candidates with the same package idempotency keys.
- The mocked workflow proof preserves all tracking numbers in package order and keeps every stage
  explicitly non-live.
- The per-package label purchase boundary builds one idempotent purchase request per package through
  an injected purchaser dependency.
- The purchase boundary refuses to buy labels without an explicit purchaser, rejects mismatched
  package idempotency keys, and blocks live postage results by default.
- The purchased-label orchestration owner writes planned group/package sidecars, invokes the injected
  purchaser, applies purchased label shipment/tracking/URL results back to sidecar packages, and marks
  the sidecar group as `labels_purchased`.
- Duplicate purchased label idempotency keys are checked before any sidecar writes or purchaser calls.
- The current slices have no provider, real label, print queue, marketplace, postage, or
  shipped/cancelled mutation behavior.

## Missing before close

- Real carrier adapter wiring for per-package label purchase plus DJ-approved live canary proof.
- Group-aware print queue persistence/integration with the existing printer path.
- Marketplace confirmation persistence/integration that can send the correct N tracking numbers.
- UI for defining package groups and reviewing per-package labels.
- No live postage, marketplace notification, or operator canary until the real integrations are
  mocked, guarded, and explicitly approved.

## Recommendation

Keep PS-289 in progress. The current foundation is now stronger, but the card remains substantial
net-new product work and should not move to Final Review.
