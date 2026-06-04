# PS-098 Shipping Purchase-Boundary Certification

Status: 100% after the verification commands in this report pass.

Scope: certify the integrated PS-093 through PS-097 shipping purchase boundary in static/offline/mocked mode. This is a certification slice only; it does not add broad feature behavior.

## Summary

The shipping purchase boundary is backend-owned at the rate and label purchase edges:

- Direct-carrier rate and label paths reject unassigned, inactive, or wrong-client carrier accounts before provider calls.
- Backend selected-rate proof/fingerprint validation exists and rejects missing, stale, mismatched, or non-eligible selected rates.
- Frontend label flows pass backend-issued selected-rate proof through to ShipStation and direct-carrier label payloads.
- ShipStation and direct-carrier real label paths validate selected-rate proof before connector calls.
- Existing direct-carrier print-to-queue ship-to recovery remains covered so queueing an existing local order does not need a second postage purchase.

## Certification Table

| Phase | Invariant | Evidence | Required command | Result |
|---|---|---|---|---|
| PS-093 | Direct-carrier account must exist, be active, and be assigned to the scoped client before rate/label calls. Empty assignment is unavailable, not global. | `src/lib/direct-carrier-scope.ts`; `api/carriers/rates.ts`; `api/carriers/labels.ts`; `scripts/ps-083-direct-carrier-assignment-scope-guard.ts` | `npm run test:ps-083-direct-carrier-scope`; `npm run test:carriers-rates-hardening`; `npm run test:direct-carrier-labels` | PASS |
| PS-094 | Proof primitive changes when rate-affecting fields change and excludes secrets, raw labels, and full customer PII. | `src/services/shipping-workflow/rate-fingerprint.ts`; `scripts/ps-098-shipping-purchase-boundary-certification-guard.ts` | `npm run test:ps-098-shipping-purchase-boundary`; `npm run test:ps-079-best-rate-source-of-truth`; `npm run test:ps-081-rate-sync` | PASS |
| PS-095 | Frontend preserves backend-issued proof and sends it with create/queue label payloads; frontend remains a pass-through/action layer. | `web/src/components/Views/OrdersView.tsx`; `scripts/selected-rate-proof-purchase-boundary-guard.ts` | `npm run test:selected-rate-proof-boundary`; `npm run test:full-site-certification` | PASS |
| PS-096 | ShipStation real label purchase requires exact selected-rate proof before the connector can buy postage. | `src/routes/labels.ts`; `src/services/labels.ts`; `src/services/shipping-workflow/rate-fingerprint.ts` | `npm run test:selected-rate-proof-boundary`; `npm run test:shipping-roundtrip-certification` | PASS |
| PS-097 | Direct-carrier label purchase checks scope first, then selected-rate proof, before Shipp/Walmart Shipping/UPS/EasyPost connector calls. | `api/carriers/labels.ts`; `src/services/shipping-workflow/rate-fingerprint.ts`; `scripts/selected-rate-proof-purchase-boundary-guard.ts` | `npm run test:selected-rate-proof-boundary`; `npm run test:direct-carrier-labels`; `npm run test:direct-carrier-queue-route` | PASS |
| Supporting PS-084 | Direct-carrier Print-to-Queue can recover local ship-to and queue existing labels without buying duplicate postage. | `docs/ps-084-direct-carrier-print-queue-completion-report.md`; `scripts/ps-084-direct-carrier-print-queue-guard.ts` | `npm run test:ps-084-direct-carrier-print-queue` | PASS |
| Aggregate | Safe offline certification passes without live provider mutation. | Package scripts and certification docs | `npm run typecheck`; `npm run test:shipping-roundtrip-certification`; `npm run test:full-site-certification` | PASS |

## Allowed And Blocked Boundary Evidence

Allowed path:

- An exact selected-rate proof whose request fingerprint matches the current payload and whose selected rate remains in the current eligible set is accepted by offline validation.

Blocked paths:

- Unassigned direct carrier against an order/client/store scope is rejected by the shared scope guard.
- Wrong-client direct carrier is rejected by the shared scope guard.
- Missing selected-rate proof is rejected with `SELECTED_RATE_PROOF_INVALID`.
- Stale proof with a changed request fingerprint is rejected.
- A selected rate not in the current eligible set is rejected.

## Exact Files Changed For PS-098

- `docs/ps-098-shipping-purchase-boundary-certification.md`
- `docs/superpowers/plans/2026-06-05-shipping-purchase-boundary-task-plan.md`
- `package.json`
- `scripts/ps-098-shipping-purchase-boundary-certification-guard.ts`

## What Was Intentionally Not Changed

- No selected-rate enforcement behavior was changed in this certification slice.
- No direct-carrier connector behavior was changed.
- No ShipStation connector behavior was changed.
- No print queue behavior was changed.
- No shipped/cancelled order logic or shipment persistence logic was modified.
- No PS-099 Create+Print separation or SHIPP 4x6 normalization was implemented here.

## Verification Commands

Run and record:

```powershell
npm run test:ps-098-shipping-purchase-boundary
npm run typecheck
npm run test:ps-079-best-rate-source-of-truth
npm run test:ps-081-rate-sync
npm run test:ps-083-direct-carrier-scope
npm run test:ps-084-direct-carrier-print-queue
npm run test:selected-rate-proof-boundary
npm run test:direct-carrier-labels
npm run test:direct-carrier-queue-route
npm run test:carriers-rates-hardening
npm run test:shipping-roundtrip-certification
npm run test:full-site-certification
```

All commands listed above passed on 2026-06-05 in safe local/offline certification mode.

## Safety Confirmation

- No real labels or postage were purchased.
- No labels were voided.
- No live marketplace notifications were sent.
- No production shipped/cancelled order mutations were performed.
- No secrets, raw provider payloads, raw labels, or customer PII were exposed.
- Locked shipped/cancelled files touched for PS-098: none.

## Follow-Up Risks And Blockers

- PS-099 remains open for Create+Print separation and SHIPP 4x6 output normalization.
- PS-094 is functionally covered by `rate-fingerprint.ts`, but the board prompt named `rate-selection-proof.ts`; add a compatibility alias only if DJ wants the exact filename present.
- PS-095 proof pass-through is covered, but a separate visual UX certification can be added if stale-rate messaging needs board-level evidence.
- PS-087 should close the lane after PS-099 and any PS-094/PS-095 compatibility decisions are resolved.
