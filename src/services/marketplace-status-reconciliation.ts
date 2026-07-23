import type postgres from 'postgres';
import type {
  OrderLifecycleCommandInput,
  OrderLifecycleCommandResult,
} from './order-lifecycle-command.js';

export type MarketplaceProvider = 'walmart' | 'ebay' | 'shopify';
export type PrepShipOrderStatus = 'awaiting_shipment' | 'shipped' | 'cancelled';

// Per user override unlock shipped data on 2026-07-14: shared-pool typing only;
// awaiting-only reconciliation predicates and status authority are unchanged.
export type MarketplaceSql = postgres.Sql;

export type MarketplaceReconciliationCandidate = {
  id: number;
  orderNumber: string;
  externalOrderId: string;
  currentStatus: string;
  targetStatus: PrepShipOrderStatus;
  sourceStatuses: string[];
};

export type MarketplaceReconciliationResult = {
  provider: MarketplaceProvider;
  dryRun: boolean;
  checkedOrderNumbers: number;
  updated: number;
  candidates: MarketplaceReconciliationCandidate[];
  skipped: Array<{
    orderNumber: string;
    reason: string;
    sourceStatuses: string[];
    targetStatus: PrepShipOrderStatus | null;
  }>;
};

function cleanStatus(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeMarketplaceOrderStatus(
  provider: MarketplaceProvider,
  sourceStatus: unknown,
): PrepShipOrderStatus | null {
  const status = cleanStatus(sourceStatus);
  if (!status) return null;

  if (provider === 'walmart') {
    if (status === 'shipped' || status === 'delivered') return 'shipped';
    if (status === 'cancelled' || status === 'canceled') return 'cancelled';
    if (status === 'acknowledged' || status === 'created') return 'awaiting_shipment';
    return null;
  }

  if (provider === 'shopify') {
    if (status === 'fulfilled') return 'shipped';
    if (status === 'cancelled' || status === 'canceled' || status === 'voided') return 'cancelled';
    if (status === 'unfulfilled' || status === 'partial' || status === 'restocked') return 'awaiting_shipment';
    return null;
  }

  if (status === 'fulfilled') return 'shipped';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (
    status === 'not_started' ||
    status === 'in_progress' ||
    status === 'ready_to_ship' ||
    status === 'started'
  ) {
    return 'awaiting_shipment';
  }
  return null;
}

export function aggregateMarketplaceOrderStatus(
  sourceStatuses: unknown[],
  provider: MarketplaceProvider,
): PrepShipOrderStatus | null {
  const normalized = sourceStatuses
    .map((status) => normalizeMarketplaceOrderStatus(provider, status))
    .filter((status): status is PrepShipOrderStatus => status !== null);

  if (!normalized.length) return null;
  if (normalized.includes('awaiting_shipment')) return 'awaiting_shipment';
  if (normalized.includes('shipped')) return 'shipped';
  if (normalized.every((status) => status === 'cancelled')) return 'cancelled';
  return null;
}

export function shouldUpdateMarketplaceOrderStatus(
  currentStatus: unknown,
  targetStatus: PrepShipOrderStatus | null,
): boolean {
  return currentStatus === 'awaiting_shipment' && targetStatus !== null && targetStatus !== 'awaiting_shipment';
}

function aggregateTerminalDuplicateStatus(statuses: unknown[]): PrepShipOrderStatus | null {
  const normalized = statuses
    .map((status) => cleanStatus(status))
    .filter(Boolean);
  if (!normalized.length) return null;
  if (normalized.includes('awaiting_shipment')) return null;
  if (normalized.includes('shipped')) return 'shipped';
  if (normalized.every((status) => status === 'cancelled' || status === 'canceled')) return 'cancelled';
  return null;
}

export async function hasExistingMarketplaceOrderRow(
  sql: MarketplaceSql,
  provider: MarketplaceProvider,
  orderNumber: string | null | undefined,
): Promise<boolean> {
  const normalizedOrderNumber = String(orderNumber ?? '').trim();
  if (!normalizedOrderNumber) return false;
  const syntheticPrefix = `${provider}-%`;
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
    FROM orders
    WHERE order_number = ${normalizedOrderNumber}
      AND external_order_id NOT LIKE ${syntheticPrefix}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function loadStoreOrderStatuses(
  sql: MarketplaceSql,
  options: {
    provider: MarketplaceProvider;
    storeAccountId?: number | null;
    orderNumbers?: string[];
  },
): Promise<Array<{ orderNumber: string; sourceStatus: string | null }>> {
  const orderNumbers = [...new Set((options.orderNumbers ?? []).map((value) => value.trim()).filter(Boolean))];
  const storeAccountId = Number.isFinite(options.storeAccountId)
    ? Number(options.storeAccountId)
    : null;

  if (storeAccountId !== null && orderNumbers.length > 0) {
    return sql<Array<{ orderNumber: string; sourceStatus: string | null }>>`
      SELECT customer_order_id AS "orderNumber", source_status AS "sourceStatus"
      FROM store_orders
      WHERE provider = ${options.provider}
        AND carrier_account_id = ${storeAccountId}
        AND customer_order_id = ANY(${orderNumbers}::text[])
        AND customer_order_id IS NOT NULL
    `;
  }

  if (storeAccountId !== null) {
    return sql<Array<{ orderNumber: string; sourceStatus: string | null }>>`
      SELECT customer_order_id AS "orderNumber", source_status AS "sourceStatus"
      FROM store_orders
      WHERE provider = ${options.provider}
        AND carrier_account_id = ${storeAccountId}
        AND customer_order_id IS NOT NULL
    `;
  }

  if (orderNumbers.length > 0) {
    return sql<Array<{ orderNumber: string; sourceStatus: string | null }>>`
      SELECT customer_order_id AS "orderNumber", source_status AS "sourceStatus"
      FROM store_orders
      WHERE provider = ${options.provider}
        AND customer_order_id = ANY(${orderNumbers}::text[])
        AND customer_order_id IS NOT NULL
    `;
  }

  return sql<Array<{ orderNumber: string; sourceStatus: string | null }>>`
    SELECT customer_order_id AS "orderNumber", source_status AS "sourceStatus"
    FROM store_orders
    WHERE provider = ${options.provider}
      AND customer_order_id IS NOT NULL
  `;
}

export async function reconcileMarketplaceOrderStatuses(
  sql: MarketplaceSql,
  options: {
    provider: MarketplaceProvider;
    storeAccountId?: number | null;
    orderNumbers?: string[];
    dryRun?: boolean;
    applyLifecycleCommand?: (
      input: OrderLifecycleCommandInput,
    ) => Promise<OrderLifecycleCommandResult>;
  },
): Promise<MarketplaceReconciliationResult> {
  const dryRun = options.dryRun !== false;
  const sourceRows = await loadStoreOrderStatuses(sql, options);
  const statusesByOrderNumber = new Map<string, string[]>();

  for (const row of sourceRows) {
    const orderNumber = String(row.orderNumber ?? '').trim();
    if (!orderNumber) continue;
    const statuses = statusesByOrderNumber.get(orderNumber) ?? [];
    statuses.push(String(row.sourceStatus ?? ''));
    statusesByOrderNumber.set(orderNumber, statuses);
  }

  const result: MarketplaceReconciliationResult = {
    provider: options.provider,
    dryRun,
    checkedOrderNumbers: statusesByOrderNumber.size,
    updated: 0,
    candidates: [],
    skipped: [],
  };

  const syntheticPrefix = `${options.provider}-%`;
  for (const [orderNumber, sourceStatuses] of statusesByOrderNumber) {
    const targetStatus = aggregateMarketplaceOrderStatus(sourceStatuses, options.provider);
    if (!targetStatus || targetStatus === 'awaiting_shipment') {
      const realRows = await sql<Array<{ currentStatus: string }>>`
        SELECT order_status AS "currentStatus"
        FROM orders
        WHERE order_number = ${orderNumber}
          AND external_order_id NOT LIKE ${syntheticPrefix}
      `;
      const duplicateTargetStatus = aggregateTerminalDuplicateStatus(
        realRows.map((row) => row.currentStatus),
      );
      if (duplicateTargetStatus) {
        const syntheticRows = await sql<Array<{
          id: number;
          orderNumber: string;
          externalOrderId: string;
          currentStatus: string;
        }>>`
          SELECT
            id,
            order_number AS "orderNumber",
            external_order_id AS "externalOrderId",
            order_status AS "currentStatus"
          FROM orders
          WHERE order_number = ${orderNumber}
            AND order_status = 'awaiting_shipment'
            AND external_order_id LIKE ${syntheticPrefix}
          ORDER BY id
        `;

        for (const candidate of syntheticRows) {
          if (!shouldUpdateMarketplaceOrderStatus(candidate.currentStatus, duplicateTargetStatus)) continue;
          result.candidates.push({
            ...candidate,
            targetStatus: duplicateTargetStatus,
            sourceStatuses: [...sourceStatuses, `shipstation_duplicate:${duplicateTargetStatus}`],
          });
        }

        if (!syntheticRows.length) {
          result.skipped.push({
            orderNumber,
            reason: 'terminal ShipStation duplicate exists but no awaiting synthetic row matched',
            sourceStatuses,
            targetStatus: duplicateTargetStatus,
          });
        }
        continue;
      }

      result.skipped.push({
        orderNumber,
        reason: targetStatus === 'awaiting_shipment' ? 'marketplace still open' : 'unrecognized marketplace status',
        sourceStatuses,
        targetStatus,
      });
      continue;
    }

    const realRows = await sql<Array<{
      id: number;
      orderNumber: string;
      externalOrderId: string;
      currentStatus: string;
    }>>`
      SELECT
        id,
        order_number AS "orderNumber",
        external_order_id AS "externalOrderId",
        order_status AS "currentStatus"
      FROM orders
      WHERE order_number = ${orderNumber}
        AND order_status = 'awaiting_shipment'
        AND external_order_id NOT LIKE ${syntheticPrefix}
      ORDER BY id
    `;

    let candidates = realRows.filter((row) => shouldUpdateMarketplaceOrderStatus(row.currentStatus, targetStatus));
    if (realRows.length > 0 && candidates.length === 0) {
      result.skipped.push({
        orderNumber,
        reason: 'real ShipStation row already owns order number or is not awaiting',
        sourceStatuses,
        targetStatus,
      });
      continue;
    }

    if (!realRows.length) {
      // Direct marketplace-only orders can exist as a synthetic marketplace row.
      // Reconcile that row only when no real ShipStation/non-synthetic row owns the order number.
      const syntheticRows = await sql<Array<{
        id: number;
        orderNumber: string;
        externalOrderId: string;
        currentStatus: string;
      }>>`
        SELECT
          id,
          order_number AS "orderNumber",
          external_order_id AS "externalOrderId",
          order_status AS "currentStatus"
        FROM orders
        WHERE order_number = ${orderNumber}
          AND order_status = 'awaiting_shipment'
          AND external_order_id LIKE ${syntheticPrefix}
        ORDER BY id
      `;

      candidates = syntheticRows.filter((row) => shouldUpdateMarketplaceOrderStatus(row.currentStatus, targetStatus));
    }

    if (!candidates.length) {
      result.skipped.push({
        orderNumber,
        reason: 'no visible awaiting marketplace row matched',
        sourceStatuses,
        targetStatus,
      });
      continue;
    }

    for (const candidate of candidates) {
      if (!shouldUpdateMarketplaceOrderStatus(candidate.currentStatus, targetStatus)) continue;
      result.candidates.push({
        ...candidate,
        targetStatus,
        sourceStatuses,
      });
    }
  }

  if (!dryRun && result.candidates.length > 0) {
    const lifecycleCommand = options.applyLifecycleCommand ??
      (await import('./order-lifecycle-command.js')).applyOrderLifecycleCommand;
    for (const candidate of result.candidates) {
      // Per user override unlock shipped data on 2026-05-23: promote only
      // rows that are still awaiting after marketplace/duplicate evidence
      // proves they are terminal; never rewrite existing shipped/cancelled rows.
      // Per user override unlock shipped data on 2026-07-16: marketplace
      // status without shipment lines creates review state, not full-order claims.
      const command = await lifecycleCommand({
        orderId: candidate.id,
        commandKey:
          `lifecycle:marketplace:${options.provider}:${options.storeAccountId ?? 'all'}:` +
          `${candidate.externalOrderId}:order:${candidate.id}:${candidate.targetStatus}`,
        transition: candidate.targetStatus === 'shipped' ? 'external_shipped' : 'cancelled',
        source: `marketplace_status:${options.provider}`,
        canonicalStatus: candidate.targetStatus,
        requireAwaitingOrderStatus: true,
        externallyShippedSource:
          candidate.targetStatus === 'shipped' ? `marketplace_status:${options.provider}` : undefined,
        fulfillmentFacts: candidate.targetStatus === 'shipped'
          ? {
              kind: 'unavailable',
              description: 'Marketplace order status did not contain exact fulfilled line quantities',
            }
          : { kind: 'none' },
        provenance: { sourceStatuses: candidate.sourceStatuses },
      });
      if (command.statusChanged) result.updated += 1;
    }
  }

  return result;
}
