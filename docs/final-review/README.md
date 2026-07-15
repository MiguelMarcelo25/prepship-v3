# Exact-SHA Final Review closure packets

Final Review is evidence-backed only when a versioned JSON packet in
`docs/final-review/packets/` passes the canonical validator at the exact implementation
commit that was reviewed. Trello and Hermes may display or act on the result, but they do
not calculate it.

The canonical owner is `scripts/final-review-closure.mjs`. The JSON contract is
[`evidence-packet.schema.json`](evidence-packet.schema.json), and the required command is:

```bash
npm run test:final-review-closure
npm run test:final-review-closure -- --packet docs/final-review/packets/<TASK-ID>.json --repository
```

The first form runs the full fixture suite and validates packets changed in CI. Use the
second form for an explicit local repository/SHA check of one packet.

## Exact-SHA workflow

1. Finish the implementation and its tests, then commit it.
2. Record that 40-character commit SHA in `target.reviewedSha`.
3. Create `docs/final-review/packets/<TASK-ID>.json` from the v1 schema. Link every
   acceptance criterion to evidence from the reviewed implementation.
4. Commit only the closure packet after the reviewed SHA. If any non-packet file changes,
   the reviewed SHA is stale and the packet is invalid; repeat from step 1.
5. Link the packet and exact SHA from the PR/Trello review. A reviewer may mark Hermes green
   only when the validator reports `closureStatus=complete`, `scoreCap=100`, and
   `hermesGreenEligible=true`.

CI fetches full history and validates every changed packet against the repository. A packet
may live one commit after the implementation it describes because the repository check allows
only `docs/final-review/packets/` changes after `target.reviewedSha`.

## Evidence tiers and risk profiles

Evidence classifications are `static`, `unit`, `integration`, `adversarial`,
`failure-injection`, `e2e`, and `live`. Static analysis and breadcrumbs are useful context,
but their assertions never satisfy a behavioral, failure-injection, E2E, or live requirement.

| Risk domain | Required proof |
| --- | --- |
| `auth_scope` | Integration + adversarial negative role/resource matrix; rejection has no side effect |
| `rate_label` | Integration + adversarial cross-order/account/fact rejection; provider spy untouched |
| `provider_durable_job` | Integration + adversarial + failure injection for crash, lost response, restart, concurrency, and fencing |
| `billing_inventory_lifecycle` | Integration + adversarial migrated-DB cardinality, idempotency, and repeat-run proof |
| `timing_live` | Passing staging/live artifact, or an explicit unverified block with a follow-up owner |
| `governance` | Unit + adversarial + failure-injection proof for malformed packets, SHA drift, and false-green caps |

Select every domain the change affects. One passing evidence item may support several
assertions, but omitting a required class or behavioral assertion blocks closure.

## Machine-readable score caps

- Malformed packets and SHA drift are invalid (`scoreCap=0`).
- Any unmet Critical/High acceptance criterion, unresolved Critical/High caveat, or
  source-of-truth bypass caps the review at 74.
- Missing required behavioral/failure/live evidence, non-passing evidence, unverified live
  proof, migration/rollback gaps, or lower-severity open work caps the review at 88.
- Only complete packets score above 90 and are eligible for Hermes green.

`claimedScore` is a claim, not an override. Claiming above 90 while a cap applies adds a
`FALSE_GREEN_SCORE_CLAIM` blocker.

## Packet contents

Every packet records:

- task ID, branch, and exact reviewed SHA;
- acceptance criteria mapped to evidence IDs;
- canonical owners, prior owners, wrappers, and explicit source-of-truth-bypass status;
- exact commands, results, artifact paths, classifications, assertions, and what they prove;
- migration verification and rollback proof;
- live/staging status;
- caveats with severity and follow-up ownership.

Artifact paths should point to durable CI/repository evidence and must not contain secrets,
PII, provider payloads, tracking numbers, or raw label URLs. The validator is offline and
process-only: it reads JSON and git metadata and never imports product runtime, calls a
provider, opens a database, buys postage, or mutates production data.
