// @ts-nocheck
import { IconSearch, IconX } from './sidebar-icons'

interface SidebarSearchProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}

export function SidebarSearch({
  value,
  onChange,
  placeholder = 'Search orders, SKUs, names…',
}: SidebarSearchProps) {
  return (
    <div className="px-4 pt-5 pb-2">
      <div className="relative h-11 w-full">
        <span className="pointer-events-none absolute left-4 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center text-[var(--color-text-muted)]">
          <IconSearch />
        </span>

        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full rounded-xl border border-transparent bg-[var(--color-bg-muted)] pl-11 pr-10 text-[13.5px] text-[var(--color-text-primary)] outline-none transition placeholder:text-[var(--color-text-muted)] focus:border-indigo-500 focus:bg-[var(--color-bg-surface)] focus:shadow-[0_0_0_4px_rgb(99_102_241/0.12)]"
        />

        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]"
          >
            <IconX />
          </button>
        )}
      </div>
    </div>
  )
}
