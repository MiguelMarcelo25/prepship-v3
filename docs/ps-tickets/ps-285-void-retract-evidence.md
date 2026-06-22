# PS-285 void/retract and cancellation safety evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 60%.

This packet completes PS-285 phase 7, void/retract and cancellation safety. It
does not make PS-285 Final Review-ready. The umbrella still has unfinished
lockdown preservation, recovery, certification, and final closeout phases.

## Backend Owners

The void/retract safety evidence is owned by existing backend code and guards:

- `src/services/labels.ts`
- `src/services/label-void-policy.ts`
- `src/services/label-voidability.ts`
- `src/services/fulfillment/outbox.ts`
- `src/services/fulfillment/shipping-safety.ts`
- `scripts/ps-211-universal-void-guard.ts`
- `scripts/ps-219-void-label-ui-guard.ts`
- `scripts/ps-253-combo-confirm-atomicity-guard.ts`
- `scripts/ps-263-void-confirmation-retract-guard.ts`
- `scripts/ps-128-129-upstream-shipping-safety-guard.ts`
- `scripts/ps-285-void-retract-evidence-guard.ts`

## Proof

The current backend boundary proves the phase-7 requirements:

1. Provider-aware label voids dispatch to the owning carrier connector, and
   local `voided: true` is written only after provider success.
2. The backend owns label voidability. The UI consumes `labelVoidability` and
   does not construct provider IDs or optimistically mutate shipment state.
3. Voiding a label calls `cancelShipmentConfirmationsForVoid` after the local
   void write, cancelling not-yet-succeeded confirmation outbox rows and
   stamping the shipment confirmation lifecycle so a voided shipment cannot be
   confirmed later with dead tracking.
4. Marketplace confirmation processing is idempotent: a reclaimed processing
   outbox row re-checks shipment confirmation state before dispatch and settles
   already-confirmed rows without double-confirming.
5. Upstream shipped/cancelled signals block unsafe new label purchases through
   backend shipping-safety policy.

## Commands

- `npm run test:ps-211-universal-void`
- `npm run test:ps-219-void-label-ui`
- `npm run test:ps-253-combo-confirm-atomicity`
- `npm run test:ps-263-void-confirmation-retract`
- `npm run test:ps-129-upstream-cancellation-hold`
- `npm run test:ps-285-void-retract-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not void live labels, create live labels,
buy postage, print labels, send marketplace notifications, mutate production
orders, mutate production queues, repair production data, or modify
shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
