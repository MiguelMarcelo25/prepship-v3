export type RecalculateAllRequestSource =
  | 'manual'
  | 'rate-on-ingest'
  | 'targeted-order-change'
  | 'cadence'

export type RecalculateAllJob = {
  jobId: string
  status: string
  mode?: 'manual_force_live' | 'cache_friendly'
  requestedBy?: RecalculateAllRequestSource
  processed?: number
  total?: number
  updated?: number
  skipped?: number
  failed?: number
  message?: string
  error?: string | null
}

export type RecalculateAllProgressState = {
  job: RecalculateAllJob | null
  preparingMessage?: string
  statusError?: string
}

export type RecalculateAllProgressView = {
  label: string
  percent: number | null
  completed: number
  remaining: number | null
  total: number | null
  updated: number
  skipped: number
  failed: number
  statusMessage: string
  tone: 'default' | 'success' | 'error'
}

const REQUEST_SOURCES = new Set<RecalculateAllRequestSource>([
  'manual',
  'rate-on-ingest',
  'targeted-order-change',
  'cadence',
])

export function isRecalculateAllRequestSource(value: unknown): value is RecalculateAllRequestSource {
  return typeof value === 'string' && REQUEST_SOURCES.has(value as RecalculateAllRequestSource)
}

function toCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? 0)) : 0
}

/** Only operator-started durable jobs may restore the visible toolbar progress after refresh. */
export function isManualRecalculateAllJob(job: RecalculateAllJob): boolean {
  return job.requestedBy === 'manual'
}

/**
 * PS-438 display-only projection of the backend job snapshot. The backend owns
 * every counter and terminal status; this helper only formats those values for
 * the toolbar and deliberately refuses to show 100% before a complete snapshot.
 */
export function buildRecalculateAllProgressView(
  state: RecalculateAllProgressState,
): RecalculateAllProgressView {
  const job = state.job
  if (!job) {
    return {
      label: 'Preparing recalculation',
      percent: null,
      completed: 0,
      remaining: null,
      total: null,
      updated: 0,
      skipped: 0,
      failed: 0,
      statusMessage: state.statusError ?? state.preparingMessage ?? 'Preparing recalculation',
      tone: state.statusError ? 'error' : 'default',
    }
  }

  const completed = toCount(job.processed)
  const backendTotal = typeof job.total === 'number' && Number.isFinite(job.total)
    ? toCount(job.total)
    : null
  const active = job.status === 'pending' || job.status === 'running' || job.status === 'queued'
  // The backend initializes total=0 before its selection query finishes. Treat
  // that active snapshot as unknown; a terminal zero-total snapshot is real.
  const total = active && backendTotal === 0 ? null : backendTotal
  const remaining = total == null ? null : Math.max(total - completed, 0)
  const backendComplete = job.status === 'done'
  const reachedTerminalCount = total != null && completed >= total
  const complete = backendComplete && reachedTerminalCount
  const incompleteTerminal = backendComplete && !reachedTerminalCount
  const interrupted = job.status === 'error' || job.status === 'unknown' || incompleteTerminal
  const backendMessage = job.error?.trim() || job.message?.trim() || null
  const actionableInterruptedMessage = backendMessage
    ? `${backendMessage}${/\bretry\b/i.test(backendMessage) ? '' : ' Retry recalculation.'}`
    : 'Recalculation interrupted. Retry the job.'

  let percent: number | null = null
  if (complete) {
    percent = 100
  } else if (total != null && total > 0) {
    // An active snapshot at total/total can still be finalizing. Reserve 100%
    // for a backend `done` snapshot whose processed count reached the total.
    percent = Math.min(99, Math.floor((completed / total) * 100))
  }

  const statusMessage = state.statusError
    ?? (incompleteTerminal
      ? 'Backend stopped before every item was processed. Retry recalculation.'
      : interrupted
        ? actionableInterruptedMessage
        : backendMessage)
    ?? (complete
      ? 'Rate recalculation complete'
      : total == null || total === 0
          ? state.preparingMessage ?? 'Preparing recalculation'
          : 'Recalculating best rates')

  return {
    label: state.statusError
      ? 'Status unavailable'
      : complete
        ? 'Recalculation complete'
        : interrupted
          ? 'Recalculation needs attention'
          : total == null || total === 0
            ? 'Preparing recalculation'
            : 'Recalculating all',
    percent,
    completed,
    remaining,
    total,
    updated: toCount(job.updated),
    skipped: toCount(job.skipped),
    failed: toCount(job.failed),
    statusMessage,
    tone: state.statusError || interrupted ? 'error' : complete ? 'success' : 'default',
  }
}
