import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { clients } from '../db/schema/clients';
import { shipments } from '../db/schema/shipments';
import { getSettingNumber, setSetting } from './settings';
import { getJsonSetting, setJsonSetting } from './settings-json';
import { env } from '../lib/env';
import { isExcludedStoreId } from '../config/prepship';
import {
  upsertNormalizedStoreOrders,
  type NormalizedStoreOrder,
} from './store-order-import';
import {
  buildOrderSourceIdentity,
  legacyExternalOrderIdForSource,
  orderSourceIdentitiesPredicate,
  orderSourceIdentityKey,
  orderSourceIdentityOrLegacyPredicate,
  type OrderSourceIdentity,
} from './order-source-identity';
import { applyOrderLifecycleCommand } from './order-lifecycle-command';
import { importStoreOrders } from './store-connector-orchestrator';
import type { NormalizedOrder } from '../connectors/types';
import { formatShipStationV1DateParam } from '../lib/shipstation/v1-date';
import {
  type SyncRunBudget,
  createSyncRunBudget,
  syncRunBudgetExhausted,
  syncRunBudgetTimeExhausted,
} from '../lib/sync-run-budget';
import {
  filterShipStationStoreIdsForCutover,
} from './store-source-cutover-policy';
import {
  loadActiveShipStationCutoverStoreIds,
} from './store-source-cutover';
import {
  markShipStationSyncAccountDeferred,
  markShipStationSyncAccountFailed,
  markShipStationSyncAccountStarted,
  markShipStationSyncAccountSucceeded,
  readShipStationSyncAccountStates,
  shipStationSyncAccountDisplayName,
  shipStationSyncAccountId,
  shipStationSyncWatermarkKeys,
  summarizeShipStationAccountWatermarks,
  type ShipStationSyncRunIdentity,
} from './shipstation-sync-account-state';
import { isOrderSyncCooperativeYieldError } from '../lib/order-sync-cooperative-yield';
import {
  orderSyncQueueState,
  readOrderSyncQueueTruth,
  type OrderSyncQueueState,
  type OrderSyncQueueTruth,
} from './order-sync-queue-state';
import { reconcileDeletedShipStationAwaiting } from './shipstation-deleted-awaiting-reconciliation';
import { SYNC_JOB_RUNNING_LEASE_MS } from '../lib/sync-job-deadline';

const LAST_SYNC_KEY = 'order_sync.last_modified_ms';
const STATUS_CATCHUP_SNAPSHOT_KEY = 'order_sync.status_catchup.snapshot';
const AWAITING_RESUME_CURSOR_KEY_PREFIX = 'order_sync.awaiting_resume_page';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 30; // 30 days on first run
const STATUS_CATCHUP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const AWAITING_CATCHUP_LOOKBACK_MS = STATUS_CATCHUP_LOOKBACK_MS;
// Per user override unlock shipped data on 2026-07-07: keep the order/status
// sync lane fresh enough to import ShipStation split children without
// reopening existing shipped/cancelled rows.
const DEFAULT_ORDER_SYNC_PAGE_SIZE = 100;
// Per user override unlock shipped data on 2026-07-02: background order sync
// must finish and release the shared ShipStation lane. Slow provider calls are
// retried on the next 3-minute tick instead of burning the 10-minute job guard.
const BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS = 25_000;

function throwIfOrderSyncAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Order sync attempt aborted');
}

async function buildStoreToClientMap(): Promise<{
  byStore: Map<number, number>;
  newPairs: Array<{ storeId: number; clientId: number }>;
}> {
  const rows = await db
    .select({ id: clients.id, storeIds: clients.storeIds })
    .from(clients);
  const byStore = new Map<number, number>();
  for (const c of rows) {
    for (const sid of c.storeIds ?? []) {
      if (!isExcludedStoreId(sid)) byStore.set(sid, c.id);
    }
  }
  return { byStore, newPairs: [] };
}

// Batched UPDATE that pushes the store_ids mappings discovered during the
// sync pass onto each client row. Runs once per sync (outside the hot
// loop) so the pg array-binding issue doesn't surface per-row.
async function flushNewStorePairs(
  pairs: Array<{ storeId: number; clientId: number }>
): Promise<void> {
  if (!pairs.length) return;
  const byClient = new Map<number, Set<number>>();
  for (const p of pairs) {
    if (isExcludedStoreId(p.storeId)) continue;
    if (!byClient.has(p.clientId)) byClient.set(p.clientId, new Set());
    byClient.get(p.clientId)!.add(p.storeId);
  }
  for (const [clientId, storeIdSet] of byClient) {
    const cid = Math.trunc(clientId);
    const storeIds = [...storeIdSet].map((n) => Math.trunc(n));
    // PS-254 (Card 9): PIN the integer invariant that makes this sql.raw injection-safe,
    // instead of trusting only the upstream comment. A non-integer (e.g. NaN from a future
    // coercion change) can never be spliced into the SQL — we skip the row instead. We keep
    // sql.raw (not parameterized arrays) on purpose: it sidesteps the pg array-binding issue.
    if (!Number.isInteger(cid) || !storeIds.every(Number.isInteger)) continue;
    const storeList = storeIds.join(',');
    if (!storeList) continue;
    await db.execute(
      sql.raw(
        `update clients set store_ids = array(select distinct unnest(
           coalesce(store_ids, array[]::integer[]) || array[${storeList}]::integer[]
         )), updated_at = now() where id = ${cid}`
      )
    );
  }
}

// Batched upsert — writes a page of orders in a single INSERT ... ON CONFLICT
// DO UPDATE instead of N sequential round-trips. ~10x faster than the old
// per-order loop for large backfills.
//
// Preserves the same semantics as the old single-row version:
//   - isTest clients sync like v2; label creation keeps them in test mode
//   - fallbackClientId auto-attaches orders to their owner account
//   - externallyShipped is only overwritten when the incoming row
//     affirmatively sets it (preserves user-set flags on routine syncs)
function normalizedStatusToOrderStatus(status: NormalizedOrder['canonicalStatus']): string {
  return status === 'on_hold' ? 'awaiting_shipment' : status;
}

function normalizedStoreId(order: NormalizedOrder): number | null {
  const value = order.storeId == null ? null : Number(order.storeId);
  return Number.isFinite(value) ? Math.trunc(value as number) : null;
}

function toShipStationNormalizedStoreOrder(
  o: NormalizedOrder,
  args: {
    clientId: number | null;
    storeId: number | null;
  },
): NormalizedStoreOrder {
  const raw = o.rawPayload && typeof o.rawPayload === 'object'
    ? o.rawPayload as Record<string, unknown>
    : {};
  return {
    externalOrderId: o.sourceOrderId,
    source: {
      sourceProvider: o.sourceProvider,
      sourceAccountId: o.sourceAccountId,
      sourceOrderId: o.sourceOrderId,
      sourceOrderNumber: o.sourceOrderNumber,
      rawSourcePayload: raw,
    },
    orderNumber: o.sourceOrderNumber ?? o.sourceOrderId,
    orderStatus: normalizedStatusToOrderStatus(o.canonicalStatus),
    orderDate: o.orderDate ?? null,
    clientId: args.clientId,
    storeId: args.storeId,
    customerEmail: o.customerEmail ?? null,
    shipToName: o.customerName ?? null,
    shipToCity: o.shipToCity ?? null,
    shipToState: o.shipToState ?? null,
    shipToPostalCode: o.shipToPostalCode ?? null,
    carrierCode: o.carrierCode ?? null,
    serviceCode: o.serviceCode ?? null,
    weightOz: o.weightOz ?? null,
    orderTotal: o.orderTotal ?? '0',
    shippingAmount: Number.isFinite(o.shippingPaid as number) ? (o.shippingPaid as number).toFixed(2) : '0',
    items: o.items ?? [],
    raw,
    externallyShipped: o.externallyShipped === true,
  };
}

function buildNormalizedStoreOrders(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): NormalizedStoreOrder[] {
  const normalizedOrders: NormalizedStoreOrder[] = [];
  for (const o of ordersIn) {
    const storeId = normalizedStoreId(o);
    if (isExcludedStoreId(storeId)) continue;
    let clientId =
      storeId !== null ? storeToClient.byStore.get(storeId) ?? null : null;
    if (clientId === null && fallbackClientId !== null) {
      clientId = fallbackClientId;
      if (storeId !== null) {
        storeToClient.byStore.set(storeId, fallbackClientId);
        storeToClient.newPairs?.push({ storeId, clientId: fallbackClientId });
      }
    }
    normalizedOrders.push(toShipStationNormalizedStoreOrder(o, { clientId, storeId }));
  }
  return normalizedOrders;
}

async function upsertOrdersBatch(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null
): Promise<number> {
  if (!ordersIn.length) return 0;
  const normalizedOrders = buildNormalizedStoreOrders(ordersIn, storeToClient, fallbackClientId);
  return upsertNormalizedStoreOrders(normalizedOrders);

}

async function upsertMissingShippedOrdersBatch(
  ordersIn: NormalizedOrder[],
  storeToClient: {
    byStore: Map<number, number>;
    newPairs?: Array<{ storeId: number; clientId: number }>;
  },
  fallbackClientId: number | null = null,
): Promise<number> {
  const normalizedOrders = buildNormalizedStoreOrders(ordersIn, storeToClient, fallbackClientId);
  const keyedOrders = normalizedOrders
    .map((order) => {
      const identity = buildOrderSourceIdentity(order.source);
      return identity ? { order, identity, legacyExternalOrderId: order.externalOrderId ?? legacyExternalOrderIdForSource(identity) } : null;
    })
    .filter((entry): entry is { order: NormalizedStoreOrder; identity: OrderSourceIdentity; legacyExternalOrderId: string } => entry !== null);
  if (!keyedOrders.length) return 0;

  const existingPredicate = orderSourceIdentityOrLegacyPredicate({
    identities: keyedOrders.map((entry) => entry.identity),
    legacyExternalOrderIds: keyedOrders.map((entry) => entry.legacyExternalOrderId),
    includeUnqualifiedShipStationLegacy: true,
  });
  if (!existingPredicate) return 0;
  const existingRows = await db
    .select({
      externalOrderId: orders.externalOrderId,
      sourceProvider: orders.sourceProvider,
      sourceAccountId: orders.sourceAccountId,
      sourceOrderId: orders.sourceOrderId,
    })
    .from(orders)
    .where(existingPredicate);
  const existingSourceKeys = new Set<string>();
  const existingLegacyExternalIds = new Set<string>();
  for (const row of existingRows) {
    const identity = buildOrderSourceIdentity(row);
    if (identity) existingSourceKeys.add(orderSourceIdentityKey(identity));
    if (row.externalOrderId) existingLegacyExternalIds.add(row.externalOrderId);
  }

  const missingEntries = keyedOrders.filter(
    (entry) =>
      !existingSourceKeys.has(orderSourceIdentityKey(entry.identity)) &&
      !existingLegacyExternalIds.has(entry.legacyExternalOrderId)
  );
  if (!missingEntries.length) return 0;
  const missingOrders = missingEntries.map((entry) => entry.order);

  // Per user override `unlock shipped data` on 2026-05-29: shipped ShipStation
  // orders that were created and shipped before PrepShip saw the awaiting row
  // must be imported so Inventory History can deduct from real order items.
  // This is insert-only for missing shipped rows; existing shipped/cancelled
  // protections and the inventory auto-deduct kill switch remain in force.
  await upsertNormalizedStoreOrders(missingOrders, {
    inventoryDeductionSource: 'order_sync_status',
  });

  const insertedPredicate = orderSourceIdentitiesPredicate(missingEntries.map((entry) => entry.identity));
  if (!insertedPredicate) return 0;
  const insertedRows = await db
    .select()
    .from(orders)
    .where(insertedPredicate);

  let shipmentsLinked = 0;
  let shippedHydrated = 0;
  for (const row of insertedRows) {
    if (row.orderStatus !== 'shipped') continue;
    shippedHydrated += 1;
    const linked = await db
      .update(shipments)
      .set({ orderId: row.id, clientId: row.clientId, updatedAt: new Date() })
      .where(
        and(
          isNull(shipments.orderId),
          eq(shipments.orderNumber, row.orderNumber)
        )
      )
      .returning({ id: shipments.id });
    shipmentsLinked += linked.length;
  }

  // Observability (PS-046): redacted counts only — no order numbers, no PII,
  // no raw provider payloads. Lets the operator/runbook confirm the
  // never-imported-while-awaiting recovery path is actually healing orphans.
  if (insertedRows.length) {
    console.log(
      `[order-sync] hydrated ${insertedRows.length} missing order(s) ` +
        `(${shippedHydrated} shipped), linked ${shipmentsLinked} orphan shipment(s)`,
    );
  }

  return insertedRows.length;
}

// Per user override unlock shipped data on 2026-06-10: status catch-up now covers the non-awaiting,
// non-shipped ShipStation states (on_hold / awaiting_payment / pending_fulfillment) in addition to
// shipped/cancelled, so PrepShip's awaiting list converges to ShipStation's — orders SS puts On Hold /
// Pending no longer rot in PrepShip's "Awaiting Shipment". Only 'shipped' triggers inventory deduction.
export type CatchUpOrderStatus =
  | 'shipped'
  | 'cancelled'
  | 'on_hold'
  | 'awaiting_payment'
  | 'pending_fulfillment';

export type OrderStatusCatchupPass = {
  orderStatus: CatchUpOrderStatus;
  sinceMs: number;
  storeId?: number;
};

const STATUS_CATCHUP_STATUSES: CatchUpOrderStatus[] = [
  'shipped',
  'cancelled',
  'on_hold',
  'awaiting_payment',
  'pending_fulfillment',
];

type StatusCatchupStopReason =
  | 'complete'
  | 'page_budget'
  | 'time_budget'
  | 'page_count_changed'
  | 'failed'
  | 'not_started_budget_exhausted';

export type AwaitingOrderCursorState = {
  version: 1;
  accountId: string;
  storeId: number | null;
  sinceMs: number;
  untilMs: number;
  sortDir: 'DESC';
  pageSize: number;
  nextPage: number;
  totalPages: number;
  totalOrders: number;
  hasBacklog: boolean;
  backlogPages: number;
  stoppedBy: Extract<
    StatusCatchupStopReason,
    'complete' | 'page_budget' | 'time_budget' | 'page_count_changed'
  >;
  checkedAt: string;
  /**
   * PS-484: consecutive passes where this cursor carried a backlog and `nextPage`
   * did NOT advance. Mirrors OrderStatusCatchupEntry.stalledPasses and is computed
   * by the same shared rule, so "stuck" means one thing across both cursors.
   */
  stalledPasses: number;
};

export type OrderStatusCatchupEntry = {
  accountLabel: string;
  storeId: number | null;
  orderStatus: CatchUpOrderStatus;
  sinceIso: string;
  sortDir: 'DESC';
  pageSize: number;
  startPage: number;
  totalPages: number | null;
  pagesProcessed: number;
  lastPageProcessed: number;
  nextPage: number | null;
  updatedRows: number;
  hasBacklog: boolean;
  backlogPages: number | null;
  stoppedBy: StatusCatchupStopReason;
  checkedAt: string;
  /**
   * PS-431: consecutive passes where this entry carried a backlog and `nextPage`
   * did NOT advance. Zero means the backlog is draining normally.
   *
   * A page-budgeted catch-up ALWAYS leaves pages behind on any store with more
   * pages than the budget, so `hasBacklog` alone cannot distinguish "working
   * through it" from "wedged". Store 378060 has 13 pages of shipped orders
   * against a 10-page budget: it stops at 10 (backlog), resumes at 11 and
   * completes, restarts at 1 and backlogs again -- forever, while updating zero
   * rows. That alternation is what made the watchdog flap red/green 12 times in
   * 20 runs and is not a fault.
   */
  stalledPasses: number;
};

export type OrderStatusCatchupSnapshot = {
  version: 1;
  updatedAt: string | null;
  hasBacklog: boolean;
  backlogCount: number;
  /** PS-431: entries whose backlog has not advanced for STALLED_PASS_ALERT_THRESHOLD passes. */
  stalledCount: number;
  entries: OrderStatusCatchupEntry[];
};

/**
 * PS-431. Consecutive non-advancing passes before a backlog counts as wedged.
 *
 * Three keeps detection inside the card's ~10 minute target at the observed
 * catch-up cadence, while being longer than the one-pass dip a store larger
 * than the page budget produces on every cycle.
 */
export const STALLED_PASS_ALERT_THRESHOLD = 3;

function emptyStatusCatchupSnapshot(): OrderStatusCatchupSnapshot {
  return {
    version: 1,
    updatedAt: null,
    hasBacklog: false,
    backlogCount: 0,
    stalledCount: 0,
    entries: [],
  };
}

export async function getOrderStatusCatchupSnapshot(): Promise<OrderStatusCatchupSnapshot> {
  const parsed = await getJsonSetting<Partial<OrderStatusCatchupSnapshot>>(
    STATUS_CATCHUP_SNAPSHOT_KEY,
  );
  if (!parsed || !Array.isArray(parsed.entries)) return emptyStatusCatchupSnapshot();
  const entries = parsed.entries
    .filter((entry): entry is OrderStatusCatchupEntry => {
      return Boolean(
        entry &&
          typeof entry.accountLabel === 'string' &&
          typeof entry.orderStatus === 'string' &&
          typeof entry.hasBacklog === 'boolean',
      );
    })
    // PS-431: snapshots written before stalledPasses existed have no counter.
    // Default to 0 (draining) rather than treating unknown history as wedged --
    // a stall has to be observed across passes to be claimed.
    .map((entry) => ({
      ...entry,
      stalledPasses: Number.isFinite(entry.stalledPasses) ? entry.stalledPasses : 0,
    }));
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    hasBacklog: entries.some((entry) => entry.hasBacklog),
    backlogCount: entries.filter((entry) => entry.hasBacklog).length,
    stalledCount: entries.filter(
      (entry) => entry.hasBacklog && entry.stalledPasses >= STALLED_PASS_ALERT_THRESHOLD,
    ).length,
    entries,
  };
}

async function persistOrderStatusCatchupSnapshot(
  entries: OrderStatusCatchupEntry[],
  updatedAtMs: number,
  previous: OrderStatusCatchupSnapshot,
  accounts: SyncAccount[],
): Promise<void> {
  const activeKeys = new Set(
    accounts.flatMap((account) =>
      STATUS_CATCHUP_STATUSES.flatMap((orderStatus) =>
        statusCatchupStoreTargets(account).map((target) =>
          statusCatchupEntryKey({
            accountLabel: account.label,
            storeId: target.storeId ?? null,
            orderStatus,
          }),
        ),
      ),
    ),
  );
  const mergedEntries = mergeOrderStatusCatchupEntries(previous.entries, entries, activeKeys);
  const snapshot: OrderStatusCatchupSnapshot = {
    version: 1,
    updatedAt: new Date(updatedAtMs).toISOString(),
    hasBacklog: mergedEntries.some((entry) => entry.hasBacklog),
    backlogCount: mergedEntries.filter((entry) => entry.hasBacklog).length,
    stalledCount: mergedEntries.filter(
      (entry) => entry.hasBacklog && entry.stalledPasses >= STALLED_PASS_ALERT_THRESHOLD,
    ).length,
    entries: mergedEntries,
  };
  await setJsonSetting(STATUS_CATCHUP_SNAPSHOT_KEY, snapshot);
}

/**
 * PS-431 / PS-484. A backlog is only a fault if it stops moving.
 *
 * Draining normally -- including the every-other-pass restart of a store whose
 * page count exceeds the pass budget -- resets the counter, because either the
 * backlog cleared or `nextPage` advanced. Only a backlog that persists across
 * passes with the cursor pinned to the same page increments it.
 *
 * Shared by BOTH paginated cursors (status catch-up and awaiting) so the two
 * cannot drift into different definitions of "stuck". PS-484 was filed because
 * they already had: the status path learned this rule and the awaiting path did
 * not, so an account could still be called stale for healthy paginated progress.
 */
function nextStalledPassCount(
  previous: { hasBacklog: boolean; nextPage: number | null; stalledPasses?: number } | null | undefined,
  current: { hasBacklog: boolean; nextPage: number | null },
): number {
  if (!current.hasBacklog) return 0;
  if (!previous?.hasBacklog) return 0;
  if (previous.nextPage !== current.nextPage) return 0;
  const prior = previous.stalledPasses;
  return (typeof prior === 'number' && Number.isFinite(prior) ? prior : 0) + 1;
}

function nextStalledPasses(
  previous: OrderStatusCatchupEntry | undefined,
  current: OrderStatusCatchupEntry,
): number {
  return nextStalledPassCount(previous, current);
}

/**
 * PS-484. Whether one ShipStation sync account counts as stale.
 *
 * Extracted from the diagnostics loop so the rule is directly testable. It was inline
 * and consequently untested: reverting the fix below left every sync guard green.
 *
 * The correction: a backlog only counts once it has STOPPED DRAINING. Both backlog
 * clauses used to read `.length > 0`, so ANY backlog made the account stale and healthy
 * paginated progress reported as a fault. Store 378060 carries 13 pages of shipped
 * orders against a 10-page pass budget, so it has a backlog on every other pass
 * forever while updating zero rows -- the same non-fault PS-431 fixed one layer up in
 * the watchdog verdict, of which this flag was the half that never learned it.
 *
 * Narrowing loses no real detection. A backlog whose watermark has stopped advancing is
 * already caught by the age clause; a failed pass by `failed`. What only these clauses
 * can catch is a backlog that never drains while the watermark keeps moving, and that
 * is exactly what stalledPasses measures.
 */
export function isOrderSyncAccountStale(input: {
  failed: boolean;
  watermarkMs: number | null;
  ageMs: number | null;
  freshMs: number;
  statusBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
  awaitingBacklogEntries: ReadonlyArray<{ stalledPasses: number }>;
}): boolean {
  const stalled = (entries: ReadonlyArray<{ stalledPasses: number }>) =>
    entries.some((entry) => entry.stalledPasses >= STALLED_PASS_ALERT_THRESHOLD);
  return (
    input.failed ||
    input.watermarkMs === null ||
    (input.ageMs !== null && input.ageMs > input.freshMs) ||
    stalled(input.statusBacklogEntries) ||
    stalled(input.awaitingBacklogEntries)
  );
}

export function mergeOrderStatusCatchupEntries(
  previousEntries: OrderStatusCatchupEntry[],
  currentEntries: OrderStatusCatchupEntry[],
  activeKeys: ReadonlySet<string>,
): OrderStatusCatchupEntry[] {
  const merged = new Map<string, OrderStatusCatchupEntry>();
  for (const previous of previousEntries) {
    const key = statusCatchupEntryKey(previous);
    if (activeKeys.has(key)) merged.set(key, previous);
  }
  for (const current of currentEntries) {
    const key = statusCatchupEntryKey(current);
    const previous = merged.get(key);
    const shouldPreserveCursor =
      Boolean(previous?.hasBacklog) &&
      current.pagesProcessed === 0 &&
      (current.stoppedBy === 'failed' || current.stoppedBy === 'not_started_budget_exhausted');
    const resolved =
      shouldPreserveCursor && previous
        ? {
            ...current,
            startPage: previous.nextPage ?? previous.startPage,
            totalPages: previous.totalPages,
            lastPageProcessed: previous.lastPageProcessed,
            nextPage: previous.nextPage,
            hasBacklog: true,
            backlogPages: previous.backlogPages,
          }
        : current;
    merged.set(key, { ...resolved, stalledPasses: nextStalledPasses(previous, resolved) });
  }
  return [...merged.values()].sort((left, right) =>
    statusCatchupEntryKey(left).localeCompare(statusCatchupEntryKey(right)),
  );
}

async function updateExistingOrderStatusesBatch(
  ordersIn: NormalizedOrder[],
  orderStatus: CatchUpOrderStatus
): Promise<number> {
  const identities = ordersIn
    .map((order) => buildOrderSourceIdentity(order))
    .filter((identity): identity is OrderSourceIdentity => identity !== null);
  if (!identities.length) return 0;

  // v2 parity: shipped/cancelled sync is a status catch-up for orders already
  // loaded as awaiting_shipment. It must not insert shipped-only rows or
  // rewrite the original order details/date.
  let updated = 0;
  for (let i = 0; i < identities.length; i += 250) {
    const chunk = identities.slice(i, i + 250);
    const identityPredicate = orderSourceIdentityOrLegacyPredicate({
      identities: chunk,
      legacyExternalOrderIds: chunk.map(legacyExternalOrderIdForSource),
      includeUnqualifiedShipStationLegacy: true,
    });
    if (!identityPredicate) continue;
    if (orderStatus === 'shipped' || orderStatus === 'cancelled') {
      const terminalCandidates = await db
        .select({
          id: orders.id,
          sourceProvider: orders.sourceProvider,
          sourceAccountId: orders.sourceAccountId,
          sourceOrderId: orders.sourceOrderId,
          externalOrderId: orders.externalOrderId,
        })
        .from(orders)
        .where(and(
          identityPredicate,
          notInArray(orders.orderStatus, ['shipped', 'cancelled']),
          ne(orders.orderStatus, orderStatus),
        ));
      for (const row of terminalCandidates) {
        // Per user override unlock shipped data on 2026-07-16: order-level
        // status is not shipment-line proof; shipped status is review-only.
        const command = await applyOrderLifecycleCommand({
          orderId: row.id,
          commandKey:
            `lifecycle:order-sync:${row.sourceProvider ?? 'shipstation'}:` +
            `${row.sourceAccountId ?? 'legacy'}:${row.sourceOrderId ?? row.externalOrderId ?? row.id}:` +
            `${orderStatus}`,
          transition: orderStatus,
          source: 'order_sync_status',
          canonicalStatus: orderStatus,
          fulfillmentFacts: orderStatus === 'shipped'
            ? {
                kind: 'unavailable',
                description: 'Order status sync did not contain shipment-scoped line quantities',
              }
            : { kind: 'none' },
          provenance: {
            sourceProvider: row.sourceProvider,
            sourceAccountId: row.sourceAccountId,
            sourceOrderId: row.sourceOrderId,
            lineFacts: orderStatus === 'shipped' ? 'review_missing' : 'not_applicable',
          },
        });
        if (command.statusChanged) updated += 1;
      }
      continue;
    }

    // Non-terminal catch-up stays a direct status projection; it creates no
    // fulfillment side effect and is outside the terminal command boundary.
    const rows = await db.transaction(async (tx) => {
      const transitioned = await tx
        .update(orders)
        .set({ orderStatus, updatedAt: new Date() })
        .where(
          and(
          // Per user override unlock shipped data on 2026-07-06: PS-388
          // narrows status catch-up matching to the composite source identity,
          // with external_order_id fallback only for legacy/unqualified rows.
          identityPredicate,
          // Transition from ANY non-terminal state to the ShipStation-reported status. Terminal rows
          // (shipped/cancelled) are NEVER overwritten here — they stay locked/preserved (and the import
          // upsert preserves them too). `ne` skips no-op rewrites (e.g. on_hold -> on_hold). This lets
          // awaiting->on_hold AND a later on_hold->shipped both converge.
          notInArray(orders.orderStatus, ['shipped', 'cancelled']),
            ne(orders.orderStatus, orderStatus)
          )
        )
        .returning();
      return transitioned;
    });
    updated += rows.length;

    // Print Queue persistence: shipped/cancelled sync status does not mean a
    // warehouse operator physically printed the label. Active entries remain
    // until explicit operator confirmation or removal.
  }

  return updated;
}

export type SyncResult = {
  synced: number;
  pages: number;
  lastSyncedAt: string | null;
  sinceIso: string;
};

// A "SyncAccount" is a ShipStation login we pull orders from. v2-parity:
// one "main" account (env-level SHIPSTATION_API_KEY/SECRET) plus one per
// client that has its own ss_api_key stored on the clients table (e.g.
// KF Goods has its own ShipStation org).
export type SyncAccount = {
  label: string;               // for the per-account watermark + logs
  apiKey: string | undefined;  // undefined → use env default
  apiSecret: string | undefined;
  storeIds: number[];
  // When the account is a per-client account (ss_api_key set on a clients
  // row), `ownerClientId` lets upsertOrder attribute orphan orders to that
  // client instead of leaving them at clientId=null.
  ownerClientId: number | null;
};

type SyncClientRow = {
  id: number;
  name: string;
  storeIds: number[] | null;
  ssApiKey: string | null;
  ssApiSecret: string | null;
};

export function buildSyncAccountsFromClientRows(
  clientRows: SyncClientRow[],
): SyncAccount[] {
  // Per user override unlock shipped data on 2026-07-07: per-client
  // ShipStation credential stores must be pulled only through their owning
  // account, otherwise main sync repeats work and can starve awaiting imports.
  const mainStoreIds = [
    ...new Set(
      clientRows.flatMap((row) =>
        row.ssApiKey && row.ssApiSecret
          ? []
          : (row.storeIds ?? []).filter((sid) => !isExcludedStoreId(sid))
      )
    ),
  ];
  const accounts: SyncAccount[] = [
    {
      label: 'main',
      apiKey: undefined,
      apiSecret: undefined,
      storeIds: mainStoreIds,
      ownerClientId: null,
    },
  ];
  for (const r of clientRows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
        storeIds: (r.storeIds ?? []).filter((sid) => !isExcludedStoreId(sid)),
        ownerClientId: r.id,
      });
    }
  }
  return accounts;
}

async function loadSyncAccounts(): Promise<SyncAccount[]> {
  const clientRows = await db
    .select({
      id: clients.id,
      name: clients.name,
      storeIds: clients.storeIds,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.active, true));
  return buildSyncAccountsFromClientRows(clientRows);
}

async function readOrderSyncWatermark(
  account: SyncAccount,
): Promise<{ primaryKey: string; value: number | null }> {
  // Per user override unlock shipped data on 2026-07-14: migrate only sync
  // cursor metadata to immutable account identity; order edit locks are unchanged.
  const { primaryKey, legacyKey } = shipStationSyncWatermarkKeys(LAST_SYNC_KEY, account);
  const stableValue = await getSettingNumber(primaryKey);
  if (stableValue !== null || legacyKey === null) return { primaryKey, value: stableValue };
  return { primaryKey, value: await getSettingNumber(legacyKey) };
}

// v2-parity: one paginated pass for a (status, since) pair. Factored out so
// the 3-pass dispatch below can reuse the batched-upsert + inter-page-delay
// + dedupe-key logic.
async function fetchOrdersPage(
  account: SyncAccount,
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>,
  args: {
    orderStatus: string;
    sinceMs: number;
    untilMs?: number;
    pageSize: number;
    storeId?: number;
    statusOnly?: boolean;
    sortDir?: 'ASC' | 'DESC';
    startPage?: number;
    expectedTotalOrders?: number;
    probeFirstPageOnResume?: boolean;
    signal?: AbortSignal;
  },
  budget: SyncRunBudget = createSyncRunBudget(),
): Promise<{
  synced: number;
  pages: number;
  totalOrders: number;
  startPage: number;
  pagesProcessed: number;
  lastPageProcessed: number;
  complete: boolean;
  stoppedBy: Exclude<StatusCatchupStopReason, 'failed' | 'not_started_budget_exhausted'>;
  resumePage: number | null;
  liveSourceOrderIds: string[];
}> {
  const sinceParam = formatShipStationV1DateParam(args.sinceMs);
  const startPage = Math.max(1, Math.floor(Number(args.startPage ?? 1) || 1));
  let page = startPage;
  let pages = 1;
  let totalOrders = 0;
  let total = 0;
  let pagesThisPass = 0;
  let lastPageProcessed = 0;
  const liveSourceOrderIds = new Set<string>();
  let stoppedBy: Exclude<StatusCatchupStopReason, 'failed' | 'not_started_budget_exhausted'> =
    'complete';
  let resumePage: number | null = null;

  const processPage = async (
    pageToFetch: number,
  ): Promise<{ ordersLength: number; totalOrders: number }> => {
    throwIfOrderSyncAborted(args.signal);
    const res = await importStoreOrders('shipstation', {
      companyId: 0,
      accountId: account.label,
      credentials: {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
      },
      orderStatus: args.orderStatus,
      sinceMs: args.sinceMs,
      untilMs: args.untilMs,
      pageSize: args.pageSize,
      page: pageToFetch,
      storeId: args.storeId,
      sortDir: args.sortDir,
      dedupeKey: `orders:list:${account.label}:${args.orderStatus}:${args.storeId ?? 'all'}:${sinceParam}:${args.untilMs ?? 'open'}:${pageToFetch}:${args.pageSize}:${args.sortDir ?? 'ASC'}`,
      timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
      signal: args.signal,
    });
    // Per user override unlock shipped data on 2026-07-10: a timed-out queue
    // attempt must stop before any later order/status persistence begins.
    throwIfOrderSyncAborted(args.signal);
    for (const order of res.orders) {
      const sourceOrderId = String(order.sourceOrderId ?? '').trim();
      if (sourceOrderId) liveSourceOrderIds.add(sourceOrderId);
    }

    pages = res.pages ?? 1;
    totalOrders = Math.max(0, Math.floor(Number(res.total ?? 0) || 0));
    // Per user override unlock shipped data on 2026-05-27: this keeps the
    // existing forward-only shipped/cancelled catch-up behavior while routing
    // ShipStation order import through StoreConnector normalized output.
    if (args.statusOnly) {
      total += await updateExistingOrderStatusesBatch(
        res.orders,
        args.orderStatus as CatchUpOrderStatus,
      );
      if (args.orderStatus === 'shipped') {
        total += await upsertMissingShippedOrdersBatch(
          res.orders,
          storeToClient,
          account.ownerClientId,
        );
      }
    } else {
      total += await upsertOrdersBatch(
        res.orders,
        storeToClient,
        account.ownerClientId,
      );
    }

    pagesThisPass += 1;
    lastPageProcessed = Math.max(lastPageProcessed, pageToFetch);
    return { ordersLength: res.orders.length, totalOrders };
  };

  // Per user override unlock shipped data on 2026-07-07: resumable status
  // catch-up still probes page 1 first because ShipStation's DESC modified
  // ordering means today's terminal changes live there. Older backlog then
  // resumes from the stored page cursor so a large history does not restart
  // page 1 forever.
  if (
    startPage > 1 &&
    args.probeFirstPageOnResume !== false &&
    !syncRunBudgetTimeExhausted(budget)
  ) {
    const firstPage = await processPage(1);
    if (!firstPage.ordersLength || pages < startPage) {
      return {
        synced: total,
        pages,
        totalOrders,
        startPage,
        pagesProcessed: pagesThisPass,
        lastPageProcessed,
        complete: true,
        stoppedBy: 'complete',
        resumePage: null,
        liveSourceOrderIds: [...liveSourceOrderIds],
      };
    }
    if (syncRunBudgetExhausted(budget, pagesThisPass)) {
      return {
        synced: total,
        pages,
        totalOrders,
        startPage,
        pagesProcessed: pagesThisPass,
        lastPageProcessed,
        complete: false,
        stoppedBy: syncRunBudgetTimeExhausted(budget) ? 'time_budget' : 'page_budget',
        resumePage: null,
        liveSourceOrderIds: [...liveSourceOrderIds],
      };
    }
  }

  while (!syncRunBudgetTimeExhausted(budget)) {
    const res = await processPage(page);
    const rebasedPage = awaitingOrderPageCountRebasePage({
      startPage,
      previousTotalOrders: args.expectedTotalOrders,
      currentTotalOrders: res.totalOrders,
      pageSize: args.pageSize,
    });
    if (rebasedPage !== null) {
      // Per user override unlock shipped data on 2026-05-23: PS-426 only
      // rewinds Awaiting cursor metadata when the frozen provider window
      // shrinks. Shipped/cancelled edit protections and status semantics are
      // unchanged; the overlap avoids silently skipping shifted Awaiting rows.
      stoppedBy = 'page_count_changed';
      resumePage = rebasedPage;
      break;
    }
    if (!res.ordersLength || page >= pages) {
      stoppedBy = 'complete';
      break;
    }
    // PS-265: bound the per-pass pages + run wall-clock so the orders handler finishes UNDER
    // its ~10-min deadline (stops the kill-mid-walk / no-progress / re-pull-same-backlog loop).
    // A partial pass persists nextPage and resumes older backlog next run, while page 1 is still
    // probed first for recent DESC-modified terminal changes.
    if (syncRunBudgetExhausted(budget, pagesThisPass)) {
      stoppedBy = syncRunBudgetTimeExhausted(budget) ? 'time_budget' : 'page_budget';
      break;
    }
    page += 1;
    // v2-parity: 500ms inter-page delay. Matches v1Pages helper.
    await new Promise((r) => setTimeout(r, 500));
  }

  if (pagesThisPass === 0 && syncRunBudgetTimeExhausted(budget)) {
    stoppedBy = 'time_budget';
  }

  return {
    synced: total,
    pages,
    totalOrders,
    startPage,
    pagesProcessed: pagesThisPass,
    lastPageProcessed,
    complete: stoppedBy === 'complete',
    stoppedBy,
    resumePage,
    liveSourceOrderIds: [...liveSourceOrderIds],
  };
}

export function awaitingOrderPageCountRebasePage(input: {
  startPage: number;
  previousTotalOrders?: number;
  currentTotalOrders: number;
  pageSize: number;
}): number | null {
  const startPage = Math.max(1, Math.floor(Number(input.startPage) || 1));
  const previousTotal = Number(input.previousTotalOrders);
  const currentTotal = Math.max(0, Math.floor(Number(input.currentTotalOrders) || 0));
  const pageSize = Math.max(1, Math.floor(Number(input.pageSize) || 1));
  if (startPage <= 1 || !Number.isFinite(previousTotal) || currentTotal >= previousTotal) {
    return null;
  }
  const removedPages = Math.max(1, Math.ceil((previousTotal - currentTotal) / pageSize));
  return Math.max(1, startPage - removedPages);
}

export function nextOrderSyncResumePage(input: {
  complete: boolean;
  startPage: number;
  lastPageProcessed: number;
}): number {
  if (input.complete) return 1;
  const startPage = Math.max(1, Math.floor(Number(input.startPage) || 1));
  const lastPageProcessed = Math.max(
    0,
    Math.floor(Number(input.lastPageProcessed) || 0),
  );
  // A resumed pass probes DESC page 1 before returning to old backlog. If the
  // budget expires after only that probe, keep the old cursor instead of
  // falsely advancing from page 1 to page 2.
  if (startPage > 1 && lastPageProcessed === 1) return startPage;
  return lastPageProcessed > 0 ? lastPageProcessed + 1 : startPage;
}

function awaitingOrderResumeCursorKey(
  account: SyncAccount,
  storeId: number | undefined,
): string {
  return `${AWAITING_RESUME_CURSOR_KEY_PREFIX}:${shipStationSyncAccountId(account)}:${storeId ?? 'all'}`;
}

export function parseAwaitingOrderCursorState(
  value: unknown,
  identity?: { accountId: string; storeId: number | null },
): AwaitingOrderCursorState | null {
  if (!value || typeof value !== 'object') return null;
  const cursor = value as Partial<AwaitingOrderCursorState>;
  const valid =
    cursor.version === 1 &&
    typeof cursor.accountId === 'string' &&
    (cursor.storeId === null || Number.isInteger(cursor.storeId)) &&
    Number.isFinite(cursor.sinceMs) &&
    Number.isFinite(cursor.untilMs) &&
    cursor.sortDir === 'DESC' &&
    Number.isInteger(cursor.pageSize) && Number(cursor.pageSize) > 0 &&
    Number.isInteger(cursor.nextPage) && Number(cursor.nextPage) > 0 &&
    Number.isInteger(cursor.totalPages) && Number(cursor.totalPages) >= 0 &&
    Number.isInteger(cursor.totalOrders) && Number(cursor.totalOrders) >= 0 &&
    typeof cursor.hasBacklog === 'boolean' &&
    Number.isInteger(cursor.backlogPages) && Number(cursor.backlogPages) >= 0 &&
    ['complete', 'page_budget', 'time_budget', 'page_count_changed'].includes(
      String(cursor.stoppedBy),
    ) &&
    typeof cursor.checkedAt === 'string';
  if (!valid) return null;
  if (
    identity &&
    (cursor.accountId !== identity.accountId || cursor.storeId !== identity.storeId)
  ) {
    return null;
  }
  // PS-484: cursors written before stalledPasses existed carry no counter. Default
  // to 0 (draining) rather than treating unknown history as wedged -- a stall has to
  // be observed across passes to be claimed, never inferred from its absence.
  return {
    ...(cursor as AwaitingOrderCursorState),
    stalledPasses: Number.isFinite(cursor.stalledPasses) ? Number(cursor.stalledPasses) : 0,
  };
}

export function buildAwaitingOrderCursorState(input: {
  accountId: string;
  storeId: number | null;
  sinceMs: number;
  untilMs: number;
  pageSize: number;
  checkedAtMs: number;
  result: {
    pages: number;
    totalOrders: number;
    startPage: number;
    lastPageProcessed: number;
    complete: boolean;
    stoppedBy: AwaitingOrderCursorState['stoppedBy'];
    resumePage: number | null;
  };
  /**
   * PS-484: the cursor this pass is replacing. Required to tell a backlog that is
   * advancing from one that is wedged -- only the previous pass's nextPage can say.
   * Omitted/null means no history, which counts as draining, never as stuck.
   */
  previous?: AwaitingOrderCursorState | null;
}): AwaitingOrderCursorState {
  const totalPages = Math.max(0, Math.floor(Number(input.result.pages) || 0));
  const hasBacklog = !input.result.complete;
  const nextPage = hasBacklog
    ? input.result.resumePage ?? nextOrderSyncResumePage(input.result)
    : 1;
  return {
    version: 1,
    accountId: input.accountId,
    storeId: input.storeId,
    sinceMs: input.sinceMs,
    untilMs: input.untilMs,
    sortDir: 'DESC',
    pageSize: Math.max(1, Math.floor(Number(input.pageSize) || 1)),
    nextPage,
    totalPages,
    totalOrders: Math.max(0, Math.floor(Number(input.result.totalOrders) || 0)),
    hasBacklog,
    backlogPages: hasBacklog ? Math.max(0, totalPages - nextPage + 1) : 0,
    stoppedBy: input.result.stoppedBy,
    checkedAt: new Date(input.checkedAtMs).toISOString(),
    stalledPasses: nextStalledPassCount(input.previous, { hasBacklog, nextPage }),
  };
}

async function readAwaitingOrderCursor(
  account: SyncAccount,
  storeId: number | undefined,
): Promise<{ state: AwaitingOrderCursorState | null; legacyNextPage: number | null }> {
  const accountId = shipStationSyncAccountId(account);
  const raw = await getJsonSetting<unknown>(awaitingOrderResumeCursorKey(account, storeId));
  const state = parseAwaitingOrderCursorState(raw, {
    accountId,
    storeId: storeId ?? null,
  });
  if (state) return { state, legacyNextPage: null };
  const legacyNextPage = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(1, Math.floor(raw))
    : null;
  return { state: null, legacyNextPage };
}

function awaitingStoreTargets(
  account: SyncAccount,
  activeShipStationCutoverStoreIds: ReadonlySet<number>,
): Array<{ storeId?: number }> {
  const storeIds = filterShipStationStoreIdsForCutover(
    account.storeIds.filter((sid) => !isExcludedStoreId(sid)),
    activeShipStationCutoverStoreIds,
  );
  return storeIds.length > 0
    ? storeIds.map((storeId) => ({ storeId }))
    : [{ storeId: undefined }];
}

async function readAwaitingOrderBacklogByAccount(
  accounts: ReadonlyArray<SyncAccount>,
  activeShipStationCutoverStoreIds: ReadonlySet<number>,
): Promise<Map<string, AwaitingOrderCursorState[]>> {
  const byAccount = new Map<string, AwaitingOrderCursorState[]>();
  await Promise.all(accounts.map(async (account) => {
    const accountId = shipStationSyncAccountId(account);
    const states = await Promise.all(
      awaitingStoreTargets(account, activeShipStationCutoverStoreIds).map(async (target) =>
        (await readAwaitingOrderCursor(account, target.storeId)).state,
      ),
    );
    byAccount.set(
      accountId,
      states.filter((state): state is AwaitingOrderCursorState => Boolean(state?.hasBacklog)),
    );
  }));
  return byAccount;
}

function statusCatchupEntryKey(args: {
  accountLabel: string;
  storeId: number | null | undefined;
  orderStatus: CatchUpOrderStatus;
}): string {
  return `${args.accountLabel}:${args.storeId ?? 'all'}:${args.orderStatus}`;
}

function statusCatchupResumePage(
  snapshot: OrderStatusCatchupSnapshot,
  args: {
    account: SyncAccount;
    storeId?: number;
    orderStatus: CatchUpOrderStatus;
  },
): number {
  const key = statusCatchupEntryKey({
    accountLabel: args.account.label,
    storeId: args.storeId ?? null,
    orderStatus: args.orderStatus,
  });
  const previous = snapshot.entries.find(
    (entry) =>
      statusCatchupEntryKey({
        accountLabel: entry.accountLabel,
        storeId: entry.storeId,
        orderStatus: entry.orderStatus,
      }) === key,
  );
  if (!previous?.hasBacklog) return 1;
  const nextPage = Math.floor(Number(previous.nextPage ?? previous.lastPageProcessed + 1) || 1);
  const totalPages = previous.totalPages == null ? null : Math.max(1, Math.floor(previous.totalPages));
  if (totalPages !== null && nextPage > totalPages) return 1;
  return Math.max(2, nextPage);
}

function statusCatchupStoreTargets(account: SyncAccount): Array<{ storeId?: number }> {
  const storeIds = account.storeIds.filter((sid) => !isExcludedStoreId(sid));
  return storeIds.length > 0
    ? storeIds.map((storeId) => ({ storeId }))
    : [{ storeId: undefined }];
}

export function prioritizeOrderStatusCatchupPasses(
  accountLabel: string,
  passes: ReadonlyArray<OrderStatusCatchupPass>,
  snapshot: OrderStatusCatchupSnapshot,
): OrderStatusCatchupPass[] {
  const backlogKeys = new Set(
    snapshot.entries
      .filter((entry) => entry.accountLabel === accountLabel && entry.hasBacklog)
      .map((entry) => statusCatchupEntryKey(entry)),
  );
  return passes
    .map((pass, index) => ({
      pass,
      index,
      backlog: backlogKeys.has(
        statusCatchupEntryKey({
          accountLabel,
          storeId: pass.storeId,
          orderStatus: pass.orderStatus,
        }),
      ),
    }))
    .sort((left, right) => Number(right.backlog) - Number(left.backlog) || left.index - right.index)
    .map(({ pass }) => pass);
}

function statusCatchupEntry(args: {
  account: SyncAccount;
  storeId?: number;
  orderStatus: CatchUpOrderStatus;
  sinceMs: number;
  pageSize: number;
  checkedAtMs: number;
  result?: Awaited<ReturnType<typeof fetchOrdersPage>>;
  stoppedBy?: StatusCatchupStopReason;
}): OrderStatusCatchupEntry {
  const totalPages = args.result?.pages ?? null;
  const pagesProcessed = args.result?.pagesProcessed ?? 0;
  const startPage = args.result?.startPage ?? 1;
  const lastPageProcessed = args.result?.lastPageProcessed ?? 0;
  const stoppedBy = args.stoppedBy ?? args.result?.stoppedBy ?? 'complete';
  const hasBacklog =
    stoppedBy !== 'complete' ||
    (totalPages !== null && lastPageProcessed > 0 && lastPageProcessed < totalPages);
  const nextPage = hasBacklog
    ? nextOrderSyncResumePage({ complete: false, startPage, lastPageProcessed })
    : null;
  const processedThroughPage =
    nextPage !== null
      ? Math.max(0, nextPage - 1)
      : Math.max(lastPageProcessed, pagesProcessed);
  return {
    accountLabel: args.account.label,
    storeId: args.storeId ?? null,
    orderStatus: args.orderStatus,
    sinceIso: new Date(args.sinceMs).toISOString(),
    sortDir: 'DESC',
    pageSize: args.pageSize,
    startPage,
    totalPages,
    pagesProcessed,
    lastPageProcessed,
    nextPage,
    updatedRows: args.result?.synced ?? 0,
    hasBacklog,
    backlogPages:
      totalPages === null
        ? null
        : Math.max(0, totalPages - processedThroughPage),
    stoppedBy,
    checkedAt: new Date(args.checkedAtMs).toISOString(),
    // PS-431: a freshly observed pass has no history of its own. Whether this
    // backlog is stalled is decided in mergeOrderStatusCatchupEntries, which is
    // the only place that can see the previous pass's cursor.
    stalledPasses: 0,
  };
}

async function syncOrdersForAccount(
  account: SyncAccount,
  opts: {
    sinceMs?: number;
    awaitingSinceMs?: number;
    pageSize?: number;
    skipStatusPasses?: boolean;
    previousStatusCatchup?: OrderStatusCatchupSnapshot;
    activeShipStationCutoverStoreIds?: ReadonlySet<number>;
    signal?: AbortSignal;
  },
  storeToClient: Awaited<ReturnType<typeof buildStoreToClientMap>>,
  budget: SyncRunBudget = createSyncRunBudget(),
): Promise<{
  synced: number;
  pages: number;
  sinceIso: string;
  statusCatchupEntries: OrderStatusCatchupEntry[];
  succeeded: boolean;
  error: string | null;
}> {
  const { primaryKey: key, value: storedLastSync } = await readOrderSyncWatermark(account);
  const lastSync =
    opts.sinceMs ??
    storedLastSync ??
    Date.now() - DEFAULT_LOOKBACK_MS;

  // Smaller default pages keep the background worker below its 10-minute guard
  // while still letting explicit backfills request a larger page size.
  const pageSize = opts.pageSize ?? DEFAULT_ORDER_SYNC_PAGE_SIZE;
  const runStartMs = Date.now();
  const sinceIso = new Date(lastSync).toISOString();

  // v2 parity plus production recovery: ShipStation can move an order from
  // awaiting_shipment to shipped/cancelled without that old awaiting row being
  // revisited by a narrow watermark. Use a 30-day catch-up window so stale DB
  // awaiting counts converge back to ShipStation's live sidebar counts.
  let total = 0;
  let maxPages = 1;
  let failed = false;
  let complete = true;
  const errors: string[] = [];
  const statusCatchupEntries: OrderStatusCatchupEntry[] = [];

  // PS-265: the awaiting_shipment pass (the new orders operators ship TODAY) runs FIRST so a
  // large historical status catch-up can never starve it under the run budget.
  const defaultAwaitingSinceMs =
    opts.awaitingSinceMs ?? Math.min(lastSync, runStartMs - AWAITING_CATCHUP_LOOKBACK_MS);
  const awaitingTargets = awaitingStoreTargets(
    account,
    opts.activeShipStationCutoverStoreIds ?? new Set(),
  );

  for (const target of awaitingTargets) {
    throwIfOrderSyncAborted(opts.signal);
    if (syncRunBudgetTimeExhausted(budget)) {
      complete = false;
      break;
    }
    try {
      const cursorKey = awaitingOrderResumeCursorKey(account, target.storeId);
      const loadedCursor = await readAwaitingOrderCursor(account, target.storeId);
      const storedCursor = loadedCursor.state?.hasBacklog ? loadedCursor.state : null;
      const cursorCompatible = Boolean(
        storedCursor &&
        (opts.awaitingSinceMs === undefined || storedCursor.sinceMs === defaultAwaitingSinceMs) &&
        (opts.pageSize === undefined || storedCursor.pageSize === pageSize),
      );
      const activeCursor = cursorCompatible ? storedCursor : null;
      // Per user override unlock shipped data on 2026-05-23: PS-426 freezes
      // only the Awaiting query window/page shape while backlog exists. This
      // prevents a moving 30-day window from invalidating cursor progress; it
      // does not weaken shipped/cancelled mutation guards or rewrite history.
      const awaitingSinceMs = activeCursor?.sinceMs ?? defaultAwaitingSinceMs;
      const awaitingUntilMs = activeCursor?.untilMs ?? runStartMs;
      const awaitingPageSize = activeCursor?.pageSize ?? pageSize;
      const startPage = activeCursor?.nextPage ??
        (opts.awaitingSinceMs === undefined && opts.pageSize === undefined
          ? loadedCursor.legacyNextPage ?? 1
          : 1);
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: 'awaiting_shipment',
        sinceMs: awaitingSinceMs,
        untilMs: awaitingUntilMs,
        pageSize: awaitingPageSize,
        storeId: target.storeId,
        sortDir: 'DESC',
        startPage,
        expectedTotalOrders: activeCursor?.totalOrders,
        probeFirstPageOnResume: false,
        signal: opts.signal,
      }, budget);
      // Audit SY-7: persist only after a successful provider/import pass. A
      // failed or not-started target retains its old cursor. Awaiting resumes
      // directly at the next frozen-window page; terminal status catch-up keeps
      // its separate newest-first probe behavior.
      await setJsonSetting(cursorKey, buildAwaitingOrderCursorState({
        accountId: shipStationSyncAccountId(account),
        storeId: target.storeId ?? null,
        sinceMs: awaitingSinceMs,
        untilMs: awaitingUntilMs,
        pageSize: awaitingPageSize,
        checkedAtMs: runStartMs,
        result,
        // PS-484: the cursor loaded at the top of this target's pass, so the stall
        // counter can see whether nextPage actually moved.
        previous: loadedCursor.state,
      }));
      total += result.synced;
      if (
        target.storeId !== undefined &&
        result.complete &&
        result.startPage === 1
      ) {
        try {
          const reconciliation = await reconcileDeletedShipStationAwaiting({
            accountLabel: account.label,
            apiKey: account.apiKey,
            apiSecret: account.apiSecret,
            storeId: target.storeId,
            sinceMs: awaitingSinceMs,
            liveSourceOrderIds: new Set(result.liveSourceOrderIds),
            signal: opts.signal,
          });
          total += reconciliation.cancelled;
        } catch (err) {
          throwIfOrderSyncAborted(opts.signal);
          console.warn(
            `[order-sync] deleted-awaiting reconciliation failed account="${account.label}" storeId=${target.storeId}; awaiting import remains authoritative for this run:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      if (result.pages > maxPages) maxPages = result.pages;
      if (!result.complete) complete = false;
    } catch (err) {
      throwIfOrderSyncAborted(opts.signal);
      failed = true;
      errors.push(err instanceof Error ? err.message : String(err));
      console.warn(
        `[order-sync] account="${account.label}" orderStatus="awaiting_shipment" storeId="${target.storeId ?? 'all'}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Status catch-up passes run AFTER awaiting and only while run-budget time remains. Partial
  // passes persist a page cursor and resume old backlog on the next run, while every resumed
  // pass still probes page 1 for today's DESC-modified status changes.
  const catchupSinceMs = Math.min(lastSync, runStartMs - STATUS_CATCHUP_LOOKBACK_MS);
  // Per user override unlock shipped data on 2026-05-23, reconfirmed on
  // 2026-07-07: scope shipped/cancelled/hold catch-up by known ShipStation
  // store IDs so recent transitions do not hide behind all-store history.
  const statusTargets = statusCatchupStoreTargets(account);
  const passes = prioritizeOrderStatusCatchupPasses(
    account.label,
    opts.skipStatusPasses
      ? []
      : STATUS_CATCHUP_STATUSES.flatMap((orderStatus) =>
          statusTargets.map((target) => ({
            orderStatus,
            sinceMs: catchupSinceMs,
            storeId: target.storeId,
          })),
        ),
    opts.previousStatusCatchup ?? emptyStatusCatchupSnapshot(),
  );
  // Per user override unlock shipped data on 2026-07-15: a saved status
  // cursor now runs before fresh passes so the same late store/status cannot
  // be starved by the seven-minute bounded run forever. Existing terminal-row
  // guards and status update semantics are unchanged.

  for (const pass of passes) {
    throwIfOrderSyncAborted(opts.signal);
    // PS-265/PS-409: stop starting status catch-up passes once the run is out of time budget;
    // the previous snapshot keeps the resume cursor for the next run.
    if (syncRunBudgetTimeExhausted(budget)) {
      statusCatchupEntries.push(
        statusCatchupEntry({
          account,
          storeId: pass.storeId,
          orderStatus: pass.orderStatus,
          sinceMs: pass.sinceMs,
          pageSize,
          checkedAtMs: runStartMs,
          stoppedBy: 'not_started_budget_exhausted',
        }),
      );
      continue;
    }
    try {
      const result = await fetchOrdersPage(account, storeToClient, {
        orderStatus: pass.orderStatus,
        sinceMs: pass.sinceMs,
        pageSize,
        storeId: pass.storeId,
        statusOnly: true,
        startPage: statusCatchupResumePage(
          opts.previousStatusCatchup ?? emptyStatusCatchupSnapshot(),
          {
            account,
            storeId: pass.storeId,
            orderStatus: pass.orderStatus,
          },
        ),
        // Per user override unlock shipped data on 2026-05-23, reconfirmed on
        // 2026-07-07: status catch-up removes today's rows from Awaiting after
        // ShipStation moves them to shipped/cancelled/hold. Pull newest modified
        // rows first so bounded workers do not spend every tick on old history.
        sortDir: 'DESC',
        signal: opts.signal,
      }, budget);
      statusCatchupEntries.push(
        statusCatchupEntry({
          account,
          storeId: pass.storeId,
          orderStatus: pass.orderStatus,
          sinceMs: pass.sinceMs,
          pageSize,
          checkedAtMs: runStartMs,
          result,
        }),
      );
      total += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
    } catch (err) {
      throwIfOrderSyncAborted(opts.signal);
      failed = true;
      errors.push(err instanceof Error ? err.message : String(err));
      statusCatchupEntries.push(
        statusCatchupEntry({
          account,
          storeId: pass.storeId,
          orderStatus: pass.orderStatus,
          sinceMs: pass.sinceMs,
          pageSize,
          checkedAtMs: runStartMs,
          stoppedBy: 'failed',
        }),
      );
      // Per-status failure shouldn't kill the whole account sync.
      console.warn(
        `[order-sync] account="${account.label}" orderStatus="${pass.orderStatus}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (!failed && complete) {
    throwIfOrderSyncAborted(opts.signal);
    await setSetting(key, String(runStartMs));
  } else {
    console.warn(
      `[order-sync] account="${account.label}" was incomplete or had failed pass(es); watermark not advanced`
    );
  }
  return {
    synced: total,
    pages: maxPages,
    sinceIso,
    statusCatchupEntries,
    succeeded: !failed && complete,
    error: errors.length > 0 ? errors.join('; ') : complete ? null : 'run budget exhausted',
  };
}

export async function syncOrders(opts: {
  sinceMs?: number;
  awaitingSinceMs?: number;
  pageSize?: number;
  skipStatusPasses?: boolean;
  runIdentity?: ShipStationSyncRunIdentity;
  signal?: AbortSignal;
} = {}): Promise<SyncResult> {
  const runStartMs = Date.now();
  const runIdentity = opts.runIdentity ?? {
    queueJobId: `orders:${runStartMs}`,
    attemptId: `direct:${runStartMs}`,
  };
  // PS-265: one run-wide budget bounds the WHOLE orders handler (all accounts + passes) under
  // its ~10-min deadline, so it returns and advances watermarks instead of being killed
  // mid-walk with no progress (the loop that re-pulled the same backlog and drained nothing).
  const budget = createSyncRunBudget();
  const storeToClient = await buildStoreToClientMap();
  const loadedAccounts = await loadSyncAccounts();
  const accountWatermarks = await Promise.all(
    loadedAccounts.map(async (account) => ({
      account,
      watermarkMs: (await readOrderSyncWatermark(account)).value,
    })),
  );
  const accounts = accountWatermarks
    .sort((left, right) => (left.watermarkMs ?? 0) - (right.watermarkMs ?? 0))
    .map(({ account }) => account);
  const activeShipStationCutoverStoreIds = await loadActiveShipStationCutoverStoreIds().catch((err) => {
    console.warn(
      '[order-sync] store-source cutover lookup failed; continuing with all ShipStation awaiting stores:',
      err instanceof Error ? err.message : err,
    );
    return new Set<number>();
  });
  const previousStatusCatchup = opts.skipStatusPasses
    ? emptyStatusCatchupSnapshot()
    : await getOrderStatusCatchupSnapshot();

  let grandTotal = 0;
  let maxPages = 1;
  let earliestSinceIso = new Date(runStartMs).toISOString();
  const statusCatchupEntries: OrderStatusCatchupEntry[] = [];

  for (const acct of accounts) {
    throwIfOrderSyncAborted(opts.signal);
    if (syncRunBudgetTimeExhausted(budget)) break;
    // Per user override unlock shipped data on 2026-07-10: lifecycle metadata
    // follows one queue attempt; shipped/cancelled mapping remains unchanged.
    await markShipStationSyncAccountStarted(acct, runIdentity, Date.now());
    try {
      const result = await syncOrdersForAccount(
        acct,
        { ...opts, previousStatusCatchup, activeShipStationCutoverStoreIds },
        storeToClient,
        budget,
      );
      grandTotal += result.synced;
      if (result.pages > maxPages) maxPages = result.pages;
      if (result.sinceIso < earliestSinceIso) earliestSinceIso = result.sinceIso;
      statusCatchupEntries.push(...result.statusCatchupEntries);
      if (result.succeeded) {
        await markShipStationSyncAccountSucceeded(acct, runIdentity, Date.now());
      } else {
        await markShipStationSyncAccountFailed(
          acct,
          runIdentity,
          Date.now(),
          result.error ?? 'sync incomplete',
        );
      }
    } catch (err) {
      if (isOrderSyncCooperativeYieldError(opts.signal?.reason ?? err)) {
        // Per user override unlock shipped data on 2026-07-22: a durable
        // queue-control yield closes only account lifecycle metadata as
        // deferred. It does not weaken shipped/cancelled guards or mutate an
        // order, shipment, label, postage, or marketplace confirmation.
        await markShipStationSyncAccountDeferred(acct, runIdentity, Date.now());
        throwIfOrderSyncAborted(opts.signal);
      }
      await markShipStationSyncAccountFailed(acct, runIdentity, Date.now(), err);
      throwIfOrderSyncAborted(opts.signal);
      console.error(
        `[order-sync] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
    // PS-265: stop starting new accounts once the run is out of time budget; their watermarks
    // are unchanged, so they resume on the next run (fair round-robin across runs).
    if (syncRunBudgetTimeExhausted(budget)) break;
  }

  // Flush any new (storeId → clientId) mappings discovered during this
  // sync pass — one UPDATE per client, outside the hot loop.
  try {
    await flushNewStorePairs(storeToClient.newPairs);
  } catch (err) {
    console.error('[order-sync] flushNewStorePairs failed:', (err as Error).message);
  }

  if (!opts.skipStatusPasses) {
    try {
      await persistOrderStatusCatchupSnapshot(
        statusCatchupEntries,
        runStartMs,
        previousStatusCatchup,
        accounts,
      );
    } catch (err) {
      console.error('[order-sync] persist status catch-up snapshot failed:', (err as Error).message);
    }
  }

  const completedWatermarks = await Promise.all(
    accounts.map(async (account) => (await readOrderSyncWatermark(account)).value),
  );
  const { completeThroughMs } = summarizeShipStationAccountWatermarks(completedWatermarks);
  return {
    synced: grandTotal,
    pages: maxPages,
    lastSyncedAt: completeThroughMs ? new Date(completeThroughMs).toISOString() : null,
    sinceIso: earliestSinceIso,
  };
}

export type OrderSyncAccountDiagnostic = {
  accountId: string;
  displayName: string;
  ownerClientId: number | null;
  storeIds: number[];
  lastSyncedAt: string | null;
  ageSeconds: number | null;
  runAgeSeconds: number | null;
  fresh: boolean;
  stale: boolean;
  state: 'fresh' | 'stale' | 'never_synced' | 'failed' | 'running';
  activeJobId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  backlogPasses: number;
  backlogPages: number | null;
  cursors: Array<{
    storeId: number | null;
    orderStatus: CatchUpOrderStatus | 'awaiting_shipment';
    nextPage: number | null;
    totalPages: number | null;
    stoppedBy: StatusCatchupStopReason;
    sinceIso: string | null;
    untilIso: string | null;
    pageSize: number | null;
  }>;
};

export function orderSyncRunQueueVerdict(
  runState: {
    status: 'running' | 'succeeded' | 'failed' | 'deferred';
    activeJobId: string | null;
    lastStartedAt: string | null;
  } | undefined,
  queueTruth: OrderSyncQueueTruth,
  nowMs: number,
): { running: boolean; abandoned: boolean; error: string | null; runAgeSeconds: number | null } {
  if (runState?.status !== 'running') {
    return { running: false, abandoned: false, error: null, runAgeSeconds: null };
  }

  const startedMs = runState.lastStartedAt ? Date.parse(runState.lastStartedAt) : NaN;
  const runAgeMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
  const withinLease = runAgeMs !== null && runAgeMs <= SYNC_JOB_RUNNING_LEASE_MS;
  const activeJobId = runState.activeJobId;
  const queueOwnsRun =
    !queueTruth.available ||
    (Boolean(activeJobId) && queueTruth.activeJobIds.includes(activeJobId as string));
  const running = Boolean(activeJobId) && withinLease && queueOwnsRun;
  if (running) {
    return {
      running: true,
      abandoned: false,
      error: null,
      runAgeSeconds: runAgeMs === null ? null : Math.floor(runAgeMs / 1000),
    };
  }

  const retrying = Boolean(
    activeJobId && queueTruth.available && queueTruth.retryingJobIds.includes(activeJobId),
  );
  return {
    running: false,
    abandoned: true,
    error: retrying
      ? 'Order sync timed out and is waiting to retry.'
      : !withinLease
        ? 'Order sync exceeded its worker deadline.'
        : 'Order sync worker no longer owns this job.',
    runAgeSeconds: runAgeMs === null ? null : Math.floor(runAgeMs / 1000),
  };
}

export async function getSyncStatus(options: { includeOrderCount?: boolean } = {}): Promise<{
  lastSyncedAt: string | null;
  latestSyncedAt: string | null;
  orderCount: number;
  statusCatchup: OrderStatusCatchupSnapshot;
  laneOwner: 'pg_boss_shipstation_sync';
  queueState: OrderSyncQueueState;
  health: 'healthy' | 'stale' | 'error' | 'running';
  allAccountsFresh: boolean;
  staleAccountCount: number;
  accounts: OrderSyncAccountDiagnostic[];
}> {
  // Account diagnostics use every active watermark. The aggregate timestamp is
  // the oldest completed account so one fresh account cannot hide a stale one.
  const accounts = await loadSyncAccounts();
  const [statusCatchup, runStates, watermarks, queueTruth, activeCutoverStoreIds] = await Promise.all([
    getOrderStatusCatchupSnapshot(),
    readShipStationSyncAccountStates(),
    Promise.all(accounts.map(async (account) => (await readOrderSyncWatermark(account)).value)),
    readOrderSyncQueueTruth(),
    loadActiveShipStationCutoverStoreIds(),
  ]);
  const awaitingBacklogByAccount = await readAwaitingOrderBacklogByAccount(
    accounts,
    activeCutoverStoreIds,
  );
  const nowMs = Date.now();
  const configuredFreshSeconds = Number(env.SHIPMENT_SYNC_WATCHDOG_ORDER_FRESH_SECONDS);
  const freshMs =
    (Number.isFinite(configuredFreshSeconds) && configuredFreshSeconds > 0
      ? configuredFreshSeconds
      : 15 * 60) * 1000;
  const accountDiagnostics = accounts.map((account, index) => {
    const accountId = shipStationSyncAccountId(account);
    const runState = runStates[accountId];
    const watermarkMs = watermarks[index] ?? null;
    const statusBacklogEntries = statusCatchup.entries.filter(
      (entry) => entry.accountLabel === account.label && entry.hasBacklog,
    );
    const awaitingBacklogEntries = awaitingBacklogByAccount.get(accountId) ?? [];
    const ageMs = watermarkMs === null ? null : Math.max(0, nowMs - watermarkMs);
    const runVerdict = orderSyncRunQueueVerdict(runState, queueTruth, nowMs);
    const failed = runState?.status === 'failed' || runVerdict.abandoned;
    const running = runVerdict.running;
    const stale = isOrderSyncAccountStale({
      failed,
      watermarkMs,
      ageMs,
      freshMs,
      statusBacklogEntries,
      awaitingBacklogEntries,
    });
    const backlogPageValues = [
      ...statusBacklogEntries.map((entry) => entry.backlogPages),
      ...awaitingBacklogEntries.map((entry) => entry.backlogPages),
    ];
    return {
      accountId,
      displayName: shipStationSyncAccountDisplayName(account),
      ownerClientId: account.ownerClientId,
      storeIds: account.storeIds,
      lastSyncedAt: watermarkMs ? new Date(watermarkMs).toISOString() : null,
      ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
      runAgeSeconds: runVerdict.runAgeSeconds,
      fresh: !stale,
      stale,
      state: running
        ? 'running'
        : failed
          ? 'failed'
          : watermarkMs === null
            ? 'never_synced'
            : stale
              ? 'stale'
              : 'fresh',
      activeJobId: running ? runState?.activeJobId ?? null : null,
      lastStartedAt: runState?.lastStartedAt ?? null,
      lastCompletedAt: runState?.lastCompletedAt ?? null,
      lastSuccessAt:
        runState?.lastSuccessAt ?? (watermarkMs ? new Date(watermarkMs).toISOString() : null),
      lastFailureAt: runState?.lastFailureAt ?? null,
      lastError: runVerdict.error ?? runState?.lastError ?? null,
      backlogPasses: statusBacklogEntries.length + awaitingBacklogEntries.length,
      backlogPages: backlogPageValues.some((value) => value === null)
        ? null
        : backlogPageValues.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      cursors: [
        ...awaitingBacklogEntries.map((entry) => ({
          storeId: entry.storeId,
          orderStatus: 'awaiting_shipment' as const,
          nextPage: entry.nextPage,
          totalPages: entry.totalPages,
          stoppedBy: entry.stoppedBy,
          sinceIso: new Date(entry.sinceMs).toISOString(),
          untilIso: new Date(entry.untilMs).toISOString(),
          pageSize: entry.pageSize,
        })),
        ...statusBacklogEntries.map((entry) => ({
          storeId: entry.storeId,
          orderStatus: entry.orderStatus,
          nextPage: entry.nextPage,
          totalPages: entry.totalPages,
          stoppedBy: entry.stoppedBy,
          sinceIso: entry.sinceIso,
          untilIso: null,
          pageSize: entry.pageSize,
        })),
      ],
    } satisfies OrderSyncAccountDiagnostic;
  });
  const { completeThroughMs: oldestMs, latestMs } =
    summarizeShipStationAccountWatermarks(watermarks);
  const staleAccountCount = accountDiagnostics.filter((account) => account.stale).length;
  const anyRunning = accountDiagnostics.some((account) => account.state === 'running');
  const anyFailed = accountDiagnostics.some((account) => account.state === 'failed');
  const health: 'healthy' | 'stale' | 'error' | 'running' = anyRunning
    ? 'running'
    : anyFailed
      ? 'error'
      : accounts.length === 0 || staleAccountCount > 0
        ? 'stale'
        : 'healthy';
  const base = {
    lastSyncedAt: oldestMs ? new Date(oldestMs).toISOString() : null,
    latestSyncedAt: latestMs ? new Date(latestMs).toISOString() : null,
    statusCatchup,
    laneOwner: 'pg_boss_shipstation_sync' as const,
    queueState: orderSyncQueueState(queueTruth),
    health,
    allAccountsFresh: staleAccountCount === 0 && accounts.length > 0,
    staleAccountCount,
    accounts: accountDiagnostics,
  };
  if (options.includeOrderCount === false) {
    return { ...base, orderCount: 0 };
  }
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders);
  return { ...base, orderCount: rows[0]?.count ?? 0 };
}
