# PS-285 label purchase boundary evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 50%.

This packet completes PS-285 phase 4, label purchase boundary safety. It does
not make PS-285 Final Review-ready. The umbrella still has unfinished print
queue, lockdown preservation, void/retract, recovery, certification, and final
closeout phases.

## Backend Owners

The label-purchase safety evidence is owned by existing backend code and guards:

- `src/lib/label-purchase-lock.ts`
- `src/services/labels.ts`
- `scripts/ps-248-label-purchase-lock-guard.ts`
- `scripts/ps-248-persist-mark-shipped-atomic-guard.ts`
- `scripts/ps-285-label-purchase-evidence-guard.ts`

## Proof

The current backend boundary proves two label-purchase safety requirements:

1. Concurrent label purchases for the same order are serialized with a
   non-blocking per-order advisory lock. A second in-flight purchase is rejected
   with `LABEL_PURCHASE_IN_PROGRESS` instead of buying duplicate postage.
2. Label persistence and the local mark-shipped update run inside one
   `db.transaction`, so the local DB state cannot commit a shipment row without
   the matching order status update in that transaction.

The existing focused guards pin the runtime owners:

- `test:ps-248-label-purchase-lock`
- `test:ps-248-persist-mark-shipped-atomic`
- `test:ps-285-label-purchase-evidence`

## Commands

- `npm run test:ps-248-label-purchase-lock`
- `npm run test:ps-248-persist-mark-shipped-atomic`
- `npm run test:ps-285-label-purchase-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not buy postage, create live labels,
void labels, print labels, send marketplace notifications, mutate production
orders, mutate production queues, repair production data, or modify
shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
