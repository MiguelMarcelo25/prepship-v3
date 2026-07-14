import 'dotenv/config';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/client';
import { orders } from '../src/db/schema/orders';
import { shipments } from '../src/db/schema/shipments';
import { clients } from '../src/db/schema/clients';
import { isExcludedStoreId } from '../src/config/prepship';
import {
  listShipStationOrders,
  normalizeShipStationOrder,
} from '../src/connectors/store/shipstation';
import {
  upsertNormalizedStoreOrders,
  type NormalizedStoreOrder,
} from '../src/services/store-order-import';
import { enqueueInventoryDeduction } from '../src/services/fulfillment/inventory-deduction-outbox';

/**
 * PS-046 — Orphan ShipStation shipment reconciliation / backfill.
 *
 * Companion to PS-036's `recover-missing-shipments.ts`. That tool handles SS
 * shipments whose order ALREADY exists locally but is missing a shipment row.
 * THIS tool handles the opposite, harder case that PS-036 explicitly punted on
 * ("Unmatched orphans … needs order sync first"): shipment rows already in our
 * DB with `order_id IS NULL` because the ShipStation order was shipped before
 * PrepShip ever imported it as `awaiting_shipment`, so order-sync's
 * status-only pass never created the local `orders` row and shipment-sync had
 * nothing to link to (see shipment-sync.ts::upsertShipmentsBatch, which inserts
 * `orderId: null` on no-match).
 *
 * Read-only by default. For every non-voided orphan shipment it classifies
 * the row and reports counts + samples. `--apply` (off by default, requires
 * DJ approval at run time) hydrates the missing order from ShipStation and
 * links the orphan shipment(s) by order number.
 *
 * SAFETY:
 *   - Dry-run unless `--apply` is passed.
 *   - Apply hydrates orders via the canonical `upsertNormalizedStoreOrders`
 *     (ON CONFLICT (external_order_id) DO UPDATE — never creates a duplicate
 *     order for an existing ShipStation source identity) and links shipments
 *     with a scoped `UPDATE … WHERE order_id IS NULL AND order_number = $`.
 *   - NEVER deletes shipments. NEVER buys postage / creates labels / notifies
 *     marketplaces. NEVER reopens a shipped/cancelled order (the upsert
 *     preserves terminal local statuses).
 *   - Inventory deduction for hydrated SHIPPED orders reuses the AI-locked
 *     durable inventory outbox (same lane order-sync uses); its processor is gated by
 *     the INVENTORY_AUTO_DEDUCT kill switch + ledger dedupe — no refactor.
 *   - `main()` only runs when the file is invoked directly, so a guard/test can
 *     import `classifyOrphanShipment` without triggering a network fetch/write.
 */

const PAGE_SIZE_DEFAULT = 200;

// ---------------------------------------------------------------------------
// Pure classification — no DB, no network. Exported so the guard can unit-test
// every branch with fixtures.
// ---------------------------------------------------------------------------

export type OrphanClassification =
  | 'link_local' // a single local order matches by order number → link shipment
  | 'hydrate' // no local order, but ShipStation has the order upstream → create + link
  | 'manual' // no order number, or no upstream order → leave as diagnostic orphan
  | 'ambiguous' // >1 local order candidate for the order number → unsafe to touch
  | 'lookup_failed'; // upstream ShipStation lookup errored → retry later

export interface LocalOrderCandidate {
  id: number;
  clientId: number | null;
  externalOrderId: string | null;
}

export interface OrphanClassificationInput {
  /** The orphan shipment's order number (shipments.order_number). */
  orderNumber: string | null | undefined;
  /** Local `orders` rows whose order_number equals this orphan's order number. */
  localOrderCandidates: LocalOrderCandidate[];
  /**
   * Result of the ShipStation upstream lookup by order number. Only consulted
   * when there is no local candidate (so dry-run can skip the network call for
   * orphans that already match a local order).
   */
  upstream: { found: boolean; lookupFailed: boolean };
}

export function classifyOrphanShipment(input: OrphanClassificationInput): OrphanClassification {
  const orderNumber = (input.orderNumber ?? '').trim();
  // No order number at all → nothing to reconcile against. Almost always a
  // manual/standalone label; surface it diagnostically, never auto-link.
  if (!orderNumber) return 'manual';

  const candidates = input.localOrderCandidates ?? [];
  if (candidates.length === 1) return 'link_local';
  if (candidates.length > 1) return 'ambiguous';

  // No local order — fall back to the upstream ShipStation lookup.
  if (input.upstream.lookupFailed) return 'lookup_failed';
  if (input.upstream.found) return 'hydrate';
  return 'manual';
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parsePositiveInteger(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return Math.floor(value);
}

function parseOrderNumbers(): string[] | null {
  const raw = argValue('order-numbers');
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

// ---------------------------------------------------------------------------
// Store → client mapping (mirrors order-sync.buildStoreToClientMap so hydrated
// orders attach to the correct client/store instead of null).
// ---------------------------------------------------------------------------

type ReconcileAccount = {
  label: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  ownerClientId: number | null;
};

async function loadReconcileAccounts(): Promise<ReconcileAccount[]> {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
    })
    .from(clients)
    .where(eq(clients.active, true));
  const accounts: ReconcileAccount[] = [
    { label: 'main', apiKey: undefined, apiSecret: undefined, ownerClientId: null },
  ];
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
        ownerClientId: r.id,
      });
    }
  }
  return accounts;
}

async function buildStoreToClientMap(): Promise<Map<number, number>> {
  const rows = await db.select({ id: clients.id, storeIds: clients.storeIds }).from(clients);
  const byStore = new Map<number, number>();
  for (const c of rows) {
    for (const sid of c.storeIds ?? []) {
      if (!isExcludedStoreId(sid)) byStore.set(sid, c.id);
    }
  }
  return byStore;
}

type SSOrdersList = { orders: unknown[]; total: number; page: number; pages: number };

/**
 * Look up a ShipStation order by its order number across every active account.
 * Returns the normalized order (preferring a shipped match) plus whether the
 * lookup itself failed so the classifier can distinguish "no order upstream"
 * from "couldn't reach ShipStation".
 */
async function lookupUpstreamOrderByNumber(
  orderNumber: string,
  accounts: ReconcileAccount[],
): Promise<{ found: boolean; lookupFailed: boolean; normalized: ReturnType<typeof normalizeShipStationOrder> | null }> {
  let lookupFailed = false;
  let best: ReturnType<typeof normalizeShipStationOrder> | null = null;
  for (const account of accounts) {
    try {
      const q = new URLSearchParams({ orderNumber, pageSize: '50', page: '1' });
      const res = await listShipStationOrders<SSOrdersList>(q, {
        apiKey: account.apiKey,
        apiSecret: account.apiSecret,
        dedupeKey: `orphan-reconcile:order-lookup:${account.label}:${orderNumber}`,
      });
      for (const raw of res.orders ?? []) {
        const normalized = normalizeShipStationOrder(raw);
        if (String(normalized.sourceOrderNumber ?? '') !== orderNumber) continue;
        // Prefer a shipped match (the orphan is a shipped label); otherwise keep
        // the first real match so we can still hydrate awaiting/cancelled.
        if (!best || normalized.canonicalStatus === 'shipped') best = normalized;
      }
    } catch {
      lookupFailed = true;
    }
  }
  return { found: best !== null, lookupFailed: lookupFailed && best === null, normalized: best };
}

function toNormalizedStoreOrder(
  normalized: ReturnType<typeof normalizeShipStationOrder>,
  storeToClient: Map<number, number>,
  fallbackClientId: number | null,
): NormalizedStoreOrder | null {
  const storeIdRaw = normalized.storeId == null ? null : Number(normalized.storeId);
  const storeId = Number.isFinite(storeIdRaw as number) ? Math.trunc(storeIdRaw as number) : null;
  if (isExcludedStoreId(storeId)) return null;
  let clientId = storeId !== null ? storeToClient.get(storeId) ?? null : null;
  if (clientId === null) clientId = fallbackClientId;
  const raw =
    normalized.rawPayload && typeof normalized.rawPayload === 'object'
      ? (normalized.rawPayload as Record<string, unknown>)
      : {};
  const status = normalized.canonicalStatus === 'on_hold' ? 'awaiting_shipment' : normalized.canonicalStatus;
  return {
    externalOrderId: normalized.sourceOrderId,
    source: {
      sourceProvider: normalized.sourceProvider,
      sourceAccountId: normalized.sourceAccountId,
      sourceOrderId: normalized.sourceOrderId,
      sourceOrderNumber: normalized.sourceOrderNumber,
      rawSourcePayload: raw,
    },
    orderNumber: normalized.sourceOrderNumber ?? normalized.sourceOrderId,
    orderStatus: status,
    orderDate: normalized.orderDate ?? null,
    clientId,
    storeId,
    customerEmail: normalized.customerEmail ?? null,
    shipToName: normalized.customerName ?? null,
    shipToCity: normalized.shipToCity ?? null,
    shipToState: normalized.shipToState ?? null,
    shipToPostalCode: normalized.shipToPostalCode ?? null,
    carrierCode: normalized.carrierCode ?? null,
    serviceCode: normalized.serviceCode ?? null,
    weightOz: normalized.weightOz ?? null,
    orderTotal: normalized.orderTotal ?? '0',
    shippingAmount: Number.isFinite(normalized.shippingPaid as number)
      ? (normalized.shippingPaid as number).toFixed(2)
      : '0',
    items: normalized.items ?? [],
    raw,
    externallyShipped: normalized.externallyShipped === true,
  };
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

type OrphanRow = {
  id: number;
  orderNumber: string | null;
  clientId: number | null;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
};

type ReconcileReport = {
  orphanShipmentsScanned: number;
  distinctOrderNumbers: number;
  linkLocal: number;
  hydrate: number;
  manual: number;
  ambiguous: number;
  lookupFailed: number;
  // --link-only mode: orphans with no local order whose upstream lookup was
  // skipped (deferred to a later hydrate pass). 0 in normal mode.
  deferred: number;
  // Apply-mode outcomes (0 in dry-run)
  ordersHydrated: number;
  shipmentsLinked: number;
  inventoryDeducted: number;
  samples: Array<{
    orderNumber: string | null;
    classification: OrphanClassification;
    localCandidates: number;
    orphanShipmentIds: number[];
  }>;
};

function printUsage(): void {
  console.log(`
PS-046 orphan ShipStation shipment reconciliation / backfill

Usage:
  npm run shipstation:orphans:dry-run
  npm run shipstation:orphans:dry-run -- --order-numbers 1039,1040,1041
  npm run shipstation:orphans:dry-run -- --limit 2000
  npm run shipstation:orphans:apply -- --order-numbers 1039,1040,1041   # DJ-approved only
  npm run shipstation:orphans:link-only                                 # fast: link existing-order matches only

Options:
  --order-numbers a,b,c   Restrict to specific orphan order numbers.
  --limit <n>             Max orphan shipment rows to scan. Default: all.
  --page-size <n>         ShipStation order-lookup page size. Default: ${PAGE_SIZE_DEFAULT}.
  --apply                 Hydrate missing orders + link orphan shipments. OFF by default.
  --link-only             Skip the slow ShipStation hydrate lookups; only link
                          orphans whose order already exists locally (pure DB,
                          seconds). No-local-order orphans are deferred.

Safety:
  Dry run only unless --apply is present. Apply hydrates via the canonical
  upsert (no duplicate orders), links shipments by order number, never deletes
  rows, never buys labels/postage, never notifies marketplaces, and never
  reopens shipped/cancelled orders. Requires DJ approval at run time.
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const apply = hasFlag('apply');
  // --link-only: skip the (slow, ~10s each) ShipStation upstream lookups and
  // only act on orphans whose order ALREADY exists locally (pure DB linkage,
  // seconds not hours). Orphans with no local order are deferred to a later
  // full hydrate pass. The fast, high-value subset of the backfill.
  const linkOnly = hasFlag('link-only');
  const orderNumbersFilter = parseOrderNumbers();
  const limit = argValue('limit') ? parsePositiveInteger('limit', 0) : null;

  console.log(`\n[orphan-reconcile] ${apply ? 'APPLY' : 'DRY RUN'}${linkOnly ? ' (link-only)' : ''}`);
  console.log(
    `filter=${orderNumbersFilter ? orderNumbersFilter.join(',') : '(all non-voided orphans)'} limit=${limit ?? 'none'}`,
  );

  // 1. Load orphan shipments: order_id IS NULL and not voided.
  const baseWhere = and(isNull(shipments.orderId), eq(shipments.voided, false));
  const where = orderNumbersFilter
    ? and(baseWhere, inArray(shipments.orderNumber, orderNumbersFilter))
    : baseWhere;
  const orphanQuery = db
    .select({
      id: shipments.id,
      orderNumber: shipments.orderNumber,
      clientId: shipments.clientId,
      carrierCode: shipments.carrierCode,
      serviceCode: shipments.serviceCode,
      trackingNumber: shipments.trackingNumber,
    })
    .from(shipments)
    .where(where)
    .orderBy(shipments.id);
  const orphanRows: OrphanRow[] = limit ? await orphanQuery.limit(limit) : await orphanQuery;

  // 2. Group orphans by order number.
  const orphansByNumber = new Map<string, OrphanRow[]>();
  const noNumber: OrphanRow[] = [];
  for (const row of orphanRows) {
    const num = (row.orderNumber ?? '').trim();
    if (!num) {
      noNumber.push(row);
      continue;
    }
    if (!orphansByNumber.has(num)) orphansByNumber.set(num, []);
    orphansByNumber.get(num)!.push(row);
  }

  // 3. Look up existing local orders for those order numbers.
  const orderNumbers = [...orphansByNumber.keys()];
  const localByNumber = new Map<string, LocalOrderCandidate[]>();
  for (let i = 0; i < orderNumbers.length; i += 500) {
    const chunk = orderNumbers.slice(i, i + 500);
    if (!chunk.length) continue;
    const rows = await db
      .select({
        id: orders.id,
        clientId: orders.clientId,
        externalOrderId: orders.externalOrderId,
        orderNumber: orders.orderNumber,
      })
      .from(orders)
      .where(inArray(orders.orderNumber, chunk));
    for (const r of rows) {
      const num = (r.orderNumber ?? '').trim();
      if (!num) continue;
      if (!localByNumber.has(num)) localByNumber.set(num, []);
      localByNumber.get(num)!.push({ id: r.id, clientId: r.clientId, externalOrderId: r.externalOrderId });
    }
  }

  const accounts = await loadReconcileAccounts();
  const storeToClient = apply ? await buildStoreToClientMap() : new Map<number, number>();

  const report: ReconcileReport = {
    orphanShipmentsScanned: orphanRows.length,
    distinctOrderNumbers: orderNumbers.length,
    linkLocal: 0,
    hydrate: 0,
    manual: 0,
    ambiguous: 0,
    lookupFailed: 0,
    deferred: 0,
    ordersHydrated: 0,
    shipmentsLinked: 0,
    inventoryDeducted: 0,
    samples: [],
  };

  // 4. Classify + (optionally) apply, per distinct order number.
  for (const [orderNumber, orphanGroup] of orphansByNumber) {
    const localCandidates = localByNumber.get(orderNumber) ?? [];
    const rowCount = orphanGroup.length;

    // --link-only fast path: an orphan with no local order would need a ~10s
    // ShipStation lookup to decide hydrate vs manual. Skip it entirely and
    // defer to a later full pass — this mode only links existing-order matches.
    if (linkOnly && localCandidates.length === 0) {
      report.deferred += rowCount;
      if (report.samples.length < 50) {
        report.samples.push({
          orderNumber,
          classification: 'manual', // placeholder; truly "deferred" — see report.deferred
          localCandidates: 0,
          orphanShipmentIds: orphanGroup.map((o) => o.id),
        });
      }
      continue;
    }

    // Only consult ShipStation when there is no local candidate (keeps the
    // network footprint proportional to the genuinely-missing set).
    let upstream = { found: false, lookupFailed: false };
    let normalizedUpstream: ReturnType<typeof normalizeShipStationOrder> | null = null;
    if (localCandidates.length === 0) {
      const result = await lookupUpstreamOrderByNumber(orderNumber, accounts);
      upstream = { found: result.found, lookupFailed: result.lookupFailed };
      normalizedUpstream = result.normalized;
    }

    const classification = classifyOrphanShipment({
      orderNumber,
      localOrderCandidates: localCandidates,
      upstream,
    });

    // Count shipment ROWS per bucket (not distinct order numbers) so the
    // buckets sum to orphanShipmentsScanned and read as "how many shipment
    // rows are in each state".
    switch (classification) {
      case 'link_local':
        report.linkLocal += rowCount;
        break;
      case 'hydrate':
        report.hydrate += rowCount;
        break;
      case 'manual':
        report.manual += rowCount;
        break;
      case 'ambiguous':
        report.ambiguous += rowCount;
        break;
      case 'lookup_failed':
        report.lookupFailed += rowCount;
        break;
    }

    if (report.samples.length < 50) {
      report.samples.push({
        orderNumber,
        classification,
        localCandidates: localCandidates.length,
        orphanShipmentIds: orphanGroup.map((o) => o.id),
      });
    }

    if (!apply) continue;

    // ---- APPLY ----
    if (classification === 'link_local') {
      const target = localCandidates[0];
      const linked = await db
        .update(shipments)
        .set({ orderId: target.id, clientId: target.clientId, updatedAt: new Date() })
        .where(and(isNull(shipments.orderId), eq(shipments.orderNumber, orderNumber)))
        .returning({ id: shipments.id });
      report.shipmentsLinked += linked.length;
    } else if (classification === 'hydrate' && normalizedUpstream) {
      const storeOrder = toNormalizedStoreOrder(
        normalizedUpstream,
        storeToClient,
        // Attribute to the per-client account owner when the store isn't mapped.
        accounts.find((a) => a.ownerClientId != null)?.ownerClientId ?? null,
      );
      if (storeOrder) {
        await upsertNormalizedStoreOrders([storeOrder]);
        const hydratedRows = await db
          .select()
          .from(orders)
          .where(eq(orders.externalOrderId, storeOrder.externalOrderId ?? ''));
        report.ordersHydrated += hydratedRows.length;
        for (const row of hydratedRows) {
          const linked = await db
            .update(shipments)
            .set({ orderId: row.id, clientId: row.clientId, updatedAt: new Date() })
            .where(and(isNull(shipments.orderId), eq(shipments.orderNumber, row.orderNumber)))
            .returning({ id: shipments.id });
          report.shipmentsLinked += linked.length;
          // Mirror order-sync's forward path: a hydrated SHIPPED order must run
          // the same AI-locked inventory deduction (kill-switch + ledger-dedupe
          // protected) so backfilled orders don't skip stock movement.
          if (row.orderStatus === 'shipped') {
            try {
              // Per user override unlock shipped data on 2026-07-14: enqueue
              // durable intent; do not execute shipped stock writes inline.
              await enqueueInventoryDeduction(row, { source: 'order_sync_status' });
              report.inventoryDeducted += 1;
            } catch (err) {
              console.warn('[orphan-reconcile] inventory deduction failed:', err);
            }
          }
        }
      }
    }
  }

  // Orphans with no order number can't be reconciled against anything — they
  // are standalone/manual labels by definition. Counted as manual shipment rows.
  if (noNumber.length) {
    report.manual += noNumber.length;
    if (report.samples.length < 50) {
      report.samples.push({
        orderNumber: null,
        classification: 'manual',
        localCandidates: 0,
        orphanShipmentIds: noNumber.map((o) => o.id),
      });
    }
  }

  // 5. Report.
  console.log('\n[orphan-reconcile] summary');
  console.table([
    {
      orphanShipmentsScanned: report.orphanShipmentsScanned,
      distinctOrderNumbers: report.distinctOrderNumbers,
      link_local: report.linkLocal,
      hydrate: report.hydrate,
      manual: report.manual,
      ambiguous: report.ambiguous,
      lookup_failed: report.lookupFailed,
      deferred: report.deferred,
    },
  ]);
  if (linkOnly && report.deferred) {
    console.log(
      `\nlink-only mode: ${report.deferred} orphan(s) with no local order were deferred ` +
        `(skipped the slow ShipStation hydrate lookup). Run a full pass (no --link-only) to hydrate those.`,
    );
  }
  if (apply) {
    console.log(
      `\n[orphan-reconcile] applied: ordersHydrated=${report.ordersHydrated} ` +
        `shipmentsLinked=${report.shipmentsLinked} inventoryDeducted=${report.inventoryDeducted}`,
    );
  } else {
    console.log('\nDry run only. Re-run with --apply (DJ-approved) after review.');
  }
  if (report.samples.length) {
    console.log('\nSamples (order number → classification):');
    console.table(
      report.samples.map((s) => ({
        orderNumber: s.orderNumber,
        classification: s.classification,
        localCandidates: s.localCandidates,
        orphanShipments: s.orphanShipmentIds.length,
      })),
    );
  }
}

// Only auto-run when invoked directly (so guards/tests can import the pure
// classifier without triggering DB/network).
const invokedDirectly =
  process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
