// Recalculate All — the toolbar button's entire feature, in one small module.
//
// Simple by design (DJ requirement): ONE POST kicks the BACKEND best-rate
// backfill over every awaiting-shipment order (`maxAgeHours: 0` = refresh even
// fresh rates), and the backend owns everything from there — per-order rating,
// quote/key stamping (PS-174), persistence, and the per-row pending/rating
// states the table already renders via PS-120. The frontend only starts the
// job and polls its status line; no per-order loop, no rate logic here.
import { api } from '../../lib/api'

export type RecalculateAllJob = {
  jobId: string
  status: string
  processed?: number
  total?: number
  updated?: number
  skipped?: number
  failed?: number
  message?: string
}

export const FAST_RECALCULATE_MAX_AGE_HOURS = 6

function normalizeRecalculateAllJob(raw: Record<string, unknown>, fallbackJobId?: string): RecalculateAllJob | null {
  const jobId = typeof raw.jobId === 'string'
    ? raw.jobId
    : typeof raw.job_id === 'string'
      ? raw.job_id
      : fallbackJobId
  if (!jobId) return null
  return {
    jobId,
    status: String(raw.status ?? 'unknown'),
    processed: typeof raw.processed === 'number' ? raw.processed : undefined,
    total: typeof raw.total === 'number' ? raw.total : undefined,
    updated: typeof raw.updated === 'number' ? raw.updated : undefined,
    skipped: typeof raw.skipped === 'number' ? raw.skipped : undefined,
    failed: typeof raw.failed === 'number' ? raw.failed : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
  }
}

/** PS-347: normal Recalculate All is cache-first/fast, not force-live all rows. */
export async function startRecalculateAllBestRates(maxAgeHours = FAST_RECALCULATE_MAX_AGE_HOURS): Promise<{ jobId: string }> {
  const response = await api.post<{ job_id: string }>('/rates/backfill-best', {
    mode: 'cache_first',
    maxAgeHours,
  })
  return { jobId: response.job_id }
}

/** Explicit slow path for an operator-requested Full Live Recalculate audit. */
export async function startFullLiveRecalculateAllBestRates(): Promise<{ jobId: string }> {
  const response = await api.post<{ job_id: string }>('/rates/backfill-best', {
    mode: 'full_live_audit',
    maxAgeHours: 0,
  })
  return { jobId: response.job_id }
}

/** Poll the backend job. */
export async function fetchRecalculateAllJob(jobId: string): Promise<RecalculateAllJob> {
  const job = await api.get<Record<string, unknown>>(`/rates/backfill-best/status/${encodeURIComponent(jobId)}`)
  return normalizeRecalculateAllJob(job, jobId) ?? { jobId, status: 'unknown' }
}

/** Observe the backend/latest job started by sync/cron/manual paths without starting new rate work. */
export async function fetchLatestRecalculateAllJob(): Promise<RecalculateAllJob | null> {
  const payload = await api.get<{
    job?: Record<string, unknown> | null
    durableJob?: Record<string, unknown> | null
  }>('/rates/backfill-best/latest')
  const raw = payload.job && typeof payload.job === 'object'
    ? payload.job
    : payload.durableJob && typeof payload.durableJob === 'object'
      ? payload.durableJob
      : null
  return raw ? normalizeRecalculateAllJob(raw) : null
}

export function isRecalculateAllJobDone(job: RecalculateAllJob): boolean {
  return job.status !== 'pending' && job.status !== 'running' && job.status !== 'queued'
}

/** One short status line for the toolbar chip / completion toast. */
export function summarizeRecalculateAllJob(job: RecalculateAllJob): string {
  const progress =
    job.processed != null && job.total != null ? `${job.processed}/${job.total}` : job.status
  const updated = job.updated != null ? ` · ${job.updated} updated` : ''
  const failed = job.failed ? ` · ${job.failed} failed` : ''
  return `${progress}${updated}${failed}`
}
