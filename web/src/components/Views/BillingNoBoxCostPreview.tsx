import { AlertTriangle } from 'lucide-react'
import {
  formatBillingMoney,
  formatBillingShipDate,
  type BillingDetailDto,
} from './billing-parity'
import { hasBillingNoBoxCostAlert } from './BillingNoBoxCostAction'

function moneyValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}

function rowKey(row: BillingDetailDto, index: number) {
  return String(row.orderId ?? row.order_id ?? row.id ?? row.orderNumber ?? row.order_number ?? index)
}

function sameBillingRow(a: BillingDetailDto | null | undefined, b: BillingDetailDto) {
  if (!a) return false
  const aId = a.orderId ?? a.order_id ?? a.id
  const bId = b.orderId ?? b.order_id ?? b.id
  if (aId != null && bId != null) return String(aId) === String(bId)
  return String(a.orderNumber ?? a.order_number ?? '') === String(b.orderNumber ?? b.order_number ?? '')
}

function rowOrderLabel(row: BillingDetailDto) {
  return row.orderNumber ?? row.order_number ?? row.orderId ?? row.order_id ?? 'Unknown order'
}

function rowSkuLabel(row: BillingDetailDto) {
  return row.itemSkus ?? row.item_skus ?? row.sku ?? 'No SKU'
}

function rowItemLabel(row: BillingDetailDto) {
  return row.itemNames ?? row.item_names ?? row.description ?? 'No item name'
}

function rowBoxLabel(row: BillingDetailDto) {
  return row.packageName ?? row.package_name ?? row.boxSize ?? row.box_size ?? 'No box selected'
}

export function BillingNoBoxCostPreview({
  rows,
  activeRow,
  onOpenBillingEdit,
}: {
  rows: BillingDetailDto[]
  activeRow?: BillingDetailDto | null
  onOpenBillingEdit: (row: BillingDetailDto) => void
}) {
  const noBoxCostRows = rows.filter(hasBillingNoBoxCostAlert)

  if (noBoxCostRows.length === 0) return null

  return (
    <section
      aria-label="No box cost preview"
      className="my-2 rounded-lg border border-amber-200 bg-amber-50/65 p-2.5 text-[11px] text-ink"
      data-billing-no-box-cost-preview
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-extrabold text-amber-800">
          <AlertTriangle size={13} strokeWidth={2.4} aria-hidden="true" />
          <span>No box cost preview</span>
          <span className="rounded bg-amber-100 px-1.5 py-0.5">{noBoxCostRows.length} rows need box cost</span>
        </div>
        <span className="text-[10px] font-semibold text-ink-3">
          Click a row to edit its Box Cost.
        </span>
      </div>
      <p className="mt-1 text-[10.5px] text-ink-2">
        Enter the Box Cost below, then Save. The saved billing override will be used when this billing range is regenerated.
      </p>
      <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-amber-200 bg-surface">
        {noBoxCostRows.map((row, index) => {
          const active = sameBillingRow(activeRow, row)
          const shipping = moneyValue(row.shipping ?? row.shippingCost ?? row.shipping_cost)
          const selectedRate = moneyValue(row.selectedRateCost ?? row.selected_rate_cost)

          return (
            <button
              key={rowKey(row, index)}
              type="button"
              className={[
                'grid w-full grid-cols-[74px_74px_minmax(150px,1fr)_minmax(110px,0.6fr)_82px] items-center gap-2 border-b border-amber-100 px-2 py-1.5 text-left last:border-b-0',
                'hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-300',
                active ? 'bg-amber-100/80' : 'bg-transparent',
              ].join(' ')}
              onClick={() => onOpenBillingEdit(row)}
            >
              <span className="font-extrabold text-sky-600">#{rowOrderLabel(row)}</span>
              <span className="text-ink-2">{formatBillingShipDate(row.shipDate ?? row.ship_date)}</span>
              <span className="min-w-0">
                <span className="block truncate font-bold text-ink">{rowItemLabel(row)}</span>
                <span className="block truncate font-mono text-[10px] text-ink-3">{rowSkuLabel(row)}</span>
              </span>
              <span className="truncate text-ink-2">{rowBoxLabel(row)}</span>
              <span className="text-right font-bold text-ink">
                {formatBillingMoney(selectedRate ?? shipping, { dashIfZero: true })}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
