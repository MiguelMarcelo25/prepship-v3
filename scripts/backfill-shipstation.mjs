#!/usr/bin/env node
/**
 * One-time backfill: pulls ALL orders + shipments from ShipStation for each client
 * for the last N days. Use this to populate a fresh DB with historical data.
 *
 * Usage:
 *   DATABASE_URL=... SHIPSTATION_API_KEY=... SHIPSTATION_API_SECRET=... \
 *   node scripts/backfill-shipstation.mjs [days]
 */

import postgres from "postgres";

const DAYS = Number.parseInt(process.argv[2] ?? "90", 10);
const DATABASE_URL = process.env.DATABASE_URL;
const MAIN_KEY = process.env.SHIPSTATION_API_KEY;
const MAIN_SECRET = process.env.SHIPSTATION_API_SECRET;
const KFG_KEY = process.env.SHIPSTATION_KFG_API_KEY;
const KFG_SECRET = process.env.SHIPSTATION_KFG_API_SECRET;

if (!DATABASE_URL || !MAIN_KEY || !MAIN_SECRET) {
  console.error("ERROR: DATABASE_URL, SHIPSTATION_API_KEY, SHIPSTATION_API_SECRET required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { ssl: "require" });

function auth(key, secret) {
  return "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
}

async function fetchPage(key, secret, path, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`https://ssapi.shipstation.com${path}?${query}`, {
    headers: { Authorization: auth(key, secret), "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`SS ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllOrders(key, secret, orderStatus, modifyDateStart) {
  const results = [];
  let page = 1;
  while (true) {
    const data = await fetchPage(key, secret, "/orders", {
      orderStatus, modifyDateStart, pageSize: 500, page,
    });
    results.push(...(data.orders || []));
    console.log(`  page ${page}/${data.pages}: ${data.orders?.length ?? 0} orders`);
    if (page >= (data.pages ?? 1)) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

async function fetchAllShipments(key, secret, createDateStart) {
  const results = [];
  let page = 1;
  while (true) {
    const data = await fetchPage(key, secret, "/shipments", {
      createDateStart, pageSize: 500, page, includeShipmentItems: false,
    });
    results.push(...(data.shipments || []));
    console.log(`  ship page ${page}/${data.pages}: ${data.shipments?.length ?? 0} shipments`);
    if (page >= (data.pages ?? 1)) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

async function resolveClientId(storeId) {
  if (!storeId) return null;
  const rows = await sql`
    SELECT "clientId" FROM clients
    WHERE active=1 AND "storeIds"::text LIKE ${`%${storeId}%`}
    LIMIT 1
  `;
  return rows[0]?.clientId ?? null;
}

async function insertOrder(order, clientIdOverride) {
  const storeId = order.advancedOptions?.storeId ?? null;
  const clientId = clientIdOverride ?? await resolveClientId(storeId);
  if (!clientId) return false;

  const weightOz = order.weight?.value != null
    ? (order.weight.units === "ounces" ? order.weight.value : order.weight.value * 16)
    : null;

  try {
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
    return true;
  } catch (e) {
    console.warn(`  failed to insert order ${order.orderId}: ${e.message}`);
    return false;
  }
}

async function insertShipment(s, clientIdOverride) {
  // Resolve orderId from orderNumber
  const orderRows = await sql`
    SELECT "orderId", "clientId" FROM orders WHERE "orderNumber"=${s.orderNumber} LIMIT 1
  `;
  if (!orderRows[0]) return false;

  try {
    await sql`
      INSERT INTO shipments (
        "shipmentId", "orderId", "orderNumber", "carrierCode", "serviceCode", "trackingNumber",
        "shipDate", "labelUrl", "shipmentCost", "otherCost", voided, "updatedAt", "clientId",
        source, label_created_at, label_format
      ) VALUES (
        ${s.shipmentId}, ${orderRows[0].orderId}, ${s.orderNumber}, ${s.carrierCode ?? null},
        ${s.serviceCode ?? null}, ${s.trackingNumber ?? null}, ${s.shipDate ?? null},
        ${s.formUrl ?? null}, ${s.shipmentCost ?? 0}, ${0}, ${s.voided ? 1 : 0}, ${Date.now()},
        ${orderRows[0].clientId}, ${"ss_backfill"}, ${Date.now()}, ${"pdf"}
      )
      ON CONFLICT ("shipmentId") DO NOTHING
    `;
    return true;
  } catch (e) {
    console.warn(`  failed to insert shipment ${s.shipmentId}: ${e.message}`);
    return false;
  }
}

async function backfillAccount(accountName, key, secret, clientIdOverride) {
  console.log(`\n=== Backfilling ${accountName} (last ${DAYS} days) ===`);
  const sinceDate = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "");

  for (const status of ["awaiting_shipment", "shipped", "cancelled"]) {
    console.log(`\nFetching ${status} orders...`);
    const orders = await fetchAllOrders(key, secret, status, sinceDate);
    console.log(`  total: ${orders.length}`);
    let inserted = 0;
    for (const o of orders) {
      if (await insertOrder(o, clientIdOverride)) inserted++;
    }
    console.log(`  inserted: ${inserted}/${orders.length}`);
  }

  console.log(`\nFetching shipments...`);
  const shipments = await fetchAllShipments(key, secret, sinceDate);
  console.log(`  total: ${shipments.length}`);
  let insertedS = 0;
  for (const s of shipments) {
    if (s.voided) continue;
    if (await insertShipment(s, clientIdOverride)) insertedS++;
  }
  console.log(`  shipments inserted: ${insertedS}/${shipments.length}`);
}

try {
  await backfillAccount("Main (DJC)", MAIN_KEY, MAIN_SECRET, null);
  if (KFG_KEY && KFG_SECRET) {
    // KFG client should be clientId=2
    const kfgClient = await sql`SELECT "clientId" FROM clients WHERE name='KF Goods' LIMIT 1`;
    await backfillAccount("KFG", KFG_KEY, KFG_SECRET, kfgClient[0]?.clientId ?? null);
  }

  const counts = await sql`
    SELECT c.name, COUNT(o."orderId") as orders
    FROM clients c LEFT JOIN orders o ON o."clientId" = c."clientId"
    GROUP BY c.name ORDER BY c.name
  `;
  console.log("\n=== Final counts ===");
  for (const r of counts) console.log(`  ${r.name}: ${r.orders} orders`);
} catch (e) {
  console.error("Backfill failed:", e);
  process.exit(1);
} finally {
  await sql.end();
}
