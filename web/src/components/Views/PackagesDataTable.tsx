// @ts-nocheck
import { useRef, type MutableRefObject } from 'react'
import { DollarSign, PackagePlus, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { PackageDto, PackageLedgerEntryDto } from '../../types/api'
import {
  formatPackageDimensionsText,
  formatPackageLedgerDate,
  formatPackageUnitCost,
  getPackageStockColor,
} from './packages-parity'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import './PackagesView.css'

export type PackagesColumnKey = 'package' | 'stock' | 'reorder' | 'cost' | 'actions'
export type PackagesColumnWidths = Partial<Record<PackagesColumnKey, number>>

const PACKAGES_COLUMNS_ORDER: PackagesColumnKey[] = ['package', 'stock', 'reorder', 'cost', 'actions']
const PACKAGES_COLUMN_DEFAULTS: Record<PackagesColumnKey, number | undefined> = {
  package: undefined,
  stock: 60,
  reorder: 75,
  cost: 70,
  actions: undefined,
}
const PACKAGES_MIN_COLUMN_WIDTH = 50

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
  sectionTitle?: string
  columnWidths?: PackagesColumnWidths
  onResizeColumn?: (key: PackagesColumnKey, width: number) => void
  onResetColumn?: (key: PackagesColumnKey) => void
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
  sectionTitle = 'Custom Packages',
  columnWidths,
  onResizeColumn,
  onResetColumn,
}: PackagesDataTableProps) {
  const thRefs = useRef<Partial<Record<PackagesColumnKey, HTMLTableCellElement | null>>>({})

  const renderHeader = (
    key: PackagesColumnKey,
    label: string,
    align: 'left' | 'center' | 'right',
    extraStyle: Record<string, unknown> = {},
  ) => {
    const isLast = key === PACKAGES_COLUMNS_ORDER[PACKAGES_COLUMNS_ORDER.length - 1]
    const overrideWidth = columnWidths?.[key]
    const widthStyle = overrideWidth
      ? { width: overrideWidth, minWidth: overrideWidth, maxWidth: overrideWidth }
      : (PACKAGES_COLUMN_DEFAULTS[key] != null
        ? { width: PACKAGES_COLUMN_DEFAULTS[key] }
        : (key === 'package' ? { maxWidth: 280 } : {}))
    const padding = align === 'left' ? '5px 10px' : (key === 'actions' ? '5px 6px' : '5px 8px')

    return (
      <th
        ref={(node) => { thRefs.current[key] = node }}
        style={{
          position: 'relative',
          padding,
          textAlign: align,
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text3)',
          textTransform: 'uppercase',
          letterSpacing: '.3px',
          ...widthStyle,
          ...extraStyle,
        }}
      >
        {label}
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
          />
        ) : null}
      </th>
    )
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', background: 'var(--surface2)', fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
        {sectionTitle}
      </div>
      <table className="pkg-table">
        <thead>
          <tr style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
            {renderHeader('package', 'Package', 'left')}
            {renderHeader('stock', 'Stock', 'center')}
            {renderHeader('reorder', 'Reorder', 'center')}
            {renderHeader('cost', 'Cost', 'right')}
            {renderHeader('actions', 'Actions', 'right')}
          </tr>
        </thead>
        <tbody>
          {packages.map((pkg) => {
            const ledger = ledgerByPackageId[pkg.packageId]
            return (
              <tr
                key={pkg.packageId ?? pkg.id ?? pkg.name}
                ref={(el) => { rowRefs.current[pkg.packageId] = el }}
                id={`pkg-row-${pkg.packageId}`}
                style={{
                  borderBottom: '1px solid var(--border)',
                  background: highlightedPackageId === pkg.packageId ? 'rgba(254, 240, 138, 0.45)' : undefined,
                  transition: 'background 0.4s ease',
                }}
              >
                <td style={{ padding: '7px 10px', maxWidth: 280, overflow: 'hidden' }}>
                  <button
                    type="button"
                    className="packages-inline-button"
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      color: 'var(--text)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textDecorationColor: 'var(--border)',
                      display: 'block',
                    }}
                    onClick={() => onToggleLedger(pkg.packageId)}
                  >
                    {pkg.name}
                  </button>
                  <div style={{ fontSize: 10.5, color: 'var(--text3)', marginTop: 1 }}>{formatPackageDimensionsText(pkg)}</div>
                  {ledger?.open ? (
                    <div id={`pkg-ledger-${pkg.packageId}`} style={{ marginTop: 6 }}>
                      {ledger.loading ? (
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>Loading…</span>
                      ) : ledger.error ? (
                        <span style={{ fontSize: 11, color: 'var(--red)' }}>Failed to load</span>
                      ) : ledger.rows.length === 0 ? (
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>No history yet</span>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, color: 'var(--text2)' }}>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border)' }}>
                              <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Date</th>
                              <th style={{ textAlign: 'center', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Change</th>
                              <th style={{ textAlign: 'right', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Cost/unit</th>
                              <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Reason</th>
                              <th style={{ textAlign: 'left', padding: '3px 6px', fontSize: 10, color: 'var(--text3)' }}>Order</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ledger.rows.map((row) => (
                              <tr key={`${pkg.packageId}-${row.id ?? row.createdAt}`} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{formatPackageLedgerDate(row.createdAt)}</td>
                                <td style={{ textAlign: 'center', padding: '3px 6px', fontWeight: 700, color: row.delta > 0 ? 'var(--green)' : 'var(--red)' }}>
                                  {row.delta > 0 ? '+' : ''}
                                  {row.delta}
                                </td>
                                <td style={{ textAlign: 'right', padding: '3px 6px', color: 'var(--text3)' }}>{formatPackageUnitCost(row.unitCost)}</td>
                                <td style={{ padding: '3px 6px' }}>{row.reason || '—'}</td>
                                <td style={{ padding: '3px 6px' }}>
                                  {row.orderId ? (
                                    <button
                                      type="button"
                                      className="packages-inline-button"
                                      style={{ color: 'var(--ss-blue)' }}
                                      onClick={() => onOpenOrder?.(row.orderId as number)}
                                    >
                                      #{row.orderId}
                                    </button>
                                  ) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ) : null}
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'center', fontWeight: 700, fontSize: 13, color: getPackageStockColor(pkg) }}>
                  {pkg.stockQty ?? 0}
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'center' }}>
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
                    style={{
                      width: 50,
                      padding: '3px 4px',
                      border: '1px solid var(--border2)',
                      borderRadius: 3,
                      background: 'var(--surface2)',
                      color: 'var(--text)',
                      fontSize: 11,
                      textAlign: 'center',
                    }}
                  />
                </td>
                <td style={{ padding: '7px 8px', textAlign: 'right', fontSize: 11.5, color: 'var(--text2)', fontFamily: 'monospace' }}>
                  {formatPackageUnitCost(pkg.unitCost)}
                </td>
                <td style={{ padding: '7px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-xs pkg-action-btn" type="button" title="Receive stock" aria-label="Receive stock" onClick={() => onReceive(pkg)}>
                    <PackagePlus size={15} strokeWidth={2} />
                  </button>
                  <button className="btn btn-ghost btn-xs pkg-action-btn" type="button" title="Adjust stock" aria-label="Adjust stock" onClick={() => onAdjust(pkg)}>
                    <SlidersHorizontal size={15} strokeWidth={2} />
                  </button>
                  <button className="btn btn-ghost btn-xs pkg-action-btn" type="button" title="Edit package" aria-label="Edit package" onClick={() => onEdit(pkg.packageId)}>
                    <Pencil size={14} strokeWidth={2} />
                  </button>
                  <button className="btn btn-ghost btn-xs pkg-action-btn" type="button" title="Set billing default" aria-label="Set billing default" onClick={() => onSetBillingDefault(pkg)}>
                    <DollarSign size={15} strokeWidth={2.25} />
                  </button>
                  <button className="btn btn-ghost btn-xs pkg-action-btn pkg-action-btn-danger" type="button" title="Delete package" aria-label="Delete package" onClick={() => onDelete(pkg.packageId)}>
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
