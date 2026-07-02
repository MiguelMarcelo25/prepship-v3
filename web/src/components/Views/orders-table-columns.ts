// PS-257: this module is now strict-typed. The sort-value resolver reads loose
// rate records: `order.selectedRate` is `AnyRecord` (its reads stay `any`), while
// `order.bestRate` is declared `unknown` in types/api.ts, so its property reads are
// routed through the LooseBestRate cast (exported from orders-display-state.ts).
// Casts are type-erased — no runtime behavior change. The exported types
// (OrderStatus/SortKey/TableColumnKey/TableColumn) remain fully typed for consumers.
//
// PS-166 (Wave 2a2): OrdersView's column system — the status/sort/column key
// types, the TABLE_COLUMNS definition table, per-status column visibility,
// and the display-only sort-value resolver — moved VERBATIM out of
// OrdersView.tsx (module-level pure helpers — no hooks, no JSX, no behavior
// change). Accessors come from the SAME owners OrdersView already used
// (orders-items, orders-display-state, orders-row-display).
import type { CarrierAccountDto, OrderFullDto, OrderSummaryDto } from '../../types/api'
import { getOrderWeightOz, getPrimaryItem, getShipTo, getTotalQuantity } from './orders-items'
import { getShipAccountDisplay, isStrictShippedOrder, type LooseBestRate } from './orders-display-state'
import {
  getBackendRowMoney,
  getBackendRowMarketplace,
  getBestRateFinalBaseCost,
  getBestRateBaseCost,
  getBestRateCarrierNickname,
  getBestRateServiceCode,
  getBestRateShippingProviderId,
  getShippingString,
  toStringValue,
} from './orders-row-display'

export type OrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled'
// Per user override `unlock shipped data` (2026-06-04): every data column is
// now sortable across Awaiting / Shipped / Cancelled. This only adds DISPLAY
// sorting (client-side, same path as the existing keys) — it does not modify,
// edit, or weaken any shipped/cancelled order data or protection.
export type SortKey = 'date' | 'age' | 'orderNum' | 'client' | 'customer' | 'itemname' | 'sku' | 'qty' | 'weight' | 'shipto' | 'carrier' | 'custcarrier' | 'total' | 'bestrate' | 'bestRateFinal' | 'ratecost' | 'margin' | 'marketplacefee' | 'profit' | 'tracking' | 'labelcreated' | 'test_carrierCode' | 'test_shippingProviderID' | 'test_clientID' | 'test_shippingAccount' | 'test_serviceCode' | 'test_bestRate' | 'test_orderLocal'
export type TableColumnKey = 'select' | 'date' | 'client' | 'orderNum' | 'customer' | 'itemname' | 'sku' | 'qty' | 'weight' | 'shipto' | 'carrier' | 'custcarrier' | 'total' | 'bestrate' | 'bestRateFinal' | 'ratecost' | 'margin' | 'marketplacefee' | 'profit' | 'tracking' | 'labelcreated' | 'age' | 'test_carrierCode' | 'test_shippingProviderID' | 'test_clientID' | 'test_serviceCode' | 'test_bestRate' | 'test_orderLocal' | 'test_shippingAccount'

export interface TableColumn {
  key: TableColumnKey
  label: string
  width: number
  sort: SortKey | null
}

export const TABLE_COLUMNS: TableColumn[] = [
  { key: 'select', label: '', width: 34, sort: null },
  { key: 'date', label: 'Order Date', width: 90, sort: 'date' },
  { key: 'client', label: 'Client', width: 100, sort: 'client' },
  { key: 'orderNum', label: 'Order #', width: 85, sort: 'orderNum' },
  { key: 'customer', label: 'Recipient', width: 175, sort: 'customer' },
  { key: 'itemname', label: 'Item Name', width: 170, sort: 'itemname' },
  { key: 'sku', label: 'SKU', width: 150, sort: 'sku' },
  { key: 'qty', label: 'Qty', width: 44, sort: 'qty' },
  { key: 'weight', label: 'Weight', width: 80, sort: 'weight' },
  { key: 'shipto', label: 'Ship To', width: 135, sort: 'shipto' },
  { key: 'carrier', label: 'Carrier', width: 145, sort: 'carrier' },
  { key: 'custcarrier', label: 'Shipping Account', width: 140, sort: 'custcarrier' },
  { key: 'total', label: 'Order Total', width: 85, sort: 'total' },
  { key: 'bestrate', label: 'Best Rate', width: 175, sort: 'bestrate' },
  { key: 'bestRateFinal', label: 'Best Rate Final', width: 110, sort: 'bestRateFinal' },
  // PS-356/PS-357: legacy compatibility key kept for saved column preferences.
  // The visible column is C. Shipping Rate: the backend-owned customer billing amount.
  // Best Rate renders the backend purchase/display policy without recomputing money.
  { key: 'ratecost', label: 'C. Shipping Rate', width: 110, sort: 'ratecost' },
  { key: 'test_carrierCode', label: 'Carrier Code', width: 120, sort: 'test_carrierCode' },
  { key: 'test_shippingProviderID', label: 'Provider ID', width: 110, sort: 'test_shippingProviderID' },
  { key: 'test_clientID', label: 'Client ID', width: 90, sort: 'test_clientID' },
  { key: 'test_shippingAccount', label: 'Acct Nickname', width: 120, sort: 'test_shippingAccount' },
  { key: 'test_serviceCode', label: 'Service Code', width: 130, sort: 'test_serviceCode' },
  { key: 'test_bestRate', label: 'Best Rate (awaiting)', width: 200, sort: 'test_bestRate' },
  { key: 'test_orderLocal', label: 'Order Local', width: 140, sort: 'test_orderLocal' },
  { key: 'labelcreated', label: 'Label Created', width: 115, sort: 'labelcreated' },
  { key: 'margin', label: 'Ship Margin', width: 90, sort: 'margin' },
  // PS-239: backend-computed marketplace fee + profit (Awaiting + Shipped).
  { key: 'marketplacefee', label: 'Marketplace Fee', width: 115, sort: 'marketplacefee' },
  { key: 'profit', label: 'Profit', width: 90, sort: 'profit' },
  { key: 'tracking', label: 'Tracking #', width: 160, sort: 'tracking' },
  { key: 'age', label: 'Age', width: 50, sort: 'age' },
]

export function getVisibleColumns(currentStatus: OrderStatus) {
  const hidden = new Set<TableColumnKey>()
  if (currentStatus !== 'awaiting_shipment') {
    hidden.add('age')
    hidden.add('bestRateFinal')
  }
  // PS-239: marketplace fee + profit show on Awaiting + Shipped only, not Cancelled.
  // PS-356: C. Shipping Rate is a rate/financial column — same Cancelled hide.
  if (currentStatus === 'cancelled') { hidden.add('marketplacefee'); hidden.add('profit'); hidden.add('ratecost') }

  return TABLE_COLUMNS.filter((column) => !hidden.has(column.key)).map((column) => (
    column.key === 'bestrate' && currentStatus !== 'awaiting_shipment'
      ? { ...column, label: 'Selected Rate' }
      : column
  ))
}

export function getSortValue(
  order: OrderSummaryDto,
  detail: OrderFullDto | null,
  key: SortKey,
  accounts: CarrierAccountDto[],
): string | number {
  switch (key) {
    case 'date':
    case 'age':
      return order.orderDate ?? ''
    case 'orderNum':
      return order.orderNumber ?? ''
    case 'client':
      return (order.clientName ?? '').toLowerCase()
    case 'customer':
      return (getShipTo(order, detail).name ?? '').toLowerCase()
    case 'itemname':
      return (getPrimaryItem(order, detail)?.name ?? '').toLowerCase()
    case 'sku':
      return (getPrimaryItem(order, detail)?.sku ?? '').toLowerCase()
    case 'qty':
      return getTotalQuantity(order, detail)
    case 'weight':
      return getOrderWeightOz(order, detail)
    case 'shipto': {
      const shipTo = getShipTo(order, detail)
      return `${shipTo.state ?? ''}${shipTo.city ?? ''}`.toLowerCase()
    }
    case 'carrier':
      if (isStrictShippedOrder(order)) {
        return `${getShippingString(order, 'carrierCode') ?? ''}${getShippingString(order, 'serviceCode') ?? ''}`.toLowerCase()
      }
      return `${getShippingString(order, 'carrierCode') ?? order.selectedRate?.carrierCode ?? (order.bestRate as LooseBestRate | undefined)?.carrierCode ?? ''}${getShippingString(order, 'serviceCode') ?? order.selectedRate?.serviceCode ?? getBestRateServiceCode(order) ?? ''}`.toLowerCase()
    case 'custcarrier':
      return String(getShipAccountDisplay(order, accounts)).toLowerCase()
    case 'total':
      return order.orderTotal ?? 0
    // Per user override `unlock shipped data` (2026-06-04): display-only sort
    // values for the remaining columns. Numeric columns return numbers
    // (missing → -1 so blanks group together); text columns return lowercased
    // strings. No order data is mutated.
    case 'bestrate':
    case 'test_bestRate':
      return getBestRateBaseCost(order) ?? -1
    case 'bestRateFinal':
      return getBestRateFinalBaseCost(order) ?? -1
    // PS-356: sort by the backend customer billing amount (blanks/non-financial → -1).
    case 'ratecost':
      return getBackendRowMoney(order)?.cShippingRateAmount ?? -1
    case 'margin': {
      // PS-178 final part: the margin sort value is the BACKEND money tuple's
      // markupAmount (PS-177) — the FE markup-math fallback is deleted. Rows
      // without the tuple sort with the blanks (-1), same as no-rate rows.
      if (order.orderStatus !== 'awaiting_shipment') return -1
      return getBackendRowMoney(order)?.markupAmount ?? -1
    }
    // PS-239: marketplace fee (>=0, blanks → -1) + profit (can be negative, so
    // blanks sort to the bottom via -Infinity rather than mingling with negatives).
    case 'marketplacefee':
      return getBackendRowMarketplace(order)?.marketplaceFee ?? -1
    case 'profit': {
      const profit = getBackendRowMarketplace(order)?.profit
      return profit == null ? Number.NEGATIVE_INFINITY : profit
    }
    case 'tracking':
      return (toStringValue(order.label?.trackingNumber) ?? '').toLowerCase()
    case 'labelcreated':
      return order.label?.createdAt ?? ''
    case 'test_carrierCode':
      return (getShippingString(order, 'carrierCode') ?? toStringValue((order.bestRate as LooseBestRate | undefined)?.carrierCode) ?? '').toLowerCase()
    case 'test_serviceCode':
      return (getShippingString(order, 'serviceCode') ?? toStringValue((order.bestRate as LooseBestRate | undefined)?.serviceCode) ?? '').toLowerCase()
    case 'test_shippingProviderID':
      return (toStringValue((order.bestRate as LooseBestRate | undefined)?.shippingProviderId) ?? toStringValue(getBestRateShippingProviderId(order)) ?? '').toLowerCase()
    case 'test_clientID':
      return Number(order.clientId ?? -1)
    case 'test_shippingAccount':
      return (getBestRateCarrierNickname(order) ?? '').toLowerCase()
    case 'test_orderLocal':
      return Number(order.weight?.value ?? -1)
    default:
      return ''
  }
}
