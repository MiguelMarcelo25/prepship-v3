-- Audit 3.5 / PQ-4: per-job durable PDF-merge metadata.
-- This sidecar stores workflow state only; it never mutates orders, shipments,
-- labels, postage, or marketplace confirmation state.

CREATE TABLE IF NOT EXISTS print_queue_merge_jobs (
  job_id text PRIMARY KEY,
  status text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  client_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  current integer NOT NULL DEFAULT 0,
  message text,
  file_name text,
  error_message text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS print_queue_merge_jobs_updated_at_idx
  ON print_queue_merge_jobs (updated_at DESC);

ALTER TABLE print_queue_merge_jobs ENABLE ROW LEVEL SECURITY;
