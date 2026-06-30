# PS-346 - Print Queue durable full-results fallback

Status: implemented with user override `unlock shipped data` on 2026-06-30.

## Source of truth

The backend Print Queue job owner remains the source of truth for Send-to-Queue
progress and per-order outcomes. The frontend polls
`GET /print-queue/batch-send/status/:jobId` and renders the backend DTO; it does
not compute queue success/failure counts.

## Root cause fixed

Before this slice, the active in-memory job returned all `job.results`, but the
durable fallback only returned `durableJob.resultSamples`, capped to the latest
10 rows. Long batches could therefore look stuck or incomplete after a refresh,
restart, or slow durable poll because the status route no longer had every
per-order result.

## Fix

- `src/services/print-queue/queue-send-snapshot.ts` owns durable batch-send
  snapshot construction.
- Durable snapshots now store full `results` plus compact `resultSamples`.
- `src/routes/print-queue.ts` returns full durable `results` when the in-memory
  job is gone, while keeping `result_samples` for compact legacy/debug display.
- Existing old snapshots without `results` still fall back to `resultSamples`.

## Verification

- `npm run test:ps-346-print-queue-durable-full-results -- --no-color`
- `npm run test:print-queue-durable -- --no-color`

No live labels, postage, marketplace notifications, billing, inventory, or
production shipped/cancelled mutations are performed by these guards.
