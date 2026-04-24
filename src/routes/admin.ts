import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orders } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { inventoryLedger } from '../db/schema/inventory';
import { billingLineItems } from '../db/schema/billing';
import { products } from '../db/schema/products';
import { settings } from '../db/schema/settings';
import { syncOrders } from '../services/order-sync';
import { syncShipments } from '../services/shipment-sync';

const app = new Hono();

// Flip a client to sandbox/test mode. Any client with is_test=true is
// excluded from ShipStation sync, billing, shipment sync, daily stats, and
// the main orders table — and any label action under it is forced into
// offline mock mode.
app.patch(
  '/clients/:id{[0-9]+}/flag-test',
  zValidator('json', z.object({ isTest: z.boolean() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { isTest } = c.req.valid('json');
    const [row] = await db
      .update(clients)
      .set({ isTest, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    if (!row) return c.json({ error: 'Client not found' }, 404);
    return c.json(row);
  }
);

// Delete every order (+ dependent shipments / ledger / billing lines) that
// belongs to a test-flagged client. Intended as a one-time cleanup after
// flipping a legacy store to is_test=true.
app.post('/purge-test-orders', async (c) => {
  const testClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.isTest, true));
  if (!testClients.length) {
    return c.json({
      deleted: { orders: 0, shipments: 0, ledger: 0, billing: 0 },
      message: 'No clients flagged is_test=true — nothing to purge.',
    });
  }
  const ids = testClients.map((c) => c.id);

  // Collect order IDs first so we can cascade cleanly.
  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.clientId, ids));
  const orderIds = orderRows.map((r) => r.id);

  let deletedBilling = 0;
  let deletedLedger = 0;
  let deletedShipments = 0;
  if (orderIds.length) {
    const billingDel = await db
      .delete(billingLineItems)
      .where(inArray(billingLineItems.orderId, orderIds))
      .returning({ id: billingLineItems.id });
    deletedBilling = billingDel.length;

    const ledgerDel = await db
      .delete(inventoryLedger)
      .where(inArray(inventoryLedger.orderId, orderIds))
      .returning({ id: inventoryLedger.id });
    deletedLedger = ledgerDel.length;

    const shipmentsDel = await db
      .delete(shipments)
      .where(inArray(shipments.orderId, orderIds))
      .returning({ id: shipments.id });
    deletedShipments = shipmentsDel.length;
  }

  const ordersDel = await db
    .delete(orders)
    .where(inArray(orders.clientId, ids))
    .returning({ id: orders.id });

  return c.json({
    clients: testClients,
    deleted: {
      orders: ordersDel.length,
      shipments: deletedShipments,
      ledger: deletedLedger,
      billing: deletedBilling,
    },
  });
});

// Seed synthetic mock orders under the first is_test client. These rows use
// fake order numbers (TEST-xxxxx), fake ship-to addresses, and fake items —
// they'll be forced into offline-mock label mode by the isTest guard in
// labels.ts, so no real postage, billing, or inventory movement can happen.
const seedBody = z.object({
  count: z.number().int().positive().max(200).default(20),
  clientId: z.number().int().positive().optional(),
});

// Every field is deliberately prefixed/labelled "TEST" / "TESTING" so the
// rows are unmistakable in the UI, on receipts, on labels, and anywhere the
// data is exported. No neutral-looking sample data — the goal is "obviously
// fake at a glance".
const SAMPLE_NAMES = [
  'Test User 01',
  'Test User 02',
  'Testing Customer A',
  'Testing Customer B',
  'TEST — Do Not Ship',
  'Testing Buyer',
  'Test Order Recipient',
  'Testing Account',
];
const SAMPLE_CITIES = [
  { city: 'Test City', state: 'TX', zip: '99901' },
  { city: 'Testing Town', state: 'CA', zip: '99902' },
  { city: 'Testville', state: 'NY', zip: '99903' },
  { city: 'Test Springs', state: 'FL', zip: '99904' },
  { city: 'Testing Harbor', state: 'WA', zip: '99905' },
];
const SAMPLE_SKUS = [
  {
    sku: 'TEST-SKU-001',
    name: 'TESTING Product — Do Not Ship',
    weightOz: 8,
    length: 6,
    width: 4,
    height: 2,
  },
  {
    sku: 'TEST-SKU-002',
    name: 'TEST Item — Sandbox Only',
    weightOz: 16,
    length: 8,
    width: 6,
    height: 3,
  },
  {
    sku: 'TESTING-KIT',
    name: 'TESTING Starter Kit — Fake',
    weightOz: 32,
    length: 10,
    width: 8,
    height: 4,
  },
  {
    sku: 'TEST-PACK',
    name: 'TEST Accessory Pack — Mock Data',
    weightOz: 4,
    length: 5,
    width: 3,
    height: 1,
  },
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

app.post('/seed-test-orders', zValidator('json', seedBody), async (c) => {
  const { count, clientId } = c.req.valid('json');

  let testClient;
  if (clientId !== undefined) {
    const [row] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.isTest, true)))
      .limit(1);
    testClient = row;
  } else {
    const [row] = await db
      .select()
      .from(clients)
      .where(eq(clients.isTest, true))
      .orderBy(sql`case when lower(${clients.name}) = 'test orders' then 0 else 1 end`, clients.id)
      .limit(1);
    testClient = row;
  }

  if (!testClient) {
    return c.json(
      {
        error:
          'No client flagged is_test=true. Flag one first via PATCH /admin/clients/:id/flag-test.',
      },
      400
    );
  }

  // Upsert product defaults for every TEST SKU so the Create Label flow's
  // product-lookup succeeds (no 404s) and auto-fills weight/dims. Safe to
  // call repeatedly — ON CONFLICT keeps the stored values fresh.
  for (const s of SAMPLE_SKUS) {
    await db
      .insert(products)
      .values({
        sku: s.sku,
        name: s.name,
        weightOz: s.weightOz,
        length: s.length,
        width: s.width,
        height: s.height,
      })
      .onConflictDoUpdate({
        target: products.sku,
        set: {
          name: s.name,
          weightOz: s.weightOz,
          length: s.length,
          width: s.width,
          height: s.height,
          updatedAt: new Date(),
        },
      });
  }

  const now = Date.now();
  const rows = Array.from({ length: count }).map((_, i) => {
    const name = pick(SAMPLE_NAMES);
    const city = pick(SAMPLE_CITIES);
    const sku = pick(SAMPLE_SKUS);
    const qty = 1 + Math.floor(Math.random() * 3);
    const orderDate = new Date(
      now - Math.floor(Math.random() * 1000 * 60 * 60 * 48)
    );
    const serial = `${Date.now().toString(36).toUpperCase()}-${String(i).padStart(3, '0')}`;
    const externalId = `TEST-ORDER-${serial}`;
    const orderNumber = `TESTING-${serial}`;
    return {
      externalOrderId: externalId,
      orderNumber,
      orderStatus: 'awaiting_shipment',
      orderDate,
      clientId: testClient.id,
      storeId: (testClient.storeIds ?? [])[0] ?? null,
      customerEmail: `testing+${i}@test.invalid`,
      shipToName: name,
      shipToCity: city.city,
      shipToState: city.state,
      shipToPostalCode: city.zip,
      carrierCode: 'stamps_com',
      serviceCode: 'usps_first_class_mail',
      // Use the product's real weight × qty so Create Label's defaulting
      // logic produces a sane rate query.
      weightOz: sku.weightOz * qty,
      orderTotal: (10 + Math.random() * 80).toFixed(2),
      shippingAmount: (3 + Math.random() * 12).toFixed(2),
      items: [
        {
          sku: sku.sku,
          name: sku.name,
          quantity: qty,
          unitPrice: (8 + Math.random() * 15).toFixed(2),
          // Explicit marker on every line item — receipts/exports that read
          // the items array see "test": true and can render accordingly.
          test: true,
        },
      ],
      raw: {
        seeded: true,
        test: true,
        testing: true,
        note: 'TESTING ORDER — sandbox data, do not ship',
        seedBatch: new Date().toISOString(),
        // Label creation reads ship-to from raw.shipTo. Without street1 the
        // createLabelFromOrderId validator rejects the order with
        // "ship-to missing street".
        shipTo: {
          name,
          street1: `${100 + i} Testing St`,
          city: city.city,
          state: city.state,
          postalCode: city.zip,
          country: 'US',
          phone: '555-000-0000',
          residential: true,
        },
      },
      externallyShipped: false,
      externallyFulfilledVerified: false,
    };
  });

  const inserted = await db
    .insert(orders)
    .values(rows)
    .returning({ id: orders.id, orderNumber: orders.orderNumber });

  return c.json({
    seeded: inserted.length,
    seededProducts: SAMPLE_SKUS.length,
    clientId: testClient.id,
    clientName: testClient.name,
    sample: inserted.slice(0, 5),
  });
});

// Upsert a ShipStation client with its own API credentials. Used when
// onboarding a secondary SS account (e.g. KF Goods has its own SS org —
// the main DR Prepper key can't see those orders). After this endpoint
// runs, syncOrders + syncShipments will iterate the new account on their
// next tick and pull its orders into our local DB.
const upsertKeyedClientBody = z.object({
  name: z.string().min(1),
  apiKey: z.string().min(1),
  apiSecret: z.string().min(1),
  apiKeyV2: z.string().nullable().optional(),
  rateSourceClientId: z.number().int().positive().nullable().optional(),
});

app.post(
  '/upsert-keyed-client',
  zValidator('json', upsertKeyedClientBody),
  async (c) => {
    const body = c.req.valid('json');

    // Check for an existing row by name (case-insensitive). If found, just
    // refresh the creds — safer than duplicating the client.
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(sql`lower(${clients.name}) = lower(${body.name})`)
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(clients)
        .set({
          ssApiKey: body.apiKey,
          ssApiSecret: body.apiSecret,
          ssApiKeyV2: body.apiKeyV2 ?? null,
          rateSourceClientId: body.rateSourceClientId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(clients.id, existing.id))
        .returning();
      return c.json({ created: false, client: updated });
    }

    const [created] = await db
      .insert(clients)
      .values({
        name: body.name,
        ssApiKey: body.apiKey,
        ssApiSecret: body.apiSecret,
        ssApiKeyV2: body.apiKeyV2 ?? null,
        rateSourceClientId: body.rateSourceClientId ?? null,
        storeIds: [],
        active: true,
      })
      .returning();
    return c.json({ created: true, client: created });
  }
);

// List test clients + current order count. Quick way to verify state.
app.get('/test-clients', async (c) => {
  const rows = await db.execute<{
    id: number;
    name: string;
    order_count: number;
  }>(sql`
    select c.id, c.name, count(o.id)::int as order_count
    from clients c
    left join orders o on o.client_id = c.id
    where c.is_test = true
    group by c.id, c.name
    order by c.name
  `);
  return c.json({ data: rows });
});

// ── Hard reset + fresh sync ─────────────────────────────────────────────
//
// Destructive: deletes every synced row (orders, shipments, their billing
// line items + inventory ledger entries) AND wipes every order/shipment
// sync watermark so the next sync pulls from DEFAULT_LOOKBACK_MS (30 days).
//
// Preserves: clients (with their credentials + storeIds), packages,
// locations, billing_config, inventory (just not the ledger), settings
// other than sync watermarks. Test-client seeded orders are also deleted
// — re-seed from the Settings view after.
//
// Pass { lookbackDays: N } to override the default 30-day backfill, or
// { sync: false } to just wipe without immediately re-syncing.
const resetSyncBody = z
  .object({
    lookbackDays: z.number().int().positive().max(365).optional(),
    sync: z.boolean().optional(),
  })
  .optional();

app.post('/reset-sync', zValidator('json', resetSyncBody), async (c) => {
  const body = c.req.valid('json') ?? {};
  const lookbackDays = body.lookbackDays ?? 30;
  const runSync = body.sync !== false;

  // Count rows BEFORE the delete so we can report what got wiped, then
  // TRUNCATE — that bypasses row-by-row protocol serialization entirely.
  // order_overrides is TRUNCATE-cascaded by the FK on order_id.
  const preCounts = await db.execute<{
    billing: number;
    ledger: number;
    shipments: number;
    orders: number;
    watermarks: number;
  }>(sql`
    select
      (select count(*)::int from billing_line_items) as billing,
      (select count(*)::int from inventory_ledger) as ledger,
      (select count(*)::int from shipments) as shipments,
      (select count(*)::int from orders) as orders,
      (select count(*)::int from settings where key like 'order_sync.%' or key like 'shipment_sync.%') as watermarks
  `);
  const pre = preCounts[0] ?? { billing: 0, ledger: 0, shipments: 0, orders: 0, watermarks: 0 };

  // Order matters — child tables first so FK deletes are clean.
  // RESTART IDENTITY resets the id sequences so the next sync produces
  // small integer ids again, matching a fresh DB.
  await db.execute(sql`truncate table billing_line_items restart identity`);
  await db.execute(sql`truncate table inventory_ledger restart identity cascade`);
  await db.execute(sql`truncate table shipments restart identity cascade`);
  await db.execute(sql`truncate table orders restart identity cascade`);
  await db.execute(sql`
    delete from settings where key like 'order_sync.%' or key like 'shipment_sync.%'
  `);

  const sinceMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const deleted = {
    billing_line_items: pre.billing,
    inventory_ledger: pre.ledger,
    shipments: pre.shipments,
    orders: pre.orders,
    sync_watermarks: pre.watermarks,
  };

  if (!runSync) {
    return c.json({ deleted, synced: null });
  }

  // 3. Trigger the fresh sync immediately. Orders first (so shipments can
  //    match back by externalOrderId), then shipments.
  const ordersResult = await syncOrders({ sinceMs });
  const shipmentsResult = await syncShipments({ sinceMs });

  return c.json({
    deleted,
    synced: {
      orders: {
        synced: ordersResult.synced,
        pages: ordersResult.pages,
        sinceIso: ordersResult.sinceIso,
      },
      shipments: {
        fetched: shipmentsResult.fetched,
        inserted: shipmentsResult.inserted,
        updated: shipmentsResult.updated,
        matchedOrders: shipmentsResult.matchedOrders,
        ordersMarkedShipped: shipmentsResult.ordersMarkedShipped,
      },
    },
  });
});

export default app;
