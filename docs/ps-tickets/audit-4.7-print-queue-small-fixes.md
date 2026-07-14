# Audit 4.7 — Print Queue small fixes

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** A concurrent printed/delivered
  transition must never be overwritten back to queued; API job dispatch must
  reuse one supervised enqueue connection; and a timed-out durable status read
  must be reported as temporarily unavailable rather than not found.
- **Canonical backend/domain/read-model/policy owner:** `addToQueue` in
  `src/services/print-queue.ts` owns the final queue UPSERT predicate.
  `src/services/print-queue-worker.ts` owns the PgBoss enqueue lifecycle.
  `durable-status-read.ts` owns timeout-versus-value distinction, while the
  Print Queue route owns its HTTP 503 translation.
- **Current duplicated/unsafe owners:** `addToQueue` checks final status before
  an unconditional conflict update; every API enqueue starts/stops a new PgBoss
  supervisor; the route converts both a missing record and a slow read to null.
- **Where bad/stale/incomplete data can enter:** A print confirmation or
  delivery retirement can commit between the queue pre-read and UPSERT; each
  enqueue request constructs independent supervisor state; the durable database
  read may outlive the 1.5-second route budget.
- **Callers that must delegate to the owner:** Direct and batch queue insertion
  use the guarded UPSERT, `enqueueQueueSendWorkerJob` uses the shared enqueue
  boss, and batch status uses the explicit durable-read outcome.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** An
  unconditional queue conflict update, per-enqueue PgBoss start/stop, and
  timeout-as-null status helpers are forbidden.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend changes. The frontend continues polling the backend status DTO and
  never decides queue finality or worker availability.
- **Backend boundary tests required:** Ephemeral PostgreSQL proves a finalized
  row survives the guarded conflict update while a queued row can refresh; a
  pure timing test distinguishes null from timeout; static pins prove one shared
  enqueue boss and HTTP 503 mapping.
- **Workflow/UI proof required:** Existing Print Queue retry, lifecycle,
  durability, worker, status, scope, lockdown, strict typecheck, production
  build, and SOT guards pass.

Per user override `unlock shipped data` in the current conversation, changes are
limited to Print Queue finality protection, queue orchestration metadata, and
read-only status reporting. No real label/postage, marketplace notification,
inventory movement, order/shipment write, or production mutation is performed.
