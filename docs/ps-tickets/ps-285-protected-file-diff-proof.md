# PS-285 protected-file diff proof

Date: 2026-06-22

## Status

Current completion estimate: PS-285 45%.

This packet completes PS-285 phase 1, lockdown fence and protected-file audit.
It does not make PS-285 Final Review-ready. The umbrella still has unfinished
label, queue, recovery, certification, and final closeout phases.

## Locked Surfaces Checked

The repository lockdown policy in `AGENTS.md` protects:

- `src/db/schema/orders.ts`
- `src/db/schema/shipments.ts`
- `src/services/fulfillment-deductions.ts`
- `src/routes/orders.ts` shipped/cancelled modification endpoints guarded by
  `assertOrderEditable()`
- `web/src/components/Views/OrdersView.tsx` shipped/cancelled read-only controls
- production `orders` rows whose `order_status` is `shipped` or `cancelled`
- the entire production `shipments` table

## Proof

The PS-285 phase-1 slice is limited to documentation and guard files:

- `docs/ps-tickets/ps-285-protected-file-diff-proof.md`
- `scripts/ps-285-protected-file-diff-proof-guard.ts`
- `docs/ps-tickets/ps-285-phase-checklist.md`
- `docs/ps-tickets/ps-285-phase-evidence-matrix.md`
- `scripts/ps-285-phase-evidence-matrix-guard.ts`
- `scripts/ps-285-umbrella-closeout-guard.ts`
- `package.json`

Those files are outside the shipped/cancelled locked file set. The existing
lockdown fence owner remains `scripts/fence-match.ts`, with the CI driver
`scripts/verify-lockdown-fence.ts` and focused guard
`scripts/ps-245-lockdown-fence-guard.ts`.

## Commands

- `npm run test:ps-285-protected-file-diff-proof`
- `npm run test:ps-245-lockdown-fence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not run live labels, buy postage, print
labels, void labels, send marketplace notifications, mutate production orders,
mutate production queues, repair production data, or modify shipped/cancelled
data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
