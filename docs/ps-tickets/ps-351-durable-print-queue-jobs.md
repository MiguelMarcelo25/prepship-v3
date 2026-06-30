# PS-351 - Durable Print Queue preflight and batch jobs

## Backend Owner

`src/services/print-queue/queue-send-job-store.ts` owns durable queue-send job
status. `src/services/print-queue.ts` creates the in-memory worker state, but
the initial job id is not returned until the backend durable job store accepts
the pending snapshot.

The legacy settings blob is legacy fallback only. It remains readable for older
jobs and compatibility diagnostics, but it is no longer the first durable source
for current queue-send status.

## Imperfect Data Injection

Bad queue status first enters when a long batch is represented only by process
memory or one overwritten `settings` row. A restart, timeout, or overlapping run
can make the operator see the wrong total, lose per-order results, or inherit a
previous run's status.

This slice adds `print_queue_send_jobs`, an additive runtime table keyed by
`job_id`. Each row stores the full backend snapshot, status, client scope facts,
progress counts, and updated timestamp. The status route still reads by the
requested job id before using any latest-job fallback.

## Current Slice

- Adds a focused queue-send job store module with runtime `CREATE TABLE IF NOT EXISTS`.
- Persists the initial pending snapshot to that store before `/batch-send`
  returns a job id.
- Reads per-job and latest snapshots from the job store first.
- Keeps the settings snapshot as a legacy fallback after the canonical write.
- Leaves label purchase, queue entry writes, and PDF merge behavior unchanged.

## Safety

No labels, postage, provider calls, queue mutation, billing, inventory, or shipped/cancelled mutation is performed by this guard or documentation slice.
The implementation changes the durable status owner only.

## Verification

Run:

```bash
npm run test:ps-351-durable-print-queue-jobs
npm run test:print-queue-durable
npm run test:ps-346-print-queue-durable-full-results
npm run test:ps-346-print-queue-volume-evidence
npm run typecheck
```
