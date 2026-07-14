# Audit 3.11 — print-queue lifecycle placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** A durable print-queue parent job must make bounded
  progress across worker restarts without overlapping label work, silently
  remaining active, or placing all 1,000 orders under one deadline.
- **Canonical owners:** `queue-send-job-store.ts` owns durable recovery claims,
  attempt counts, and interruption state. `print-queue-worker.ts` owns boot and
  periodic recovery, chunk sequencing, and the parent deadline.
  `queue-send-execution.ts` owns bounded admission and same-process
  single-flight execution. `print-queue.ts` remains the per-order workflow
  executor and delegates those lifecycle controls.
- **Unsafe/duplicated owners removed:** The boot-only recovery reader and its
  one-shot singleton key were removed. Worker retries no longer re-enter an
  already-running parent, and the old non-cancelling concurrency pool no longer
  admits work after the parent deadline.
- **Earliest imperfect-data entry:** A worker can die or cross its deadline
  after provider work has started but before the parent snapshot is terminal.
  pg-boss can then redeliver the same chunk, while another process can discover
  the same stale durable row.
- **Callers that delegate:** API enqueue schedules only the first chunk. Each
  successful worker chunk reloads durable results and schedules at most 100
  remaining orders. Boot and the 60-second reaper both call the same atomic
  recovery claim. Worker execution passes its cancellation signal into the
  service, which delegates admission and re-entry to the execution owner.
- **Wrapper/resolver logic deleted or forbidden:** No recovery path may first
  SELECT stale rows and later enqueue them without an atomic claim. No retry may
  bypass `runQueueSendSingleFlight`, no per-order pool may ignore the parent
  signal, and no worker payload may exceed the 100-order boundary.
- **Frontend role:** None. The frontend only observes the existing durable job
  status DTO; it owns no label, retry, recovery, or chunking decision.
- **Backend boundary proof:** `test:audit-print-queue-lifecycle` behaviorally
  proves 1,000-to-100 chunking, cooperative cancellation, and same-job
  single-flight. Its static checks pin cross-process `FOR UPDATE SKIP LOCKED`
  recovery claims, three-attempt exhaustion, periodic reaping, deadline wiring,
  and continuation ordering. It is mandatory in the source-of-truth guard pack.
- **Workflow proof:** PS-403 recovery, worker offload, in-progress purchase
  recovery, durable job, retry recovery, progress, strict typecheck, production
  build, and the full SOT pack are required.

Per user override `unlock shipped data` on 2026-07-14, these changes control
orchestration around the protected label path only. Existing duplicate-postage,
selected-rate proof, shipped/cancelled edit, and provider-purchase boundaries
remain unchanged. Offline verification performs no database mutation, provider
call, real label/postage purchase, marketplace notification, inventory change,
or production shipped/cancelled mutation.
