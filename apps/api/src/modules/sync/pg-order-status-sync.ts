/**
 * Order Status Sync Orchestrator — PostgreSQL version
 *
 * Postgres adaptation of order-status-sync.ts. Uses the postgres.js
 * tagged-template client instead of node:sqlite DatabaseSync.
 *
 * Each cycle does 3 things with minimal API calls:
 *
 * 1. STATUS + SHIPMENT SYNC
 *    - Fetch all SS shipped orders modified in last 2h
 *    - Fetch all SS shipments created in last 45min
 *    - Join locally and save
 *
 * 2. CANCELLATION SYNC
 *    - Fetch SS cancelled orders modified in last 2h
 *    - Mark matching awaiting orders as cancelled
 *
 * 3. ORDER INGEST
 *    - Fetch SS awaiting_shipment orders modified in last 4h
 *    - Insert any new orders not yet in our DB
 */

import type { Sql } from "postgres";
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

async function loadAccounts(sql: Sql, mainApiKey: string, mainApiSecret: string): Promise<SyncAccount[]> {
  const accounts: SyncAccount[] = [];
  const clientRows = await sql`SELECT "clientId", "storeIds" FROM clients WHERE active = 1`;
  const mainStoreIds: number[] = [];

  for (const row of clientRows) {
    try {
      const ids = typeof row.storeIds === "string" ? JSON.parse(row.storeIds) : (row.storeIds ?? []);
      mainStoreIds.push(...(ids as number[]));
    } catch { /* ignore */ }
  }

  if (mainApiKey && mainApiSecret) {
    accounts.push({ clientId: 0, accountName: "main", apiKey: mainApiKey, apiSecret: mainApiSecret, v2ApiKey: undefined, storeIds: mainStoreIds });
  }

  const clientKeyRows = await sql`
    SELECT "clientId", name, ss_api_key, ss_api_secret, ss_api_key_v2, "storeIds"
    FROM clients WHERE active=1 AND ss_api_key IS NOT NULL AND ss_api_key != ''
  `;

  for (const row of clientKeyRows) {
    let storeIds: number[] = [];
    try {
      const ids = typeof row.storeIds === "string" ? JSON.parse(row.storeIds) : (row.storeIds ?? []);
      storeIds = ids as number[];
    } catch { /* ignore */ }
    const apiKey = (row as Record<string, string>).ssApiKey ?? (row as Record<string, string>).ss_api_key;
    const apiSecret = (row as Record<string, string>).ssApiSecret ?? (row as Record<string, string>).ss_api_secret;
    const v2Key = (row as Record<string, string>).ssApiKeyV2 ?? (row as Record<string, string>).ss_api_key_v2;
    accounts.push({ clientId: row.clientId, accountName: row.name, apiKey, apiSecret, v2ApiKey: v2Key, storeIds });
  }

  return accounts;
}

async function resolveClientId(sql: Sql, storeId: number | null): Promise<number | null> {
  if (!storeId) return null;
  const rows = await sql`
    SELECT "clientId" FROM clients
    WHERE active=1 AND "storeIds"::text LIKE ${`%${storeId}%`}
    LIMIT 1
  `;
  return rows[0]?.clientId ?? null;
}

// ─── Save a shipment record ───────────────────────────────────────────────────

async function saveShipmentRecord(
  sql: Sql,
  s: SSShipmentSummary,
  orderId: number,
  clientId: number | null,
): Promise<void> {
  const now = Date.now();
  const nickname = resolveCarrierNickname(null, s.carrierCode, s.trackingNumber, clientId);

  await sql`
    INSERT INTO shipments (
      "shipmentId", "orderId", "orderNumber", "carrierCode", "serviceCode", "trackingNumber",
      "shipDate", "labelUrl", "shipmentCost", "otherCost", voided, "updatedAt", "clientId",
      provider_account_nickname, source, label_created_at, label_format
    ) VALUES (
      ${s.shipmentId}, ${orderId}, ${s.orderNumber}, ${s.carrierCode ?? null}, ${s.serviceCode ?? null},
      ${s.trackingNumber ?? null}, ${s.shipDate ?? null}, ${s.formUrl ?? null},
      ${s.shipmentCost}, ${0}, ${0}, ${now}, ${clientId},
      ${nickname}, ${"ss_sync"}, ${now}, ${"pdf"}
    )
    ON CONFLICT ("shipmentId") DO NOTHING
  `;

  // Update order_local: real SS label → external_shipped=0
  await sql`
    INSERT INTO order_local ("orderId", external_shipped, tracking_number, "updatedAt")
    VALUES (${orderId}, ${0}, ${s.trackingNumber ?? null}, ${now})
    ON CONFLICT ("orderId") DO UPDATE SET external_shipped=0, tracking_number=${s.trackingNumber ?? null}, "updatedAt"=${now}
  `;
}

// ─── Job 1: Status + Shipment Sync ───────────────────────────────────────────

async function runStatusSync(
  sql: Sql,
  accounts: SyncAccount[],
  modifyDateStart: string,
  client: ShipStationClient,
  signal?: AbortSignal,
): Promise<number> {
  let updated = 0;

  for (const account of accounts) {
    const credentials = { apiKey: account.apiKey, apiSecret: account.apiSecret };

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

    const shipmentMap = new Map<string, SSShipmentSummary>();
    for (const s of shipments) {
      if (!s.voided && s.orderNumber && !shipmentMap.has(s.orderNumber)) {
        shipmentMap.set(s.orderNumber, s);
      }
    }

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

      const existing = await sql`
        SELECT "orderId", "clientId" FROM orders
        WHERE "orderNumber"=${order.orderNumber} AND "orderStatus"='awaiting_shipment'
        LIMIT 1
      `;
      if (!existing[0]) continue;
      const { orderId: existingOrderId, clientId: existingClientId } = existing[0];

      await sql`UPDATE orders SET "orderStatus"='shipped', "updatedAt"=${now} WHERE "orderId"=${existingOrderId}`;
      await sql`
        INSERT INTO order_local ("orderId", "updatedAt")
        VALUES (${existingOrderId}, ${now})
        ON CONFLICT ("orderId") DO NOTHING
      `;

      const shipment = shipmentMap.get(order.orderNumber);

      if (shipment) {
        const hasPrepShipLabel = await sql`
          SELECT 1 FROM shipments
          WHERE "orderId"=${existingOrderId} AND voided=0 AND source IN ('prepship_v2', 'prepship', 'test_offline')
          LIMIT 1
        `;

        if (hasPrepShipLabel.length === 0) {
          await saveShipmentRecord(sql, shipment, existingOrderId, existingClientId);
        }
        console.log(`[sync] Marked shipped: ${order.orderNumber} | ${shipment.carrierCode} ${shipment.trackingNumber ?? "no-tracking"} $${shipment.shipmentCost} via ${account.accountName}`);
      } else {
        await sql`UPDATE order_local SET external_shipped=1, "updatedAt"=${now} WHERE "orderId"=${existingOrderId}`;
        console.log(`[sync] Marked shipped (external): ${order.orderNumber}`);
      }

      updated++;
    }

    for (const [orderNumber, shipment] of shipmentMap) {
      const existingShipped = await sql`
        SELECT o."orderId", o."clientId" FROM orders o
        LEFT JOIN shipments s ON s."orderId"=o."orderId" AND s.voided=0
        WHERE o."orderNumber"=${orderNumber} AND o."orderStatus"='shipped' AND s."shipmentId" IS NULL
        LIMIT 1
      `;
      if (!existingShipped[0]) continue;

      const hasPrepShipLabel = await sql`
        SELECT 1 FROM shipments
        WHERE "orderId"=${existingShipped[0].orderId} AND voided=0 AND source IN ('prepship_v2', 'prepship', 'test_offline')
        LIMIT 1
      `;
      if (hasPrepShipLabel.length > 0) continue;

      await saveShipmentRecord(sql, shipment, existingShipped[0].orderId, existingShipped[0].clientId);
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
  sql: Sql,
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
      const existing = await sql`
        SELECT "orderId" FROM orders WHERE "orderNumber"=${order.orderNumber} AND "orderStatus"='awaiting_shipment' LIMIT 1
      `;
      if (!existing[0]) continue;
      await sql`UPDATE orders SET "orderStatus"='cancelled', "updatedAt"=${Date.now()} WHERE "orderId"=${existing[0].orderId}`;
      cancelled++;
      console.log(`[sync] Marked cancelled: ${order.orderNumber}`);
    }

    if (accounts.indexOf(account) < accounts.length - 1) await new Promise((r) => setTimeout(r, 1_500));
  }

  return cancelled;
}

// ─── Job 3: Order Ingest ──────────────────────────────────────────────────────

async function runOrderIngest(
  sql: Sql,
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
      const exists = await sql`SELECT 1 FROM orders WHERE "orderId"=${order.orderId} LIMIT 1`;
      if (exists.length > 0) continue;

      const storeId = order.advancedOptions?.storeId ?? null;
      const clientId = await resolveClientId(sql, storeId);
      if (!clientId) continue;

      const weightOz = order.weight?.value != null
        ? (order.weight.units === "ounces" ? order.weight.value : order.weight.value * 16)
        : null;

      await sql`
        INSERT INTO orders (
          "orderId", "orderNumber", "orderStatus", "orderDate", "storeId", "customerEmail",
          "shipToName", "shipToCity", "shipToState", "shipToPostalCode", "carrierCode", "serviceCode",
          "weightValue", "orderTotal", "shippingAmount", items, raw, "updatedAt", "clientId"
        ) VALUES (
          ${order.orderId}, ${order.orderNumber}, ${order.orderStatus}, ${order.orderDate}, ${storeId},
          ${order.customerEmail ?? null}, ${order.shipTo?.name ?? null}, ${order.shipTo?.city ?? null},
          ${order.shipTo?.state ?? null}, ${order.shipTo?.postalCode ?? null},
          ${order.carrierCode ?? null}, ${order.serviceCode ?? null}, ${weightOz},
          ${order.orderTotal ?? 0}, ${order.shippingAmount ?? 0},
          ${JSON.stringify(order.items ?? [])}, ${JSON.stringify(order)}, ${Date.now()}, ${clientId}
        )
        ON CONFLICT ("orderId") DO NOTHING
      `;

      inserted++;
      console.log(`[sync] Ingested: ${order.orderNumber} (orderId=${order.orderId}, client=${clientId})`);
    }

    if (accounts.indexOf(account) < accounts.length - 1) await new Promise((r) => setTimeout(r, 1_500));
  }

  return inserted;
}

// ─── Main Worker Class ────────────────────────────────────────────────────────

export class PgOrderStatusSyncWorker {
  private readonly sql: Sql;
  private readonly mainApiKey: string;
  private readonly mainApiSecret: string;
  private readonly intervalMs: number;
  private readonly lookbackMs: number;
  private readonly client: ShipStationClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    sql: Sql,
    mainApiKey: string,
    mainApiSecret: string,
    intervalMs = 3 * 60 * 1000,
    lookbackMs = 4 * 60 * 60 * 1000,
    client?: ShipStationClient,
  ) {
    this.sql = sql;
    this.mainApiKey = mainApiKey;
    this.mainApiSecret = mainApiSecret;
    this.intervalMs = intervalMs;
    this.lookbackMs = lookbackMs;
    this.client = client ?? getShipStationClient();
  }

  start(): void {
    if (this.timer) return;
    console.log(`[sync] PG Order sync worker started (interval=${this.intervalMs / 1000}s)`);
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

    const cycleAbort = AbortSignal.timeout(150_000);

    const circuitState = this.client.getCircuitState();
    if (circuitState === "open") {
      console.warn(`[sync] Circuit breaker OPEN — skipping cycle`);
      this.running = false;
      return;
    }

    try {
      const accounts = await loadAccounts(this.sql, this.mainApiKey, this.mainApiSecret);
      const statusStart = toISOStringUTC(new Date(Date.now() - 2 * 60 * 60 * 1000));

      const statusUpdated = await runStatusSync(this.sql, accounts, statusStart, this.client, cycleAbort);
      const cancelled = await runCancellationSync(this.sql, accounts, statusStart, this.client, cycleAbort);

      const ingestStart = toISOStringUTC(new Date(Date.now() - this.lookbackMs));
      const ingested = await runOrderIngest(this.sql, accounts, ingestStart, this.client, cycleAbort);

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
