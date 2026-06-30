import { getOrdersDateRange, type OrdersDateFilter } from './orders-view-filters';

export type ResolvedOrdersDateRange = {
  start?: string;
  end?: string;
};

function toDateInputValue(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}

function normalizeDateInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function isAllDatesOrdersFilter(filter: OrdersDateFilter): boolean {
  return filter === '';
}

export function resolveOrdersDateRangeForFilter(
  filter: OrdersDateFilter,
  customRange: ResolvedOrdersDateRange = {},
): ResolvedOrdersDateRange {
  // PS-353: "All Dates" is an explicit no-bounds contract. Callers must not
  // send hidden dateFrom/dateTo params to table, count, export, or selection APIs.
  if (isAllDatesOrdersFilter(filter)) return {};

  if (filter === 'custom') {
    return {
      start: normalizeDateInput(customRange.start),
      end: normalizeDateInput(customRange.end),
    };
  }

  const range = getOrdersDateRange(filter);
  if (!range) return {};

  return {
    start: toDateInputValue(range.start),
    end: toDateInputValue(range.end),
  };
}
