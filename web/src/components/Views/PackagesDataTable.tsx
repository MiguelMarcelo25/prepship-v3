// @ts-nocheck
// ──────────────────────────────────────────────────────────────────
// PackagesDataTable — now a thin consumer of the reusable <Table>
// primitive (components/ui/Table.tsx). Migrated 2026-05-12 per
// operator request: "in my packages can you use my table component".
//
// Why the rewrite:
//   - One table renderer for the whole project (Clients V11, Packages,
//     future Manifests/audit logs). Bug fixes + UX wins land once.
//   - Sortable, resizable, drag-reorderable, hide/show columns via the
//     "Columns ▾" picker, double-click an edge to auto-fit — all for
//     free from Table. Operator settings persist under
//     'packages-table:{sort,widths,order,hidden}'.
//   - Pagination is also handled by Table now (paginated={true}).
//
// What we keep:
//   - All cell renderers (package name + dimensions, stock-tone color,
//     usage chip, reorder input, cost format, action buttons).
//   - Ledger expansion via Table's new `renderRowExpansion` prop —
//     when ledgerByPackageId[id].open is true we render a detail
//     row beneath the package with the same grid layout as before.
//   - Section title (e.g. "Custom Packages") as a sticky gold bar
//     above the table.
//   - Row refs for parent scroll-to-row + highlighted-row glow.
//
// Backward compat:
//   - The external PackagesDataTable prop API is unchanged so
//     PackagesView doesn't have to re-plumb every callback.
//   - The legacy width/sort/order/hidden props (columnWidths,
//     onResizeColumn, etc.) are now NO-OPS — Table owns that state
//     under its storageKey. If the caller still passes them they're
//     simply ignored.
// ──────────────────────────────────────────────────────────────────

import { type MutableRefObject, type ReactNode } from 'react'
import { BadgeDollarSign, PackagePlus, PencilLine, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { PackageDto, PackageLedgerEntryDto } from '../../types/api'
import {
  formatPackageDimensionsText,
  formatPackageLedgerDate,
  formatPackageUnitCost,
} from './packages-parity'
import { Table, type TableColumn } from '../ui/Table'

export type PackagesColumnKey = 'package' | 'stock' | 'usage30' | 'reorder' | 'cost' | 'actions'
export type PackagesSortKey = Exclude<PackagesColumnKey, 'actions'>
export type PackagesSortDirection = 'asc' | 'desc'
export interface PackagesSortState {
  key: PackagesSortKey
  direction: PackagesSortDirection
}
export type PackagesColumnWidths = Partial<Record<PackagesColumnKey, number>>

// These exports stay for any existing import sites in PackagesView's
// state/persistence code; the new Table primitive manages everything
// internally so they're advisory now (operators still get sensible
// defaults if they clear localStorage).
export const PACKAGES_COLUMNS_ORDER: PackagesColumnKey[] = ['package', 'stock', 'usage30', 'reorder', 'cost', 'actions']
export const PACKAGES_REQUIRED_COLUMNS = new Set<PackagesColumnKey>(['package'])
export const PACKAGES_COLUMN_LABELS: Record<PackagesColumnKey, string> = {
  package: 'Package',
  stock: 'Stock',
  usage30: '30d Used',
  reorder: 'Reorder',
  cost: 'Cost',
  actions: 'Actions',
}

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
  usageByPackageId?: Record<number, number | null>
  usageLoading?: boolean
  /** When true, Table renders an internal pagination bar. Defaults
   *  to true (Packages is always a long list). */
  paginated?: boolean

  // ── Legacy props — now no-ops, Table manages state via storageKey ─
  // Kept in the interface so existing call sites compile without
  // changes; remove once PackagesView is cleaned up.
  columnWidths?: PackagesColumnWidths
  onResizeColumn?: (key: PackagesColumnKey, width: number) => void
  onResetColumn?: (key: PackagesColumnKey) => void
  sortState?: PackagesSortState | null
  onSortChange?: (key: PackagesSortKey) => void
  columnOrder?: PackagesColumnKey[]
  hiddenColumns?: PackagesColumnKey[]
  onReorderColumn?: (fromKey: PackagesColumnKey, toKey: PackagesColumnKey) => void
}

// ─── Cell helpers (kept private to this module) ──────────────────────

function stockTone(pkg: PackageDto): string {
  const qty = Number(pkg.stockQty ?? 0)
  const reorderLevel = Number(pkg.reorderLevel ?? 10)
  if (qty <= 0) return 'text-danger'
  if (qty <= reorderLevel) return 'text-warn'
  return 'text-ok'
}

function renderUsageValue(value: number | null | undefined, loading?: boolean): ReactNode {
  if (value == null) {
    return <span className="text-tiny font-semibold text-ink-3">{loading ? '…' : '-'}</span>
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
  label, tone, onClick, children,
}: {
  label: string
  tone: ActionTone
  onClick: (e: React.MouseEvent) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[7px] border transition duration-150 shadow-[inset_0_1px_0_rgba(255,255,255,.65)] hover:-translate-y-px active:translate-y-0 active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/25 ${actionToneClasses[tone]}`}
    >
      {children}
    </button>
  )
}

// The package_ledger.note column stores the reason text. Two backend
// patterns:
//   "Shipment <id> for order <orderNumber>"
//   "Order <orderNumber> / shipment <id>"
// Capture the orderNumber and turn it into a clickable link.
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
        className="font-semibold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark"
        onClick={(e) => { e.stopPropagation(); onOpenOrderByNumber(cleanedNumber) }}
        title={`Open order ${cleanedNumber}`}
      >
        {cleanedNumber}
      </button>
      {after}
    </>
  )
}

// Ledger expansion content — rendered inside Table's renderRowExpansion
// row when an operator clicks a package name. Layout identical to the
// pre-migration version so muscle memory carries over.
function PackageLedger({
  pkg,
  ledger,
  onOpenOrder,
  onOpenOrderByNumber,
}: {
  pkg: PackageDto
  ledger: LedgerState
  onOpenOrder?: (orderId: number) => void
  onOpenOrderByNumber?: (orderNumber: string) => void
}) {
  return (
    <div className="px-4 py-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        {ledger.loading ? (
          <div className="px-3 py-3 text-xs2 font-medium text-ink-3">Loading…</div>
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
                <div className={`text-center font-extrabold ${row.delta > 0 ? 'text-ok' : 'text-danger'}`}>
                  {row.delta > 0 ? '+' : ''}{row.delta}
                </div>
                <div className="text-right font-mono text-ink-3">{formatPackageUnitCost(row.unitCost)}</div>
                <div className="pl-4">{renderLedgerReason(row.reason, onOpenOrderByNumber)}</div>
                <div>
                  {row.orderId ? (
                    <button
                      type="button"
                      className="font-semibold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark"
                      onClick={(e) => { e.stopPropagation(); onOpenOrder?.(row.orderId as number) }}
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
    </div>
  )
}

// ─── Component ───────────────────────────────────────────────────────

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
  usageByPackageId,
  usageLoading,
  paginated = true,
}: PackagesDataTableProps) {
  const columns: TableColumn<PackageDto>[] = [
    {
      key: 'package',
      label: PACKAGES_COLUMN_LABELS.package,
      width: 280,
      minWidth: 180,
      sortable: true,
      hideable: false, // required — without it rows lose identity
      sortValue: (row) => row.name ?? '',
      render: (row) => (
        <button
          type="button"
          className="block w-full text-left"
          onClick={(e) => { e.stopPropagation(); onToggleLedger(row.packageId) }}
          title={`Open ledger for ${row.name}`}
        >
          <span className="block max-w-full truncate text-[13px] font-extrabold text-brand underline decoration-line underline-offset-2 hover:text-brand-dark">
            {row.name}
          </span>
          <span className="mt-1 block truncate text-tiny font-medium text-ink-3">
            {formatPackageDimensionsText(row)}
          </span>
        </button>
      ),
    },
    {
      key: 'stock',
      label: PACKAGES_COLUMN_LABELS.stock,
      width: 88,
      minWidth: 70,
      align: 'center',
      sortable: true,
      sortValue: (row) => Number(row.stockQty ?? 0),
      render: (row) => (
        <span className={`text-[15px] font-extrabold tabular-nums ${stockTone(row)}`}>
          {row.stockQty ?? 0}
        </span>
      ),
    },
    {
      key: 'usage30',
      label: PACKAGES_COLUMN_LABELS.usage30,
      width: 112,
      minWidth: 90,
      align: 'center',
      sortable: true,
      sortValue: (row) => usageByPackageId?.[row.packageId] ?? -1,
      render: (row) => (
        <span title="Units used in the last 30 days" className="tabular-nums">
          {renderUsageValue(usageByPackageId?.[row.packageId], usageLoading)}
        </span>
      ),
    },
    {
      key: 'reorder',
      label: PACKAGES_COLUMN_LABELS.reorder,
      width: 116,
      minWidth: 96,
      align: 'center',
      sortable: true,
      sortValue: (row) => Number(row.reorderLevel ?? 10),
      render: (row) => (
        <input
          type="number"
          min="0"
          step="1"
          title="Reorder Level"
          value={reorderInputs[row.packageId] ?? String(row.reorderLevel ?? 10)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onReorderInputChange(row.packageId, e.target.value)}
          onBlur={() => onSaveReorderLevel(row)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSaveReorderLevel(row)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          className="h-8 w-14 rounded-md border border-line-2 bg-white px-2 text-center text-xs font-semibold text-ink transition focus:border-brand focus:bg-brand-bg/40"
        />
      ),
    },
    {
      key: 'cost',
      label: PACKAGES_COLUMN_LABELS.cost,
      width: 112,
      minWidth: 90,
      align: 'right',
      sortable: true,
      sortValue: (row) => Number(row.unitCost ?? 0),
      render: (row) => (
        <span className="font-mono text-xs2 font-semibold text-ink-2">
          {formatPackageUnitCost(row.unitCost)}
        </span>
      ),
    },
    {
      key: 'actions',
      label: PACKAGES_COLUMN_LABELS.actions,
      width: 200,
      minWidth: 180,
      align: 'right',
      pinned: true,
      hideable: false,
      render: (row) => (
        <div className="inline-flex items-center justify-end gap-1.5">
          <ActionButton label="Receive stock" tone="receive" onClick={() => onReceive(row)}>
            <PackagePlus size={15} strokeWidth={2.25} />
          </ActionButton>
          <ActionButton label="Adjust stock" tone="adjust" onClick={() => onAdjust(row)}>
            <SlidersHorizontal size={15} strokeWidth={2.25} />
          </ActionButton>
          <ActionButton label="Edit package" tone="edit" onClick={() => onEdit(row.packageId)}>
            <PencilLine size={14} strokeWidth={2.25} />
          </ActionButton>
          <ActionButton label="Set billing default" tone="billing" onClick={() => onSetBillingDefault(row)}>
            <BadgeDollarSign size={15} strokeWidth={2.15} />
          </ActionButton>
          <ActionButton label="Delete package" tone="delete" onClick={() => onDelete(row.packageId)}>
            <Trash2 size={14} strokeWidth={2.15} />
          </ActionButton>
        </div>
      ),
    },
  ]

  return (
    <div className="rounded-card border border-line bg-white shadow-sm overflow-hidden">
      {/* Sticky section title — "Custom Packages" / "Carrier Packages".
          Sits OUTSIDE the Table so the table's own thead can be sticky
          independently. */}
      {sectionTitle ? (
        <div className="h-9 bg-brand-bg border-b border-line flex items-center px-4 text-2xs font-extrabold uppercase tracking-[0.05em] text-ink-3">
          {sectionTitle}
        </div>
      ) : null}

      <Table<PackageDto>
        data={packages}
        columns={columns}
        rowKey={(row) => row.packageId}
        storageKey="packages-table"
        defaultSort={{ key: 'package', direction: 'asc' }}
        paginated={paginated}
        defaultPageSize={50}
        pageSizeOptions={[25, 50, 100]}
        className="!rounded-none !ring-0 !shadow-none"
        rowRef={(row, el) => { rowRefs.current[row.packageId] = el }}
        rowClassName={(row) =>
          highlightedPackageId === row.packageId
            ? 'bg-warn-bg shadow-[inset_3px_0_0_#f59e0b]'
            : 'odd:bg-white even:bg-surface-2'
        }
        renderRowExpansion={(row) => {
          const ledger = ledgerByPackageId[row.packageId]
          if (!ledger?.open) return null
          return (
            <PackageLedger
              pkg={row}
              ledger={ledger}
              onOpenOrder={onOpenOrder}
              onOpenOrderByNumber={onOpenOrderByNumber}
            />
          )
        }}
        emptyMessage="No packages match the current filter."
      />
    </div>
  )
}
