# PS-084 Completion Report

Status: 100%

## Summary

PS-084 fixed the direct-carrier Print-to-Queue failure class where a local
PrepShip/ShipStation-source order could have a complete ship-to address but the
direct-carrier label endpoint still failed because it only inspected explicit
`body.shipTo` or marketplace-prefixed raw payloads.

Direct-carrier label creation now resolves ship-to in this order:

1. explicit `body.shipTo`
2. supported marketplace raw payload shapes
3. loaded local `orders` row plus `orders.raw.shipTo`

If the resolved address is incomplete, the endpoint fails before provider label
purchase with a safe no-postage message.

Direct-carrier Print-to-Queue payloads now also include the same canonical
`shipTo` object that normal side-panel label creation sends. If the local order
address is incomplete, the UI path returns a clear no-postage error before
calling `apiClient.createLabel`.

Existing-label recovery remains duplicate-postage safe: shipped/cancelled or
already-labelled conflict paths retrieve and queue the existing active label
instead of buying a replacement.

## Exact Files Changed

- `api/carriers/labels.ts`
- `web/src/components/Views/OrdersView.tsx`
- `scripts/ps-084-direct-carrier-print-queue-guard.ts`
- `package.json`
- `docs/superpowers/plans/2026-06-05-shipping-purchase-boundary-task-plan.md`
- `docs/ps-084-direct-carrier-print-queue-completion-report.md`

## What Was Intentionally Not Changed

- No live order was retried.
- No SP6819 operation was performed.
- No label, shipment, or marketplace confirmation persistence was rewritten.
- No shipped/cancelled production rows were updated.
- No direct marketplace confirmation behavior was changed for ShipStation-source
  orders.
- No raw address, tracking number, label URL, provider payload, token, or secret
  is logged by the new guard/report.

## Verification

All commands passed:

- `npm run test:ps-084-direct-carrier-print-queue`
- `npm run typecheck`
- `npm run test:direct-carrier-queue-route`
- `npm run test:direct-carrier-labels`
- `npm run test:print-queue-invalid-label`
- `npm run test:shipping-roundtrip-certification`
- `npm run build:web`
- `npm run test:full-site-certification`

## Safety Confirmation

- No real labels/postage purchased.
- No labels voided.
- No live marketplace notifications sent.
- No production shipped/cancelled mutations performed.
- Locked files touched under the active `unlock shipped data` override:
  - `web/src/components/Views/OrdersView.tsx`

## Follow-Up Risks / Blockers

- PS-098 should now save the aggregate purchase-boundary certification table for
  PS-093 through PS-097 plus this PS-084 closeout evidence.
- PS-099 remains open for Create+Print vs Print Queue separation and SHIPP 4x6
  output normalization.
