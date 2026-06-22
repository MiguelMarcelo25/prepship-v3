# PS-285 runbook evidence packet

Date: 2026-06-22

## Status

Current completion estimate: PS-285 40%.

This packet completes PS-285 phase 10, observability and runbook coverage. It
does not make PS-285 Final Review-ready. PS-285 remains an umbrella card until
every phase is either complete with evidence or split into smaller active PS
cards.

## Source documents

- `docs/security-readiness-checklist.md`
- `docs/shipping-certification-harness.md`
- `docs/full-workflow-certification-matrix.md`
- `scripts/run-workflow-certification.mjs`
- `docs/ps-tickets/ps-285-phase-checklist.md`
- `docs/ps-tickets/ps-285-phase-evidence-matrix.md`

## Safe runbook workflow

1. Confirm the working tree does not include unrelated shipped/cancelled logic
   changes.
2. Run the static phase evidence guards before any broader certification:
   - `npm run test:ps-285-runbook-evidence`
   - `npm run test:ps-285-phase-evidence-matrix`
   - `npm run test:ps-285-umbrella-closeout`
3. Run the child-ticket owner guards that do not require live operations:
   - `npm run test:ps-245-lockdown-fence`
   - `npm run test:ps-245-verification-harness`
   - `npm run test:ps-248-label-purchase-lock`
   - `npm run test:ps-248-persist-mark-shipped-atomic`
   - `npm run test:ps-253-combo-confirm-atomicity`
   - `npm run test:ps-285-marketplace-confirm-boundary`
   - `npm run test:ts-nocheck-ratchet`
   - `npm run test:authz-guard-behavioral-ratchet`
4. Run global code gates for any code batch:
   - `git diff --check`
   - `npm run typecheck`
   - `npm run build:web`
5. If `scripts/run-workflow-certification.mjs` is used, keep it in offline
   certification mode only and summarize failures back into the phase matrix.

## Safety boundaries

This runbook is offline and read-only. It does not buy postage, create labels,
print labels, void labels, send marketplace notifications, mutate production
orders, mutate production queues, repair production data, or modify
shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.

## Closeout rule

PS-285 can move toward Final Review only after the remaining incomplete phases
have evidence or are split into separate PS cards. Phase 10 completion is useful
because the operator runbook is now pinned, but it is not a substitute for the
remaining label, queue, recovery, certification, and final closeout work.
