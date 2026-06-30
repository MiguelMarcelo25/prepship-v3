# PS-346 - Print Queue Volume Evidence

## Scope

This slice is read-only/certification work for the Print Queue part of PS-346.
No Print Queue internals, shipped/cancelled mutation paths, shipment history,
labels, postage, marketplace notifications, billing, inventory, or production
data were changed.

## Root-Cause Findings

The selected-count issue has two different layers:

1. The active backend queue-send job is per-run. `startQueueSendJob` creates a
   fresh `jobId`, `total`, `current`, `queued`, `failed`, `results`, and
   `queuedEntryIds` for the selected orders in that run.
2. The active status endpoint returns the full in-memory `job.results`, so while
   the worker is alive the UI can see every per-order success/failure reason for
   the current run.
3. The durable fallback is capped to the latest 10 result samples. That is safe
   for storage, but it is not full proof for a 20/50/200-order batch after a
   process restart, stale worker, or fallback-only status read.
4. The frontend progress poller uses the selected run total passed to
   `pollBackendQueueSendJob`, and persistent queue jobs reset
   `completedOrderIds`/`failedOrderIds` for each new run. That protects the UI
   from showing a cumulative `30/30` when the second run selected only 20
   orders.

## Current Safe Proof

- Batch-send snapshot persistence uses `setJsonSettings`, so the previous
  multi-row settings upsert failure pattern is not present for batch-send status
  writes.
- Active `/print-queue/batch-send/status/:jobId` returns `job.total`,
  `job.current`, `job.queued`, `job.failed`, `job.queuedEntryIds`, and full
  `job.results`.
- Durable fallback derives stale/interrupted state through
  `deriveQueueSendSnapshotStatus`, which clamps `current` to `total` and marks
  stale missing-worker jobs as interrupted instead of pretending they are still
  running.
- Persistent queue jobs store identifiers only, not rate/proof/money payloads,
  and each new run starts with empty completed/failed arrays.

## Selected-Count Acceptance Matrix

The live behavior PS-346 must prove before final review:

| Scenario | Required proof |
|---|---|
| Selected 10 | status `total = 10`, `current <= 10`, and final `queued + failed = total` |
| Selected 20 after a prior 10-run | status `total = 20`; display is not cumulative and must not show `30/30` |
| Individual blockers | failed orders have per-order `results[].error`, `retryEligible`, and `retryReason` where applicable |
| Retry after one failure | retry starts a new job with a new selected total and does not inherit the previous run total |
| Worker restart/stale job | status becomes interrupted/stale with safe retry instructions instead of infinite running |

## Remaining Blocker

Full durable per-order proof for long batches is still blocked by the
repository lockdown gate. The active job has full `results`, but durable fallback
stores only capped `resultSamples`. If DJ wants every result preserved after a
worker restart for 20+ selected orders, the next implementation must touch the
locked Print Queue internals and requires the exact override phrase:

`unlock shipped data`

Until then, PS-346 can certify the current active-job behavior and document the
remaining durable-proof gap, but it should not be moved to final review as a
complete Print Queue volume fix.

## Guard

Run:

```bash
npm run test:ps-346-print-queue-volume-evidence -- --no-color
```
