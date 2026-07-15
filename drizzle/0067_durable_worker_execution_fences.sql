-- PS-428: worker-owned Rate Browse and Print merge execution fences.
-- These sidecars store durable job inputs, heartbeats, and generation metadata.
-- They do not mutate orders, shipments, labels, postage, or marketplace state.

ALTER TABLE rate_browse_jobs
  ADD COLUMN IF NOT EXISTS request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_acknowledged_at timestamptz;

-- Old API-local scheduling could create more than one active row for one
-- request. Keep the newest as the sole owner before installing the atomic
-- reservation constraint; only job-sidecar metadata is reconciled here.
WITH ranked_active_requests AS (
  SELECT
    job_id,
    row_number() OVER (
      PARTITION BY request_key
      ORDER BY updated_at DESC, created_at DESC, job_id DESC
    ) AS request_rank
  FROM rate_browse_jobs
  WHERE active = true AND request_key IS NOT NULL
)
UPDATE rate_browse_jobs AS jobs
SET active = false,
    status = 'error',
    message = 'Superseded duplicate active request during PS-428 worker-fence migration',
    snapshot = jobs.snapshot || jsonb_build_object(
      'active', false,
      'phase', 'error',
      'message', 'Superseded duplicate active request during PS-428 worker-fence migration',
      'finishedAt', now()::text,
      'updatedAt', now()::text
    ),
    finished_at = COALESCE(jobs.finished_at, now()),
    updated_at = now()
FROM ranked_active_requests AS ranked
WHERE jobs.job_id = ranked.job_id
  AND ranked.request_rank > 1;

UPDATE rate_browse_jobs
SET snapshot_updated_at = updated_at
WHERE snapshot_updated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS rate_browse_jobs_request_active_unq
  ON rate_browse_jobs (request_key)
  WHERE active = true AND request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS rate_browse_jobs_recovery_idx
  ON rate_browse_jobs (active, status, heartbeat_at, updated_at);

ALTER TABLE print_queue_merge_jobs
  ADD COLUMN IF NOT EXISTS input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_acknowledged_at timestamptz;

UPDATE print_queue_merge_jobs
SET snapshot_updated_at = updated_at
WHERE snapshot_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS print_queue_merge_jobs_recovery_idx
  ON print_queue_merge_jobs (active, status, heartbeat_at, updated_at);

ALTER TABLE print_queue_pdf_chunks
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;
