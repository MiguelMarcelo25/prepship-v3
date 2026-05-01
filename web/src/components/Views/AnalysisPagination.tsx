import './AnalysisDataTable.css'

interface AnalysisPaginationProps {
  page: number
  pageSize: number
  pageSizeOptions: number[]
  totalItems: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

function getVisiblePages(currentPage: number, totalPages: number) {
  const windowSize = 3
  const start = Math.max(1, Math.min(currentPage - 1, totalPages - windowSize + 1))
  const end = Math.min(totalPages, start + windowSize - 1)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

export function AnalysisPagination({
  page,
  pageSize,
  pageSizeOptions,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: AnalysisPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const firstItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const lastItem = Math.min(totalItems, currentPage * pageSize)
  const pageButtons = getVisiblePages(currentPage, totalPages)

  return (
    <div className="analysis-pagination" aria-label="Analysis table pagination">
      <div className="analysis-pagination-count">
        Showing <strong>{firstItem.toLocaleString()}-{lastItem.toLocaleString()}</strong> of{' '}
        <strong>{totalItems.toLocaleString()}</strong> SKUs
      </div>

      <div className="analysis-pagination-controls">
        <label className="analysis-pagination-size">
          Rows
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
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
          className="analysis-pagination-button"
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
        >
          First
        </button>
        <button
          type="button"
          className="analysis-pagination-button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
          Prev
        </button>
        <div className="analysis-pagination-pages">
          {pageButtons.map((pageNumber) => (
            <button
              key={pageNumber}
              type="button"
              className={`analysis-pagination-page${pageNumber === currentPage ? ' is-active' : ''}`}
              onClick={() => onPageChange(pageNumber)}
              aria-current={pageNumber === currentPage ? 'page' : undefined}
            >
              {pageNumber}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="analysis-pagination-button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
          Next
        </button>
        <button
          type="button"
          className="analysis-pagination-button"
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
        >
          Last
        </button>
      </div>
    </div>
  )
}
