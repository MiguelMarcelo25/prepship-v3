# PrepShip Durable Jobs Plan

## Executive Summary

This Phase 11/12 deliverable defines how PrepShip should move user-visible and operational background jobs from mixed in-memory state toward durable, restart-safe job state. The goal is to prevent lost progress, duplicate work, confusing stuck states, and repeated external API calls when Render restarts or scales.

This is a planning/control batch only. It does not change worker scheduling, print queue behavior, rate backfill behavior, label behavior, shipped/cancelled logic, or database state.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| User-visible jobs can be process-local | Render restart can lose job status for print queue/rate backfill/ref-rate fetch | Durable job status for user-visible long jobs | Restart test preserves job record |
| Mixed job state models exist | Sync uses queue/locks while other jobs use maps | One job-state policy with clear owners | Job matrix review |
| Duplicate work risk remains for some manual jobs | Multiple requests can start repeated external API work | Idempotency keys and singleton/lease policy | duplicate-start test |
| Failure/dead-letter state is incomplete | Jobs can fail without a consistent recovery path | Terminal failure state, retry policy, and owner action | failed job fixture |

## High-Risk Issues

| Job Area | Current State | Risk If Unchanged | Required Fix |
|---|---|---|---|
| Print queue batch send | in-memory job status with scoped ownership checks | restart loses status/results | persist job header, progress, ownership, and result summary |
| Print queue PDF merge | in-memory job plus base64 PDF output | restart loses output/status; large memory use | durable job metadata and artifact storage/expiry policy |
| Rate backfill best rates | in-memory job map | restart loses active/latest status and can duplicate provider calls | durable backfill job table or pg-boss workflow |
| Billing reference-rate fetch | in-memory job map | billing support cannot prove prior job state after restart | durable job state and failure samples |
| Sync/reporting worker jobs | pg-boss/scheduler foundation exists | status/history needs unified operator view | unify status snapshots with durable job events |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Job result artifacts | PDF/CSV/report outputs can be too large for DB | store artifacts separately with signed/expiring access |
| Cancellation | Long jobs need safe stop behavior | add cancellable state checked between units of work |
| Progress granularity | Operators need useful progress without noisy writes | update progress at bounded intervals |
| Client/store ownership | scoped users must only see their jobs | persist client/store ids on job rows |
| Audit logging | job starts/stops/failures are business events | emit audit events for manual starts and terminal states |

## Job Matrix

| Job | Current State Storage | Restart Behavior | Multi-Instance Risk | Idempotency Key | Durable Target | Owner | Test |
|---|---|---|---|---|---|---|---|
| Sync scheduler orders | pg-boss / scheduler status | mostly survives via queue | singleton/lock protection exists | job name + interval | pg-boss + worker status event | Sync owner | dual-worker enqueue test |
| Sync scheduler shipments | pg-boss / scheduler status | mostly survives via queue | singleton/lock protection exists | job name + interval | pg-boss + worker status event | Sync owner | dual-worker enqueue test |
| Reporting refresh | worker/reporting status | partial | duplicate refresh possible if not locked | report type + period | pg-boss or job table lease | Reporting owner | duplicate refresh test |
| Rate backfill best rates | in-memory `Map` in `rates-backfill.ts` | lost after restart | duplicate provider fanout possible | backfill type + date/window | durable job row + progress events | Rate owner | restart/status test |
| Billing reference-rate fetch | in-memory `Map` in `ref-rates-fetch.ts` | lost after restart | duplicate reference-rate fetch possible | client/date/window | durable job row + result summary | Billing owner | restart/status test |
| Print queue batch send | in-memory `Map` in `print-queue.ts` | lost after restart | duplicate queue entries possible | selected order ids + user | durable job row + per-order results | Warehouse owner | restart/status test |
| Print queue PDF merge | in-memory `Map` plus base64 output | lost after restart | duplicate merge possible | entry ids + user | durable job row + artifact pointer | Warehouse owner | artifact expiry test |
| Fulfillment outbox | DB-backed outbox concept | survives if table applied | duplicate send risk depends on idempotency | provider/order event key | DB outbox + terminal status | Fulfillment owner | replay idempotency test |

## Recommended Patches

- [ ] Create a `job_runs` table or adopt pg-boss state as the canonical durable job source.
- [ ] Persist job owner, client ids, store ids, status, progress, total, failure count, message, started/finished timestamps, and idempotency key.
- [ ] Persist large artifacts outside hot job rows with signed/expiring access.
- [ ] Add helper APIs for start, progress update, terminal success/failure, cancellation, and visibility checks.
- [ ] Move rate backfill, reference-rate fetch, print queue batch send, and print queue PDF merge to durable state in separate batches.
- [ ] Add audit events for manual starts, cancellation, failure, and completion.
- [ ] Keep sync/reporting jobs on pg-boss where practical, but expose a unified status view.

## Test Plan

- `npm run test:durable-jobs-plan`
- Future implementation tests:
  - duplicate job start returns existing active job
  - job status survives simulated process restart
  - scoped user cannot view another client's job
  - failed job persists terminal error and failure samples
  - cancellation moves job to terminal cancelled state
  - artifact URL expires and remains scoped

## Deployment / Rollback Notes

- This matrix is planning-only and safe to deploy with documentation and guard changes.
- Runtime migration should begin with durable status writes while keeping existing in-memory status as a compatibility fallback.
- Rollout should start with rate backfill/reference-rate fetch before print PDF artifacts.
- Rollback should keep job rows but allow routes to read old in-memory state while the feature flag is disabled.
- Do not change label purchase, shipped/cancelled mutation, or fulfillment deduction behavior in the durable-status rollout.

## Recommended Implementation Order

1. Review this matrix with DJ/OpenClaw and approve durable job storage target.
2. Add `job_runs` migration or pg-boss status adapter design.
3. Implement durable state for rate backfill best rates.
4. Implement durable state for billing reference-rate fetch.
5. Implement durable state for print queue batch send.
6. Implement durable metadata and artifact pointer for print queue PDF merge.
7. Add unified job status panel and audit events.
