# Print Queue Merge Durability Audit

## Audit 3.5 Placement

- Business rule: a PDF merge job may report `done` only after its job metadata
  is durable and, when artifact durability is enabled, every completed PDF
  chunk has been stored.
- Canonical lifecycle owner: `src/services/print-queue.ts`.
- Canonical metadata owner: `src/services/print-queue/merge-job-store.ts`.
- Canonical artifact owner: `src/services/print-queue-pdf-store.ts`.
- Imperfect-state entry point: the former `print_queue.pdf_merge.last_run`
  settings singleton allowed concurrent jobs to overwrite each other, and
  fire-and-forget artifact writes allowed `done` to appear before persistence.
- Callers: print-queue status and PDF-serving routes read the requested job from
  the backend owners; the frontend remains a poll/render/open consumer.
- Forbidden duplicate owner: routes and React code must not infer whether a
  merge worker is still alive or whether PDF bytes are durable.

## Implemented Boundary

Migration `drizzle/0064_print_queue_merge_jobs.sql` adds a per-`job_id` metadata
table. Writes carry a monotonic timestamp guard so an older asynchronous
progress write cannot replace a newer terminal snapshot. The legacy latest-run
settings key remains write/read fallback compatibility only.

The initial snapshot is required before a job id is returned. Running progress
remains best-effort, but chunk terminal snapshots and the final job snapshot are
awaited. With `DURABLE_PRINT_QUEUE_PDF=true`, a chunk storage failure prevents
the job from publishing `done`.

When the in-process worker is absent and an active snapshot has not moved for
five minutes, `merge-job-status.ts` derives a terminal error with
`worker_missing_stale_snapshot`. This is read-only derivation; it creates no
label, postage, order, shipment, or marketplace side effect.

## Deployment and Canary Gate

This item is code-ready but remains operationally open until the runtime canary
is completed:

1. Apply migrations through `0064` before deploying the API/worker code.
2. Deploy with `DURABLE_PRINT_QUEUE_PDF=false`.
3. Verify two concurrent synthetic/mock-label merges retain distinct job
   snapshots and terminal status.
4. With DJ's runtime go/no-go, enable `DURABLE_PRINT_QUEUE_PDF` on the canary.
5. Merge synthetic/mock labels, confirm chunk rows exist, restart the API, and
   verify the same signed PDF/chunk can be opened without regenerating labels.
6. Disable the flag immediately if artifact persistence or restart rehydration
   fails. No live label purchase or marketplace notification belongs in this
   canary.

## Offline Proof

- `npm run test:audit-print-queue-merge-durability`
- `npm run test:print-queue-durable`
- `npm run test:ps-256-durable-print-queue-pdf`
- `npm run test:ps-403-print-queue-pdf-chunks`
- `npm run test:runtime-ddl`
- `npm run typecheck`
