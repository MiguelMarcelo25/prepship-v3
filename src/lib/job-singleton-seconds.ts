/**
 * PS-265 — pg-boss singleton (throttle) window for a cadence job.
 *
 * pg-boss REJECTS a job whose singletonSeconds exceeds its archive interval
 * (default 12h = 43200s) with "throttling interval cannot exceed archive
 * interval". The previous formula (intervalMs/1000 - 5) produced 86395s for the
 * DAILY walmart-fees job (86400s) — above 43200 — so that job could NEVER enqueue.
 *
 * The singleton window only needs to dedupe overlapping cadence ticks, so cap it
 * well below the archive interval. Sub-6h jobs are unaffected (their window is
 * already < the cap); only the daily job is clamped.
 */
export const PGBOSS_ARCHIVE_SECONDS = 43_200; // pg-boss default archive interval (12h)
export const MAX_SINGLETON_SECONDS = 6 * 60 * 60; // 21600s — safely below the archive interval

export function jobSingletonSeconds(intervalMs: number): number {
  return Math.max(30, Math.min(MAX_SINGLETON_SECONDS, Math.floor(intervalMs / 1000) - 5));
}
