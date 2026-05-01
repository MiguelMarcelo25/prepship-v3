interface AnalysisPaginationProps {
  page: number
  pageSize: number
  pageSizeOptions: number[]
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  unitLabel?: string
  ariaLabel?: string
}

function getVisiblePages(currentPage: number, totalPages: number) {
  const windowSize = 3
  const start = Math.max(1, Math.min(currentPage - 1, totalPages - windowSize + 1))
  const end = Math.min(totalPages, start + windowSize - 1)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

const BTN_BASE =
  'min-w-[30px] h-7 border border-line-2 rounded-md bg-surface text-ink-2 cursor-pointer text-[12px] font-bold transition-colors duration-150'
const BTN_HOVER = 'hover:border-[rgba(42,91,215,.45)] hover:text-brand hover:bg-[#eef4ff]'
const BTN_DISABLED = 'disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-surface disabled:hover:text-ink-2 disabled:hover:border-line-2'

export function AnalysisPagination({
  page,
  pageSize,
  pageSizeOptions,
  totalItems,
  onPageChange,
  onPageSizeChange,
  unitLabel = 'SKUs',
  ariaLabel = 'Table pagination',
}: AnalysisPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const firstItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const lastItem = Math.min(totalItems, currentPage * pageSize)
  const pageButtons = getVisiblePages(currentPage, totalPages)

  return (
    <div
      className="flex items-center justify-between gap-3 pt-2.5 pb-0.5 px-0.5 text-ink-3 text-[12px] max-[900px]:flex-col max-[900px]:items-start"
      aria-label={ariaLabel}
    >
      <div>
        Showing <strong className="text-ink font-extrabold">{firstItem.toLocaleString()}-{lastItem.toLocaleString()}</strong> of{' '}
        <strong className="text-ink font-extrabold">{totalItems.toLocaleString()}</strong> {unitLabel}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap justify-end max-[900px]:justify-start">
        <label className="inline-flex items-center gap-1.5 mr-1 text-ink-3 font-bold">
          Rows
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            className="h-7 border border-line-2 rounded-md bg-surface text-ink text-[12px] pl-2 pr-6"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`${BTN_BASE} ${BTN_HOVER} ${BTN_DISABLED} px-2.5`}
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
        >
          First
        </button>
        <button
          type="button"
          className={`${BTN_BASE} ${BTN_HOVER} ${BTN_DISABLED} px-2.5`}
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
          Prev
        </button>
        <div className="flex items-center gap-1">
          {pageButtons.map((pageNumber) => {
            const isActive = pageNumber === currentPage
            return (
              <button
                key={pageNumber}
                type="button"
                className={`${BTN_BASE} ${
                  isActive
                    ? 'border-brand bg-brand text-white hover:bg-brand hover:text-white hover:border-brand'
                    : BTN_HOVER
                }`}
                onClick={() => onPageChange(pageNumber)}
                aria-current={isActive ? 'page' : undefined}
              >
                {pageNumber}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className={`${BTN_BASE} ${BTN_HOVER} ${BTN_DISABLED} px-2.5`}
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
          Next
        </button>
        <button
          type="button"
          className={`${BTN_BASE} ${BTN_HOVER} ${BTN_DISABLED} px-2.5`}
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
        >
          Last
        </button>
      </div>
    </div>
  )
}
