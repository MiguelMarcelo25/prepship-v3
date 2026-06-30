# PS-346 - Print Queue Volume Evidence

## Scope

This slice is read-only/certification work for the Print Queue part of PS-346.
The current implementation also includes the user-approved locked Print Queue
durable-results slice already present in the repo. This document records the
proof boundary only; no labels, postage, marketplace notifications, billing,
inventory, production data, shipped-order mutations, cancelled-order mutations,
or shipment-history changes were performed by this evidence update.

## Root-Cause Findings

The selected-count issue has two different layers:

1. The active backend queue-send job is per-run. `startQueueSendJob` creates a
   fresh `jobId`, `total`, `current`, `queued`, `failed`, `results`, and
   `queuedEntryIds` for the selected orders in that run.
2. The active status endpoint returns the full in-memory `job.results`, so while
   the worker is alive the UI can see every per-order success/failure reason for
   the current run.
3. Durable fallback now preserves full per-order `results` for the selected
   batch, and still carries compact `resultSamples` as a legacy/preview field.
   This closes the old 20+ order restart gap where only the latest 10 failures
   or successes survived in durable status.
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
- Durable fallback returns full per-order `results` through
  `queueSendSnapshotResults(durableJob)`, so 20/50/200-order batches keep every
  order's success/failure, retry eligibility, retry reason, and timing evidence
  even after an in-memory worker restart.
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
| Durable fallback after restart | returned `results.length = total`, while `resultSamples` remains only a compact preview |

## Durable Full-Result Proof

The previous blocker was durable fallback only carrying capped
`resultSamples`. The repo now preserves full `results` in
`src/services/print-queue/queue-send-snapshot.ts` and the status route returns
those full results for durable fallback reads. `resultSamples` remains as a
small preview only; it is no longer the authoritative per-order proof.

The focused guard `npm run test:ps-346-print-queue-durable-full-results --
--no-color` proves a 20-order durable snapshot preserves all 20 per-order
results, earliest and latest order ids, retry eligibility, retry reason, and
failure detail.

## Guard

Run:

```bash
npm run test:ps-346-print-queue-volume-evidence -- --no-color
```
