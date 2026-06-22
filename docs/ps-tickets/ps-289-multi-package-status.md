# PS-289 Multi-package shipment groups status

Date: 2026-06-20

## Current status

Current completion estimate: PS-289 88%.

PS-289 is not Final Review-ready. The backend-owned planning slice, additive persistence
foundation, mocked per-package label identity workflow, and DB-backed mocked status orchestration
exist. Group-aware print queue planning also exists. Marketplace confirmation planning now exists,
end-to-end mocked workflow proof now exists, and a test-gated per-package label purchase boundary now
exists. An injected carrier adapter boundary now exists, and ShipStation-shaped adapter proof now exists.
Purchased-label sidecar orchestration now exists, print queue sidecar persistence now exists,
marketplace confirmation sidecar persistence now exists, and a dry-run real print queue contract now
exists. Runtime compatibility proof maps package-scoped queue ids back to numeric source order ids
before real print queue insertion is allowed. A backend-owned package review DTO now exists so future
UI/API consumers can fetch package rows without rebuilding label, print queue, or marketplace state
in the browser. The real product still needs real production label creator wiring, real print queue
insertion/printer integration, real marketplace notification connector/integration, and UI work
before any operator should use it.

## Evidence now wired

- `test:ps-289-multi-package-plan`
- `test:ps-289-multi-package-schema`
- `test:ps-289-multi-package-mock-label-flow`
- `test:ps-289-multi-package-db-orchestration`
- `test:ps-289-multi-package-print-queue-plan`
- `test:ps-289-multi-package-marketplace-confirmation-plan`
- `test:ps-289-multi-package-mocked-workflow`
- `test:ps-289-multi-package-label-purchase-boundary`
- `test:ps-289-multi-package-carrier-adapter`
- `test:ps-289-multi-package-shipstation-adapter`
- `test:ps-289-multi-package-purchased-label-orchestration`
- `test:ps-289-multi-package-print-queue-sidecar`
- `test:ps-289-multi-package-marketplace-confirmation-sidecar`
- `test:ps-289-multi-package-real-print-queue-contract`
- `test:ps-289-multi-package-print-queue-runtime-compat`
- `test:ps-289-multi-package-review-dto`
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
- The injected carrier adapter boundary shapes one carrier label request per package and carries
  provider, carrier account, ship-from, ship-to, package identity, dimensions, and item facts.
- The carrier adapter has no direct provider imports and still relies on the purchase boundary to
  block live postage unless a caller explicitly approves it.
- The ShipStation-shaped adapter builds one existing ShipStation v2 label request body per package
  through the pure `buildSsLabelRequestBody` owner.
- The ShipStation-shaped adapter proves package-level insured value, residential verdict,
  confirmation, account, service, dimensions, and order facts without calling ShipStation.
- The purchased-label orchestration owner writes planned group/package sidecars, invokes the injected
  purchaser, applies purchased label shipment/tracking/URL results back to sidecar packages, and marks
  the sidecar group as `labels_purchased`.
- Duplicate purchased label idempotency keys are checked before any sidecar writes or purchaser calls.
- The print queue sidecar owner derives one package-aware queue candidate per purchased label, stores
  package rows as `print_queue_sidecar_planned`, and marks the group with deterministic queue IDs.
- Duplicate queued label idempotency keys are checked before any sidecar print queue updates.
- The dry-run real print queue contract maps sidecar labels into package-scoped
  `print_queue_orders` insert shapes and proves the old source-order `(orderId, clientId)` key would
  collapse multiple package labels.
- The contract keeps `sourceOrderId` visible for the future runtime integration while avoiding writes
  to the real print queue table.
- Runtime compatibility proof maps package-scoped queue IDs back to the numeric source order ID that
  existing hold, recipient, dimensions, and order-detail lookup paths need.
- The compatibility guard also pins the current numeric `Number(orderId)` assumptions so real queue
  insertion cannot be enabled without replacing them.
- The backend-owned package review DTO merges planned packages, purchased label facts, print queue
  sidecar candidates, and marketplace confirmation sidecar candidates into package rows for future
  UI/API consumption.
- The review DTO rejects sidecar facts that do not belong to the current plan and keeps internal
  postage cost out of the review payload.
- The marketplace confirmation sidecar owner derives one package-aware confirmation candidate per
  purchased label/tracking number, stores package rows as `marketplace_confirmation_sidecar_planned`,
  and marks the group with all tracking numbers.
- Duplicate marketplace confirmation label idempotency keys are checked before any sidecar updates.
- The current slices have no provider, real label, print queue, marketplace, postage, or
  shipped/cancelled mutation behavior.

## Missing before close

- Real production label creator wiring from the multi-package workflow into ShipStation plus
  DJ-approved live canary proof.
- Real print queue insertion/printer integration with the existing printer path. The dry-run contract
  now proves the package-scoped key shape and runtime source-order compatibility, but no real queue
  insert is enabled yet.
- Real marketplace notification connector/integration plus DJ-approved live canary proof for the
  correct N tracking numbers.
- UI for defining package groups and reviewing per-package labels. The backend review DTO exists,
  but no operator UI is wired yet.
- No live postage, marketplace notification, or operator canary until the real integrations are
  mocked, guarded, and explicitly approved.

## Recommendation

Keep PS-289 in progress. The current foundation is now stronger, but the card remains substantial
net-new product work and should not move to Final Review.
