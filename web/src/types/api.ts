// v2-compat type shim. v2's OrdersView imports many DTO types from
// `../../types/api`. v4 doesn't have a hand-maintained DTO file (it
// uses inline types per-route). To unblock the wholesale port we
// alias the needed names to structural `any`-ish shapes here, then
// tighten them in a follow-up pass once the port compiles.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>

export type CarrierAccountDto = AnyRecord
export type CreateLabelRequestDto = AnyRecord
export type LocationDto = AnyRecord
export type OrderFullDto = AnyRecord
export type OrderPicklistResponseDto = AnyRecord
export type OrderPicklistItemDto = AnyRecord
export type ReturnOrderSummaryDto = {
  returnId: number
  returnReference: string | null
  status: string
  createdAt?: string | null
  returnCustomerShippingRate: number | null
  items?: Array<{
    sku: string | null
    name: string
    quantity: number
  }>
  shipment?: AnyRecord | null
}
export type OrderSummaryDto = AnyRecord & {
  orderId: number
  orderNumber: string | null
  displayRowKey?: string
  displayRowKind?: 'order' | 'return'
  orderStatus?: string | null
  effectiveOrderStatus?: string | null
  orderLifecycleStatus?: string | null
  orderLifecycleLabel?: string | null
  orderLifecycleReason?: string | null
  fulfillmentConflict?: AnyRecord | null
  returnSummary?: ReturnOrderSummaryDto | null
  returnSummaries?: ReturnOrderSummaryDto[]
  clientId: number
  items?: unknown
  raw?: unknown
  bestRate?: unknown
  bestRateWorkflow?: AnyRecord | null
  shippingWorkflowState?: AnyRecord | null
  selectedRate?: AnyRecord | null
  label?: AnyRecord | null
  shipping?: AnyRecord | null
  canonicalOrder?: AnyRecord | null
  serviceCode?: string | null
}
export type OrdersDailyStatsDto = {
  totalOrders: number
  needToShip: number
  upcomingOrders: number
  window?: {
    from: string
    to: string
    fromLabel?: string
    toLabel?: string
  }
}
export type PackageDto = AnyRecord & {
  packageId: number
  length?: number | null
  width?: number | null
  height?: number | null
}
export type PrintQueueEntryDto = AnyRecord & {
  queue_entry_id: string
  // 'delivered' = tracking-driven retirement: carrier tracking confirmed the
  // package reached the customer, so the entry left the ACTIVE queue and lives
  // in History (auto_retired_at carries the delivery/retirement time).
  status: 'queued' | 'printed' | 'delivered'
  auto_retired_at?: string | null
  sku_group_id: string
  order_qty: number | null
  primary_sku: string | null
  item_description: string | null
}
export type ProductDefaultsDto = AnyRecord & {
  defaultPackageCode?: string | null
}
