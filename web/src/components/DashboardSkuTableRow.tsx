// PS-154: per-row presentational render for the SKU Performance Summary
// table, extracted VERBATIM from DashboardView.tsx so the parent's body
// map collapses to a thin <DashboardSkuTableRow .../> map. This component
// is PURELY presentational: it receives an already-computed row plus the
// already-resolved visible column metadata and the row's interaction
// callbacks. NO aggregation, NO money math, NO sorting/paging lives here
// — the parent still owns all of that and passes finished values in.
// (formatMoney/formatInt formatting runs inside each column's renderCell,
// which the parent owns via SKU_COLUMNS and hands over already resolved.)
import { Package, Search, Star } from 'lucide-react'
import HoverImage from './HoverImage'

export function DashboardSkuTableRow({
  row,
  columns,
  rowPadY,
  isFavorite,
  onToggleFavorite,
  onOpenProduct,
}: {
  // Already-computed DashboardSkuRow (typed loosely here; the parent owns the shape).
  row: any
  // Visible columns, already filtered + resolved to their SKU_COLUMNS
  // metadata in the parent. Each meta.renderCell is a pure display fn.
  columns: Array<{ key: string; meta: { align: 'left' | 'right'; renderCell: (row: any) => React.ReactNode } }>
  rowPadY: string
  isFavorite: boolean
  onToggleFavorite: () => void
  onOpenProduct: () => void
}) {
  return (
    <tr key={row.sku} className="border-b border-line last:border-b-0 hover:bg-brand-bg/30">
      {/* Favorite toggle — filled amber star when the
          SKU is in favoriteSkus, outline ink-3 otherwise.
          stopPropagation on the click prevents the row's
          hover/select behaviour from interpreting a star
          click as a row click. */}
      <td className={`px-3 ${rowPadY} overflow-hidden`}>
        {(() => {
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite()
              }}
              title={isFavorite ? 'Remove from favorites' : 'Mark as favorite'}
              aria-pressed={isFavorite}
              aria-label={isFavorite ? `Unfavorite ${row.sku}` : `Favorite ${row.sku}`}
              className={`inline-flex items-center justify-center w-6 h-6 rounded transition-all duration-150 hover:bg-amber-100/60 active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 ${
                isFavorite ? 'text-amber-400' : 'text-ink-3 hover:text-amber-400'
              }`}
            >
              <Star
                size={14}
                strokeWidth={2.25}
                fill={isFavorite ? 'currentColor' : 'none'}
              />
            </button>
          )
        })()}
      </td>
      {/* SKU cell — overflow-hidden + block truncate.
          Wrapping in a div with block + truncate makes
          the truncation engage inside the table-fixed
          cell box; long SKUs now ellipsize instead of
          bleeding into the Product column. */}
      <td className={`px-3 ${rowPadY} overflow-hidden`}>
        <div className="block truncate font-mono text-xs font-semibold text-brand">{row.sku}</div>
      </td>
      {/* Product cell — was bleeding into Store because
          the inner button had a hardcoded max-w-[320px]
          that ignored the actual column width, and the
          <td> itself had no overflow-hidden. Two fixes:
          (1) overflow-hidden on the <td>, (2) drop the
          hardcoded button max-w and let it size to its
          flex parent (`w-full min-w-0`). The inner span
          with `truncate` already has `min-w-0` on its
          flex-parent so it now truncates correctly when
          the column is narrow. */}
      <td className={`px-3 ${rowPadY} overflow-hidden`}>
        <button
          type="button"
          onClick={onOpenProduct}
          className="flex w-full min-w-0 items-center gap-2 text-left"
        >
          <span className="group relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-2">
            {row.imageUrl ? (
              <>
                <HoverImage
                  src={row.imageUrl}
                  alt=""
                  size={36}
                  previewSize={180}
                  radius={6}
                  title="Preview product image"
                />
                <span
                  className="pointer-events-none absolute inset-0 grid place-items-center bg-black/35 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                  aria-hidden="true"
                >
                  <Search size={14} strokeWidth={2.5} />
                </span>
              </>
            ) : (
              <Package size={15} strokeWidth={2.25} className="text-ink-3" />
            )}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block truncate text-xs font-semibold text-ink hover:text-brand">{row.product}</span>
          </span>
        </button>
      </td>
      {/* Body cells map over the same visibleColumnOrder
          as the header, so reorder + visibility changes
          flow through in a single pass. Each cell's
          content comes from the column's renderCell()
          defined in SKU_COLUMNS — no per-column
          conditional left to drift. */}
      {columns.map(({ key, meta }) => {
        return (
          <td
            key={key}
            className={`${meta.align === 'right' ? 'pr-4 pl-3 text-right' : 'px-3 text-left'} ${rowPadY} overflow-hidden`}
          >
            {meta.renderCell(row)}
          </td>
        )
      })}
      {/* Trend was rendered as a separate anchor <td>
          here — now flows through the map above via
          SKU_COLUMNS.trend.renderCell. */}
    </tr>
  )
}

export default DashboardSkuTableRow
