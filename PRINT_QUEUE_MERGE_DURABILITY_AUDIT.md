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

Completed in production on 2026-07-14 under the user override
`unlock shipped data`:

1. Migrations through `0064` were applied before the canary.
2. The API was deployed with `DURABLE_PRINT_QUEUE_PDF=false`.
3. Concurrent synthetic/mock-only jobs
   `81bf573d-340d-4457-879d-0bd264c1de01` and
   `a0304221-64d4-4bd7-9bd8-6780af5a9c25` both reached `done`, retained
   distinct two-entry snapshots, and wrote zero durable PDF/chunk rows.
4. DJ gave the runtime go/no-go in-session. `DURABLE_PRINT_QUEUE_PDF=true`
   was deployed to the Render API in `dep-d9as4be7r5hc739cadk0`.
5. Synthetic/mock-only job `284df37c-9292-43fe-ae11-83bc89f2ed65`
   reached `done` and stored one per-job snapshot, one merged-PDF row, and one
   PDF-chunk row. Its signed chunk served 3,329 bytes with SHA-256
   `a5c6c7e244c4402d6c1352ae06336f7402dd87476a801a2e784fc5feede40d07`.
6. Restart deploy `dep-d9as5peq1p3s73d95fb0` replaced the API process. The
   durable status still returned `done`, and the rehydrated signed chunk served
   the same byte length and SHA-256 without regenerating a label.
7. Synthetic queue fixtures were removed. `/health`, `/health/ready`, and
   `/health/deep` remained green. Shipment, mock-label, fulfillment-outbox,
   and shipped/cancelled-order counts were unchanged. No real label/postage,
   marketplace notification, or production shipped/cancelled mutation occurred.

The canary passed, so the flag remains enabled on the API service.

## Offline Proof

- `npm run test:audit-print-queue-merge-durability`
- `npm run test:print-queue-durable`
- `npm run test:ps-256-durable-print-queue-pdf`
- `npm run test:ps-403-print-queue-pdf-chunks`
- `npm run test:runtime-ddl`
- `npm run typecheck`
