/**
 * Order Status Sync Orchestrator — Unified sync using shared ShipStationClient
 *
 * Each cycle does 3 things with minimal API calls:
 *
 * 1. STATUS + SHIPMENT SYNC
 *    - Fetch all SS shipped orders modified in last 2h  (1-2 API calls)
 *    - Fetch all SS shipments created in last 2h        (1-2 API calls)
 *    - Join them locally: if shipment exists → save it, external_shipped=0
 *                         if no shipment    → external_shipped=1 (confirmed external)
 *    No per-order API calls. No retry loop. No race condition.
 *
 * 2. CANCELLATION SYNC
 *    - Fetch SS cancelled orders modified in last 2h    (1-2 API calls)
 *    - Mark matching awaiting orders as cancelled
 *
 * 3. ORDER INGEST
 *    - Fetch SS awaiting_shipment orders modified in last 4h (1-2 API calls)
 *    - Insert any new orders not yet in our DB
 *
 * Uses the shared ShipStationClient for:
 * - Centralized rate limiting (token bucket + X-Rate-Limit-Reset)
 * - Circuit breaker (opens after 5 failures, recovers after 30s)
 * - Concurrent request deduplication
 * - No duplicate simultaneous syncs (mutex guard via this.running flag)
 */

import type { DatabaseSync } from "node:sqlite";
import { resolveCarrierNickname } from "../orders/application/carrier-resolver.js";
import { getShipStationClient, type ShipStationClient } from "../../common/shipstation/client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SyncAccount {
  clientId: number;
  accountName: string;
  apiKey: string;
  apiSecret: string;
  v2ApiKey?: string;
  storeIds: number[];
}

interface SSOrderSummary {
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  orderDate: string;
  modifyDate: string;
  customerEmail: string | null;
  shipTo: { name: string | null; city: string | null; state: string | null; postalCode: string | null };
  carrierCode: string | null;
  serviceCode: string | null;
  weight: { value: number; units: string } | null;
  orderTotal: number;
  shippingAmount: number;
  items: unknown[];
  advancedOptions: { storeId: number | null } | null;
}

interface SSShipmentSummary {
  shipmentId: number;
  orderNumber: string;
  carrierCode: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  shipDate: string | null;
  shipmentCost: number;
  formUrl: string | null;
  voided: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toISOStringUTC(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ─── Account + Client helpers ─────────────────────────────────────────────────

function loadAccounts(db: DatabaseSync, mainApiKey: string, mainApiSecret: string): SyncAccount[] {
  const accounts: SyncAccount[] = [];
  const clientRows = db.prepare(`SELECT clientId, storeIds FROM clients WHERE active = 1`).all() as Array<{ clientId: number; storeIds: string }>;
  const mainStoreIds: number[] = [];

  for (const row of clientRows) {
    try { mainStoreIds.push(...(JSON.parse(row.storeIds ?? "[]") as number[])); } catch { /* ignore */ }
  }

  if (mainApiKey && mainApiSecret) {
    accounts.push({ clientId: 0, accountName: "main", apiKey: mainApiKey, apiSecret: mainApiSecret, v2ApiKey: undefined, storeIds: mainStoreIds });
  }

  const clientKeyRows = db.prepare(`
    SELECT clientId, name, ss_api_key, ss_api_secret, ss_api_key_v2, storeIds
    FROM clients WHERE active=1 AND ss_api_key IS NOT NULL AND ss_api_key != ''
  `).all() as Array<{ clientId: number; name: string; ss_api_key: string; ss_api_secret: string; ss_api_key_v2?: string; storeIds: string }>;

  for (const row of clientKeyRows) {
    let storeIds: number[] = [];
    try { storeIds = JSON.parse(row.storeIds ?? "[]") as number[]; } catch { /* ignore */ }
    accounts.push({ clientId: row.clientId, accountName: row.name, apiKey: row.ss_api_key, apiSecret: row.ss_api_secret, v2ApiKey: row.ss_api_key_v2, storeIds });
  }

  return accounts;
}

function resolveClientId(db: DatabaseSync, storeId: number | null): number | null {
  if (!storeId) return null;
  const row = db.prepare(`SELECT clientId FROM clients WHERE active=1 AND storeIds LIKE ? LIMIT 1`).get(`%${storeId}%`) as { clientId: number } | undefined;
  return row?.clientId ?? null;
}

// ─── Save a shipment record ───────────────────────────────────────────────────

function saveShipmentRecord(
  db: DatabaseSync,
  s: SSShipmentSummary,
  orderId: number,
  clientId: number | null,
): void {
  const now = Date.now();
  const nickname = resolveCarrierNickname(null, s.carrierCode, s.trackingNumber, clientId);

  db.prepare(`
    INSERT OR IGNORE INTO shipments (
      shipmentId, orderId, orderNumber, carrierCode, serviceCode, trackingNumber,
      shipDate, labelUrl, shipmentCost, otherCost, voided, updatedAt, clientId,
      provider_account_nickname, source, label_created_at, label_format
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    s.shipmentId, orderId, s.orderNumber, s.carrierCode ?? null, s.serviceCode ?? null,
    s.trackingNumber ?? null, s.shipDate ?? null, s.formUrl ?? null,
    s.shipmentCost, 0, 0, now, clientId,
    nickname, "ss_sync", now, "pdf",
  );

  // Update order_local: real SS label → external_shipped=0
  db.prepare(`INSERT OR IGNORE INTO order_local (orderId, external_shipped, tracking_number, updatedAt) VALUES (?,0,?,?)`).run(orderId, s.trackingNumber ?? null, now);
  db.prepare(`UPDATE order_local SET external_shipped=0, tracking_number=?, updatedAt=? WHERE orderId=?`).run(s.trackingNumber ?? null, now, orderId);
}

// ─── Job 1: Status + Shipment Sync ───────────────────────────────────────────

async function runStatusSync(
  db: DatabaseSync,
  accounts: SyncAccount[],
  modifyDateStart: string,
  client: ShipStationClient,
  signal?: AbortSignal,
): Promise<number> {
  let updated = 0;

  for (const account of accounts) {
    const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };

    // Step A: Bulk-fetch all shipments created in this window.
    const shipmentStart = toISOStringUTC(new Date(Date.now() - 45 * 60 * 1000));
    const shipments = await client.v1Pages<SSShipmentSummary>(
      credentials,
      "/shipments",
      { createDateStart: shipmentStart },
      signal,
    ).catch((err) => {
      console.warn(`[sync] Shipment fetch failed for ${account.accountName}: ${(err as Error).message}`);
      return [] as SSShipmentSummary[];
    });

    // Build lookup: orderNumber → shipment (non-voided only)
    const shipmentMap = new Map<string, SSShipmentSummary>();
    for (const s of shipments) {
      if (!s.voided && s.orderNumber && !shipmentMap.has(s.orderNumber)) {
        shipmentMap.set(s.orderNumber, s);
      }
    }

    // Step B: Fetch all orders marked shipped in this window
    const orders = await client.v1Pages<SSOrderSummary>(
      credentials,
      "/orders",
      { orderStatus: "shipped", modifyDateStart },
      signal,
    ).catch((err) => {
      console.warn(`[sync] Order status fetch failed for ${account.accountName}: ${(err as Error).message}`);
      return [] as SSOrderSummary[];
    });

    const now = Date.now();

    for (const order of orders) {
      if (!order.orderNumber) continue;

      // Only process orders we currently have as awaiting_shipment
      const existing = db.prepare(`
        SELECT orderId, clientId FROM orders WHERE orderNumber=? AND orderStatus='awaiting_shipment' LIMIT 1
      `).get(order.orderNumber) as { orderId: number; clientId: number } | undefined;

      if (!existing) continue;

      // Mark order as shipped
      db.prepare(`UPDATE orders SET orderStatus='shipped', updatedAt=? WHERE orderId=?`).run(now, existing.orderId);
      db.prepare(`INSERT OR IGNORE INTO order_local (orderId, updatedAt) VALUES (?,?)`).run(existing.orderId, now);

      const shipment = shipmentMap.get(order.orderNumber);

      if (shipment) {
        // SS has a shipment record — save it, external_shipped=0.
        // But skip if PrepShip already created a label for this order to avoid duplicates.
        const hasPrepShipLabel = db.prepare(`
          SELECT 1 FROM shipments
          WHERE orderId=? AND voided=0 AND source IN ('prepship_v2', 'prepship', 'test_offline')
          LIMIT 1
        `).get(existing.orderId);

        if (!hasPrepShipLabel) {
          saveShipmentRecord(db, shipment, existing.orderId, existing.clientId);
        }
        console.log(`[sync] Marked shipped: ${order.orderNumber} | ${shipment.carrierCode} ${shipment.trackingNumber ?? "no-tracking"} $${shipment.shipmentCost} via ${account.accountName}`);
      } else {
        // No SS shipment in this window — confirmed external (Amazon/marketplace)
        db.prepare(`UPDATE order_local SET external_shipped=1, updatedAt=? WHERE orderId=?`).run(now, existing.orderId);
        console.log(`[sync] Marked shipped (external): ${order.orderNumber}`);
      }

      updated++;
    }

    // Also save shipments for orders already marked shipped but missing shipment records.
    // Skip orders that already have a PrepShip-created label (source='prepship_v2') to
    // avoid creating duplicate shipment records with different V1/V2 IDs for the same label.
    for (const [orderNumber, shipment] of shipmentMap) {
      const existingShipped = db.prepare(`
        SELECT o.orderId, o.clientId FROM orders o
        LEFT JOIN shipments s ON s.orderId=o.orderId AND s.voided=0
        WHERE o.orderNumber=? AND o.orderStatus='shipped' AND s.shipmentId IS NULL
        LIMIT 1
      `).get(orderNumber) as { orderId: number; clientId: number } | undefined;

      if (!existingShipped) continue;

      // Don't backfill if a PrepShip-originated label already exists for this order.
      // The V1 enrichment background job handles this in label-services.ts.
      const hasPrepShipLabel = db.prepare(`
        SELECT 1 FROM shipments
        WHERE orderId=? AND voided=0 AND source IN ('prepship_v2', 'prepship', 'test_offline')
        LIMIT 1
      `).get(existingShipped.orderId);

      if (hasPrepShipLabel) {
        // PrepShip owns this label — skip SS sync backfill to avoid duplicate records
        continue;
      }

      saveShipmentRecord(db, shipment, existingShipped.orderId, existingShipped.clientId);
      console.log(`[sync] Backfilled shipment: ${orderNumber}`);
    }

    if (accounts.indexOf(account) < accounts.length - 1) {
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }

  return updated;
}

// ─── Job 2: Cancellation Sync ────────────────────────────────────────────────

async function runCancellationSync(
  db: DatabaseSync,
  accounts: SyncAccount[],
  modifyDateStart: string,
  client: ShipStationClient,
  signal?: AbortSignal,
): Promise<number> {
  let cancelled = 0;

  for (const account of accounts) {
    const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };
    const orders = await client.v1Pages<SSOrderSummary>(
      credentials,
      "/orders",
      { orderStatus: "cancelled", modifyDateStart },
      signal,
    ).catch(() => [] as SSOrderSummary[]);

    for (const order of orders) {
      if (!order.orderNumber) continue;
      const existing = db.prepare(`SELECT orderId FROM orders WHERE orderNumber=? AND orderStatus='awaiting_shipment' LIMIT 1`).get(order.orderNumber) as { orderId: number } | undefined;
      if (!existing) continue;
      db.prepare(`UPDATE orders SET orderStatus='cancelled', updatedAt=? WHERE orderId=?`).run(Date.now(), existing.orderId);
      cancelled++;
      console.log(`[sync] Marked cancelled: ${order.orderNumber}`);
    }

    if (accounts.indexOf(account) < accounts.length - 1) await new Promise((r) => setTimeout(r, 1_500));
  }

  return cancelled;
}

// ─── Job 3: Order Ingest ──────────────────────────────────────────────────────

async function runOrderIngest(
  db: DatabaseSync,
  accounts: SyncAccount[],
  modifyDateStart: string,
  client: ShipStationClient,
  signal?: AbortSignal,
): Promise<number> {
  let inserted = 0;

  for (const account of accounts) {
    const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };
    const orders = await client.v1Pages<SSOrderSummary>(
      credentials,
      "/orders",
      { orderStatus: "awaiting_shipment", modifyDateStart },
      signal,
    ).catch(() => [] as SSOrderSummary[]);

    for (const order of orders) {
      if (!order.orderId || !order.orderNumber) continue;
      const exists = db.prepare(`SELECT 1 FROM orders WHERE orderId=? LIMIT 1`).get(order.orderId);
      if (exists) continue;

      const storeId = order.advancedOptions?.storeId ?? null;
      const clientId = resolveClientId(db, storeId);
      if (!clientId) continue;

      const weightOz = order.weight?.value != null
        ? (order.weight.units === "ounces" ? order.weight.value : order.weight.value * 16)
        : null;

      db.prepare(`
        INSERT INTO orders (orderId,orderNumber,orderStatus,orderDate,storeId,customerEmail,
          shipToName,shipToCity,shipToState,shipToPostalCode,carrierCode,serviceCode,
          weightValue,orderTotal,shippingAmount,items,raw,updatedAt,clientId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        order.orderId, order.orderNumber, order.orderStatus, order.orderDate, storeId,
        order.customerEmail ?? null, order.shipTo?.name ?? null, order.shipTo?.city ?? null,
        order.shipTo?.state ?? null, order.shipTo?.postalCode ?? null,
        order.carrierCode ?? null, order.serviceCode ?? null, weightOz,
        order.orderTotal ?? 0, order.shippingAmount ?? 0,
        JSON.stringify(order.items ?? []), JSON.stringify(order), Date.now(), clientId,
      );

      inserted++;
      console.log(`[sync] Ingested: ${order.orderNumber} (orderId=${order.orderId}, client=${clientId})`);
    }

    if (accounts.indexOf(account) < accounts.length - 1) await new Promise((r) => setTimeout(r, 1_500));
  }

  return inserted;
}

// ─── Main Worker Class ────────────────────────────────────────────────────────

export class OrderStatusSyncWorker {
  private readonly db: DatabaseSync;
  private readonly mainApiKey: string;
  private readonly mainApiSecret: string;
  private readonly intervalMs: number;
  private readonly lookbackMs: number;
  private readonly client: ShipStationClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    db: DatabaseSync,
    mainApiKey: string,
    mainApiSecret: string,
    intervalMs = 3 * 60 * 1000,
    lookbackMs = 4 * 60 * 60 * 1000,
    client?: ShipStationClient,
  ) {
    this.db = db;
    this.mainApiKey = mainApiKey;
    this.mainApiSecret = mainApiSecret;
    this.intervalMs = intervalMs;
    this.lookbackMs = lookbackMs;
    this.client = client ?? getShipStationClient();
  }

  start(): void {
    if (this.timer) return;
    console.log(`[sync] Order sync worker started (interval=${this.intervalMs / 1000}s)`);
    void this.runSync();
    this.timer = setInterval(() => void this.runSync(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runSync(): Promise<void> {
    if (this.running) {
      console.log("[sync] Previous sync still running, skipping");
      return;
    }
    this.running = true;

    // Hard cap: abort the entire cycle if SS is unresponsive after 2.5 min
    const cycleAbort = AbortSignal.timeout(150_000);

    // Check circuit breaker state
    const circuitState = this.client.getCircuitState();
    if (circuitState === "open") {
      console.warn(`[sync] Circuit breaker OPEN — skipping cycle`);
      this.running = false;
      return;
    }

    try {
      const accounts = loadAccounts(this.db, this.mainApiKey, this.mainApiSecret);
      const statusStart = toISOStringUTC(new Date(Date.now() - 2 * 60 * 60 * 1000));

      // Job 1: Status + shipment sync (bulk — no per-order calls)
      const statusUpdated = await runStatusSync(this.db, accounts, statusStart, this.client, cycleAbort);

      // Job 2: Cancellation sync
      const cancelled = await runCancellationSync(this.db, accounts, statusStart, this.client, cycleAbort);

      // Job 3: Ingest new awaiting orders
      const ingestStart = toISOStringUTC(new Date(Date.now() - this.lookbackMs));
      const ingested = await runOrderIngest(this.db, accounts, ingestStart, this.client, cycleAbort);

      if (statusUpdated > 0 || cancelled > 0 || ingested > 0) {
        console.log(`[sync] Cycle — ${statusUpdated} shipped, ${cancelled} cancelled, ${ingested} ingested`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync] Cycle error: ${msg}`);
    } finally {
      this.running = false;
    }
  }
}
