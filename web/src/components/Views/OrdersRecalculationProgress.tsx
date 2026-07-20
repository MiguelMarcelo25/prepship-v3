export type OrdersRecalculationProgressProps = {
  kind: 'all' | 'selected'
  label: string
  percent: number | null
  completed: number
  remaining: number | null
  total: number | null
  detail: string
  statusMessage?: string
  tone?: 'default' | 'success' | 'error'
}

/** Shared compact progress pattern for Recalculate All and Recalculate Selected. */
export function OrdersRecalculationProgress({
  kind,
  label,
  percent,
  completed,
  remaining,
  total,
  detail,
  statusMessage,
  tone = 'default',
}: OrdersRecalculationProgressProps) {
  const determinate = percent != null
  const toneClasses = tone === 'error'
    ? 'ring-danger/40 text-danger'
    : tone === 'success'
      ? 'ring-ok/40 text-ok'
      : 'ring-line text-ink-2'
  const fillClasses = tone === 'error'
    ? 'bg-danger'
    : tone === 'success'
      ? 'bg-ok'
      : 'bg-brand'
  const totalLabel = total == null ? '—' : total.toLocaleString()
  const remainingLabel = remaining == null ? '—' : remaining.toLocaleString()
  const ariaValueText = determinate
    ? `${percent}% complete. Completed ${completed} of ${totalLabel}. Remaining ${remainingLabel}.`
    : statusMessage ?? label

  return (
    <div
      data-recalculate-all-progress={kind === 'all' ? '' : undefined}
      data-batch-recalculate-progress={kind === 'selected' ? '' : undefined}
      role="status"
      aria-live="polite"
      className={`flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-surface-2 px-2.5 py-1.5 ring-1 text-[11px] ${toneClasses}`}
      title={statusMessage ?? label}
    >
      <span className="max-w-48 truncate font-semibold text-ink" title={label}>{label}</span>
      <span className="w-8 text-right font-mono font-semibold tabular-nums">
        {determinate ? `${percent}%` : '···'}
      </span>
      <span
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
        aria-valuetext={ariaValueText}
        className="relative h-1.5 w-20 overflow-hidden rounded-full bg-line"
      >
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-200 ${fillClasses} ${determinate ? '' : 'w-2/5 animate-pulse'}`}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </span>
      <span className="whitespace-nowrap font-mono tabular-nums text-ink-2">
        Completed {completed.toLocaleString()}
      </span>
      <span className="whitespace-nowrap font-mono tabular-nums text-ink-2">
        Remaining {remainingLabel}
      </span>
      <span className="whitespace-nowrap font-mono tabular-nums text-ink-2">
        Total {totalLabel}
      </span>
      {detail ? <span className="whitespace-nowrap text-ink-3">{detail}</span> : null}
      {statusMessage ? (
        <span className="min-w-0 basis-full truncate text-ink-3" title={statusMessage}>
          {statusMessage}
        </span>
      ) : null}
    </div>
  )
}
