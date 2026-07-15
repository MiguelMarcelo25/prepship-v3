# PS-430 — Print Queue pg-boss freeze and worker-aware recovery

## Placement record

- **Business rule/workflow being changed:** a Print Queue batch is healthy only when the
  dedicated pg-boss consumer is alive, claims work, and advances the durable batch. Recovery
  must admit one current generation and must never replay an unknown provider outcome.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/print-queue-worker.ts` owns pg-boss connection/claim/recovery execution;
  `print_queue_send_jobs` and `print_queue_batch_job_items` own durable progress and provider
  state; `src/services/print-queue-worker-policy.ts` owns pure liveness, connection, fatal
  signal, and recovery-generation decisions.
- **Current duplicated/unsafe owners:** the API pg-boss producer previously used the same
  `DATABASE_URL` configuration as the consumer and enabled supervision; `/health/deep`
  exposed only `print_queue_orders` counts; stale recovery had no generation admission check
  before importing the provider-capable service; provider-unknown item state did not stop
  automatic recovery.
- **Where bad/stale/incomplete data can enter:** a Supabase transaction-pooler session can
  retain session-level read-only state from a diagnostic client; a claim transaction can
  freeze or time out; a process can die after provider acceptance but before local
  persistence; an old pg-boss payload can remain active after a durable recovery claim; list
  rows can be zero while a batch remains stale.
- **Callers that must delegate to the owner:** the dedicated worker delegates connection and
  admission decisions to the policy owner; recovery reads authoritative per-item state from
  the durable store; `/health/deep` delegates its worker component to
  `readPrintQueueWorkerHealth`; the API producer only sends metadata.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** forbid consumer fallback
  to Supabase transaction mode in production, session-level read-only diagnostics through a
  transaction-pooler URL, frontend/API-list inference of worker health, and any recovery
  wrapper that calls the provider before the generation/provider-state fences.
- **Frontend role: display/action only; no authoritative business logic:** no frontend file is
  changed. The existing UI may display the backend status; it does not calculate health,
  decide recovery, or invoke restart/provider actions.
- **Backend boundary tests required:** direct/session URL admission and transaction-mode
  rejection; 210-second stale durable/claim fixtures; repeated timeout and timekeeper-skew
  failure injection; exact recovery-generation provider spy; provider-unknown rejection;
  migrated PostgreSQL durable-table lifecycle.
- **Workflow/UI proof required when operator-facing:** `/health/deep` must show distinct
  `printQueue` and `printQueueWorker` components, safe counts/ages/reason codes, and a stale
  durable batch must fail even when list `queuedCount` is zero. No UI change is required.

## Root cause and implementation

The 2026-07-13 incident combined two independent hazards:

1. the long-lived pg-boss consumer was using a Supabase transaction-pooler connection, which
   is not a safe owner for persistent claim/session behavior; and
2. a read-only diagnostic used session-level state through that pooler, allowing later writes
   to inherit `default_transaction_read_only=on`. The worker could claim a job but fail to
   persist its state change, leaving the pg-boss row active and the durable batch incomplete.

PS-430 separates the consumer connection (`PRINT_QUEUE_PG_BOSS_DATABASE_URL`), requires
direct/session mode on port 5432 in production, bounds statements and idle transactions,
turns the API pg-boss instance into a producer only, persists worker job outcomes, and exits
unhealthy on stale claim/durable health, repeated timeouts, or sustained clock skew.

The recovery claim's incremented `recoveryAttempts` is now a fencing generation. The worker
reloads it before the provider-capable import; stale payloads return successfully as skipped.
The current generation must then complete an atomic generation-matched durable write before
that import, so a read-only-poisoned connection also fails closed. Recovery reads
`print_queue_batch_job_items` and interrupts rather than requeues when any provider outcome
is unknown.

## Shipped-data override accounting

User override `unlock shipped data` was present in this conversation on 2026-07-15. The
protected shipping-reliability scope was used only for Print Queue orchestration safety.

- Exact enumerated lockdown files touched: none. The shipping-reliability files touched under
  the override-adjacent PS-430 scope are `src/services/print-queue-worker.ts` and
  `src/services/print-queue/queue-send-job-store.ts`.
- Why necessary: the canonical claim/recovery boundary and durable per-item state live there;
  the generation and provider-unknown fences cannot be authoritative in the UI or route.
- Protections not weakened: no order/shipment edit guard, shipped/cancelled lock, inventory
  switch, label URL behavior, or provider purchase owner changed. Recovery became stricter.
- Production side effects: none. No real label, postage purchase, provider call, marketplace
  notification, service restart, production job insertion, or production shipped/cancelled
  mutation was performed.

## Evidence

```text
npm run test:ps-430-print-queue-worker-health
  PASS pure health/connection/fatal/admission fixtures
  PASS migration 0062 PGlite durable lifecycle and generation fence

npm run test:print-queue-worker-offload
  PASS

npm run test:ps-335-sot-guard-pack
  PASS

npm run test:sot-guard-pack
  PASS (39/39 mandatory commands)

npm run test:order-editable-lockdown
  PASS

npm run typecheck
  PASS

npm run build:web
  PASS
```

The production configuration/deploy and any manual restart remain operator actions. Follow
`docs/runbooks/ps-430-print-queue-worker-freeze.md`; they are not development-time tests and
require DJ approval when they change live service state.
