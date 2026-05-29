// @ts-nocheck
/**
 * Order utility functions
 * Age calculation, residential detection, SKU grouping, etc.
 */

import type { OrderDTO, OrderDimensions } from '../types/orders';
import { CALIFORNIA_TZ } from '../lib/ca-time';

export function ageHours(createdAt: string): number {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  return (now - created) / (1000 * 60 * 60);
}

export function ageColor(createdAt: string): 'red' | 'orange' | 'green' {
  const hours = ageHours(createdAt);
  if (hours > 48) return 'red';
  if (hours > 24) return 'orange';
  return 'green';
}

export function ageDisplay(createdAt: string): string {
  const hours = Math.floor(ageHours(createdAt));
  if (hours < 1) return 'now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function isResidential(order: OrderDTO): boolean {
  if (typeof order.residential === 'boolean') return order.residential;
  if (order.sourceResidential) return true;
  return !order.shipTo?.company;
}

export function getOrderStoreId(order: OrderDTO): number {
  return order.storeId ?? 1;
}

export function getPrimarySku(order: OrderDTO): string {
  const items = order.items ?? [];
  if (items.length === 0) return '';

  const skuCounts = new Map<string, number>();
  for (const item of items) {
    if (item.adjustment) continue; // Skip adjustments
    skuCounts.set(item.sku, (skuCounts.get(item.sku) ?? 0) + item.quantity);
  }

  let maxSku = '';
  let maxQty = 0;
  for (const [sku, qty] of skuCounts) {
    if (qty > maxQty) {
      maxSku = sku;
      maxQty = qty;
    }
  }

  return maxSku;
}

export function getTotalQty(order: OrderDTO): number {
  return (order.items ?? []).reduce((sum, item) => sum + (item.quantity ?? 1), 0);
}

export function getExpedited(serviceCode?: string): '1-day' | '2-day' | null {
  if (!serviceCode) return null;
  if (/1[\s-]?day/i.test(serviceCode)) return '1-day';
  if (/2[\s-]?day/i.test(serviceCode)) return '2-day';
  return null;
}

/**
 * Get order dimensions, preferring enriched dims
 */
export function getOrderDimensions(order: OrderDTO): OrderDimensions | null {
  const dims = order._enrichedDims || order.dimensions;
  if (!dims || dims.length <= 0 || dims.width <= 0 || dims.height <= 0) {
    return null;
  }
  return dims;
}

/**
 * Get order weight, preferring enriched weight
 */
export function getOrderWeight(order: OrderDTO): number {
  const weight = order._enrichedWeight || order.weight;
  return weight?.value ?? 0;
}

/**
 * Get shipping zip from order
 */
export function getOrderZip(order: OrderDTO): string {
  return (order.shipTo?.postalCode || '').replace(/\D/g, '').slice(0, 5);
}

/**
 * Format weight for display
 */
export function fmtWeight(ounces: number): string {
  if (ounces < 16) return `${ounces.toFixed(1)}oz`;
  const lbs = ounces / 16;
  return `${lbs.toFixed(2)}lbs`;
}

/**
 * Format date for display
 */
export function fmtDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: '2-digit',
      timeZone: CALIFORNIA_TZ
    });
  } catch {
    return '-';
  }
}
