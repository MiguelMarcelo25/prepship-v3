# PS-285 auth and scope evidence

Date: 2026-06-22

## Status

Current completion estimate: PS-285 75%.

This packet completes PS-285 phase 3, auth and scope behavioral ratchets. It
does not make PS-285 Final Review-ready. The umbrella still has unfinished
verification harness operational capture, lockdown preservation, and final
closeout phases.

## Backend Owners

The auth/scope evidence is owned by existing permission and scope guards:

- `scripts/ps-246-financials-write-permission-guard.ts`
- `scripts/ps-246-behavioral-rls-matrix-guard.ts`
- `scripts/ps-246-jwt-audit-soak-guard.ts`
- `scripts/ps-250-rates-scope-enforcement-guard.ts`
- `scripts/ps-252-catalog-mutation-authz-guard.ts`
- `scripts/authz-guard-behavioral-ratchet-guard.ts`
- `scripts/ps-285-auth-scope-evidence-guard.ts`

## Proof

The current auth/scope boundary proves the phase-3 requirements:

1. `financials:write` is verified by the real `hasAppPermission()` owner, not
   only by source text.
2. Client/store scope uses the behavioral RLS-equivalent matrix and fails
   closed when a restricted user has no scope IDs.
3. Rates browse and destructive cache routes are scope-fenced or global/admin
   gated.
4. Catalog mutation routes require `settings:write` and prove the role matrix
   by running the real permission owner.
5. The authz behavioral ratchet ceiling is now `0`, so new auth/scope guards
   cannot be substring-only.

## Commands

- `npm run test:ps-246-financials-write-permission`
- `npm run test:ps-246-behavioral-rls-matrix`
- `npm run test:ps-246-jwt-audit-soak`
- `npm run test:ps-250-rates-scope-enforcement`
- `npm run test:ps-252-catalog-mutation-authz`
- `npm run test:authz-guard-behavioral-ratchet`
- `npm run test:ps-285-auth-scope-evidence`
- `npm run test:ps-285-phase-evidence-matrix`
- `npm run test:ps-285-umbrella-closeout`
- `git diff --check`
- `npm run typecheck`
- `npm run build:web`

## Safety Boundaries

This packet is offline/static. It does not capture live golden snapshots, start
a server, restart workers, enable live retry flags, create live labels, buy
postage, void labels, print labels, send marketplace notifications, mutate
production orders, mutate production queues, repair production data, or modify
shipped/cancelled data.

No Trello comment, card move, card creation, title edit, checklist edit, label
change, member change, archive, or deletion is authorized by this packet.
