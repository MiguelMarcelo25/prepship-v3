# PS-331 - BLOCKED: PrepShip dead-code inventory + safe deletion plan

Date: 2026-07-01
Status: Blocked/full-ticket audit plan. Plan slice: complete. Full ticket: blocked.
Trello: Comments/actions checked from Codex on 2026-07-01. PS-359 and PS-360 implementation proof is present, but no explicit DJ/Hermes acceptance was found that authorizes PS-331 code deletion.

## Decision

No deletion in PS-331.

PS-331 is the inventory and deletion-gate ticket after the cleanup sequence. It reserves the cleanup map, identifies what is blocked, and requires every future deletion to prove its own source-of-truth gate before code is removed.

No `DELETE NOW` code deletion is authorized in this pass.

The PS-331 plan/guard slice is complete, but the full Trello ticket is not complete until
Trello/Hermes/DJ dependency acceptance is verified and any future deletion slices are
split, tested, and reviewed separately.

## Canonical owner

PS-331 does not own runtime truth. It owns only the cleanup inventory and safety gates.

The deletion candidates below keep their existing canonical owners:

- Legacy Vercel `api/` decommission stays under PS-200.
- Dead-but-retained schema definitions stay under PS-153.
- Superseded package/label deletion stays under PS-225.
- HUGRAB label-purchase safety stays under PS-261.
- Rate Browser and row DTO cleanup evidence stays under PS-340 backend rate-engine plus PS-341, PS-342, PS-343, and PS-344.

## Imperfect data injection points

- Trello comments can be read from this thread now, but the current comments do not clear the deletion gate; PS-331 must not claim acceptance without an explicit DJ/Hermes comment.
- Untracked scratch files can look like repo-owned dead code during broad searches.
- Legacy guard scripts still read old files by design; deleting those files before re-anchoring guards can remove important safety checks.
- Drizzle schema definitions can look code-dead while still representing live database tables.
- Label helpers can look inactive while still representing a dangerous revival path for real postage.

## Cleanup sequence already landed locally

These tickets reduce compatibility bridges and wrapper-search habits before deletion:

- PS-340 backend rate-engine guard.
- PS-341 - Frontend compatibility helper audit.
- PS-342 - Legacy rate display adapter cleanup.
- PS-343 - RateBrowserModal money normalization cleanup.
- PS-344 - Order row workflow shape cleanup.
- PS-359 - Obsolete frontend Print Queue route-plan bridge deletion.
- PS-360 - Unreachable batch Print Queue tail cleanup after queue early-return.

PS-331 depends on that sequence, but it does not delete additional code from it.

## Hard start gate status

Repo-side guard evidence is green for the known dependency set after the PS-266 guard
was re-anchored to tolerate the current `rates-combined` import shape while still
requiring `combineCarrierUniverses` and `rateTotal`. On 2026-07-01, the PS-269
static guard was re-anchored to the current structural retry variables used by
`src/services/print-queue.ts`, then the PS-269 guard passed again. PS-359 and
PS-360 are now landed on `prepshipv4-stable` through `a6dc1138`, and their
Print Queue authority/tail guards pass; that proves the bridge cleanup sequence,
not permission for PS-331 to delete additional code. The PS-261 guard was also
re-anchored to the current Print Queue `timeQueueStep(... createLabelV2 ...)`
missing-label purchase wrapper so it continues to prove queue-created labels use
the same HUGRAB preflight boundary.

| Dependency | Repo evidence | External acceptance |
| --- | --- | --- |
| PS-266 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-267 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-268 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-269 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-322 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-328 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-329 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-330 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-340 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-341 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-342 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-343 | Repo guard green | Trello checked; deletion acceptance not found |
| PS-344 | Repo guard green | Trello checked; deletion acceptance not found |

Conditional dependency notes:

- PS-281: no repo evidence found in this audit; treat as unresolved until DJ/Hermes
  marks it not-needed, superseded, or complete.
- PS-282: no repo evidence found in this audit; treat as unresolved until DJ/Hermes
  marks it not-needed, superseded, or complete.
- PS-284: PS-268 documents no current implementation gap and says PS-284 is not
  triggered unless a future provider canary proves a specific connector behavior gap.

## Deletion inventory

Candidate counts by classification:

| Classification | Count |
| --- | ---: |
| DELETE NOW | 0 |
| KEEP ACTIVE | 4 |
| MIGRATE FIRST | 2 |
| BLOCKED BY CANARY | 1 |
| BLOCKED BY CONDITIONAL CARD | 2 |
| DOCUMENT ONLY | 3 |

| Area | Candidate | Classification | Current decision | Gate before future deletion |
| --- | --- | --- | --- | --- |
| Frontend bridges | Rate Browser display helpers, including backend-rank sort/display helpers | KEEP ACTIVE | Display-only helpers may remain when they consume backend rank/proof facts and never emit/persist Best Rate. | Keep PS-340 backend rate-engine, PS-321, and rate-source-of-truth guards green. |
| Frontend transport | v2-apiClient transport shims | KEEP ACTIVE | These are compatibility transports, not business truth owners. | Keep PS-320 and backend-truth guards green before removing any shim. |
| Legacy serverless stack | Legacy Vercel `api/` stack and Vercel exclusions | BLOCKED BY CANARY | Blocked by PS-200. | PS-200 S8 must pass: no exclusion patterns, no crons, `api/` absent only after zero Vercel function invocations over a full business day. |
| Legacy direct carrier endpoints | `api/carriers/labels.ts`, `api/carriers/rates.ts`, provider probes, validate-address | MIGRATE FIRST | Do not delete as a PS-331 bulk action. | Follow PS-200 S2/S5/S8. Preserve PS-229 sanitized carrier errors and PS-230 strict JWT behavior when re-anchored. |
| Legacy shared Vercel helpers | `api/_lib/*` | MIGRATE FIRST | Still has live import dependency risk. | PS-200 S6 must relocate live imports first. `src/lib/imported-handlers/carrier-accounts.ts` still depends on `api/_lib/safe-error`. |
| Schema definitions | `skuQtyDims`, `syncMeta` | KEEP ACTIVE | Dead-but-retained schema definitions stay. | PS-153 proved these are dead-but-retained. Deleting them can arm a Drizzle DROP migration. Only a deliberate, approval-gated migration may remove them. |
| Label helper | `src/services/labels.ts#createLabelFromShipment` | DOCUMENT ONLY | Do not delete in PS-331; keep the warning as a revival landmine. | If revived, it must route through `createLabelV2` and the PS-261 HUGRAB preflight before real postage. |
| Label/queue safety | Print Queue and label safety guards, including PS-359/PS-360 bridge/tail guards | KEEP ACTIVE | These guards pin backend-owned label purchase, queue, and HUGRAB safety boundaries. | Keep PS-225, PS-261, PS-267, PS-269, PS-303, PS-317, PS-318, PS-319, PS-351, and PS-360 green before any deletion slice. |
| Superseded package/label path | `src/services/direct-label-persistence.ts` and related removed calls | DOCUMENT ONLY | Already deleted by PS-225. | Keep PS-225 guard green. Do not recreate `persistDirectCarrierLabel`. |
| Frontend bridge cleanup | PS-340 backend rate-engine guard plus PS-341 to PS-344 docs and guards | KEEP ACTIVE | PS-358 retired the stale PS-340 frontend audit artifact. The remaining guards are regression evidence for backend source-of-truth delegation and cleanup sequencing. | Future removal must keep backend source-of-truth delegation intact and leave guards green. |
| Conditional cards | PS-281 and PS-282 unresolved conditional dependencies | BLOCKED BY CONDITIONAL CARD | No repo evidence found. | DJ/Hermes must mark not-needed, superseded, or complete before PS-331 can claim the hard gate is fully clear. |
| Local scratch | untracked scratch files including `apps/` | BLOCKED BY CONDITIONAL CARD | Excluded from repo-owned dead-code planning. | Do not include untracked scratch files in deletion planning until DJ confirms they are repo-owned artifacts. |
| Marketplace confirmation conditional | PS-284 implementation card | DOCUMENT ONLY | PS-268 says no current implementation gap was proven. | Use PS-284 only if a future provider canary proves a specific connector behavior gap. |

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

## 2026-07-04 completion update — gate cleared, ticket complete, zero deletions by design

The 2026-07-01 plan above stands unchanged. This update records that the two
outstanding blockers are now resolved, so the PS-331 deliverable (inventory +
safe-deletion plan + hard gate) is complete.

Repo-side hard gate — re-verified fully green on `prepshipv4-stable`. On
re-check, three dependency guards had rotted again after the OrdersView / rates /
print-queue refactors and were re-anchored to the current (verified-correct)
source — behaviour intact, patterns drifted, no product code changed (commit
`c74bb068`):

- PS-329 — the awaiting Best Rate SOT cleanup finished; `getBackendRowMoney` now
  returns `selectedRateCost/baseAmount/cShippingRateAmount/markedAmount` and the
  `shipping.bestRateAmount` fallback is gone. Guard now asserts backend-money-only
  + the absence of the fallback.
- PS-266 — `customerShippingAmount()` folded into `rateTotal()` (reads
  `cShippingRateAmount`, the customer charge) with a `rateCostTotal()` tie-breaker;
  `/browse` combined-selection + quote-proof moved into
  `src/services/rate-browse-response-producer.ts` (route delegates via
  `produceRateBrowsePayload`). Guard repointed to the current owners.
- PS-267 — the print-queue queue-existing-without-rebuy + `createLabelV2` + recovery
  ladder is intact; calls are wrapped in `timeQueueStep()` and `order.label` hoisted
  to `labelInput`. Guard repointed to the wrapped forms.

All eight dependency guards now pass: PS-266, PS-267, PS-268, PS-269, PS-322,
PS-328, PS-329, PS-330. PS-153 / PS-225 / PS-261 safety guards remain green.

Conditional cards — no repo implementation gap. PS-281 and PS-282 have no source
implementation and were never triggered; PS-284 is documented by PS-268 as
not-triggered (no proven connector gap). DJ authorized treating all three as
not-needed for the PS-331 gate.

External acceptance — DJ authorized finishing PS-331 on 2026-07-04.

Deletion outcome — UNCHANGED: `DELETE NOW = 0`. No code is deleted under PS-331,
by design. The dead code that can eventually be removed keeps its canonical owner
and its own separate gate, and must be executed as guarded follow-up slices there,
never as a PS-331 bulk deletion:

- Legacy Vercel `api/` stack → PS-200 (final delete only after zero Vercel function
  invocations over a full business day — S8).
- `api/_lib/*` shared helpers → PS-200 S6 (relocate live imports first;
  `src/lib/imported-handlers/carrier-accounts.ts` still imports `api/_lib/safe-error`).
- Dead-but-retained schema (`skuQtyDims`, `syncMeta`) → PS-153 (deletion needs a
  deliberate, approval-gated Drizzle migration; "dead code" alone is not enough).
- `createLabelFromShipment` label helper → keep as a HUGRAB revival landmine
  (DOCUMENT ONLY); if revived it must route through `createLabelV2` + the PS-261
  preflight.

PS-331 (the inventory + gate) is complete. Nothing further is safe to delete under
this ticket; the safe removals are correctly deferred to the owner cards above.
