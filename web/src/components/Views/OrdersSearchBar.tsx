// PS-166 (Wave 2b): the Orders filter-bar search control, extracted from
// OrdersView.tsx with BYTE-IDENTICAL markup (ids #searchInput/#searchClear,
// placeholder, classes, and the PS-210 global-search pill are pinned by the
// e2e suites and the ps-210 guard). Render-only: OrdersView keeps the search
// state (it lives in Home) and passes the same props the inline JSX read.
import { Search as SearchIcon, X as XIcon } from 'lucide-react'

export function OrdersSearchBar({
  searchQuery,
  onSearchQueryChange,
  dateRange,
}: {
  searchQuery: string
  onSearchQueryChange?: (value: string) => void
  dateRange: { start?: string; end?: string }
}) {
  return (
    <>
      {/* Search input with icon + clear */}
      <div className="relative flex-1 min-w-[200px] max-w-[340px]">
        <SearchIcon
          size={13}
          strokeWidth={2.25}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
          aria-hidden
        />
        <input
          type="text"
          id="searchInput"
          placeholder="Search orders, SKUs, names…"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange?.(event.target.value)}
          className={`
            w-full h-8 pl-8 pr-7
            rounded-lg
            bg-surface-2 ring-1 ring-line
            text-[12.5px] text-ink placeholder:text-ink-3
            focus:bg-surface focus:ring-2 focus:ring-brand/40
            focus:outline-none
            transition-all duration-150
            ${searchQuery.trim() ? 'ring-brand/60 bg-brand-bg/40' : ''}
          `}
          title={searchQuery.trim() ? 'Global search — looking across all statuses & stores' : undefined}
        />
        {searchQuery ? (
          <button
            id="searchClear"
            type="button"
            onClick={() => onSearchQueryChange?.('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md flex items-center justify-center text-ink-3 hover:text-ink hover:bg-line/40 active:scale-90 transition-all duration-150"
          >
            <XIcon size={11} strokeWidth={2.5} />
          </button>
        ) : null}
      </div>

      {/* Global-search hint pill — only appears while a search is
          active. Tells the operator the search is scanning every
          status + store, not just the currently-active tab, so a
          hit in 'Shipped' isn't a surprise when they're on
          'Awaiting'. The pill is muted enough to not steal focus
          but explicit enough to set the right mental model. */}
      {searchQuery.trim() ? (
        <div className="inline-flex items-center gap-1 h-7 px-2 rounded-full bg-brand-bg ring-1 ring-brand/40 text-brand text-[10.5px] font-semibold whitespace-nowrap">
          <span aria-hidden>🌐</span>
          {/* PS-210: this claim is now TRUE — the backend widens search
              across Awaiting/Shipped/Cancelled and drops store scoping.
              Date + Hide-Test filters intentionally still apply, so say
              so instead of overclaiming. */}
          <span>
            Searching all statuses &amp; stores
            {dateRange.start || dateRange.end ? ' · in date range' : ''}
          </span>
        </div>
      ) : null}
    </>
  )
}
