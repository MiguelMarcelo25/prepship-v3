# PS-430 Print Queue worker freeze and recovery

**Audience:** DJ / Lawrence / operators responding to a Print Queue worker incident.

**Safety rule:** diagnosis is counts/ages and transaction-local read-only SQL only. Do not
restart a production worker, resubmit a batch, reconcile a provider outcome, buy postage,
notify a marketplace, or mutate production orders/shipments without DJ's explicit approval
for that action.

## Canonical ownership

- The dedicated Print Queue worker's pg-boss claim loop owns job claiming.
- `print_queue_send_jobs` and `print_queue_batch_job_items` own durable progress,
  recovery generation, and per-order provider state.
- The persisted `print-worker` status snapshot owns heartbeat and last job
  start/success/failure.
- `/health/deep` is a read-only consumer. `printQueue.queuedCount` counts list rows only;
  `printQueueWorker` reports worker/pg-boss/durable health. A zero list count cannot prove
  a batch worker is healthy.

## Required connection layout

Keep ordinary API SQL on `DATABASE_URL`. The API may use Supabase transaction mode on port
6543. Configure the production Print Queue consumer separately:

```text
RUN_PRINT_QUEUE_WORKER=true
RUN_SYNC_SCHEDULER=false
PRINT_QUEUE_PG_BOSS_DATABASE_URL=<direct-or-session-mode-postgres-url-on-port-5432>
PRINT_QUEUE_PG_BOSS_STATEMENT_TIMEOUT_MS=12000
PRINT_QUEUE_PG_BOSS_IDLE_IN_TRANSACTION_TIMEOUT_MS=15000
PRINT_QUEUE_WORKER_HEALTH_INTERVAL_MS=30000
```

Allowed worker connections are Supabase direct (`db.<ref>.supabase.co:5432`) or Supabase
session mode (`*.pooler.supabase.com:5432`). The worker rejects Supabase transaction mode
(`*.pooler.supabase.com:6543`) and, in production, refuses to start without the dedicated
URL. Never log or paste either connection string.

The Print Queue consumer refuses to share a process with the sync scheduler. Use a separate
Render worker service; an invalid combined configuration exits unhealthy at startup.

Deploy migrations before starting the worker. The API's producer instance only inserts
queue metadata; it does not supervise, schedule, migrate, or claim pg-boss jobs.

## Read-only diagnostics without pool poisoning

Never run session-level commands such as these through a transaction-pooler URL:

```sql
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;
SET default_transaction_read_only = on;
```

Session state can be returned to the transaction pool and poison a later writer. Use one of
these options instead:

1. Connect through direct/session mode on port 5432 for session-oriented diagnostics.
2. For transaction-pooler diagnostics, keep read-only state transaction-local:

```sql
BEGIN READ ONLY;
SELECT current_setting('transaction_read_only') AS transaction_read_only;
-- bounded SELECT-only diagnostics
COMMIT;
```

If a diagnostic tool previously changed session state, stop that tool. Do not attempt a
fleet-wide `RESET`, `DISCARD ALL`, or restart without DJ approval; rotate/reconnect the
affected diagnostic connection through the approved incident procedure.

## Reading `/health/deep`

The `printQueueWorker` component fails after 210 seconds without credible progress. It
returns safe values only: counts, ages, progress totals, and reason codes.

| Reason code | Meaning | Automatic worker exit? |
|---|---|---:|
| `worker_heartbeat_missing` / `worker_heartbeat_stale` | Dedicated worker status is absent or old | Yes |
| `pgboss_health_read_failed` | pg-boss claim state could not be read | Yes |
| `durable_health_read_failed` | durable batch/item state could not be read | Yes |
| `pgboss_claim_stale` | created/retry job was not claimed within 210s | Yes |
| `pgboss_active_without_progress` | old active claim has no fresh durable progress | Yes |
| `durable_batch_stale` | pending/running durable batch has not advanced for 210s | Yes |
| `pgboss_recent_failure` / `worker_job_recent_failure` | a recent claim/handler failure is visible while retry work remains | No; retry is observed first |
| `provider_reconciliation_required` | provider outcome is unknown; automatic replay is fenced | No; operator action required |

Repeated pg-boss statement/idle-in-transaction timeouts (three in two minutes) or sustained
timekeeper skew (two warnings in two minutes) also cause a controlled exit with status 1 so
Render can restart the worker. The exit request is single-flight and stops new admissions.

## Recovery contract

Every durable recovery claim increments `recoveryAttempts` atomically. Before importing the
provider-capable Print Queue service, the worker reloads the durable snapshot and admits the
payload only when its recovery generation exactly matches. The current generation must also
complete a generation-matched durable metadata write before that import. An old active
pg-boss payload, a read-only connection, and its new recovery payload therefore cannot cross
the provider boundary unsafely.

Recovery is blocked when any item is `provider_pending` or
`provider_pending_recovery`. Do not resubmit or restart to clear this state. First reconcile
the provider outcome using the label purchase-intent/provider-recovery procedure from PS-423
and PS-428. Only an outcome proven absent may become retryable; an existing purchase must be
persisted/recovered, never blindly repurchased.

## Incident sequence

1. Record `/health/deep` `printQueueWorker` reason codes, counts, and ages. Keep
   `printQueue.queuedCount` separate.
2. Check the latest persisted `print-worker` heartbeat/job result and the affected durable
   batch/item states with transaction-local read-only queries.
3. If any provider state is unknown, stop. Fence the batch and reconcile it before any
   resubmission or restart intended to replay work.
4. If the failure is an infrastructure freeze and there is no provider-unknown item, allow
   the worker's controlled unhealthy exit to request a Render restart.
5. A manual Render restart still requires DJ approval. Record approver, UTC time, service,
   reason, affected job id, pre-restart state, and post-restart claim/progress.
6. Verify one recovery generation advances, the provider-call audit remains exactly once,
   durable progress resumes, and `printQueueWorker` returns `ok`.

## Offline verification

```powershell
npm run test:ps-430-print-queue-worker-health
npm run test:print-queue-worker-offload
npm run test:audit-print-queue-lifecycle
npm run test:audit-pg-boss-inventory-outbox
npm run typecheck
```

The PS-430 command includes pure timeout/skew/exact-generation fixtures and an offline
migrated-Postgres (PGlite) test. It creates no production job, makes no network request,
calls no label provider, and performs no service restart.
