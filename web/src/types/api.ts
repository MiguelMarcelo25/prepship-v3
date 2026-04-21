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
export type OrderSummaryDto = AnyRecord & {
  orderId: number
  orderNumber: string | null
  orderStatus?: string | null
  clientId: number
  items?: unknown
  raw?: unknown
  bestRate?: unknown
  selectedRate?: AnyRecord | null
  label?: AnyRecord | null
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
  status: 'queued' | 'printed'
  sku_group_id: string
  order_qty: number | null
  primary_sku: string | null
  item_description: string | null
}
export type ProductDefaultsDto = AnyRecord & {
  defaultPackageCode?: string | null
}
