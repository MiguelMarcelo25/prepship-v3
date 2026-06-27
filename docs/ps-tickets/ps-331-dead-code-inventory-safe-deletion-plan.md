# PS-331 - BLOCKED: PrepShip dead-code inventory + safe deletion plan

Date: 2026-06-27
Status: Blocked/local artifact only
Trello: Trello connector unavailable in Codex (`Transport closed`), so this file records local evidence from the repo and the title DJ provided. Do not treat this as live Trello comment verification.

## Decision

No deletion in PS-331.

PS-331 is the inventory and deletion-gate ticket after the cleanup sequence. It reserves the cleanup map, identifies what is blocked, and requires every future deletion to prove its own source-of-truth gate before code is removed.

## Canonical owner

PS-331 does not own runtime truth. It owns only the cleanup inventory and safety gates.

The deletion candidates below keep their existing canonical owners:

- Legacy Vercel `api/` decommission stays under PS-200.
- Dead-but-retained schema definitions stay under PS-153.
- Superseded package/label deletion stays under PS-225.
- HUGRAB label-purchase safety stays under PS-261.
- Rate Browser and row DTO cleanup evidence stays under PS-340, PS-341, PS-342, PS-343, and PS-344.

## Imperfect data injection points

- Trello comments cannot be read from this thread, so PS-331 must not claim Trello-confirmed acceptance.
- Untracked scratch files can look like repo-owned dead code during broad searches.
- Legacy guard scripts still read old files by design; deleting those files before re-anchoring guards can remove important safety checks.
- Drizzle schema definitions can look code-dead while still representing live database tables.
- Label helpers can look inactive while still representing a dangerous revival path for real postage.

## Cleanup sequence already landed locally

These tickets reduce compatibility bridges and wrapper-search habits before deletion:

- PS-340 - Rate Browser frontend bridge audit.
- PS-341 - Frontend compatibility helper audit.
- PS-342 - Legacy rate display adapter cleanup.
- PS-343 - RateBrowserModal money normalization cleanup.
- PS-344 - Order row workflow shape cleanup.

PS-331 depends on that sequence, but it does not delete additional code from it.

## Deletion inventory

| Area | Candidate | Current decision | Gate before future deletion |
| --- | --- | --- | --- |
| Legacy serverless stack | `api/` and Vercel exclusions | Blocked | PS-200 S8 must pass: no exclusion patterns, no crons, `api/` absent only after zero Vercel function invocations over a full business day. |
| Legacy direct carrier endpoints | `api/carriers/labels.ts`, `api/carriers/rates.ts`, provider probes, validate-address | Blocked | Follow PS-200 S2/S5/S8. Preserve PS-229 sanitized carrier errors and PS-230 strict JWT behavior when re-anchored. |
| Legacy shared Vercel helpers | `api/_lib/*` | Blocked | PS-200 S6 must relocate live imports first. `src/lib/imported-handlers/carrier-accounts.ts` still depends on `api/_lib/safe-error`. |
| Schema definitions | `skuQtyDims`, `syncMeta` | Do not delete | PS-153 proved these are dead-but-retained. Deleting them can arm a Drizzle DROP migration. Only a deliberate, approval-gated migration may remove them. |
| Label helper | `src/services/labels.ts#createLabelFromShipment` | Do not delete in PS-331 | It is pinned as a legacy/dead-code landmine. If revived, it must route through `createLabelV2` and the PS-261 HUGRAB preflight before real postage. |
| Superseded package/label path | `src/services/direct-label-persistence.ts` and related removed calls | Already deleted by PS-225 | Keep PS-225 guard green. Do not recreate `persistDirectCarrierLabel`. |
| Frontend bridge cleanup | PS-340 to PS-344 artifacts | No further deletion here | Future removal must keep backend source-of-truth delegation intact and leave guards green. |
| Local scratch | untracked scratch files including `apps/` | Excluded | Do not include untracked scratch files in deletion planning until DJ confirms they are repo-owned artifacts. |

## Safe deletion rules for future tickets

1. Find the canonical owner first. If the candidate affects rates, labels, billing, marketplace confirmation, inventory, auth/scope, or shipped/cancelled safety, assume backend ownership until proven otherwise.
2. Prove zero live callers with repo search and the relevant guard, not by visual inspection alone.
3. Re-anchor any guard that currently reads the old file before deleting that file.
4. For schema definitions, deletion requires a deliberate migration plan and human approval; "dead code" is not enough.
5. For label/rate paths, run the related source-of-truth guards and do not buy postage, print labels, or notify marketplaces.
6. For `api/`, follow PS-200. The final delete requires zero Vercel function invocations over a full business day.
7. Exclude untracked scratch files from cleanup unless DJ explicitly says they are in scope.

## Verification for PS-331

Run:

```bash
npm run test:ps-331-dead-code-inventory-safe-deletion-plan
npm run test:ps-ticket-ledger
npm run test:ps-153-dead-symbols
npm run test:ps-225-superseded-packaging-removed
npm run test:ps-261-hugrab-label-purchase-gate
```

No database, network, label purchase, queue mutation, marketplace notification, or production order mutation is part of PS-331.
