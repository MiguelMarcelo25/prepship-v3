# PS-510 disposition addendum

Recorded before coding, per the review ruling. Splits ownership by **runtime**, not by symptom.

## Pre-fix reproduction: satisfied, and it confirms the premise

Required before any applier changes. Executed on disposable PostgreSQL 17.11 in hosted CI —
[run 33121719782](https://github.com/drprepperusa-org/prepship-v4/actions/runs/33121719782),
`scripts/ps-510-prefix-catalog-reproduction-pg17.ts`, no production database involved.

```
==================== VERDICT ====================
ABSENT/COMPROMISED — the current mechanism does not leave 0104 in its intended state.
  missing entirely : fulfillment_line_claims_occ_line_dir_unq,
                     fulfillment_line_claims_occ_identity_present_chk
Confirms: the eight lanes assert behaviour against a schema-fidelity-compromised
database. PS-510 cutover is justified on the stated grounds.
```

The claim was previously **inferred from source**. It is now **observed**. Two of 0104's
occurrence-identity objects are absent after the swallowed failures. The lane is an observation,
not a guard: it exits 0 either way, so a green tick there does not mean the schema is fine.

## Ownership split

### PS-510 — real-PostgreSQL fidelity. 11 callers, one canonical-owner correction.

| caller | local dir loop | `CONCURRENTLY` rewrite | bare catch |
|---|---|---|---|
| `ps-494-joined-origin-pg17.ts` | yes | 9 | 1 |
| `ps-508-billing-generates-frozen-line-pg17.ts` | yes | 2 | 0 |
| `ps-497-occurrence-worker-pg17.ts` | yes | 1 | 1 |
| `ps-497-occurrence-worker-execoff-pg17.ts` | yes | 1 | 1 |
| `ps-497-owner-resolver-e2e-pg17.ts` | yes | 1 | 1 |
| `ps-497-review-resolver-pg17.ts` | yes | 1 | 1 |
| `ps-497-supersession-pg17.ts` | yes | 1 | 1 |
| `ps-497-worker-retry-hardening-pg17.ts` | yes | 1 | 1 |
| `ps-497-shipped-outcome-invariant-integration.ts` | yes | 1 | 1 |
| `ps-497-flags-off-pg17.ts` (selected-file, rewrites 0104) | no | 0 | 0 |
| `ps-497-owner-cutover-pg17.ts` (selected-file, rewrites 0104) | no | 0 | 0 |

Two were already red; seven are green-but-compromised; two are selected-file consumers already
known to rewrite 0104.

### PS-511 — PGlite fidelity. Explicitly out of PS-510.

`ps-497-shipped-outcome-invariant-pglite.ts`, `ps-507-qa-stack.mjs`, `ps-499-route-harness.ts`,
`ps-424-order-lifecycle-command-integration.ts`, and other PGlite compatibility consumers from the
disposition matrix. They should consume the same planner eventually, but their capability
downgrades, reporting, catalog substitutes and truthful evidence claims belong to PS-511.

**No third card.** One is created only if a caller later proves to have a separate business owner
or acceptance contract.

## Option (c) rejected — no standalone bare-catch deletion

Removing the eight bare catches as a visibility patch is **not** done. Those catches currently
absorb more than the 0104 failure: missing Supabase roles, external/foreign-owned relations,
historical ordering artifacts, unsupported fixture/runtime capabilities, and possibly unknown
others. Wholesale removal would turn lanes red without establishing *why*, producing noisy and
possibly misleading failures instead of trustworthy evidence.

It would also modify eleven callers twice, create a deliberately broken interim stable state,
risk coupling unrelated releases to poorly classified historical setup errors, and still leave
every caller's local parser/rewrite authority intact.

Visibility is handled by the PS-510 correction itself plus release disclosure. Code goes directly
to the real fix.

## Corrected wording: not "proving nothing"

The eight lanes are **not** described as proving nothing. Their business-behaviour assertions —
worker retry, supersession, resolver, lifecycle outcomes — do execute against real PostgreSQL.
The accurate classification is:

> **Behavioural assertions passed against a schema-fidelity-compromised disposable database. The
> lanes do not prove the full current migration chain, or 0104's occurrence-identity constraints
> and indexes, were faithfully applied.**

Serious, because several headers claim "FULL" or "real" paths. Not evidence that every asserted
worker behaviour is wrong.

## Architecture contract

**Canonical owner:** `scripts/lib/migration-execution-plan.ts` plus a real-PostgreSQL execution
adapter.

**Every one of the 11 callers must:** delegate planning and execution to the shared owner; delete
its local migration directory loop; delete its local `CONCURRENTLY` rewrite regex; delete broad
bare catches; supply an explicit tolerance policy scoped by **filename + SQLSTATE + reason**; fail
on every unregistered migration error; and print an execution report naming applied and explicitly
tolerated migrations. A guard prevents local full-chain appliers being reintroduced.

**Catalog gate.** The adapter exposes a reusable post-apply catalog assertion for governed
migrations. For 0104: exact expected indexes, `indisvalid=true`, exact predicates and definitions,
exact CHECK names and definitions, `convalidated=true`. Business tests run only after the schema
gate passes.

**Three execution phases stay frozen:** `transactional-batch`, `standalone-transactional`,
`autocommit-required`. No sentinel backfill, no historical migration edit, no `CONCURRENTLY`
removal, no generic regex splitting.

## Closure evidence

PS-510 closes only when, at **one** successor SHA: planner/scanner mutation tests pass; the old
UNIQUE-blind regex mutation turns red; broad catches and local full-chain appliers are absent from
all 11 callers; every caller-specific behaviour suite passes; both currently red workflows pass;
the seven green-but-compromised suites pass after cutover; catalog readback proves 0104's exact
indexes and validated constraints; and hosted CI reports each relevant lane rather than skipping
downstream assertions.

## Constraints

No production migration, no deployment-gate change, no historical SQL edit, no shipped-data
mutation, no live activation. All reproduction on disposable databases.
