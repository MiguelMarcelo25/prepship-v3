# PS-358 - Clean PS-340 rate-engine breadcrumbs

## Decision

PS-340 now means the backend rate-engine evidence only. The active repo no longer
keeps a second PS-340 frontend-rate guard that competes with the backend
rate-engine ticket.

## Retired artifacts

- `test:ps-340-ratebrowser-bridge-audit`
- `scripts/ps-340-ratebrowser-bridge-audit-guard.ts`
- `docs/ps-tickets/ps-340-ratebrowser-bridge-audit.md`

Those artifacts were local cleanup breadcrumbs. They are replaced by the active
backend PS-340 guards:

- `test:ps-340-backend-rate-engine`
- `test:ps-340-rate-engine-volume-proof`

## Safety Boundary

No production rate code changed. No frontend rate ranking, backend rate ranking,
label purchase, print queue, billing, inventory, shipped/cancelled data, provider
calls, or database mutation is part of this cleanup.

The canonical rate safety proof remains `rate-source-of-truth`; PS-358 only
removes stale active guard wiring and re-anchors ticket inventory wording.

## Verification

Run:

```bash
npm run test:ps-358-ps340-cleanup
npm run test:ps-ticket-ledger
npm run test:ps-331-dead-code-inventory-safe-deletion-plan
npm run test:ps-340-backend-rate-engine
npm run test:ps-340-rate-engine-volume-proof
npm run test:rate-source-of-truth
```
