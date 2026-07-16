import { and, eq, gte, notInArray, sql } from 'drizzle-orm';
import { getShipStationOrderExistence } from '../connectors/store/shipstation';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { selectShipStationDeletedAwaitingCandidates } from './shipstation-deleted-awaiting-policy';
import { applyOrderLifecycleCommand } from './order-lifecycle-command';

const MAX_VERIFIED_DELETIONS_PER_TARGET = 1;
const MAX_LOCAL_CANDIDATES_PER_TARGET = 10;

type ReconcileDeletedAwaitingInput = {
  accountLabel: string;
  apiKey?: string;
  apiSecret?: string;
  storeId: number;
  sinceMs: number;
  liveSourceOrderIds: ReadonlySet<string>;
  signal?: AbortSignal;
};

export type ReconcileDeletedAwaitingResult = {
  checked: number;
  cancelled: number;
  errors: number;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('ShipStation deleted-order reconciliation aborted');
}

const noActiveShipment = sql`not exists (
  select 1
  from ${shipments} deleted_awaiting_shipment
  where (
      deleted_awaiting_shipment.order_id = ${orders.id}
      or (
        deleted_awaiting_shipment.order_id is null
        and deleted_awaiting_shipment.order_number = ${orders.orderNumber}
      )
    )
    and coalesce(deleted_awaiting_shipment.voided, false) = false
    and coalesce(deleted_awaiting_shipment.is_return, false) = false
)`;

/**
 * Reconciles a bounded number of local awaiting rows only after order-sync has
 * completed the full live-awaiting page walk for the owning account/store.
 */
export async function reconcileDeletedShipStationAwaiting(
  input: ReconcileDeletedAwaitingInput,
): Promise<ReconcileDeletedAwaitingResult> {
  throwIfAborted(input.signal);
  const liveIds = [...input.liveSourceOrderIds];
  const rows = await db
    .select({
      id: orders.id,
      externalOrderId: orders.externalOrderId,
      orderStatus: orders.orderStatus,
      canonicalStatus: orders.canonicalStatus,
      externallyShipped: orders.externallyShipped,
      sourceProvider: orders.sourceProvider,
      hasActiveShipment: sql<boolean>`not (${noActiveShipment})`.as('has_active_shipment'),
    })
    .from(orders)
    .where(and(
      eq(orders.storeId, input.storeId),
      eq(orders.orderStatus, 'awaiting_shipment'),
      eq(orders.sourceProvider, 'shipstation'),
      gte(orders.orderDate, new Date(input.sinceMs)),
      sql`${orders.externalOrderId} ~ '^[0-9]+$'`,
      noActiveShipment,
      liveIds.length > 0 ? notInArray(orders.externalOrderId, liveIds) : undefined,
    ))
    .orderBy(orders.updatedAt)
    .limit(MAX_LOCAL_CANDIDATES_PER_TARGET);

  const candidates = selectShipStationDeletedAwaitingCandidates(
    rows,
    input.liveSourceOrderIds,
    MAX_VERIFIED_DELETIONS_PER_TARGET,
  );
  let checked = 0;
  let cancelled = 0;
  let errors = 0;

  for (const candidate of candidates) {
    throwIfAborted(input.signal);
    const externalOrderId = String(candidate.externalOrderId);
    try {
      const existence = await getShipStationOrderExistence(externalOrderId, {
        apiKey: input.apiKey,
        apiSecret: input.apiSecret,
        dedupeKey: `orders:deleted-awaiting:${input.accountLabel}:${externalOrderId}`,
        timeoutMs: 25_000,
        signal: input.signal,
      });
      checked += 1;
      if (existence !== 'deleted') continue;

      // Per user override unlock shipped data on 2026-07-14: this final guard
      // permits only a verified deleted awaiting row to move forward to
      // cancelled; existing shipped/cancelled rows and active labels are untouched.
      // Per user override unlock shipped data on 2026-07-16 (PS-424): the
      // lifecycle owner repeats the no-active-shipment check while holding the
      // order lock, then atomically records cancellation provenance.
      const command = await applyOrderLifecycleCommand({
        orderId: candidate.id,
        commandKey:
          `lifecycle:shipstation-deleted:${input.accountLabel}:${input.storeId}:` +
          `${externalOrderId}:order:${candidate.id}:cancelled`,
        transition: 'cancelled',
        source: `shipstation_deleted:${input.accountLabel}`,
        canonicalStatus: 'cancelled',
        requireAwaitingOrderStatus: true,
        requireNoActiveOutboundShipment: true,
        fulfillmentFacts: { kind: 'none' },
        provenance: { storeId: input.storeId, externalOrderId },
      });
      if (command.statusChanged) cancelled += 1;
    } catch (error) {
      throwIfAborted(input.signal);
      errors += 1;
      console.warn(
        `[order-sync] deleted-awaiting verification failed account="${input.accountLabel}" storeId=${input.storeId}; row left unchanged:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (cancelled > 0) {
    console.log(
      `[order-sync] reconciled ${cancelled} verified deleted awaiting order(s) account="${input.accountLabel}" storeId=${input.storeId}`,
    );
  }
  return { checked, cancelled, errors };
}
