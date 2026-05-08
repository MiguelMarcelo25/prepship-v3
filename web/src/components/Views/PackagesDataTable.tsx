// @ts-nocheck
import { Fragment, useRef, type MutableRefObject, type ReactNode } from 'react'
import { ArrowUpDown, BadgeDollarSign, ChevronDown, ChevronUp, PackagePlus, PencilLine, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { PackageDto, PackageLedgerEntryDto } from '../../types/api'
import {
  formatPackageDimensionsText,
  formatPackageLedgerDate,
  formatPackageUnitCost,
} from './packages-parity'
import { ColumnResizeHandle } from './ColumnResizeHandle'

export type PackagesColumnKey = 'package' | 'stock' | 'usage30' | 'reorder' | 'cost' | 'actions'
export type PackagesSortKey = Exclude<PackagesColumnKey, 'actions'>
export type PackagesSortDirection = 'asc' | 'desc'
export interface PackagesSortState {
  key: PackagesSortKey
  direction: PackagesSortDirection
}
export type PackagesColumnWidths = Partial<Record<PackagesColumnKey, number>>

const PACKAGES_COLUMNS_ORDER: PackagesColumnKey[] = ['package', 'stock', 'usage30', 'reorder', 'cost', 'actions']
const PACKAGES_COLUMN_DEFAULTS: Record<PackagesColumnKey, number | undefined> = {
  package: undefined,
  stock: 88,
  usage30: 112,
  reorder: 116,
  cost: 112,
  actions: 174,
}
const PACKAGES_MIN_COLUMN_WIDTH = 56

export interface LedgerState {
  open: boolean
  loading: boolean
  error: string | null
  rows: PackageLedgerEntryDto[]
}

interface PackagesDataTableProps {
  packages: PackageDto[]
  ledgerByPackageId: Record<number, LedgerState>
  reorderInputs: Record<number, string>
  highlightedPackageId: number | null
  rowRefs: MutableRefObject<Record<number, HTMLTableRowElement | null>>
  onToggleLedger: (packageId: number) => void
  onReorderInputChange: (packageId: number, value: string) => void
  onSaveReorderLevel: (pkg: PackageDto) => void
  onReceive: (pkg: PackageDto) => void
  onAdjust: (pkg: PackageDto) => void
  onEdit: (packageId: number) => void
  onSetBillingDefault: (pkg: PackageDto) => void
  onDelete: (packageId: number) => void
  onOpenOrder?: (orderId: number) => void
  onOpenOrderByNumber?: (orderNumber: string) => void
  sectionTitle?: string
  columnWidths?: PackagesColumnWidths
  onResizeColumn?: (key: PackagesColumnKey, width: number) => void
  onResetColumn?: (key: PackagesColumnKey) => void
  usageByPackageId?: Record<number, number | null>
  usageLoading?: boolean
  sortState?: PackagesSortState | null
  onSortChange?: (key: PackagesSortKey) => void
}

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

function stockTone(pkg: PackageDto) {
  const qty = Number(pkg.stockQty ?? 0)
  const reorderLevel = Number(pkg.reorderLevel ?? 10)
  if (qty <= 0) return 'text-danger'
  if (qty <= reorderLevel) return 'text-warn'
  return 'text-ok'
}

function alignClass(align: 'left' | 'center' | 'right') {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

function justifyClass(align: 'left' | 'center' | 'right') {
  if (align === 'center') return 'justify-center'
  if (align === 'right') return 'justify-end'
  return 'justify-start'
}

function renderUsageValue(value: number | null | undefined, loading?: boolean) {
  if (value == null) {
    return <span className="text-tiny font-semibold text-ink-3">{loading ? '...' : '-'}</span>
  }
  if (value === 0) {
    return <span className="text-tiny font-semibold text-ink-3">0</span>
  }
  return (
    <span className="inline-flex items-baseline gap-1 text-[13px] font-extrabold text-ink">
      {value.toLocaleString()}
      <span className="text-[9.5px] font-bold uppercase tracking-[0.04em] text-ink-3">used</span>
    </span>
  )
}

type ActionTone = 'receive' | 'adjust' | 'edit' | 'billing' | 'delete'

const actionToneClasses: Record<ActionTone, string> = {
  receive: 'border-ok-border bg-ok-bg text-ok hover:border-ok hover:bg-ok hover:text-white hover:shadow-[0_6px_14px_rgba(22,163,74,.18)]',
  adjust: 'border-brand-border bg-brand-bg text-brand hover:border-brand hover:bg-brand hover:text-white hover:shadow-[0_6px_14px_rgba(42,91,215,.18)]',
  edit: 'border-[#fed7aa] bg-[#fff7ed] text-[#ea580c] hover:border-[#f97316] hover:bg-[#f97316] hover:text-white hover:shadow-[0_6px_14px_rgba(249,115,22,.18)]',
  billing: 'border-[#ddd6fe] bg-[#f5f3ff] text-[#7c3aed] hover:border-[#7c3aed] hover:bg-[#7c3aed] hover:text-white hover:shadow-[0_6px_14px_rgba(124,58,237,.18)]',
  delete: 'border-danger-border bg-danger-bg text-danger hover:border-danger hover:bg-danger hover:text-white hover:shadow-[0_6px_14px_rgba(220,38,38,.18)]',
}

function ActionButton({
  label,
  tone,
  onClick,
  children,
}: {
  label: string
  tone: ActionTone
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-[7px] border transition duration-150',
        'shadow-[inset_0_1px_0_rgba(255,255,255,.65)] hover:-translate-y-px active:translate-y-0 active:shadow-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25',
        actionToneClasses[tone],
      )}
    >
      {children}
    </button>
  )
}

// The package_ledger.note column stores the reason text. The two
// patterns the backend writes are:
//   "Shipment <id> for order <orderNumber>"   (label deduction)
//   "Order <orderNumber> / shipment <id>"     (manifest-side accounting)
// In both cases the orderNumber follows the literal "order " token and
// continues until whitespace. Marketplace IDs have no spaces inside,
// so a simple `\S+` is reliable.
//
// We split the reason text on the first match and wrap the captured
// orderNumber in a clickable link styled to look like a normal anchor
// (blue, underlined). Click invokes `onOpenOrderByNumber(orderNumber)`
// — the handler does the lookup → openOrder(localId) hop. Falls back
// to plain text when no order pattern is present (e.g. manual notes
// like "received from supplier").
const ORDER_REF_RE = /\border\s+(\S+)/i

function renderLedgerReason(
  reason: string | null | undefined,
  onOpenOrderByNumber: ((orderNumber: string) => void) | undefined,
): ReactNode {
  if (!reason) return '-'
  if (!onOpenOrderByNumber) return reason
  const match = ORDER_REF_RE.exec(reason)
  if (!match || typeof match.index !== 'number') return reason
  const orderNumber = match[1]
  // Strip a trailing period or comma if present — note text could be
  // something like "...for order 12345.". We keep the punctuation in
  // the `after` slice so the visible text is unchanged.
  const cleanedNumber = orderNumber.replace(/[.,;:]+$/, '')
  if (!cleanedNumber) return reason
  const numberStart = match.index + match[0].length - orderNumber.length
  const before = reason.slice(0, numberStart)
  const after = reason.slice(numberStart + cleanedNumber.length)
  return (
    <>
      {before}
      <button
        type="button"
        // Match the existing #orderId link styling on the right column
        // so the two link targets feel consistent.
        className="font-semibold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark"
        onClick={() => onOpenOrderByNumber(cleanedNumber)}
        title={`Open order ${cleanedNumber}`}
      >
        {cleanedNumber}
      </button>
      {after}
    </>
  )
}

export function PackagesDataTable({
  packages,
  ledgerByPackageId,
  reorderInputs,
  highlightedPackageId,
  rowRefs,
  onToggleLedger,
  onReorderInputChange,
  onSaveReorderLevel,
  onReceive,
  onAdjust,
  onEdit,
  onSetBillingDefault,
  onDelete,
  onOpenOrder,
  onOpenOrderByNumber,
  sectionTitle = 'Custom Packages',
  columnWidths,
  onResizeColumn,
  onResetColumn,
  usageByPackageId,
  usageLoading,
  sortState,
  onSortChange,
}: PackagesDataTableProps) {
  const thRefs = useRef<Partial<Record<PackagesColumnKey, HTMLTableCellElement | null>>>({})

  const columnStyle = (key: PackagesColumnKey) => {
    const overrideWidth = columnWidths?.[key]
    if (overrideWidth) {
      return { width: overrideWidth, minWidth: overrideWidth, maxWidth: overrideWidth }
    }
    const defaultWidth = PACKAGES_COLUMN_DEFAULTS[key]
    if (defaultWidth != null) return { width: defaultWidth, minWidth: defaultWidth }
    return {}
  }

  const renderHeader = (
    key: PackagesColumnKey,
    label: string,
    align: 'left' | 'center' | 'right',
  ) => {
    const isLast = key === PACKAGES_COLUMNS_ORDER[PACKAGES_COLUMNS_ORDER.length - 1]
    const overrideWidth = columnWidths?.[key]
    const sortable = key !== 'actions' && Boolean(onSortChange)
    const sortKey = key as PackagesSortKey
    const isSorted = sortable && sortState?.key === sortKey
    const SortIcon = isSorted
      ? sortState?.direction === 'asc'
        ? ChevronUp
        : ChevronDown
      : ArrowUpDown

    return (
      <th
        ref={(node) => { thRefs.current[key] = node }}
        scope="col"
        aria-sort={isSorted ? (sortState?.direction === 'asc' ? 'ascending' : 'descending') : undefined}
        style={columnStyle(key)}
        className={cn(
          '!sticky !top-9 !z-[70] !bg-surface-3',
          'border-b-2 border-line px-4 py-3 text-2xs font-extrabold uppercase tracking-[0.05em] text-ink-3',
          'shadow-[0_1px_0_rgba(225,228,232,1)]',
          alignClass(align),
        )}
      >
        {sortable ? (
          <button
            type="button"
            className={cn(
              'inline-flex w-full items-center gap-1.5 rounded-[6px] text-2xs font-extrabold uppercase tracking-[0.05em] transition',
              'text-ink-3 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25',
              justifyClass(align),
            )}
            onClick={() => onSortChange?.(sortKey)}
          >
            <span>{label}</span>
            <SortIcon size={12} strokeWidth={2.4} className={isSorted ? 'text-brand' : 'text-ink-4'} />
          </button>
        ) : (
          <span>{label}</span>
        )}
        {!isLast && onResizeColumn ? (
          <ColumnResizeHandle
            getStartWidth={() => {
              if (overrideWidth) return overrideWidth
              const node = thRefs.current[key]
              return node ? node.getBoundingClientRect().width : (PACKAGES_COLUMN_DEFAULTS[key] ?? PACKAGES_MIN_COLUMN_WIDTH)
            }}
            onChange={(width) => onResizeColumn(key, Math.round(width))}
            onReset={onResetColumn ? () => onResetColumn(key) : undefined}
            minWidth={PACKAGES_MIN_COLUMN_WIDTH}
            className="absolute -right-1 top-0 z-10 block h-full w-2 cursor-col-resize select-none border-r-2 border-transparent hover:border-brand active:border-brand"
          />
        ) : null}
      </th>
    )
  }

  const renderLedger = (pkg: PackageDto, ledger: LedgerState) => (
    <tr>
      <td colSpan={PACKAGES_COLUMNS_ORDER.length} className="border-b border-line bg-surface-2 px-4 py-3">
        <div className="overflow-hidden rounded-card border border-line bg-white">
          {ledger.loading ? (
            <div className="px-3 py-3 text-xs2 font-medium text-ink-3">Loading...</div>
          ) : ledger.error ? (
            <div className="px-3 py-3 text-xs2 font-semibold text-danger">Failed to load</div>
          ) : ledger.rows.length === 0 ? (
            <div className="px-3 py-3 text-xs2 font-medium text-ink-3">No history yet</div>
          ) : (
            <>
              <div className="grid grid-cols-[140px_90px_120px_minmax(180px,1fr)_110px] border-b border-line bg-surface-2 px-3 py-2 text-2xs font-bold uppercase tracking-[0.04em] text-ink-3">
                <div>Date</div>
                <div className="text-center">Change</div>
                <div className="text-right">Cost/unit</div>
                <div className="pl-4">Reason</div>
                <div>Order</div>
              </div>
              {ledger.rows.map((row) => (
                <div
                  key={`${pkg.packageId}-${row.id ?? row.createdAt}`}
                  className="grid grid-cols-[140px_90px_120px_minmax(180px,1fr)_110px] border-b border-line px-3 py-2 text-xs2 text-ink-2 last:border-b-0 hover:bg-brand-bg/40"
                >
                  <div className="whitespace-nowrap">{formatPackageLedgerDate(row.createdAt)}</div>
                  <div className={cn('text-center font-extrabold', row.delta > 0 ? 'text-ok' : 'text-danger')}>
                    {row.delta > 0 ? '+' : ''}
                    {row.delta}
                  </div>
                  <div className="text-right font-mono text-ink-3">{formatPackageUnitCost(row.unitCost)}</div>
                  <div className="pl-4">
                    {renderLedgerReason(row.reason, onOpenOrderByNumber)}
                  </div>
                  <div>
                    {row.orderId ? (
                      <button
                        type="button"
                        className="font-semibold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark"
                        onClick={() => onOpenOrder?.(row.orderId as number)}
                      >
                        #{row.orderId}
                      </button>
                    ) : '-'}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </td>
    </tr>
  )

  return (
    <div className="relative rounded-card border border-line bg-white shadow-sm">
      <table className="w-full table-fixed border-separate border-spacing-0 text-sm2">
        <thead className="relative z-50">
          <tr>
            <th
              colSpan={PACKAGES_COLUMNS_ORDER.length}
              scope="colgroup"
              className="!sticky !top-0 !z-[80] h-9 rounded-t-card border-b border-line !bg-brand-bg px-4 text-left text-2xs font-extrabold uppercase tracking-[0.05em] text-ink-3 shadow-[0_1px_0_rgba(225,228,232,1)]"
            >
              {sectionTitle}
            </th>
          </tr>
          <tr>
            {renderHeader('package', 'Package', 'left')}
            {renderHeader('stock', 'Stock', 'center')}
            {renderHeader('usage30', '30d Used', 'center')}
            {renderHeader('reorder', 'Reorder', 'center')}
            {renderHeader('cost', 'Cost', 'right')}
            {renderHeader('actions', 'Actions', 'right')}
          </tr>
        </thead>
        <tbody>
          {packages.map((pkg) => {
            const ledger = ledgerByPackageId[pkg.packageId]
            const highlighted = highlightedPackageId === pkg.packageId

            return (
              <Fragment key={pkg.packageId ?? pkg.id ?? pkg.name}>
                <tr
                  ref={(el) => { rowRefs.current[pkg.packageId] = el }}
                  id={`pkg-row-${pkg.packageId}`}
                  className={cn(
                    'group transition-colors',
                    highlighted
                      ? 'bg-warn-bg shadow-[inset_3px_0_0_#f59e0b]'
                      : 'odd:bg-white even:bg-surface-2 hover:bg-brand-bg/60',
                  )}
                >
                  <td className="border-b border-line px-4 py-3 align-middle">
                    <button
                      type="button"
                      className="block max-w-full truncate text-left text-[13px] font-extrabold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark"
                      onClick={() => onToggleLedger(pkg.packageId)}
                    >
                      {pkg.name}
                    </button>
                    <div className="mt-1 truncate text-tiny font-medium text-ink-3">
                      {formatPackageDimensionsText(pkg)}
                    </div>
                  </td>
                  <td className={cn('border-b border-line px-4 py-3 text-center align-middle text-[15px] font-extrabold tabular-nums', stockTone(pkg))}>
                    {pkg.stockQty ?? 0}
                  </td>
                  <td className="border-b border-line px-4 py-3 text-center align-middle tabular-nums" title="Units used in the last 30 days">
                    {renderUsageValue(usageByPackageId?.[pkg.packageId], usageLoading)}
                  </td>
                  <td className="border-b border-line px-4 py-3 text-center align-middle">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      title="Reorder Level"
                      value={reorderInputs[pkg.packageId] ?? String(pkg.reorderLevel ?? 10)}
                      onChange={(event) => onReorderInputChange(pkg.packageId, event.target.value)}
                      onBlur={() => onSaveReorderLevel(pkg)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          onSaveReorderLevel(pkg)
                          event.currentTarget.blur()
                        }
                      }}
                      className="h-8 w-14 rounded-md border border-line-2 bg-white px-2 text-center text-xs font-semibold text-ink transition focus:border-brand focus:bg-brand-bg/40"
                    />
                  </td>
                  <td className="border-b border-line px-4 py-3 text-right align-middle font-mono text-xs2 font-semibold text-ink-2">
                    {formatPackageUnitCost(pkg.unitCost)}
                  </td>
                  <td className="border-b border-line px-3 py-3 text-right align-middle">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      <ActionButton label="Receive stock" tone="receive" onClick={() => onReceive(pkg)}>
                        <PackagePlus size={15} strokeWidth={2.25} />
                      </ActionButton>
                      <ActionButton label="Adjust stock" tone="adjust" onClick={() => onAdjust(pkg)}>
                        <SlidersHorizontal size={15} strokeWidth={2.25} />
                      </ActionButton>
                      <ActionButton label="Edit package" tone="edit" onClick={() => onEdit(pkg.packageId)}>
                        <PencilLine size={14} strokeWidth={2.25} />
                      </ActionButton>
                      <ActionButton label="Set billing default" tone="billing" onClick={() => onSetBillingDefault(pkg)}>
                        <BadgeDollarSign size={15} strokeWidth={2.15} />
                      </ActionButton>
                      <ActionButton label="Delete package" tone="delete" onClick={() => onDelete(pkg.packageId)}>
                        <Trash2 size={14} strokeWidth={2.15} />
                      </ActionButton>
                    </div>
                  </td>
                </tr>
                {ledger?.open ? renderLedger(pkg, ledger) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
