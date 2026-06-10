// Per-section size toggle. Three buttons (Compact / Standard / Wide)
// shown in the header of each major dashboard panel. The active
// preset gets the brand-blue treatment; the others stay quiet so
// the toggle doesn't dominate the section's actual content.
// Tooltips on each button explain what the size does ("Compact:
// 1/3 width" etc.) so the abbreviation icons aren't mystery
// characters.
export function SectionSizeToggle({
  value,
  onChange,
}: {
  value: 'compact' | 'standard' | 'wide'
  onChange: (size: 'compact' | 'standard' | 'wide') => void
}) {
  const options: Array<{ key: 'compact' | 'standard' | 'wide'; label: string; symbol: string; title: string }> = [
    { key: 'compact',  label: '⅓',     symbol: '⅓', title: 'Compact — 1/3 width' },
    { key: 'standard', label: '⅔',     symbol: '⅔', title: 'Standard — 2/3 width' },
    { key: 'wide',     label: 'Full',  symbol: '◼',  title: 'Wide — full width' },
  ]
  return (
    <div
      // PS mobile: the ⅓/⅔/Full control only changes the xl column span, which
      // has no effect on the single-column phone/tablet layout — hide it below
      // xl so panel headers aren't cluttered with a no-op control.
      className="hidden items-center gap-0.5 rounded-md ring-1 ring-line p-0.5 bg-surface xl:inline-flex"
      role="group"
      aria-label="Resize this panel"
    >
      {options.map((opt) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            title={opt.title}
            aria-pressed={active}
            className={`inline-flex h-6 min-w-[28px] items-center justify-center rounded px-1.5 text-[11px] font-extrabold tabular-nums transition ${
              active
                ? 'bg-brand text-white shadow-sm'
                : 'text-ink-3 hover:text-ink hover:bg-surface-2'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

export default SectionSizeToggle
