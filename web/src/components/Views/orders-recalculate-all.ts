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

/** Kick the backend backfill over ALL awaiting orders. Returns the job id. */
// PS-293: maxAgeHours selects the backend rating mode. 0 = the manual "Recalculate All" force-live
// fan-out (re-rate every awaiting order). A POSITIVE value is the cache-friendly passive backfill the
// Awaiting page uses for its overflow rows: re-rate only stale/missing rows and reuse fresh cache, so
// auto-triggering it on page load never force-live-re-rates the whole table.
export async function startRecalculateAllBestRates(maxAgeHours = 0): Promise<{ jobId: string }> {
  const response = await api.post<{ job_id: string }>('/rates/backfill-best', { maxAgeHours })
  return { jobId: response.job_id }
}

/** Poll the backend job. */
export async function fetchRecalculateAllJob(jobId: string): Promise<RecalculateAllJob> {
  const job = await api.get<Record<string, unknown>>(`/rates/backfill-best/status/${encodeURIComponent(jobId)}`)
  return {
    jobId,
    status: String(job.status ?? 'unknown'),
    processed: typeof job.processed === 'number' ? job.processed : undefined,
    total: typeof job.total === 'number' ? job.total : undefined,
    updated: typeof job.updated === 'number' ? job.updated : undefined,
    skipped: typeof job.skipped === 'number' ? job.skipped : undefined,
    failed: typeof job.failed === 'number' ? job.failed : undefined,
    message: typeof job.message === 'string' ? job.message : undefined,
  }
}

export function isRecalculateAllJobDone(job: RecalculateAllJob): boolean {
  return job.status !== 'running' && job.status !== 'queued'
}

/** One short status line for the toolbar chip / completion toast. */
export function summarizeRecalculateAllJob(job: RecalculateAllJob): string {
  const progress =
    job.processed != null && job.total != null ? `${job.processed}/${job.total}` : job.status
  const updated = job.updated != null ? ` · ${job.updated} updated` : ''
  const failed = job.failed ? ` · ${job.failed} failed` : ''
  return `${progress}${updated}${failed}`
}
