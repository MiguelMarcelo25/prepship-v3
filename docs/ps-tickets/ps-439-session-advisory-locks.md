# PS-439 — Pool-safe worker lock ownership

Trello: https://trello.com/c/rFLviYOL

## Source-of-truth placement

`sync-job-queue.ts` is the canonical cross-process admission owner. It maps the carrier-account snapshot job and fulfillment outbox to the shared `shipstation-sync` lane, then executes the job under `withSyncLaneAdvisoryLock`. `sync-lane-lock.ts` acquires that ownership with `pg_try_advisory_xact_lock` inside `postgres.begin`, so PostgreSQL releases the lock when the transaction finishes and no pooled-session unlock query is needed.

The scheduler and rate-browse store had already removed their session advisory locks. PS-439 removes the remaining duplicate session lock from the carrier-account snapshot worker. That worker now owns only process-local promise coalescing and delegates cross-process ownership to the durable queue.

## Imperfect-data injection and health

The earliest bad state was a session lock acquired on one pooled PostgreSQL backend and an unlock that could be routed to another backend. The unlock could return false while the original session remained locked. Repeated queue lock misses were recorded as individual `skipped` snapshots, so operations could not distinguish transient contention from a persistent halt.

Worker telemetry now retains the count and first timestamp for consecutive same-reason skips. `/health/deep` evaluates the fulfillment-outbox snapshot: transient skips remain healthy, a streak older than three full fulfillment-outbox cadences fails the component, and the next successful run clears the streak by replacing the job snapshot. `/health/ready` remains lightweight and unchanged.

## Verification and safety

- `npm run test:ps-439-session-advisory-locks`
- `npm run test:sync-advisory-lock`
- `npm run test:ps-032-connector-orchestrators`
- `npm run test:audit-imported-handler-boundary`
- `npm run test:health-deep-readiness`
- `npm run typecheck`
- `npm run diagnose:ps-439-advisory-locks` (transaction-read-only, before and after deploy)

The focused guard models the pooling failure boundary: a session unlock routed to backend B cannot release a lock owned by backend A, while transaction completion releases transaction-scoped ownership without a separate unlock. It also proves transient/persistent skip thresholds and recovery after success.

No shipped/cancelled data path, label/postage path, marketplace notification, production database row, or live provider call is changed or exercised. The production diagnostic reads only `pg_locks` and `pg_stat_activity`; it never terminates sessions or mutates production data.

## Production read-only baseline

The pre-deploy diagnostic on 2026-07-21 observed one granted, idle session lock under the legacy `prepship.worker.shipstation-carrier-account-snapshots` key. Every legacy scheduler key was clear. The other observed session lock was the intentional `prepship.worker.shipstation-stately-consumers` consumer-leadership lock. No session was terminated; the normal worker deployment/restart is the recovery mechanism, and the same read-only diagnostic must be repeated after deploy.

## Production read-only closeout

The post-deploy diagnostic on 2026-07-22 passed against current stable `0f3d3b571c939886dc22fb26b7455c7e5a0b76e8`, which contains the PS-439 implementation commit `e3c9e5dee4fda2cc5a269746bc98ca8163049177`. All nine legacy session-lock keys were clear, including `prepship.worker.shipstation-carrier-account-snapshots`. The only observed locks were the intentional dedicated `prepship.worker.shipstation-stately-consumers` session-leadership lock and an active transaction-scoped `prepship.sync.lane.shipstation-sync` lock. No unnamed idle advisory lock was present.

Production `/health/ready` returned `ready` with database, database-write, and event-loop checks green. `/health/deep` reported the fulfillment outbox healthy with no skip streak. Its overall degraded result came only from a separate stale order-sync account and does not indicate a PS-439 lock or confirmation-outbox regression.

This closeout combines the offline simulated pooling boundary with the transaction-read-only production lock inspection. It does not claim a live two-session destructive test, terminate any session, notify a marketplace, or mutate order, shipment, label, inventory, or billing data.
