import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray, desc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { clients } from '../db/schema/clients';
import { orders, orderOverrides } from '../db/schema/orders';
import { shipments } from '../db/schema/shipments';
import { inventory, inventoryLedger } from '../db/schema/inventory';
import { packages } from '../db/schema/packages';
import { packageLedger } from '../db/schema/package-ledger';
import { billingLineItems } from '../db/schema/billing';
import { products } from '../db/schema/products';
import { settings } from '../db/schema/settings';
import {
  enqueueManualOrderSyncJob,
  enqueueManualShipmentSyncJob,
} from '../services/sync-job-queue';
import { backfillMissingOrderItems, getOrderItemsBackfillStatus, syncOrderItemOrderFields } from '../services/order-items';
import { ssMarkOrderShippedV1, asSSUpstreamOrderId } from '../lib/shipstation/labels';
import { loadClientCredentials } from '../lib/shipstation/credentials';
import { printQueue } from '../db/schema/print-queue';
import { setClientHouseAccountEnabled, shippingMarginPolicyModeFromEnabled } from '../services/house-account-opt-in';
import { ensureInventoryLedgerSchema } from '../services/inventory-ledger-schema';
import { applyInventoryMovementInTransaction } from '../services/inventory-movement';
import {
  listUnresolvedLabelPurchaseIntents,
  resolveLabelPurchaseIntentByOperator,
} from '../lib/label-purchase-intent';
import { auditActorFromContext, recordAuditEvent } from '../services/audit-log';

const app = new Hono();

// Per user override unlock shipped data on 2026-07-15: admin-only, audited
// resolution for ambiguous purchase intents. This never buys/voids a label or
// edits order/shipment history; it only releases a verified fail-closed block.
app.get(
  '/label-purchase-intents',
  zValidator('query', z.object({ orderId: z.coerce.number().int().positive().optional() })),
  async (c) => {
    const { orderId } = c.req.valid('query');
    const intents = await listUnresolvedLabelPurchaseIntents(orderId);
    return c.json({ intents, count: intents.length });
  },
);

app.post(
  '/label-purchase-intents/:id{[0-9]+}/resolve',
  zValidator('json', z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('linked_shipment'),
      shipmentId: z.number().int().positive(),
      note: z.string().trim().min(5).max(500),
    }),
    z.object({
      outcome: z.literal('provider_verified_no_label'),
      note: z.string().trim().min(5).max(500),
    }),
  ])),
  async (c) => {
    const id = Number(c.req.param('id'));
    try {
      const resolution = c.req.valid('json');
      const resolved = await resolveLabelPurchaseIntentByOperator(id, resolution);
      await recordAuditEvent({
        ...auditActorFromContext(c),
        eventType: 'label_purchase_intent.resolved',
        resourceType: 'label_purchase_intent',
        resourceId: id,
        action: resolution.outcome,
        details: {
          orderId: resolved.orderId,
          shipmentId: resolved.shipmentId,
          note: resolution.note,
        },
      });
      return c.json(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : 409;
      return c.json({ error: message }, status);
    }
  },
);

app.get('/order-items/backfill-status', async (c) => {
  return c.json(await getOrderItemsBackfillStatus());
});

app.post(
  '/order-items/backfill',
  zValidator(
    'json',
    z.object({
      batchSize: z.number().int().positive().max(20000).optional().default(5000),
      maxBatches: z.number().int().positive().max(100).optional().default(10),
    }).optional()
  ),
  async (c) => {
    const body = c.req.valid('json') ?? { batchSize: 5000, maxBatches: 10 };
    const startedAt = Date.now();
    let inserted = 0;
    let batches = 0;

    for (let batch = 0; batch < body.maxBatches; batch += 1) {
      const batchInserted = await backfillMissingOrderItems(body.batchSize);
      batches += 1;
      inserted += batchInserted;
      if (batchInserted === 0) break;
    }

    const repaired = await syncOrderItemOrderFields();
    const status = await getOrderItemsBackfillStatus();
    return c.json({
      inserted,
      repaired,
      batches,
      durationMs: Date.now() - startedAt,
      status,
    });
  }
);

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

// PS-220/PS-327: opt a client IN/OUT of the backend-owned shipping margin policy. Admin-only (this
// route is requireAdmin-gated in main.ts). The flag lives on billing_config.house_account_enabled
// and is written via raw SQL (it is deliberately off the drizzle schema — see house-account-opt-in.ts).
// Default-off; flipping ON makes internal-rate wins bill the captured customer_rate.
app.patch(
  '/clients/:id{[0-9]+}/house-account',
  zValidator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { enabled } = c.req.valid('json');
    const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id));
    if (!client) return c.json({ error: 'Client not found' }, 404);
    await setClientHouseAccountEnabled(id, enabled);
    return c.json({
      clientId: id,
      houseAccountEnabled: enabled,
      shippingMarginPolicyMode: shippingMarginPolicyModeFromEnabled(enabled),
    });
  }
);

// Delete every order (+ dependent shipments / ledger / billing lines /
// overrides / queue entries) AND every test inventory SKU (+ its ledger
// entries) that belongs to a test-flagged client. Intended as a one-touch
// "make sandbox clean again" button — same behavior as the
// scripts/purge-test-data.ts CLI script, exposed over HTTP so the
// Inventory page can offer a 🧹 Purge Test Data button.
//
// Response keeps the legacy `deleted.{orders,shipments,ledger,billing}`
// shape (SettingsView reads exactly those keys) and adds new keys for
// the extra surfaces. Older callers that ignore the new keys keep working.
app.post('/purge-test-orders', async (c) => {
  const testClients = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(eq(clients.isTest, true));
  if (!testClients.length) {
    // Even when there are no test CLIENTS, there may still be orphan
    // test ledger rows in package_ledger from a previous incomplete
    // purge (back when this endpoint didn't clean them). Run the
    // package-ledger sweep anyway so those orphans + their negative
    // stock impact get cleaned up.
    const orphanResult = await db.transaction(async (tx) => {
      let pkgLedgerDeleted = 0;
      let pkgStockRestored = 0;
      let pkgsAffected = 0;

      const orphanRows = await tx
        .select({ id: packageLedger.id, packageId: packageLedger.packageId, qtyDelta: packageLedger.qtyDelta })
        .from(packageLedger)
        .where(sql`${packageLedger.note} ILIKE ${'%for order TESTING-%'}`);

      if (orphanRows.length) {
        const restoreByPkg = new Map<number, number>();
        for (const r of orphanRows) {
          restoreByPkg.set(r.packageId, (restoreByPkg.get(r.packageId) ?? 0) + r.qtyDelta);
        }
        for (const [packageId, sumDelta] of restoreByPkg.entries()) {
          await tx
            .update(packages)
            .set({ stockQty: sql`${packages.stockQty} - ${sumDelta}`, updatedAt: new Date() })
            .where(eq(packages.id, packageId));
          pkgStockRestored += Math.abs(sumDelta);
          pkgsAffected += 1;
        }
        const del = await tx
          .delete(packageLedger)
          .where(sql`${packageLedger.note} ILIKE ${'%for order TESTING-%'}`)
          .returning({ id: packageLedger.id });
        pkgLedgerDeleted = del.length;
      }

      return { pkgLedgerDeleted, pkgStockRestored, pkgsAffected };
    });

    return c.json({
      deleted: {
        orders: 0,
        shipments: 0,
        ledger: 0,
        billing: 0,
        inventory: 0,
        ledgerByInventory: 0,
        orderOverrides: 0,
        printQueue: 0,
        pkgLedger: orphanResult.pkgLedgerDeleted,
        pkgStockRestored: orphanResult.pkgStockRestored,
        pkgsAffected: orphanResult.pkgsAffected,
      },
      message:
        orphanResult.pkgLedgerDeleted > 0
          ? `No test clients, but cleaned ${orphanResult.pkgLedgerDeleted} orphan test ledger rows and restored ${orphanResult.pkgStockRestored} units across ${orphanResult.pkgsAffected} package(s).`
          : 'No clients flagged is_test=true — nothing to purge.',
    });
  }
  const ids = testClients.map((c) => c.id);

  // Collect order + inventory IDs upfront so we can cascade cleanly.
  const orderRows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(inArray(orders.clientId, ids));
  const orderIds = orderRows.map((r) => r.id);

  const inventoryRows = await db
    .select({ id: inventory.id })
    .from(inventory)
    .where(inArray(inventory.clientId, ids));
  const inventoryIds = inventoryRows.map((r) => r.id);

  // Wrap all deletes in a single transaction so a mid-run failure
  // rolls everything back. Order respects FK constraints (children first).
  const result = await db.transaction(async (tx) => {
    let billing = 0;
    let ledgerByOrder = 0;
    let ledgerByInventory = 0;
    let overridesDeleted = 0;
    let shipmentsDeleted = 0;
    let queueEntries = 0;
    let ordersDeleted = 0;
    let inventoryDeleted = 0;
    let pkgLedgerDeleted = 0;
    let pkgStockRestored = 0; // sum of |qtyDelta| added back
    let pkgsAffected = 0;

    if (orderIds.length) {
      const billingDel = await tx
        .delete(billingLineItems)
        .where(inArray(billingLineItems.orderId, orderIds))
        .returning({ id: billingLineItems.id });
      billing = billingDel.length;

      const ledgerByOrderDel = await tx
        .delete(inventoryLedger)
        .where(inArray(inventoryLedger.orderId, orderIds))
        .returning({ id: inventoryLedger.id });
      ledgerByOrder = ledgerByOrderDel.length;

      const overridesDel = await tx
        .delete(orderOverrides)
        .where(inArray(orderOverrides.orderId, orderIds))
        .returning({ orderId: orderOverrides.orderId });
      overridesDeleted = overridesDel.length;

      const shipmentsDel = await tx
        .delete(shipments)
        .where(inArray(shipments.orderId, orderIds))
        .returning({ id: shipments.id });
      shipmentsDeleted = shipmentsDel.length;

      // print_queue_orders.orderId is text(stringified order id)
      const queueByOrderDel = await tx
        .delete(printQueue)
        .where(inArray(printQueue.orderId, orderIds.map(String)))
        .returning({ id: printQueue.id });
      queueEntries += queueByOrderDel.length;
    }

    // Belt-and-suspenders: nuke any queue rows whose client_id IS the
    // test client (in case a queue row was added via a different code
    // path that didn't set order_id correctly).
    const queueByClientDel = await tx
      .delete(printQueue)
      .where(inArray(printQueue.clientId, ids))
      .returning({ id: printQueue.id });
    queueEntries += queueByClientDel.length;

    // Inventory ledger rows that reference test inventory SKUs (separate
    // from order-linked ledger rows we already deleted above).
    if (inventoryIds.length) {
      const ledgerByInvDel = await tx
        .delete(inventoryLedger)
        .where(inArray(inventoryLedger.inventoryId, inventoryIds))
        .returning({ id: inventoryLedger.id });
      ledgerByInventory = ledgerByInvDel.length;
    }

    if (orderIds.length) {
      const ordersDel = await tx
        .delete(orders)
        .where(inArray(orders.clientId, ids))
        .returning({ id: orders.id });
      ordersDeleted = ordersDel.length;
    }

    if (inventoryIds.length) {
      const inventoryDel = await tx
        .delete(inventory)
        .where(inArray(inventory.clientId, ids))
        .returning({ id: inventory.id });
      inventoryDeleted = inventoryDel.length;
    }

    // Package-ledger purge — the package_ledger table references orders
    // ONLY via free-text in the `note` column ("Shipment XXX for order
    // TESTING-XXX-XXX"). It has no client_id of its own.
    //
    // Test orders ALWAYS use orderNumber prefix `TESTING-` (set by
    // /admin/seed-test-orders, line ~376) — that prefix is unique to
    // PrepShip's test seeder; no real marketplace order ever starts
    // with `TESTING-`. So `note ILIKE '%for order TESTING-%'` is a
    // safe, unambiguous match — no risk of wiping a real customer's
    // ledger entry by accident.
    //
    // Two-step: (1) sum the negative qtyDelta per packageId so we can
    // restore each box's stockQty to its pre-test value, then (2)
    // delete the rows. Without step 1, deleting alone leaves stockQty
    // negative on every box that handled a test shipment (visible in
    // the screenshot — 10x8x4 → -4 stock from 4 test shipments).
    const testNoteRows = await tx
      .select({ id: packageLedger.id, packageId: packageLedger.packageId, qtyDelta: packageLedger.qtyDelta })
      .from(packageLedger)
      .where(sql`${packageLedger.note} ILIKE ${'%for order TESTING-%'}`);

    if (testNoteRows.length) {
      // Group by packageId, sum qtyDelta (these are negative numbers
      // for shipments → so the sum is also negative).
      const restoreByPkg = new Map<number, number>();
      for (const row of testNoteRows) {
        restoreByPkg.set(row.packageId, (restoreByPkg.get(row.packageId) ?? 0) + row.qtyDelta);
      }

      // Restore each affected package's stockQty by adding back the
      // absolute value of the (negative) sum. SQL: stockQty = stockQty - sumDelta
      // where sumDelta is negative → effectively stockQty += |sumDelta|.
      for (const [packageId, sumDelta] of restoreByPkg.entries()) {
        await tx
          .update(packages)
          .set({
            stockQty: sql`${packages.stockQty} - ${sumDelta}`,
            updatedAt: new Date(),
          })
          .where(eq(packages.id, packageId));
        pkgStockRestored += Math.abs(sumDelta);
        pkgsAffected += 1;
      }

      // Now delete the matched ledger rows.
      const pkgLedgerDel = await tx
        .delete(packageLedger)
        .where(sql`${packageLedger.note} ILIKE ${'%for order TESTING-%'}`)
        .returning({ id: packageLedger.id });
      pkgLedgerDeleted = pkgLedgerDel.length;
    }

    return {
      billing,
      ledgerByOrder,
      ledgerByInventory,
      overridesDeleted,
      shipmentsDeleted,
      queueEntries,
      ordersDeleted,
      inventoryDeleted,
      pkgLedgerDeleted,
      pkgStockRestored,
      pkgsAffected,
    };
  });

  return c.json({
    clients: testClients,
    deleted: {
      // Legacy keys — SettingsView reads these by name. Don't rename.
      orders: result.ordersDeleted,
      shipments: result.shipmentsDeleted,
      ledger: result.ledgerByOrder,
      billing: result.billing,
      // New keys — surfaced on the Inventory page button.
      inventory: result.inventoryDeleted,
      ledgerByInventory: result.ledgerByInventory,
      orderOverrides: result.overridesDeleted,
      printQueue: result.queueEntries,
      // New keys — surfaced on the Packages page button. The packages
      // themselves are NOT deleted (they're global, shared across all
      // clients) — only their test-order ledger entries get wiped, and
      // each affected package's stockQty is restored by +|qtyDelta|.
      pkgLedger: result.pkgLedgerDeleted,
      pkgStockRestored: result.pkgStockRestored,
      pkgsAffected: result.pkgsAffected,
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

  /**
   * Convert a true-UTC instant into a "naive PT stamped Z" timestamp,
   * which is the convention v4's SS-sync uses for orders.orderDate
   * (see src/services/order-sync.ts:parseShipStationDate). The display
   * helpers (formatNaivePt*) render these with timeZone:'UTC' to
   * recover the original Pacific wall-clock face.
   *
   * Without this conversion, the seeder produced true-UTC timestamps
   * that displayed 7-8 hours ahead of California time — e.g. an order
   * seeded at 5 PM CA would display as 12 AM (next day UTC) — visibly
   * confusing to operators looking at the test orders list.
   *
   * The trick: use Intl.DateTimeFormat to extract the California
   * wall-clock components (Y/M/D/h/m/s) from the real UTC date, then
   * synthesize an ISO string with those components plus a literal Z
   * suffix. The resulting Date object's UTC value is "wrong" by the
   * PT offset, but that's exactly what the naive-PT-stamped-Z
   * convention requires.
   */
  function toNaivePtStampedZ(realUtc: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(realUtc);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    // Intl returns "24" for midnight in some locales — normalize to "00".
    const hour = get('hour') === '24' ? '00' : get('hour');
    return new Date(
      `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}Z`
    );
  }

  const rows = Array.from({ length: count }).map((_, i) => {
    const name = pick(SAMPLE_NAMES);
    const city = pick(SAMPLE_CITIES);
    const sku = pick(SAMPLE_SKUS);
    const qty = 1 + Math.floor(Math.random() * 3);
    // Spread orders across the last 48 hours of California wall-clock,
    // then stamp as Z so they match the SS-sync convention. Display
    // helpers (formatNaivePtDateTime) will render the original CA
    // wall-clock face the operator expects.
    const orderDate = toNaivePtStampedZ(
      new Date(now - Math.floor(Math.random() * 1000 * 60 * 60 * 48))
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

  // Per user override unlock shipped data on 2026-07-10: reset recovery now
  // queues the existing import jobs through the sole pg-boss ShipStation lane.
  // The reset semantics above are unchanged; this only prevents concurrent
  // inline order/shipment sync after the explicit admin reset.
  const ordersResult = await enqueueManualOrderSyncJob({ sinceMs });
  const shipmentsResult = await enqueueManualShipmentSyncJob({ sinceMs });

  return c.json({
    deleted,
    synced: {
      orders: {
        queued: ordersResult.queued,
        jobId: ordersResult.jobId,
        error: ordersResult.error,
      },
      shipments: {
        queued: shipmentsResult.queued,
        jobId: shipmentsResult.jobId,
        error: shipmentsResult.error,
      },
    },
  });
});

// ─── /admin/retry-marketplace-notify ──────────────────────────────────────
// One-shot recovery for orders that were shipped through PrepShip during
// the marketplace-notification bug window (pre-2026-05-07). The bug:
// every label hit ShipStation's /orders/markasshipped v1 endpoint with
// the LOCAL DB primary key instead of the upstream SS orderId, causing
// ShipStation to return 404 → silently swallowed → marketplace never
// notified → Amazon Seller Central kept showing "Buy shipping".
//
// This endpoint retries the v1 mark-shipped call with the CORRECT
// upstream orderId (parsed from orders.external_order_id) so historical
// stuck orders can finally close the loop with their marketplace.
//
// Request body:
//   { "orderNumbers": ["111-4349324-2899466", "112-6551875-5121844", …] }
//
// Behaviour:
//   - Idempotent: ShipStation accepts re-acks safely
//   - Never spends postage / never creates a new label
//   - Per-order result with specific failure reason for each
//   - Hard cap of 50 orders/call (v1 rate limit is 40/min, leave room)
//
// Per user override `unlock shipped data` on 2026-05-07.
//
// Accepts EITHER orderNumbers (marketplace-facing IDs like
// "111-4349324-2899466") OR ssShipmentIds (the upstream ShipStation
// shipment ID, e.g. 284049105 — visible in ShipStation's "Shipment #"
// column). Pass at least one. Both can be passed together; total cap
// is 50 per call across both arrays combined.
const retryNotifyBody = z
  .object({
    orderNumbers: z.array(z.string().min(1)).optional(),
    ssShipmentIds: z.array(z.number().int().positive()).optional(),
  })
  .refine(
    (data) => (data.orderNumbers?.length ?? 0) + (data.ssShipmentIds?.length ?? 0) > 0,
    { message: 'Pass at least one orderNumber or ssShipmentId' }
  )
  .refine(
    (data) => (data.orderNumbers?.length ?? 0) + (data.ssShipmentIds?.length ?? 0) <= 50,
    { message: 'Maximum 50 lookups per call' }
  );

type RetryNotifyResult = {
  orderNumber: string;
  ok: boolean;
  reason?: string;
  ssUpstreamOrderId?: number;
  trackingNumber?: string;
  carrierCode?: string | null;
};

async function retryMarketplaceNotifyOne(orderNumber: string): Promise<RetryNotifyResult> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);

  if (!order) {
    return { orderNumber, ok: false, reason: 'order not found in DB' };
  }
  // asSSUpstreamOrderId is the only safe path to produce the
  // SSUpstreamOrderId branded type. Returns null if externalOrderId
  // is missing/invalid — protects against passing the local PK by
  // mistake (compile-time guarantee, see lib/shipstation/labels.ts).
  const ssUpstreamOrderId = asSSUpstreamOrderId(order.externalOrderId);
  if (!ssUpstreamOrderId) {
    return {
      orderNumber,
      ok: false,
      reason: `externalOrderId="${order.externalOrderId ?? '(null)'}" is missing or not a valid positive integer`,
    };
  }

  const [shipment] = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, order.id), eq(shipments.voided, false)))
    .orderBy(desc(shipments.createdAt))
    .limit(1);

  if (!shipment) {
    return { orderNumber, ok: false, reason: 'no non-voided shipment row for this order' };
  }
  if (!shipment.trackingNumber) {
    return {
      orderNumber,
      ok: false,
      reason: `shipment ${shipment.id} has no tracking number`,
    };
  }

  // Per-client v1 keys are PREFERRED but optional. Sub-stores under a
  // master ShipStation account (e.g. Tran Agency) have no per-client
  // v1 keys; v1-client falls back to env.SHIPSTATION_API_KEY/SECRET
  // when we pass undefined. Matches the production label flow's
  // behavior. See loadClientCredentials docstring.
  const creds = order.clientId ? await loadClientCredentials(order.clientId) : null;
  const apiKey = creds?.apiKey ?? undefined;
  const apiSecret = creds?.apiSecret ?? undefined;

  const shipDate =
    shipment.shipDate?.toISOString().slice(0, 10) ??
    shipment.labelShipDate?.toISOString().slice(0, 10) ??
    new Date().toISOString().slice(0, 10);

  try {
    await ssMarkOrderShippedV1(
      {
        orderId: ssUpstreamOrderId,
        carrierCode: shipment.carrierCode,
        trackingNumber: shipment.trackingNumber,
        shipDate,
      },
      { apiKey, apiSecret }
    );
    console.info(
      `[admin/retry-marketplace-notify] ✅ ${orderNumber} ssUpstreamOrderId=${ssUpstreamOrderId} tracking=${shipment.trackingNumber} — marketplace will be notified by ShipStation`
    );
    return {
      orderNumber,
      ok: true,
      ssUpstreamOrderId,
      trackingNumber: shipment.trackingNumber,
      carrierCode: shipment.carrierCode,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[admin/retry-marketplace-notify] ❌ ${orderNumber} ssUpstreamOrderId=${ssUpstreamOrderId} — ${msg}`
    );
    return {
      orderNumber,
      ok: false,
      reason: `ssMarkOrderShippedV1 threw: ${msg}`,
      ssUpstreamOrderId,
      trackingNumber: shipment.trackingNumber,
      carrierCode: shipment.carrierCode,
    };
  }
}

app.post(
  '/retry-marketplace-notify',
  zValidator('json', retryNotifyBody),
  async (c) => {
    const body = c.req.valid('json');
    const explicitOrderNumbers = body.orderNumbers ?? [];
    const ssShipmentIds = body.ssShipmentIds ?? [];

    // Track per-input failures (e.g. shipmentId not found in our DB) so
    // we surface them to the caller instead of silently dropping them.
    const inputFailures: RetryNotifyResult[] = [];
    const resolvedOrderNumbers = new Set<string>(explicitOrderNumbers);

    // ssShipmentId → orderNumber lookup. We join shipments to orders by
    // local order_id; the SS-side shipment ID lives in label_shipment_id.
    if (ssShipmentIds.length > 0) {
      const rows = await db
        .select({
          ssShipmentId: shipments.labelShipmentId,
          orderNumber: orders.orderNumber,
        })
        .from(shipments)
        .innerJoin(orders, eq(orders.id, shipments.orderId))
        .where(inArray(shipments.labelShipmentId, ssShipmentIds));

      const found = new Map<number, string>();
      for (const row of rows) {
        if (row.ssShipmentId != null && row.orderNumber) {
          found.set(row.ssShipmentId, row.orderNumber);
        }
      }
      for (const ssShipmentId of ssShipmentIds) {
        const orderNumber = found.get(ssShipmentId);
        if (orderNumber) {
          resolvedOrderNumbers.add(orderNumber);
        } else {
          inputFailures.push({
            orderNumber: `ssShipmentId=${ssShipmentId}`,
            ok: false,
            reason: 'no shipment row matched this SS shipmentId in PrepShip DB',
          });
        }
      }
    }

    const results: RetryNotifyResult[] = [...inputFailures];

    // Sequential to play nice with the v1 rate limiter (40 req/min).
    // The TokenBucket in v1-client.ts already enforces this, but
    // serial execution gives cleaner logs and predictable ordering.
    for (const orderNumber of resolvedOrderNumbers) {
      const result = await retryMarketplaceNotifyOne(orderNumber);
      results.push(result);
    }

    const okCount = results.filter((r) => r.ok).length;
    const failedCount = results.filter((r) => !r.ok).length;

    return c.json({
      requested: explicitOrderNumbers.length + ssShipmentIds.length,
      resolved: resolvedOrderNumbers.size,
      ok: okCount,
      failed: failedCount,
      results,
    });
  }
);

// ─── /admin/cleanup-stale-queue-entries ────────────────────────────────
// One-shot housekeeping: scan the print_queue_orders table and delete
// any entry whose underlying order is already shipped or cancelled.
// These accumulate over time because (until 2026-05-07) the print
// queue had no auto-cleanup hook on order-status transitions —
// operators saw the same orders sitting in the queue panel even after
// shipping them.
//
// The auto-cleanup is now in place at TWO points:
//   1. labels.ts markOrderShipped — fires on local Print Label flow
//   2. order-sync.ts updateExistingOrderStatusesBatch — fires when
//      a sync detects the status flip from upstream
// So new accumulations should never happen. This endpoint exists
// for the existing stale entries already in the table.
//
// Idempotent: running twice is harmless (second run finds nothing
// to delete and returns 0).
//
// Per user override `unlock shipped data` on 2026-05-07 — touches
// shipped/cancelled-related state.
app.post('/cleanup-stale-queue-entries', async (c) => {
  // Find queue entries pointing at orders that are no longer
  // awaiting_shipment. We use a join because print_queue.orderId is
  // text (storing the local order_id stringified) while orders.id is
  // integer — cast for the comparison.
  const stale = await db.execute<{ queue_id: string; order_id: number; order_status: string; order_number: string | null }>(sql`
    select pq.id as queue_id, o.id as order_id, o.order_status, o.order_number
    from print_queue_orders pq
    inner join orders o on o.id = pq.order_id::int
    where o.order_status in ('shipped', 'cancelled')
  `);

  if (stale.length === 0) {
    return c.json({ removed: 0, results: [] });
  }

  const queueIds = stale.map((row) => row.queue_id);
  await db.delete(printQueue).where(inArray(printQueue.id, queueIds));

  console.info(
    `[admin/cleanup-stale-queue-entries] removed ${stale.length} stale entries`
  );

  return c.json({
    removed: stale.length,
    results: stale.map((row) => ({
      queueId: row.queue_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      orderStatus: row.order_status,
    })),
  });
});

// One-time reconciliation: walk every active inventory row, compute its
// canonical effective_stock and write that value into inventory.stockQty so
// the cached field aligns with what operators see.
//
// PS-133: effective_stock here is the SAME value the canonical owner returns
// (src/services/inventory-stock-math.ts — inventoryLedgerBalance /
// computeEffectiveStockForIds): SUM of all non-ship ledger rows + SUM of
// min(qty)-per-order for ship rows. The ledger_balance CTE below is the SQL
// twin of that owner, kept inline because this WRITE path needs current_stock
// + received + sold + the active/clientId filter in ONE transactional query;
// the behavioral guard (test:ps-133-stock-math) pins the shared formula.
// NOTE: the received/sold figures are used ONLY for the human-readable ledger
// note + dry-run sample — they do NOT determine the written stockQty.
// For each row
// that actually needed adjustment, insert a single `adjust`-type
// inventory_ledger entry recording the delta so the History panel
// shows the correction transparently.
//
// Idempotent: a second run after a successful first run finds no
// deltas and writes nothing.
//
// Lockdown compliance: this READS shipped orders (allowed under the
// analytics carve-out in AGENTS.md) and only WRITES to the
// `inventory` table and `inventory_ledger` (neither is locked). It
// does NOT call deductInventoryForOrder and is NOT gated by the
// INVENTORY_AUTO_DEDUCT kill switch — that switch governs the
// automatic per-shipment deduction path; reconciliation is an
// explicit human-triggered correction with a distinct ledger note
// so auditors can tell the two apart.
//
// Query params:
//   ?dryRun=1   — return the diff without writing anything.
//   ?clientId=N — limit to a single client's SKUs.
app.post('/reconcile-inventory-stock', async (c) => {
  const dryRun = c.req.query('dryRun') === '1' || c.req.query('dryRun') === 'true';
  const clientIdRaw = c.req.query('clientId');
  const clientIdParsed = clientIdRaw !== undefined ? Number(clientIdRaw) : undefined;
  const clientIdFilter = Number.isFinite(clientIdParsed as number)
    ? (clientIdParsed as number)
    : undefined;

  const rows = await db.execute<{
    inventory_id: number;
    sku: string;
    current_stock_qty: number;
    total_received: number;
    total_sold: number;
    effective_stock: number;
  }>(sql`
    with receives as (
      select l.inventory_id as id, coalesce(sum(l.qty), 0)::int as total_received
      from ${inventoryLedger} l
      where l.type = 'receive'
      group by l.inventory_id
    ),
    -- PS-133: SQL twin of the canonical effective-stock owner in
    -- src/services/inventory-stock-math.ts (computeEffectiveStockForIds). MUST
    -- stay in sync with it; behavioral parity is pinned by test:ps-133-stock-math.
    ledger_balance as (
      select stock_rows.inventory_id as id, coalesce(sum(stock_rows.qty), 0)::int as effective_stock
      from (
        select l.inventory_id, l.qty
        from ${inventoryLedger} l
        where l.type <> 'ship' or l.order_id is null
        union all
        select l.inventory_id, min(l.qty)::int as qty
        from ${inventoryLedger} l
        where l.type = 'ship'
          and l.order_id is not null
        group by l.inventory_id, l.order_id
      ) stock_rows
      group by stock_rows.inventory_id
    ),
    sells as (
      select i.id as id,
        coalesce(sum(oi.quantity), 0)::int as total_sold
      from ${inventory} i
      join order_items oi
        on lower(oi.sku) = lower(i.sku)
      join ${orders} o
        on (
          o.id = oi.order_id
          and (
          (i.client_id is null and o.client_id is null)
          or i.client_id = o.client_id
          )
        )
      where oi.quantity > 0
        and o.order_status = 'shipped'
      group by i.id
    )
    select
      i.id as inventory_id,
      i.sku as sku,
      i.stock_qty as current_stock_qty,
      coalesce(receives.total_received, 0)::int as total_received,
      coalesce(sells.total_sold, 0)::int as total_sold,
      coalesce(ledger_balance.effective_stock, i.stock_qty, 0)::int as effective_stock
    from ${inventory} i
    left join receives on receives.id = i.id
    left join ledger_balance on ledger_balance.id = i.id
    left join sells on sells.id = i.id
    where i.active = true
      ${
        clientIdFilter !== undefined
          ? sql`and i.client_id = ${clientIdFilter}`
          : sql``
      }
  `);

  const adjustments = rows
    .map((r) => {
      const currentStockQty = Number(r.current_stock_qty) || 0;
      const totalReceived = Number(r.total_received) || 0;
      const totalSold = Number(r.total_sold) || 0;
      const effectiveStock = Number(r.effective_stock) || 0;
      return {
        inventoryId: r.inventory_id,
        sku: r.sku,
        currentStockQty,
        totalReceived,
        totalSold,
        effectiveStock,
        delta: effectiveStock - currentStockQty,
      };
    })
    .filter((a) => a.delta !== 0);

  if (dryRun) {
    return c.json({
      mode: 'dry-run',
      rowsScanned: rows.length,
      rowsToAdjust: adjustments.length,
      totalDelta: adjustments.reduce((sum, a) => sum + a.delta, 0),
      sampleAdjustments: adjustments.slice(0, 20),
    });
  }

  if (adjustments.length === 0) {
    return c.json({
      mode: 'apply',
      rowsScanned: rows.length,
      rowsAdjusted: 0,
      totalDelta: 0,
      message: 'All inventory rows already match effectiveStock — nothing to do.',
    });
  }

  const reconciliationEffectiveAt = new Date();
  const reconciliationNote = `Reconciliation backfill ${reconciliationEffectiveAt.toISOString().slice(0, 10)}`;
  await ensureInventoryLedgerSchema();
  await db.transaction(async (tx) => {
    for (const a of adjustments) {
      const movement = await applyInventoryMovementInTransaction(tx, {
        inventoryId: a.inventoryId,
        type: 'adjust',
        qty: a.delta,
        effectiveAt: reconciliationEffectiveAt,
        note: `${reconciliationNote}: stockQty ${a.currentStockQty} → ${a.effectiveStock} (received ${a.totalReceived} − sold-shipped ${a.totalSold})`,
        createdBy: 'admin/reconcile-inventory-stock',
      });
      if (movement.status !== 'applied') throw new Error('Inventory reconciliation movement was not applied');
    }
  });

  console.info(
    `[admin/reconcile-inventory-stock] adjusted ${adjustments.length} of ${rows.length} active rows`
  );

  return c.json({
    mode: 'apply',
    rowsScanned: rows.length,
    rowsAdjusted: adjustments.length,
    totalDelta: adjustments.reduce((sum, a) => sum + a.delta, 0),
    sampleAdjustments: adjustments.slice(0, 20),
  });
});

export default app;
