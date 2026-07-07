import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { orderOverrides, orders as ordersTable } from '../../db/schema/orders';
import { shipments } from '../../db/schema/shipments';
import { assertLabelPurchaseRateSelection } from '../shipping-workflow/rate-quote-snapshot-store';
import type { QueueSendJobItemInput } from './queue-send-item-state';
import type { QueueSendJobResult, QueueSendOrderInput } from '../print-queue';

export type QueueSendPreflightBlockReason =
  | 'order_not_found'
  | 'order_not_editable'
  | 'missing_label_payload'
  | 'missing_rate_proof'
  | 'stale_or_mismatched_rate_proof'
  | 'missing_weight'
  | 'missing_package'
  | 'missing_address'
  | 'carrier_provider_unavailable';

type QueueSendPreflightOrderFact = {
  orderId: number;
  orderStatus: string | null;
  weightOz: number | null;
  shipToPostalCode: string | null;
  raw: Record<string, unknown> | null;
  overrideWeightOz: number | null;
  overrideDimsL: number | null;
  overrideDimsW: number | null;
  overrideDimsH: number | null;
};

export type QueueSendPreflightResult = {
  readyOrders: QueueSendOrderInput[];
  blockedResults: QueueSendJobResult[];
  itemStates: QueueSendJobItemInput[];
};

const LOCKED_ORDER_STATUSES = new Set(['shipped', 'cancelled']);

function finitePositive(value: unknown): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasPositiveDims(values: unknown[]): boolean {
  return values.every((value) => finitePositive(value) != null);
}

function rawShipToPostalCode(raw: Record<string, unknown> | null): string | null {
  const shipTo = raw && typeof raw.shipTo === 'object' ? raw.shipTo as Record<string, unknown> : null;
  const value = shipTo?.postalCode ?? shipTo?.postal_code ?? shipTo?.zip ?? null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function blockMessage(reason: QueueSendPreflightBlockReason, order: QueueSendOrderInput): string {
  const ref = order.orderNumber ?? order.orderId;
  switch (reason) {
    case 'order_not_found':
      return `Order ${ref} was not found before Send to Queue.`;
    case 'order_not_editable':
      return `Order ${ref} is shipped/cancelled and cannot buy or queue a new label.`;
    case 'missing_label_payload':
      return `Order ${ref} has no existing label URL and no label payload.`;
    case 'missing_rate_proof':
      return `Order ${ref} is missing backend selected-rate proof before label purchase.`;
    case 'stale_or_mismatched_rate_proof':
      return `Order ${ref} has stale or mismatched selected-rate proof. Re-rate before Send to Queue.`;
    case 'missing_weight':
      return `Order ${ref} is missing package weight.`;
    case 'missing_package':
      return `Order ${ref} is missing package dimensions or package selection.`;
    case 'missing_address':
      return `Order ${ref} is missing ship-to postal code.`;
    case 'carrier_provider_unavailable':
      return `Order ${ref} is missing carrier/service information.`;
  }
}

function blockedResult(
  order: QueueSendOrderInput,
  reason: QueueSendPreflightBlockReason,
): QueueSendJobResult {
  const retryable = reason === 'missing_rate_proof' || reason === 'stale_or_mismatched_rate_proof';
  return {
    orderId: order.orderId,
    orderNumber: order.orderNumber ?? null,
    success: false,
    skipped: true,
    skipReason: blockMessage(reason, order),
    error: blockMessage(reason, order),
    retryEligible: retryable,
    retryReason: reason,
    timings: { totalMs: 0, labelSource: 'skipped_preflight' },
  };
}

function blockedItem(
  order: QueueSendOrderInput,
  reason: QueueSendPreflightBlockReason,
): QueueSendJobItemInput {
  return {
    orderId: order.orderId,
    clientId: order.clientId,
    state: 'skipped_preflight',
    blockedReason: reason,
    errorMessage: blockMessage(reason, order),
  };
}

function readyItem(order: QueueSendOrderInput): QueueSendJobItemInput {
  return {
    orderId: order.orderId,
    clientId: order.clientId,
    state: 'ready',
  };
}

function labelHasWeight(order: QueueSendOrderInput, fact: QueueSendPreflightOrderFact | null): boolean {
  if (finitePositive(order.label?.weightOz) != null) return true;
  if (finitePositive(fact?.overrideWeightOz) != null) return true;
  if (finitePositive(fact?.weightOz) != null) return true;
  return order.label?.testLabel === true;
}

function labelHasPackage(order: QueueSendOrderInput, fact: QueueSendPreflightOrderFact | null): boolean {
  const label = order.label;
  if (!label) return Boolean(order.labelUrl);
  if (label.customPackageId != null || (typeof label.packageCode === 'string' && label.packageCode.trim())) return true;
  if (hasPositiveDims([label.length, label.width, label.height])) return true;
  return hasPositiveDims([fact?.overrideDimsL, fact?.overrideDimsW, fact?.overrideDimsH]);
}

function orderHasAddress(fact: QueueSendPreflightOrderFact | null): boolean {
  if (!fact) return false;
  if (typeof fact.shipToPostalCode === 'string' && fact.shipToPostalCode.trim()) return true;
  return rawShipToPostalCode(fact.raw) != null;
}

async function loadOrderFacts(orderIds: number[]): Promise<Map<number, QueueSendPreflightOrderFact>> {
  const unique = Array.from(new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: ordersTable.id,
      orderStatus: ordersTable.orderStatus,
      weightOz: ordersTable.weightOz,
      shipToPostalCode: ordersTable.shipToPostalCode,
      raw: ordersTable.raw,
      overrideWeightOz: orderOverrides.rateWeightOz,
      overrideDimsL: orderOverrides.rateDimsL,
      overrideDimsW: orderOverrides.rateDimsW,
      overrideDimsH: orderOverrides.rateDimsH,
    })
    .from(ordersTable)
    .leftJoin(orderOverrides, eq(orderOverrides.orderId, ordersTable.id))
    .where(inArray(ordersTable.id, unique));
  return new Map(rows.map((row) => [row.orderId, row]));
}

async function loadOrderIdsWithActiveLabels(orderIds: number[]): Promise<Set<number>> {
  const unique = Array.from(new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (unique.length === 0) return new Set();
  // Per user override unlock shipped data on 2026-07-07 (PS-400): preflight may
  // READ non-voided shipment labels so a shipped order can recover its existing
  // purchased label into Print Queue. This does not create labels, buy postage,
  // void labels, or mutate shipped/cancelled order data.
  const rows = await db
    .select({ orderId: shipments.orderId })
    .from(shipments)
    .where(
      and(
        inArray(shipments.orderId, unique),
        eq(shipments.voided, false),
        eq(shipments.isReturn, false),
      ),
    );
  return new Set(
    rows
      .map((row) => Number(row.orderId))
      .filter((orderId) => Number.isInteger(orderId) && orderId > 0),
  );
}

async function classifyRateProof(order: QueueSendOrderInput): Promise<QueueSendPreflightBlockReason | null> {
  const label = order.label;
  if (!label || label.testLabel === true) return null;
  if (order.labelUrl) return null;
  if (!(label.rateQuoteId && label.selectedRateKey) && !label.selectedRateProof) {
    return 'missing_rate_proof';
  }
  try {
    await assertLabelPurchaseRateSelection({
      rateQuoteId: label.rateQuoteId,
      selectedRateKey: label.selectedRateKey,
      selectedRateProof: label.selectedRateProof,
      purchaseShippingProviderId: label.shippingProviderId,
    });
    return null;
  } catch {
    return 'stale_or_mismatched_rate_proof';
  }
}

async function classifyOrder(
  order: QueueSendOrderInput,
  fact: QueueSendPreflightOrderFact | null,
  hasActiveLabel: boolean,
): Promise<QueueSendPreflightBlockReason | null> {
  if (!fact) return 'order_not_found';
  const status = String(fact.orderStatus ?? '').toLowerCase();
  if (status === 'cancelled') return 'order_not_editable';
  if (order.labelUrl) return null;
  if (status === 'shipped') return hasActiveLabel ? null : 'order_not_editable';
  if (LOCKED_ORDER_STATUSES.has(status)) return 'order_not_editable';
  if (!order.label) return 'missing_label_payload';
  if (!order.label.serviceCode) return 'carrier_provider_unavailable';
  if (!labelHasWeight(order, fact)) return 'missing_weight';
  if (!labelHasPackage(order, fact)) return 'missing_package';
  if (!orderHasAddress(fact)) return 'missing_address';
  return classifyRateProof(order);
}

export async function preflightQueueSendOrders(
  inputOrders: QueueSendOrderInput[],
): Promise<QueueSendPreflightResult> {
  const orderIds = inputOrders.map((order) => order.orderId);
  const [facts, activeLabelOrderIds] = await Promise.all([
    loadOrderFacts(orderIds),
    loadOrderIdsWithActiveLabels(orderIds),
  ]);
  const readyOrders: QueueSendOrderInput[] = [];
  const blockedResults: QueueSendJobResult[] = [];
  const itemStates: QueueSendJobItemInput[] = [];

  for (const order of inputOrders) {
    const reason = await classifyOrder(
      order,
      facts.get(order.orderId) ?? null,
      activeLabelOrderIds.has(order.orderId),
    );
    if (reason) {
      blockedResults.push(blockedResult(order, reason));
      itemStates.push(blockedItem(order, reason));
      continue;
    }
    readyOrders.push(order);
    itemStates.push(readyItem(order));
  }

  return { readyOrders, blockedResults, itemStates };
}
