# PS-351 - Durable Print Queue preflight and batch jobs

## Backend Owner

`src/services/print-queue/queue-send-job-store.ts` owns durable queue-send job
status and durable per-order item state. `src/services/print-queue/queue-send-preflight.ts`
owns the backend bulk preflight before label purchase. `src/services/print-queue.ts`
still runs the in-process worker, but the initial job id is not returned until
the backend durable job store accepts the pending snapshot and item rows.

The legacy settings blob is legacy fallback only. It remains readable for older
jobs and compatibility diagnostics, but it is no longer the first durable source
for current queue-send status.

## Imperfect Data Injection

Bad queue status first enters when a long batch is represented only by process
memory or one overwritten `settings` row. A restart, timeout, or overlapping run
can make the operator see the wrong total, lose per-order results, or inherit a
previous run's status.

This slice adds `print_queue_send_jobs`, an additive runtime table keyed by
`job_id`, plus `print_queue_batch_job_items`, keyed by `(job_id, order_id)`.
The batch row stores the full backend snapshot, status, client scope facts,
progress counts, and updated timestamp. The item table stores the current
per-order state, blocker reason, queue entry id, tracking number, and error.
The status route still reads by the requested job id before using any latest-job
fallback and returns `item_states` without requiring a full `/orders` refetch.

## Bulk Preflight

`preflightQueueSendOrders()` classifies the whole selected batch before the
worker can buy postage:

- `ready`
- `order_not_found`
- `order_not_editable`
- `missing_label_payload`
- `missing_rate_proof`
- `stale_or_mismatched_rate_proof`
- `missing_weight`
- `missing_package`
- `missing_address`
- `carrier_provider_unavailable`

Blocked orders are recorded as durable `preflight_blocked` item states and as
normal failed job results. Ready orders continue to the worker. This keeps a
20-order send as a 20-order job, instead of discovering ordinary blockers one
label purchase at a time.

## Provider Pending / Timeout Safety

The previous non-cancelling `Promise.race()` around `processQueueSendOrder()`
could mark a purchase failed while the provider call continued. That path is
removed. Slow purchases now move the durable item state to
`provider_pending_recovery`; the worker still awaits the original operation and
then records `shipment_persisted`, `queued`, `failed_retryable`, or
`failed_terminal`. Operators must verify existing labels/locks before retrying
pending-recovery items.

## Current Slice

- Adds a focused queue-send job store module with runtime `CREATE TABLE IF NOT EXISTS`.
- Adds durable `print_queue_batch_job_items` per-order states.
- Adds backend-owned bulk preflight before label purchase.
- Persists the initial pending snapshot to that store before `/batch-send`
  returns a job id.
- Persists preflight-blocked and ready item rows before the worker starts.
- Reads per-job and latest snapshots from the job store first.
- Returns status `item_states` from `/print-queue/batch-send/status/:jobId`.
- Keeps the settings snapshot as a legacy fallback after the canonical write.
- Leaves `createLabelV2` as the final selected-rate/label-purchase authority.

## Safety

No labels, postage, provider calls, queue mutation, billing, inventory, or shipped/cancelled mutation is performed by this guard or documentation slice.
The implementation changes the durable status/preflight owner only. Runtime use
of `/batch-send` still performs the operator-requested queue/label workflow; no
test or guard in this slice performs live label/postage/provider side effects.

## Verification

Run:

```bash
npm run test:ps-351-durable-print-queue-jobs
npm run test:print-queue-durable
npm run test:ps-346-print-queue-durable-full-results
npm run test:ps-346-print-queue-volume-evidence
npm run typecheck
```
