/**
 * Orders view filter utilities
 */

export type OrdersDateFilter = '' | 'this-month' | 'last-month' | 'last-30' | 'last-90' | 'custom'

export interface OrderFilter {
  status?: string;
  storeId?: string;
  dateRange?: {
    start: string;
    end: string;
  };
  searchTerm?: string;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export function applyFilters(orders: any[], filter: OrderFilter): any[] {
  return orders.filter((order) => {
    if (filter.status && order.status !== filter.status) return false;
    if (filter.storeId && order.storeId !== filter.storeId) return false;
    if (filter.searchTerm) {
      const term = filter.searchTerm.toLowerCase();
      const matches =
        order.id?.toLowerCase().includes(term) ||
        order.orderNumber?.toLowerCase().includes(term) ||
        order.storeName?.toLowerCase().includes(term);
      if (!matches) return false;
    }
    return true;
  });
}

export function getOrdersDateRange(filter: OrdersDateFilter): DateRange | null {
  const today = new Date();
  const start = new Date();

  switch (filter) {
    case 'this-month':
      start.setDate(1);
      break;
    case 'last-month':
      start.setMonth(start.getMonth() - 1);
      start.setDate(1);
      break;
    case 'last-30':
      start.setDate(today.getDate() - 30);
      break;
    case 'last-90':
      start.setDate(today.getDate() - 90);
      break;
    case '':
      return null;
    default:
      return null;
  }

  return { start, end: today };
}

export const ORDER_STATUS = {
  AWAITING_SHIPMENT: "awaiting_shipment",
  SHIPPED: "shipped",
  CANCELLED: "cancelled",
} as const;
