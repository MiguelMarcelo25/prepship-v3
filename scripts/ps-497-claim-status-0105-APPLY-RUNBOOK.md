# PS-497 Slice 2 — production APPLY runbook for `0105_ps497_claim_not_applicable_status`

**This is a SEPARATE authorization from 0104.** The 0104 authorization (M1) does **not** authorize 0105.
0105 is applied **only after DJ gives explicit written authorization** naming the exact SHA + environment
(Section 0), and **only after 0104 has already been applied and its readback is green**. Nothing here
re-enables inventory deduction — that is Release B, separately gated, and needs a fresh `unlock shipped data`.

0105 is **schema-only** but it is **not purely additive**: it adds a replacement quantity-state CHECK and a
six-value status-domain CHECK, validates both, then **drops** two legacy CHECKs — `0090`'s
`fulfillment_line_claims_quantity_state_check` and `0070`'s inline five-value
`fulfillment_line_claims_status_check`. It changes no row and no order/shipment data.

---

## 0. Authorization + artifact identity (DJ fills this in)

```
Authorized by:      DJ __________________________   Date/time: __________
Environment:        production
Repository:         drprepperusa-org/prepship-v4
Reviewed SHA:       __________________________   (the accepted Release A successor SHA; immutable, detached)
Migration:          drizzle/0105_ps497_claim_not_applicable_status.sql
Migration digest:   62a5b82de9985bc7c396a6b75f516fcd3ac671d507973a0f18088b8ceafddc6d  (LF-normalized SHA-256)
Runner:             scripts/apply-ps-497-claim-not-applicable-status.ts
Readback:           scripts/ps-497-0105-readback.ts   (independent, read-only)
Confirmation token: apply-ps-497-claim-not-applicable-status-0105
Precondition:       0104 already applied to production AND its readback green
Operator:           __________________________
```

This authorization does **not** cover: Release B, deduction re-enablement, locked-service changes,
writer/consumer cutover, claim replay/drain/supersession, inventory movement, order/shipment mutation, or
recovery of the ~4,057 historical claims.

---

## 1. Immutable checkout (detached at the exact SHA)

```bash
git fetch origin
git checkout --detach <RELEASE_A_SUCCESSOR_SHA>
git rev-parse HEAD          # MUST print the authorized SHA from Section 0
git status --porcelain      # MUST be empty (no local edits)
npm ci --ignore-scripts
```

Confirm the migration digest matches the pin before doing anything else:

```bash
npx tsx -e "import { readVerifiedMigration } from './scripts/ps-497-claim-status-migration-digest.ts'; const { digest } = readVerifiedMigration(); if (digest !== '62a5b82de9985bc7c396a6b75f516fcd3ac671d507973a0f18088b8ceafddc6d') { console.error('DIGEST MISMATCH'); process.exit(1); } console.log('digest OK', digest);"
```

The runner **refuses to run** if the file does not match this digest, so a tampered migration cannot be applied.

---

## 2. Pre-apply phase + protected-row capture (DRY RUN — no writes)

Point `DATABASE_URL` at production, then:

```bash
DATABASE_URL="$PROD_URL" npm run -s migrate:ps-497-claim-not-applicable-status
```

The dry run prints and MUST show:

- `migration digest verified: 62a5b82d…`
- `phase=phase_0104`  — the ONLY legal starting phase. Any other value (a resumable intermediate is also
  acceptable if a prior apply was interrupted: `phase_v2_added` / `phase_both_added` / `phase_v2_validated`
  / `phase_both_validated` / `phase_0090_dropped`) is fine; **`malformed` STOPS the apply** — resolve the
  catalog manually, never override.
- `unknown_statuses=0 v2_violations=0`  — no claim carries an out-of-domain status and every existing row
  already satisfies the new quantity-state contract (no rewrite is ever performed).
- a `claims=<n> by_status=…` line.

**Record the dry-run output** (phase, claim count, by_status). This is the pre-apply protected-row baseline.

If phase is `malformed`, or `unknown_statuses` / `v2_violations` are non-zero: **STOP.** Do not apply. The
runner will not rewrite data; the catalog or data must be corrected under separate authorization first.

---

## 3. Apply (writes DDL only; each statement bounded)

```bash
DATABASE_URL="$PROD_URL" \
  npm run -s migrate:ps-497-claim-not-applicable-status -- \
  --apply --confirm=apply-ps-497-claim-not-applicable-status-0105
```

Optional bounded timeouts (validated; 0/disabled/unbounded are refused):
`PS497_LOCK_TIMEOUT` (default `5s`), `PS497_0105_STATEMENT_TIMEOUT` (default `3600s`).

The apply executes the statements **parsed from the digest-pinned migration** (not a hardcoded copy), in the
order: add v2 `NOT VALID` → add status-domain `NOT VALID` → validate v2 → validate status-domain → drop
`0090` quantity check → drop `0070` status check. It re-inspects the exact phase and MUST print:

- `applied=true phase=0105`
- `claims_unchanged=true rows=<n> full_row_checksum_stable=true`  — every claim row (all columns, via
  `to_jsonb(row)`) is byte-identical over the frozen id range; 0105 changed only constraints.

If it prints a `0105 verification failed …` line, the process exited non-zero and **nothing partial should be
treated as done** — capture the output and escalate. The runner is resume-safe: a re-run from an interrupted
intermediate finishes the remaining steps.

---

## 4. Independent post-apply readback (read-only; separate tool)

```bash
DATABASE_URL="$PROD_URL" npx tsx scripts/ps-497-0105-readback.ts
```

MUST print `… GREEN` and exit 0. It independently verifies, against the live catalog:

- the pinned migration digest;
- `fulfillment_line_claims_quantity_state_v2_check` and `fulfillment_line_claims_status_domain_check` are
  present, `contype='c'`, **validated**, with the **exact** PG17 definitions;
- both legacy checks (`fulfillment_line_claims_quantity_state_check`, `fulfillment_line_claims_status_check`)
  are **gone**;
- no claim carries an out-of-domain status; no row violates the v2 quantity-state contract;
- the full-row checksum + status histogram (compare `by_status` and claim count to the Section 2 baseline —
  they must match).

---

## 5. What must NOT happen under this authorization

- No `UPDATE`/`DELETE`/`INSERT` against claims, orders, or shipments (the runner refuses DML).
- No writer/consumer cutover, no flag flips, no inventory movement.
- No reuse of this authorization for Release B or any locked-surface change.
- No forcing past a `malformed` phase, an unknown status, or a v2 violation.

Every apply must record: the exact SHA, the digest, the dry-run phase + baseline, the apply output
(`phase=0105`, `full_row_checksum_stable=true`), and the readback `GREEN` line.
