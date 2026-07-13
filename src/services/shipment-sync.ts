import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { ensureShipmentsSelectedRateCostColumn } from '../db/ensure-shipments-selected-rate-cost';
import { clients } from '../db/schema/clients';
import { listShipStationShipments } from '../connectors/store/shipstation';
import { resolveBillingSelectedRateCost } from './billing-selected-rate-cost';
import {
  listShipStationV2Labels,
  listShipStationV2Shipments,
} from '../connectors/carrier/shipstation';
import { deductInventoryForOrder } from './fulfillment-deductions';
import { consumeOutboundPackageInTransaction } from './package-consumption';
import { ensurePackageConsumptionSchema } from './package-consumption-schema';
import { getSettingNumber, setSetting } from './settings';
import { formatShipStationV1DateParam, parseShipStationV1Date } from '../lib/shipstation/v1-date';
import {
  buildOrderSourceIdentity,
  orderSourceIdentityKey,
  orderSourceIdentityOrLegacyPredicate,
  type OrderSourceIdentity,
} from './order-source-identity';
import {
  createSyncRunBudget,
  syncRunBudgetExhausted,
  syncRunBudgetTimeExhausted,
} from '../lib/sync-run-budget';
// PS-286 (per user override `unlock shipped data` on 2026-06-17): best-effort capture of
// shipments.label_url after each account's sync — the v1 list payload omits it.
import { enrichLabelUrls } from './shipment-label-url-enrich';

const LAST_SYNC_KEY = 'shipment_sync.last_created_ms';
const DEFAULT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 7; // 7 days on first run
const WATERMARK_OVERLAP_MS = 1000 * 60 * 60 * 48; // re-read recent labels so missed rows self-heal
// Per user override unlock shipped data on 2026-07-07: shipment sync shares
// the ShipStation lane with order sync, so it must return quickly enough that
// awaiting split-child imports are not starved.
const DEFAULT_SHIPMENT_SYNC_PAGE_SIZE = 100;
// Per user override unlock shipped data on 2026-07-02: background shipment sync
// owns the shipped shipment read model, so it must be bounded. A slow provider
// page should fail this tick and retry shortly, not hold the shared lane for 10m.
const BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS = 25_000;
const SHIPMENT_ENRICHMENT_MIN_REMAINING_MS = 90_000;

function syncBudgetRemainingMs(
  budget: ReturnType<typeof createSyncRunBudget>,
  nowMs = Date.now(),
): number {
  return budget.timeBudgetMs - (nowMs - budget.startedAtMs);
}

function hasSyncBudgetRoom(
  budget: ReturnType<typeof createSyncRunBudget>,
  requiredMs = SHIPMENT_ENRICHMENT_MIN_REMAINING_MS,
): boolean {
  return syncBudgetRemainingMs(budget) >= requiredMs;
}

type SSShipment = {
  shipmentId: number;
  orderId: number;
  orderKey?: string | null;
  orderNumber?: string | null;
  userId?: string | null;
  customerEmail?: string | null;
  createDate?: string | null;
  shipDate?: string | null;
  shipmentCost?: number | null;
  insuranceCost?: number | null;
  trackingNumber?: string | null;
  isReturnLabel?: boolean | null;
  batchNumber?: string | null;
  carrierCode?: string | null;
  serviceCode?: string | null;
  packageCode?: string | null;
  confirmation?: string | null;
  warehouseId?: number | null;
  voided?: boolean | null;
  voidDate?: string | null;
  marketplaceNotified?: boolean | null;
  notifyErrorMessage?: string | null;
  shipTo?: Record<string, unknown> | null;
  weight?: { value: number; units: string } | null;
  dimensions?: { length: number; width: number; height: number } | null;
  advancedOptions?: { storeId?: number | null } | null;
  shipmentItems?: unknown[] | null;
  labelData?: string | null;
  formData?: string | null;
};

type SSShipmentsList = {
  shipments: SSShipment[];
  total: number;
  page: number;
  pages: number;
};

function toOunces(w?: SSShipment['weight']): number | null {
  if (!w || typeof w.value !== 'number') return null;
  switch ((w.units ?? '').toLowerCase()) {
    case 'ounces':
      return w.value;
    case 'pounds':
      return w.value * 16;
    case 'grams':
      return w.value / 28.3495;
    default:
      return w.value;
  }
}

function toNumeric(n?: number | null): string | null {
  return Number.isFinite(n as number) ? (n as number).toFixed(2) : null;
}

type ShipmentValues = typeof shipments.$inferInsert;

function shipmentValues(
  s: SSShipment,
  orderId: number | null,
  clientId: number | null
): ShipmentValues {
  return {
    orderId,
    clientId,
    orderNumber: s.orderNumber ?? null,
    carrierCode: s.carrierCode ?? null,
    serviceCode: s.serviceCode ?? null,
    trackingNumber: s.trackingNumber ?? null,
    shipDate: parseShipStationV1Date(s.shipDate),
    createDate: parseShipStationV1Date(s.createDate),
    weightOz: toOunces(s.weight),
    dimsL: s.dimensions?.length ?? null,
    dimsW: s.dimensions?.width ?? null,
    dimsH: s.dimensions?.height ?? null,
    cost: toNumeric(s.shipmentCost),
    labelTracking: s.trackingNumber ?? null,
    labelCarrier: s.carrierCode ?? null,
    labelService: s.serviceCode ?? null,
    labelShipDate: parseShipStationV1Date(s.shipDate),
    labelShipmentId: s.shipmentId,
    voided: Boolean(s.voided),
    source: 'shipstation',
    isReturn: Boolean(s.isReturnLabel),
    updatedAt: new Date(),
  };
}

function shipStationShipmentSourceIdentity(s: SSShipment): OrderSourceIdentity | null {
  return buildOrderSourceIdentity({
    sourceProvider: 'shipstation',
    sourceAccountId: s.advancedOptions?.storeId != null ? `store:${s.advancedOptions.storeId}` : 'shipstation-default',
    sourceOrderId: s.orderId,
  });
}

// Batched upsert — one page of shipments becomes (at most) four DB
// round-trips total instead of 5 per shipment. ~10x faster than the
// old per-row loop.
//
// Flow:
//   1. Pre-fetch every matching order in one query (by source identity with bounded legacy fallback)
//   2. Pre-fetch every isTest client flag in one query
//   3. Pre-fetch every existing shipment (by labelShipmentId IN ...)
//   4. Split into inserts (new) + updates (existing), then run them
//      in parallel with a small concurrency cap for the updates.
async function upsertShipmentsBatch(
  pageShipments: SSShipment[],
  sourceAccountId: string,
  sourceAccountIsTest: boolean,
): Promise<{
  inserted: number;
  updated: number;
  matched: number;
  shippedOrderIds: number[];
}> {
  if (!pageShipments.length) {
    return { inserted: 0, updated: 0, matched: 0, shippedOrderIds: [] };
  }

  const sourceIdentities = pageShipments
    .map(shipStationShipmentSourceIdentity)
    .filter((identity): identity is OrderSourceIdentity => identity !== null);
  const externalIds = [...new Set(pageShipments.map((s) => String(s.orderId)))];
  const labelIds = [...new Set(pageShipments.map((s) => s.shipmentId))];
  const orderLookupPredicate = orderSourceIdentityOrLegacyPredicate({
    identities: sourceIdentities,
    legacyExternalOrderIds: externalIds,
    includeUnqualifiedShipStationLegacy: true,
  });

  // 1. Orders lookup
  const orderRows = orderLookupPredicate
    ? await db
        .select({
          id: orders.id,
          clientId: orders.clientId,
          externalOrderId: orders.externalOrderId,
          sourceProvider: orders.sourceProvider,
          sourceAccountId: orders.sourceAccountId,
          sourceOrderId: orders.sourceOrderId,
          status: orders.orderStatus,
        })
        .from(orders)
        .where(orderLookupPredicate)
    : [];
  const orderByExt = new Map<
    string,
    { id: number; clientId: number | null; status: string }
  >();
  const orderBySource = new Map<
    string,
    { id: number; clientId: number | null; status: string }
  >();
  for (const o of orderRows) {
    const identity = buildOrderSourceIdentity(o);
    if (identity) {
      orderBySource.set(orderSourceIdentityKey(identity), {
        id: o.id,
        clientId: o.clientId ?? null,
        status: o.status,
      });
    }
    if (o.externalOrderId) {
      orderByExt.set(o.externalOrderId, {
        id: o.id,
        clientId: o.clientId ?? null,
        status: o.status,
      });
    }
  }

  // 2. Test clients lookup — single query for all unique client IDs we saw
  const clientIds = [
    ...new Set(orderRows.map((o) => o.clientId).filter((id): id is number => id !== null)),
  ];
  const testClientSet = new Set<number>();
  if (clientIds.length) {
    const cliRows = await db
      .select({ id: clients.id, isTest: clients.isTest })
      .from(clients)
      .where(inArray(clients.id, clientIds));
    for (const c of cliRows) if (c.isTest) testClientSet.add(c.id);
  }

  // 3. Existing shipments lookup — fetch existing id + providerAccountId +
  // createDate so we can preserve them in updates (v2-parity: v2's ON CONFLICT
  // uses COALESCE(excluded.providerAccountId, shipments.providerAccountId)
  // which keeps the value set by the V2 enrichment pass instead of nulling
  // it on every re-sync). Without preservation, each sync cycle clobbers
  // downstream enrichments.
  const existingRows = labelIds.length
    ? await db
        .select({
          id: shipments.id,
          labelShipmentId: shipments.labelShipmentId,
          providerAccountId: shipments.providerAccountId,
          createDate: shipments.createDate,
          // Audit SY-5: fetched so updates can preserve the order link + provenance.
          orderId: shipments.orderId,
          clientId: shipments.clientId,
          source: shipments.source,
        })
        .from(shipments)
        .where(inArray(shipments.labelShipmentId, labelIds))
    : [];
  const existingByLabel = new Map<
    number,
    {
      id: number;
      providerAccountId: number | null;
      createDate: Date | null;
      orderId: number | null;
      clientId: number | null;
      source: string | null;
    }
  >();
  for (const r of existingRows) {
    if (r.labelShipmentId !== null) {
      existingByLabel.set(r.labelShipmentId, {
        id: r.id,
        providerAccountId: r.providerAccountId ?? null,
        createDate: r.createDate ?? null,
        orderId: r.orderId ?? null,
        clientId: r.clientId ?? null,
        source: r.source ?? null,
      });
    }
  }

  // 4. v2-parity: find orders that already have a non-voided PrepShip-created
  // shipment (source IN 'prepship','prepship_v2','test_offline'). v2 skips
  // SS-sourced shipments for these orders entirely to avoid duplicate rows
  // (the local PrepShip label is authoritative). v4 was inserting both,
  // creating duplicates. Source: apps/api/src/modules/sync/order-status-sync.ts:207-216.
  const orderIdsForCheck = orderRows.map((o) => o.id);
  const prepshipOrderIds = new Set<number>();
  if (orderIdsForCheck.length) {
    const prepshipRows = await db
      .select({ orderId: shipments.orderId })
      .from(shipments)
      .where(
        and(
          inArray(shipments.orderId, orderIdsForCheck),
          eq(shipments.voided, false),
          inArray(shipments.source, ['prepship', 'prepship_v2', 'test_offline'])
        )
      );
    for (const r of prepshipRows) {
      if (r.orderId !== null) prepshipOrderIds.add(r.orderId);
    }
  }

  // Build insert / update batches
  const toInsert: ShipmentValues[] = [];
  const toUpdate: Array<{ id: number; values: ShipmentValues }> = [];
  let matched = 0;
  const shippedOrderIds: number[] = [];

  for (const s of pageShipments) {
    const identity = shipStationShipmentSourceIdentity(s);
    const ord =
      (identity ? orderBySource.get(orderSourceIdentityKey(identity)) : undefined) ??
      orderByExt.get(String(s.orderId));
    // Test-client guard: skip entirely if matched order's client is isTest
    if (ord?.clientId && testClientSet.has(ord.clientId)) continue;

    // v2-parity PrepShip guard: if the order already has a non-voided
    // PrepShip label, the SS-sourced shipment is a duplicate — skip it.
    // Per user override `unlock shipped data` on 2026-05-21: an active
    // outbound ShipStation label may still promote an awaiting order before
    // we skip inserting the duplicate SS shipment row.
    if (ord && prepshipOrderIds.has(ord.id)) {
      matched += 1;
      if (
        ord.status === 'awaiting_shipment' &&
        Boolean(s.voided) === false &&
        Boolean(s.isReturnLabel) === false
      ) {
        shippedOrderIds.push(ord.id);
      }
      continue;
    }

    if (ord) matched += 1;

    const values = shipmentValues(s, ord?.id ?? null, ord?.clientId ?? null);
    const existing = existingByLabel.get(s.shipmentId);
    if (existing !== undefined) {
      // v2-parity preservation: keep existing providerAccountId/createDate
      // when the SS payload doesn't provide them (COALESCE behavior).
      if (values.providerAccountId == null && existing.providerAccountId != null) {
        values.providerAccountId = existing.providerAccountId;
      }
      if (values.createDate == null && existing.createDate != null) {
        values.createDate = existing.createDate;
      }
      // Audit SY-5 (2026-07-13) — Per user override unlock shipped data on
      // 2026-07-13: field-level preservation on UPDATE. When the order lookup
      // misses (identity drift, deleted/merged order, manually-linked row),
      // values.orderId/clientId are null and the whole-row update silently
      // UNLINKED a previously-linked shipped shipment from its order — the
      // Shipped view and billing lose the join. shipmentValues also hardcodes
      // source:'shipstation', which rewrote the provenance of a PrepShip-created
      // row sharing the labelShipmentId and defeated the duplicate guard on the
      // next pass. Never null a link, never rewrite provenance, on update.
      if (values.orderId == null && existing.orderId != null) {
        values.orderId = existing.orderId;
      }
      if (values.clientId == null && existing.clientId != null) {
        values.clientId = existing.clientId;
      }
      if (existing.source) {
        values.source = existing.source;
      }
      // PS-370: do NOT set selected_rate_cost on UPDATE — the update SET omits
      // otherCost (existing value is preserved), so writing cost-only here would
      // drop a labeled row's insurance/other and change its billed total. Updates
      // keep the column untouched; a labeled row keeps its exact persisted value,
      // an un-backfilled row stays NULL and reads its fallback.
      toUpdate.push({ id: existing.id, values });
    } else {
      // Per user override unlock shipped data on 2026-07-06: PS-381 stamps the
      // selected/purchased cost SOT on NEW ShipStation sync rows only. Updates
      // still leave existing selected_rate_cost untouched to avoid rewriting
      // historical shipment truth.
      values.otherCost = toNumeric(s.insuranceCost) ?? '0.00';
      values.selectedRateCost = resolveBillingSelectedRateCost({
        cost: values.cost,
        otherCost: values.otherCost,
        selectedRateJson: null,
      })?.toFixed(2) ?? null;
      toInsert.push(values);
    }

    // v2-parity: collect shippedOrderIds ONLY for rows that will be
    // upserted (not skipped). Collected here (after all skips resolved)
    // so the outer order-status flip doesn't mark orders shipped when
    // we dropped their corresponding shipment row.
    // Per user override `unlock shipped data` on 2026-05-19: do not let a
    // voided ShipStation label re-close an order that ShipStation still shows
    // in Awaiting. Only active outbound shipments can promote an order.
    if (
      ord &&
      ord.status === 'awaiting_shipment' &&
      values.voided === false &&
      values.isReturn === false
    ) {
      shippedOrderIds.push(ord.id);
    }
  }

  // 4a. Single INSERT for all new rows (chunk to 500 to stay below pg param limits)
  // PS-370: ensure the additive selected_rate_cost column exists before the new-row
  // inserts reference it. Standalone insert (no wrapping tx) so no lock/deadlock risk;
  // memoized (real DDL only on the first sync after a deploy, then a no-op).
  if (toInsert.length) await ensureShipmentsSelectedRateCostColumn();
  let inserted = 0;
  const chunkSize = 500;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize);
    if (chunk.length) {
      // Per user override unlock shipped data on 2026-07-11: PS-413 records
      // package consumption only for NEW ShipStation shipment rows. Existing
      // history is never auto-backfilled; repair remains dry-run and reviewed.
      await ensurePackageConsumptionSchema();
      await db.transaction(async (tx) => {
        const insertedRows = await tx
          .insert(shipments)
          .values(chunk)
          // Audit SY-3 / 1.21 (Per user override unlock shipped data on
          // 2026-07-13): label_shipment_id is UNIQUE now — a racing writer
          // (deadline-abandoned zombie + fresh run) loses quietly instead of
          // duplicating the row. Skipped rows also skip package consumption
          // below (returning() yields inserted rows only), which is exactly
          // right: the winner already consumed.
          .onConflictDoNothing({
            target: [shipments.labelShipmentId],
            where: sql`${shipments.labelShipmentId} is not null`,
          })
          .returning({
            id: shipments.id,
            orderId: shipments.orderId,
            orderNumber: shipments.orderNumber,
            labelShipmentId: shipments.labelShipmentId,
            providerAccountId: shipments.providerAccountId,
            selectedPackageId: shipments.selectedPackageId,
            shipDate: shipments.shipDate,
            createDate: shipments.createDate,
            dimsL: shipments.dimsL,
            dimsW: shipments.dimsW,
            dimsH: shipments.dimsH,
            voided: shipments.voided,
            isReturn: shipments.isReturn,
          });
        for (const row of insertedRows) {
          const result = await consumeOutboundPackageInTransaction({
            shipmentId: row.id,
            orderId: row.orderId,
            orderNumber: row.orderNumber,
            source: 'shipstation',
            sourceAccountId,
            providerShipmentId: row.labelShipmentId,
            effectiveAt: row.shipDate ?? row.createDate ?? new Date(),
            selectedPackageId: row.selectedPackageId,
            dimensions: { length: row.dimsL, width: row.dimsW, height: row.dimsH },
            voided: row.voided,
            isReturn: row.isReturn,
            isTest: sourceAccountIsTest,
          }, tx);
          if (result.status === 'review') {
            console.warn(
              `[shipment-sync] package consumption review for shipment ${row.id}: ${result.reason}`,
            );
          }
        }
        inserted += insertedRows.length;
      });
    }
  }

  // 4b. Parallel UPDATEs (no single-statement way to update N rows with
  // different values; use limited concurrency to avoid pooler saturation).
  // Supabase's default pgbouncer pool tops out at 15 shared connections —
  // 3-at-a-time leaves headroom for other API traffic + the 3-min scheduler.
  const updateConcurrency = 3;
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += updateConcurrency) {
    const batch = toUpdate.slice(i, i + updateConcurrency);
    await Promise.all(
      batch.map((u) =>
        db.update(shipments).set(u.values).where(eq(shipments.id, u.id))
      )
    );
    updated += batch.length;
  }

  return { inserted, updated, matched, shippedOrderIds };
}

export type ShipmentSyncResult = {
  fetched: number;
  inserted: number;
  updated: number;
  matchedOrders: number;
  orphaned: number; // shipments with no matching order row
  ordersMarkedShipped: number;
  pages: number;
  lastSyncedAt: string;
  sinceIso: string;
};

type ShipmentSyncAccount = {
  label: string;
  sourceAccountId: string;
  isTest: boolean;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  // v2-parity: V2 key is used for the /v2/shipments enrichment pass (which
  // fills in providerAccountId). null when a client has no V2 key set —
  // enrichment skips that account. Main account uses env.SHIPSTATION_API_KEY_V2.
  apiKeyV2: string | null;
};

async function loadShipmentSyncAccounts(): Promise<ShipmentSyncAccount[]> {
  // Main account's V2 key comes from env; the connector-owned ShipStation client falls back to
  // env.SHIPSTATION_API_KEY_V2 when apiKey is undefined, so we mirror that
  // explicitly here so the enrichment pass knows whether it can run for main.
  const { env } = await import('../lib/env');
  const accounts: ShipmentSyncAccount[] = [
    {
      label: 'main',
      sourceAccountId: 'main',
      isTest: false,
      apiKey: undefined,
      apiSecret: undefined,
      apiKeyV2: env.SHIPSTATION_API_KEY_V2 ?? null,
    },
  ];
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      ssApiKey: clients.ssApiKey,
      ssApiSecret: clients.ssApiSecret,
      ssApiKeyV2: clients.ssApiKeyV2,
      isTest: clients.isTest,
    })
    .from(clients)
    .where(eq(clients.active, true));
  for (const r of rows) {
    if (r.ssApiKey && r.ssApiSecret) {
      accounts.push({
        label: `client:${r.name}`,
        sourceAccountId: `client:${r.id}`,
        isTest: r.isTest,
        apiKey: r.ssApiKey,
        apiSecret: r.ssApiSecret,
        apiKeyV2: r.ssApiKeyV2 ?? null,
      });
    }
  }
  return accounts;
}

function shipWatermarkKey(label: string): string {
  return label === 'main' ? LAST_SYNC_KEY : `${LAST_SYNC_KEY}:${label}`;
}

/**
 * Pull shipments from ShipStation v1 that were created after the last sync.
 * Upsert each into our shipments table and — when the matching order is
 * still in "awaiting_shipment" — flip it to "shipped".
 *
 * Iterates every active ShipStation account (env-main + per-client
 * ss_api_key) so multi-org setups (e.g. DR Prepper + KFG) both land in
 * our local shipments table. Runs ONE pass per account.
 */
export async function syncShipments(
  opts: { sinceMs?: number; pageSize?: number } = {}
): Promise<ShipmentSyncResult> {
  // Smaller default pages keep the background worker below its 10-minute guard
  // while still letting explicit backfills request a larger page size.
  const pageSize = opts.pageSize ?? DEFAULT_SHIPMENT_SYNC_PAGE_SIZE;
  const runStartMs = Date.now();
  // PS-265: bound the per-run work so the handler finishes UNDER its ~10-min deadline and
  // advances its watermark incrementally (instead of being killed mid-walk and re-pulling the
  // same backlog forever). Page cap is per account; the time budget is run-wide (all accounts).
  const budget = createSyncRunBudget();

  let totalFetched = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalMatched = 0;
  let maxPages = 1;
  let earliestSinceIso = new Date(runStartMs).toISOString();
  const shippedOrderIds: number[] = [];

  const accounts = await loadShipmentSyncAccounts();
  for (const acct of accounts) {
    if (syncRunBudgetTimeExhausted(budget)) break;
    try {
      const key = shipWatermarkKey(acct.label);
      const storedLastSync = await getSettingNumber(key);
      const lastSync =
        opts.sinceMs ??
        (storedLastSync != null
          ? Math.max(0, storedLastSync - WATERMARK_OVERLAP_MS)
          : Date.now() - DEFAULT_LOOKBACK_MS);
      const sinceIso = new Date(lastSync).toISOString();
      if (sinceIso < earliestSinceIso) earliestSinceIso = sinceIso;
      // Per user override unlock shipped data on 2026-05-29: ShipStation v1
      // createDateStart is account-local wall-clock text, not stripped UTC.
      const sinceParam = formatShipStationV1DateParam(lastSync);

      let page = 1;
      let pagesThisAccount = 0;
      let cursorCreateMs: number | null = null;
      let drained = false;
      while (!syncRunBudgetTimeExhausted(budget)) {
        const q = new URLSearchParams({
          createDateStart: sinceParam,
          pageSize: String(pageSize),
          page: String(page),
          sortBy: 'CreateDate',
          sortDir: 'ASC',
        });

        const res = await listShipStationShipments<SSShipmentsList>(q, {
          apiKey: acct.apiKey,
          apiSecret: acct.apiSecret,
          dedupeKey: `shipments:list:${acct.label}:${sinceParam}:${page}:${pageSize}`,
          timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
        });
        if (res.pages > maxPages) maxPages = res.pages;

        // One batched upsert per page (pre-fetches orders + clients + existing
        // shipments, splits into bulk INSERT + parallel UPDATEs). Per-row loop
        // was the bottleneck — this is ~10x faster.
        const batch = await upsertShipmentsBatch(
          res.shipments,
          acct.sourceAccountId,
          acct.isTest,
        );
        totalFetched += res.shipments.length;
        totalInserted += batch.inserted;
        totalUpdated += batch.updated;
        totalMatched += batch.matched;
        shippedOrderIds.push(...batch.shippedOrderIds);
        pagesThisAccount += 1;
        // PS-265: track the newest CreateDate processed (results are CreateDate ASC) as a
        // resume cursor for a budget-bounded run.
        for (const s of res.shipments) {
          const ms = Date.parse(s.createDate ?? '');
          if (Number.isFinite(ms) && (cursorCreateMs === null || ms > cursorCreateMs)) cursorCreateMs = ms;
        }

        if (!res.shipments.length || page >= res.pages) {
          drained = true;
          break;
        }
        // PS-265: stop before the job-handler deadline so the run RETURNS and its watermark
        // advances to the cursor (incremental drain), instead of being killed mid-walk with
        // the watermark un-advanced — which re-pulled the same backlog every run and drained
        // nothing. Resume from the cursor next run.
        if (syncRunBudgetExhausted(budget, pagesThisAccount)) break;
        page += 1;
        // v2-parity: 500ms inter-page delay.
        await new Promise((r) => setTimeout(r, 500));
      }

      // v2-parity: enrichment pass. v1's /shipments endpoint doesn't expose
      // the numeric `carrierId` (provider account ID) — v2 runs a V2
      // `/v2/shipments` page over the same time window and backfills
      // `shipments.providerAccountId` by matching on tracking number.
      // Mirrors apps/api/src/modules/shipments/application/shipment-services.ts:132.
      // PS-265: skip the (paginated) V2 enrichment when the run is out of time budget — it
      // is best-effort backfill and would push the handler past its deadline. It resumes on
      // a later run once the V1 window is caught up.
      if (hasSyncBudgetRoom(budget)) {
        try {
          const enriched = await enrichProviderAccountIds(acct, lastSync, budget);
          if (enriched > 0) {
            console.log(
              `[shipment-sync] enriched providerAccountId on ${enriched} shipments for "${acct.label}"`
            );
          }
        } catch (err) {
          // Best-effort enrichment — never block the V1 sync on V2 failures.
          console.warn(
            `[shipment-sync] V2 enrichment failed for "${acct.label}":`,
            (err as Error).message
          );
        }

        // PS-286: fill any null shipments.label_url from the account's recent v2 labels so
        // shipped orders are re-queueable. Best-effort — never block the sync on this.
        if (hasSyncBudgetRoom(budget)) {
          try {
            const filled = await enrichLabelUrls(acct, lastSync, {
              timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
              shouldContinue: () =>
                hasSyncBudgetRoom(budget, BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS + 5_000),
            });
            if (filled > 0) {
              console.log(`[shipment-sync] filled label_url on ${filled} shipments for "${acct.label}"`);
            }
          } catch (err) {
            console.warn(
              `[shipment-sync] label_url enrichment failed for "${acct.label}":`,
              (err as Error).message
            );
          }
        }
      }

      // PS-265: advance the watermark. Fully drained within budget -> 'now' (runStartMs), as
      // before. Budget-bounded (backlog remains) -> resume from the last processed CreateDate
      // next run; the read-side 48h overlap re-checks the boundary, so progress is durable and
      // no un-processed shipment is skipped (CreateDate ASC guarantees this).
      //
      // Audit SY-1 (2026-07-13): MONOTONIC guard. An explicit backfill (opts.sinceMs, e.g.
      // fullResync -> 0) walks history oldest-first; when the 10-page budget cut it off, the
      // old code persisted the oldest walked CreateDate (e.g. 2024) as the account watermark —
      // every 3-min cadence run then crawled years of history at <=1000 rows/run, starving
      // CURRENT shipments for days and tripping the watchdog. The watermark may now never move
      // backwards: a budget-cut backfill still processes its pages, it just doesn't rewind the
      // cursor. (A deep backfill wider than one run's budget needs its own cursor key — tracked
      // as Phase-3 work in AUDIT-2026-07-13.md.) A zero-page run stands still (lastSync) instead
      // of jumping to runStartMs, closing the first-run skip edge.
      const candidateMs = drained ? runStartMs : cursorCreateMs ?? storedLastSync ?? lastSync;
      const nextWatermarkMs = Math.max(storedLastSync ?? 0, candidateMs);
      await setSetting(key, String(nextWatermarkMs));
    } catch (err) {
      console.error(
        `[shipment-sync] account "${acct.label}" failed:`,
        (err as Error).message
      );
    }
    // PS-265: stop starting new accounts once the run is out of time budget; their watermarks
    // are unchanged, so they resume on the next run (fair round-robin across runs).
    if (syncRunBudgetTimeExhausted(budget)) break;
  }

  let ordersMarkedShipped = 0;
  if (shippedOrderIds.length) {
    const uniqueIds = Array.from(new Set(shippedOrderIds));
    for (let i = 0; i < uniqueIds.length; i += 500) {
      const rows = await db
        .update(orders)
        .set({ orderStatus: 'shipped', updatedAt: new Date() })
        .where(
          and(
            inArray(orders.id, uniqueIds.slice(i, i + 500)),
            eq(orders.orderStatus, 'awaiting_shipment')
          )
        )
        .returning();
      ordersMarkedShipped += rows.length;
      for (const row of rows) {
        try {
          await deductInventoryForOrder(row, { source: 'shipment_sync' });
        } catch (err) {
          console.warn('[shipment-sync] inventory deduction failed:', err);
        }
      }
    }
  }

  const fetched = totalFetched;
  const inserted = totalInserted;
  const updated = totalUpdated;
  const matchedOrders = totalMatched;
  const pages = maxPages;
  const sinceIso = earliestSinceIso;

  return {
    fetched,
    inserted,
    updated,
    matchedOrders,
    orphaned: fetched - matchedOrders,
    ordersMarkedShipped,
    pages,
    lastSyncedAt: new Date(runStartMs).toISOString(),
    sinceIso,
  };
}

export async function getShipmentSyncStatus(options: { includeShipmentCount?: boolean } = {}): Promise<{
  lastSyncedAt: string | null;
  shipmentCount: number;
}> {
  const ms = await getSettingNumber(LAST_SYNC_KEY);
  const lastSyncedAt = ms ? new Date(ms).toISOString() : null;
  if (options.includeShipmentCount === false) {
    return { lastSyncedAt, shipmentCount: 0 };
  }
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(shipments);
  return { lastSyncedAt, shipmentCount: rows[0]?.count ?? 0 };
}

// v2-parity: V2 shipments enrichment. The V1 /shipments endpoint doesn't
// expose ShipStation's numeric carrier id (the "provider account" that billing
// reconciliation keys on). v2 runs a second V2 `/v2/shipments` pass over the
// same window and backfills `shipments.providerAccountId` + the nickname by
// matching on tracking_number (unique per SS shipment).
//
// Source: apps/api/src/modules/labels/data/shipstation-shipping-gateway.ts:293-314
// + apps/api/src/modules/shipments/application/shipment-services.ts:132.
async function enrichProviderAccountIds(
  acct: { label: string; apiKeyV2: string | null },
  sinceMs: number,
  budget: ReturnType<typeof createSyncRunBudget>,
): Promise<number> {
  if (!acct.apiKeyV2) return 0; // No V2 key → can't enrich this account
  const createdAtStart = new Date(sinceMs).toISOString();
  let page = 1;
  let totalUpdated = 0;
  const maxPages = 20; // safety cap — v2 doesn't cap explicitly but 20*500=10k is plenty

  type V2ProviderRow = {
    shipment_id?: string;
    carrier_id?: string; // "se-12345"
    tracking_number?: string | null;
    external_order_id?: string | null;
  };

  async function applyProviderRows(rows: V2ProviderRow[]): Promise<number> {
    // Audit M2 (2026-07-13): this loop used to issue one UPDATE per tracking number
    // per page per account per tick, unconditionally — prod pg_stat measured 1.25M
    // calls that changed 3,508 rows (99.7% no-ops), each seq-scanning shipments
    // (no tracking_number btree at the time). Gate with ONE indexed SELECT for the
    // page's still-unbound tracking numbers and update only those; in steady state
    // that is 1 SELECT and zero UPDATEs per page.
    const pairs: Array<{ tracking: string; providerId: number }> = [];
    for (const row of rows) {
      const tracking = row.tracking_number ?? null;
      if (!tracking) continue;
      const carrierIdStr = typeof row.carrier_id === 'string' ? row.carrier_id : null;
      if (!carrierIdStr) continue;
      const numericCarrierId = Number.parseInt(
        carrierIdStr.replace(/^se-/, ''),
        10,
      );
      if (!Number.isFinite(numericCarrierId)) continue;
      pairs.push({ tracking, providerId: numericCarrierId });
    }
    if (!pairs.length) return 0;
    const needy = await db
      .select({ trackingNumber: shipments.trackingNumber })
      .from(shipments)
      .where(
        and(
          inArray(shipments.trackingNumber, pairs.map((p) => p.tracking)),
          sql`${shipments.providerAccountId} is null`,
        ),
      );
    const needSet = new Set(needy.map((r) => r.trackingNumber).filter(Boolean));
    let updated = 0;
    for (const pair of pairs) {
      if (!needSet.has(pair.tracking)) continue;
      // Only update rows where providerAccountId is null. Don't clobber
      // an ID that was set during label creation. (Predicate kept even after
      // the gate above — it is the race-safety backstop.)
      const result = await db
        .update(shipments)
        .set({ providerAccountId: pair.providerId, updatedAt: new Date() })
        .where(
          sql`${shipments.trackingNumber} = ${pair.tracking} and ${shipments.providerAccountId} is null`,
        )
        .returning({ id: shipments.id });
      updated += result.length;
    }
    return updated;
  }

  while (page <= maxPages && hasSyncBudgetRoom(budget, BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS + 5_000)) {
    const qs = new URLSearchParams({
      page_size: '500',
      page: String(page),
      sort_dir: 'DESC',
      created_at_start: createdAtStart,
    });
    let payload: { shipments?: V2ProviderRow[]; pages?: number };
    try {
      payload = await listShipStationV2Shipments<{ shipments?: V2ProviderRow[]; pages?: number }>(
        qs,
        {
          apiKeyV2: acct.apiKeyV2,
          dedupeKey: `v2-shipments:enrich:${acct.label}:${createdAtStart}:${page}`,
          timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (err) {
      console.warn(
        `[shipment-sync] V2 enrichment page ${page} failed for "${acct.label}":`,
        (err as Error).message,
      );
      break;
    }

    const rows = Array.isArray(payload?.shipments) ? payload.shipments : [];
    if (!rows.length) break;

    totalUpdated += await applyProviderRows(rows);

    const totalPages = payload.pages ?? 1;
    if (page >= totalPages || rows.length < 500) break;
    page += 1;
    // v2-parity: gentle inter-page pause
    await new Promise((r) => setTimeout(r, 500));
  }

  // ShipStation's V2 shipment list does not always include tracking_number in
  // every account/label shape. The labels endpoint consistently carries the
  // tracking_number + carrier_id pair, so use it as a second best-effort
  // source for older ShipStation-synced shipped rows.
  page = 1;
  while (page <= maxPages && hasSyncBudgetRoom(budget, BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS + 5_000)) {
    const qs = new URLSearchParams({
      page_size: '500',
      page: String(page),
      sort_dir: 'DESC',
      created_at_start: createdAtStart,
    });
    let payload: { labels?: V2ProviderRow[]; pages?: number };
    try {
      payload = await listShipStationV2Labels<{ labels?: V2ProviderRow[]; pages?: number }>(
        qs,
        {
          apiKeyV2: acct.apiKeyV2,
          dedupeKey: `v2-labels:provider-enrich:${acct.label}:${createdAtStart}:${page}`,
          timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
        },
      );
    } catch (err) {
      const fallbackQs = new URLSearchParams({
        page_size: '500',
        page: String(page),
        sort_dir: 'DESC',
      });
      try {
        payload = await listShipStationV2Labels<{ labels?: V2ProviderRow[]; pages?: number }>(
          fallbackQs,
          {
            apiKeyV2: acct.apiKeyV2,
            dedupeKey: `v2-labels:provider-enrich:fallback:${acct.label}:${page}`,
            timeoutMs: BACKGROUND_SHIPSTATION_REQUEST_TIMEOUT_MS,
          },
        );
      } catch {
        console.warn(
          `[shipment-sync] V2 label enrichment page ${page} failed for "${acct.label}":`,
          (err as Error).message,
        );
        break;
      }
    }

    const rows = Array.isArray(payload?.labels) ? payload.labels : [];
    if (!rows.length) break;

    totalUpdated += await applyProviderRows(rows);

    const totalPages = payload.pages ?? 1;
    if (page >= totalPages || rows.length < 500) break;
    page += 1;
    await new Promise((r) => setTimeout(r, 500));
  }

  return totalUpdated;
}
