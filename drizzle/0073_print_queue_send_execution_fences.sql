-- PS-452: durable execution fences and per-item recovery attempts for queue send.
-- Per user override unlock shipped data on 2026-07-21: this migration changes
-- Print Queue orchestration sidecars only. Order/shipment rows, labels,
-- postage, inventory, and marketplace confirmation state remain untouched.

ALTER TABLE print_queue_send_jobs
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_chunk_sequence integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS snapshot_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_acknowledged_at timestamptz;

UPDATE print_queue_send_jobs
SET
  generation = CASE
    WHEN coalesce(snapshot->>'recoveryAttempts', '') ~ '^[0-9]+$'
      THEN greatest(0, (snapshot->>'recoveryAttempts')::integer)
    ELSE generation
  END,
  current_chunk_sequence = CASE
    WHEN coalesce(snapshot->>'chunkSequence', '') ~ '^[0-9]+$'
      THEN greatest(1, (snapshot->>'chunkSequence')::integer)
    ELSE current_chunk_sequence
  END,
  snapshot_updated_at = coalesce(snapshot_updated_at, updated_at);

ALTER TABLE print_queue_send_jobs
  ALTER COLUMN snapshot_updated_at SET NOT NULL;

ALTER TABLE print_queue_batch_job_items
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'print_queue_send_jobs_generation_nonnegative'
      AND conrelid = 'print_queue_send_jobs'::regclass
  ) THEN
    ALTER TABLE print_queue_send_jobs
      ADD CONSTRAINT print_queue_send_jobs_generation_nonnegative
      CHECK (generation >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'print_queue_send_jobs_chunk_sequence_positive'
      AND conrelid = 'print_queue_send_jobs'::regclass
  ) THEN
    ALTER TABLE print_queue_send_jobs
      ADD CONSTRAINT print_queue_send_jobs_chunk_sequence_positive
      CHECK (current_chunk_sequence >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'print_queue_batch_job_items_attempt_count_nonnegative'
      AND conrelid = 'print_queue_batch_job_items'::regclass
  ) THEN
    ALTER TABLE print_queue_batch_job_items
      ADD CONSTRAINT print_queue_batch_job_items_attempt_count_nonnegative
      CHECK (attempt_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'print_queue_batch_job_items_generation_nonnegative'
      AND conrelid = 'print_queue_batch_job_items'::regclass
  ) THEN
    ALTER TABLE print_queue_batch_job_items
      ADD CONSTRAINT print_queue_batch_job_items_generation_nonnegative
      CHECK (generation >= 0);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS print_queue_send_jobs_recovery_idx
  ON print_queue_send_jobs (
    status,
    (coalesce(heartbeat_at, updated_at)),
    generation
  )
  WHERE status IN ('pending', 'running', 'interrupted');
