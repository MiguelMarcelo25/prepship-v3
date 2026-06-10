// Top-N dropdown — surfaced in the Top SKUs and Heatmap panel headers
// so operators can pick how many ranked rows to show. Uses a styled
// native <select> (small, themed) instead of a custom popover so it
// inherits OS / keyboard / accessibility behavior for free. The
// onChange handler always returns a value from the fixed set, so
// callers can keep their state strongly typed.
export function TopNDropdown({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: number
  onChange: (next: number) => void
  options: readonly number[]
  ariaLabel: string
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-2xs font-bold text-ink-3">
      <span className="hidden sm:inline">Show</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        className="h-7 cursor-pointer rounded-md border border-line bg-surface px-1.5 pr-5 text-2xs font-extrabold text-ink outline-none ring-0 transition hover:bg-surface-2 focus:border-brand focus:ring-1 focus:ring-brand"
      >
        {options.map((n) => (
          <option key={n} value={n}>Top {n}</option>
        ))}
      </select>
    </label>
  )
}

export default TopNDropdown
