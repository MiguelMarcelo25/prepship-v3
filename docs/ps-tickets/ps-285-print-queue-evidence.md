# PS-285 print queue durability and idempotency evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 55%.

This packet completes PS-285 phase 5, print queue durability and idempotency.
It does not make PS-285 Final Review-ready. The umbrella still has unfinished
lockdown preservation, void/retract, recovery, certification, and final closeout
phases.

## Backend Owners

The print queue durability evidence is owned by existing backend code and
guards:

- `src/services/print-queue.ts`
- `src/routes/print-queue.ts`
- `src/services/print-queue-pdf-store.ts`
- `scripts/ps-053-print-queue-atomic-recovery-guard.mjs`
- `scripts/ps-253-outbox-stale-reclaim-guard.ts`
- `scripts/ps-256-durable-print-queue-pdf-guard.ts`
- `scripts/ps-303-print-queue-authority-guard.ts`
- `scripts/print-to-queue-selected-rate-proof-guard.ts`
- `scripts/test-order-queue-label-guard.mjs`
- `scripts/ps-285-print-queue-evidence-guard.ts`

## Proof

The current backend boundary proves the phase-5 requirements:

1. Print-to-queue create/recover/queue is backend-owned for the guarded path,
   and missing labels are created through `createLabelV2` instead of a
   frontend purchase loop.
2. If a label is created before a later queue failure, the queue owner re-reads
   the active shipment label and queues that existing label instead of buying
   duplicate postage.
3. Queue insertion remains idempotent through the `orderId`/`clientId` upsert
   path and reports `alreadyQueued`.
4. Label URLs are normalized or rejected before queue persistence and PDF merge.
5. Merged queue PDFs can use the additive durable side-store when
   `DURABLE_PRINT_QUEUE_PDF` is enabled, while the default-off path is a true
   no-op.
6. The fulfillment outbox reclaims stale processing rows so a worker restart
   does not strand shipment confirmation work.

## Commands

- `npm run test:ps-053-print-queue-atomic`
- `npm run test:ps-253-outbox-stale-reclaim`
- `npm run test:ps-256-durable-print-queue-pdf`
- `npm run test:ps-303-print-queue-authority`
- `npm run test:print-to-queue-selected-rate-proof`
- `npm run test:test-order-queue-label`
- `npm run test:ps-285-print-queue-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not create live labels, buy postage,
print labels, send marketplace notifications, mutate production orders, mutate
production queues, repair production data, or modify shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
