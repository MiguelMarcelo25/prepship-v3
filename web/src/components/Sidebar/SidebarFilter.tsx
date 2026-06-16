import { IconSearch, IconX } from './sidebar-icons'

interface SidebarFilterProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}

export function SidebarFilter({
  value,
  onChange,
  placeholder = 'Search for the store...',
}: SidebarFilterProps) {
  return (
    <div className="px-4 pt-4 pb-2">
      <div className="flex h-9 w-full items-center rounded-lg bg-[var(--color-bg-muted)] px-3">
        <span className="shrink-0 text-[var(--color-text-tertiary)]">
          <IconSearch />
        </span>

        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="ml-2 flex-1 bg-transparent text-[13px] outline-none border-none shadow-none ring-0 focus:outline-none focus:border-none focus:shadow-none focus:ring-0"
          style={{ boxShadow: 'none' }}
        />

        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] outline-none focus:outline-none"
          >
            <IconX />
          </button>
        )}
      </div>
    </div>
  )
}
