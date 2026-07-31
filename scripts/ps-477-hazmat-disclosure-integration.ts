// PS-477: REAL integration test for the hazmat disclosure loaders.
//
// The unsealed shape cannot be produced by buying a label. Buying through
// PrepShip -- even a mock label for a test client -- is what SEALS a snapshot.
// TESTING-MS2TCYUF-000 proves it: it went through the test-client path, PS-186
// forced a mock label, and it produced the only snapshot in production
// (prepship_test / test_label). So the broken shape is built here directly: a
// shipment with source='shipstation' and no snapshot, exactly what
// shipment-sync.ts:163 writes.
//
// This calls the REAL loadHazmatDisclosureForOrders / loadHazmatDisclosureForOrder
// against an in-process PGlite (WASM Postgres). It does not hand-write SQL that
// parallels them -- a test that mirrors the query it is meant to protect passes
// even when the loader's join, ordering, map key or reducer call regresses.
// The loaders' `conn` seam points the real functions at the in-memory instance;
// every call below passes it explicitly, and DATABASE_URL is overwritten with a
// throwaway value before the module is loaded, so the production singleton is
// unreachable. No real order is read or written; nothing connects to a network.
//
// Five orders pin the loaders' behaviour:
//   - order 1: declared, NOT sealed        -> the PS-477 bug shape (declared_unsealed)
//   - order 2: declared AND sealed         -> sealed wins, with the SNAPSHOT's revision
//   - order 3: shipment only               -> none
//   - order 4: declared + CORRUPT snapshot -> declared_unsealed, batch survives
//   - order 5: corrupt LATEST snapshot over an older valid seal
//                                          -> declared_unsealed (never the stale seal)
//
// The final section then drives the REAL print-queue listQueue() over the same
// database and asserts the five hazmat_* fields it puts on the wire. Testing the
// loader alone was not enough: the original bug was in listQueue's DTO
// construction (it joined the snapshot table directly and omitted the fields
// when no snapshot existed), and the Playwright suite stubs the HTTP response,
// so nothing exercised that builder. listQueue takes a `conn` seam for exactly
// this reason; it defaults to the production singleton and is only ever handed
// the in-memory instance here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema/index.js';
import {
  orderHazmatDeclarations,
  orderHazmatMaterials,
  shipmentHazmatSnapshots,
} from '../src/db/schema/hazmat.js';
import {
  hazmatSemanticHash,
  sealHazmatDeclaration,
  HAZMAT_DECLARATION_SCHEMA_VERSION,
  type NormalizedHazmatDeclaration,
  type NormalizedHazmatMaterial,
} from '../src/services/shipping-workflow/hazmat-declaration.js';

type LoaderModule = typeof import('../src/services/shipping-workflow/hazmat-disclosure-loader.js');
type Conn = NonNullable<Parameters<LoaderModule['loadHazmatDisclosureForOrders']>[1]>;
type PrintQueueModule = typeof import('../src/services/print-queue.js');
type ListQueue = PrintQueueModule['listQueue'];
type QueueConn = NonNullable<Parameters<ListQueue>[3]>;
type QueueRow = Awaited<ReturnType<ListQueue>>['queuedOrders'][number];

/**
 * The hazmat_* subset of a queue DTO row, as an exact object. Filtering by
 * prefix rather than reading five named properties is deliberate: deepEqual
 * against this then proves BOTH that the expected fields are present with the
 * expected values AND that no other hazmat field leaked in -- and for a
 * non-hazmat order it proves the fields are absent entirely, which is the
 * literal shape the PS-477 bug produced for a dangerous-goods order.
 */
function hazmatDto(row: QueueRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row as unknown as Record<string, unknown>)
      .filter(([key]) => key.startsWith('hazmat_')),
  );
}

const dryIceMaterial: NormalizedHazmatMaterial = {
  sequence: 1,
  unNaNumber: 'UN1845',
  properShippingName: 'Dry ice',
  technicalName: null,
  hazardClass: '9',
  subsidiaryHazardClass: null,
  packingGroup: null,
  amount: 2.5,
  amountUnit: 'kilogram',
  quantity: 1,
  packagingInstruction: null,
  packagingInstructionSection: null,
  packagingType: null,
  transportMean: 'ground',
  transportCategory: null,
  regulationAuthority: null,
  regulationLevel: 'fully_regulated',
  radioactive: false,
  reportableQuantity: false,
  additionalDescription: null,
};

function activeDeclaration(
  overrides: Partial<Omit<NormalizedHazmatDeclaration, 'schemaVersion' | 'status'>> = {},
): NormalizedHazmatDeclaration & { status: 'active' } {
  return {
    schemaVersion: HAZMAT_DECLARATION_SCHEMA_VERSION,
    status: 'active',
    limitedQuantity: false,
    containsBattery: false,
    dryIce: false,
    dryIceWeightValue: null,
    dryIceWeightUnit: null,
    emergencyContactName: 'Eddie Kim',
    emergencyContactPhone: '310-720-1871',
    uspsCategory: null,
    uspsPackageLevel: null,
    regulatedContentType: null,
    materials: [],
    ...overrides,
  } as NormalizedHazmatDeclaration & { status: 'active' };
}

/** The header row that stores `declaration` for `orderId` at `revision`. */
function declarationRow(orderId: number, revision: number, declaration: NormalizedHazmatDeclaration) {
  return {
    orderId,
    revision,
    status: declaration.status,
    limitedQuantity: declaration.limitedQuantity,
    containsBattery: declaration.containsBattery,
    dryIce: declaration.dryIce,
    emergencyContactName: declaration.emergencyContactName,
    emergencyContactPhone: declaration.emergencyContactPhone,
    uspsCategory: declaration.uspsCategory,
    uspsPackageLevel: declaration.uspsPackageLevel,
    regulatedContentType: declaration.regulatedContentType,
    semanticHash: hazmatSemanticHash(declaration),
  };
}

/** Capture the structured-log lines the loader emits while `run` executes. */
async function captureErrorLog<T>(run: () => Promise<T>): Promise<{
  value: T;
  events: Record<string, unknown>[];
}> {
  const original = console.error;
  const events: Record<string, unknown>[] = [];
  console.error = (...args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'string') {
      try {
        events.push(JSON.parse(first) as Record<string, unknown>);
        return;
      } catch {
        // Not a structured line; fall through to the real sink.
      }
    }
    original(...args);
  };
  try {
    return { value: await run(), events };
  } finally {
    console.error = original;
  }
}

async function main(): Promise<void> {
  // Set BEFORE the loader module is imported: it pulls in src/db/client.ts,
  // which parses process.env. dotenv never overrides an already-set variable,
  // so the repo's real DATABASE_URL cannot win here.
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  const { loadHazmatDisclosureForOrder, loadHazmatDisclosureForOrders } = await import(
    '../src/services/shipping-workflow/hazmat-disclosure-loader.js'
  );
  const { listQueue } = await import('../src/services/print-queue.js');

  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  try {
    await client.exec(`
      CREATE TABLE public.orders (
        id serial PRIMARY KEY,
        -- The four columns listQueue's shipping-hold read selects. Their real
        -- defaults are copied from src/db/schema/orders.ts.
        order_status text NOT NULL DEFAULT 'awaiting_shipment',
        canonical_status text,
        externally_shipped boolean NOT NULL DEFAULT false,
        source_provider text
      );
      CREATE TABLE public.order_overrides (
        order_id integer PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
        best_rate_json jsonb
      );
      CREATE TABLE public.shipments (
        id serial PRIMARY KEY,
        order_id integer NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
        source text
      );
      CREATE TABLE public.external_operations (id serial PRIMARY KEY);
      -- src/db/schema/print-queue.ts. Only the columns listQueue selects.
      CREATE TABLE public.print_queue_orders (
        id text PRIMARY KEY,
        client_id integer NOT NULL,
        order_id text NOT NULL,
        order_number text,
        label_url text NOT NULL,
        sku_group_id text NOT NULL,
        primary_sku text,
        item_description text,
        order_qty integer NOT NULL DEFAULT 1,
        multi_sku_data jsonb,
        status text NOT NULL DEFAULT 'queued',
        print_count integer NOT NULL DEFAULT 0,
        last_printed_at timestamptz,
        auto_retired_at timestamptz,
        queued_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.exec(readFileSync('drizzle/0078_order_hazmat_declarations.sql', 'utf8'));

    await client.exec(`
      -- Orders 1 and 2 are SHIPPED, which is the state the five real PS-477
      -- orders are in. 'local_shipped' is deliberately not a print-queue hold
      -- (printing an existing label buys nothing), so their queue entries must
      -- still be visible -- and must still disclose their hazmat.
      INSERT INTO public.orders (id, order_status, source_provider) VALUES
        (1, 'shipped', 'shipstation'),
        (2, 'shipped', 'shipstation');
      INSERT INTO public.orders (id) VALUES (3), (4), (5), (6);
      -- Order 1: the PS-477 shape. Sync-ingested shipment, active declaration,
      -- deliberately NO snapshot.
      INSERT INTO public.shipments (id, order_id, source) VALUES (10, 1, 'shipstation');
      -- Order 2: sealed. PrepShip bought this one.
      INSERT INTO public.shipments (id, order_id, source) VALUES (20, 2, 'prepship_v2');
      -- Order 3: shipment, no declaration at all.
      INSERT INTO public.shipments (id, order_id, source) VALUES (30, 3, 'shipstation');
      -- Order 4: a snapshot row exists but its payload is corrupt.
      INSERT INTO public.shipments (id, order_id, source) VALUES (40, 4, 'prepship_v2');
      -- Order 5: two shipments. The OLDER one sealed cleanly; the LATEST one is
      -- corrupt. The stale seal must never be presented as this order's proof.
      INSERT INTO public.shipments (id, order_id, source) VALUES (50, 5, 'prepship_v2');
      INSERT INTO public.shipments (id, order_id, source) VALUES (51, 5, 'prepship_v2');
      -- PS-478 order 6: a corrupt seal with NO declaration row at all. This is
      -- the combination that used to answer "not dangerous goods" -- orders 4
      -- and 5 were masked by their surviving live declarations, so the gap only
      -- showed once the declaration was retracted (the PS-475 path). It also
      -- exercises a distinct wiring path: declarationByOrder has no entry for
      -- this order, so the unreadable seal must carry the answer alone.
      INSERT INTO public.shipments (id, order_id, source) VALUES (60, 6, 'prepship_v2');
    `);

    const order1Declaration = activeDeclaration({ materials: [dryIceMaterial] });
    // Order 2's declaration was edited AFTER purchase (revision 7 vs the seal's
    // 4). The seal must still win and must report ITS revision, not this one.
    const order2Declaration = activeDeclaration({ emergencyContactName: 'Edited After Purchase' });
    const order4Declaration = activeDeclaration({ emergencyContactName: 'Behind A Corrupt Seal' });
    const order5Declaration = activeDeclaration({ emergencyContactName: 'Behind A Corrupt Latest Seal' });

    // Real seals, produced by the same function the loader verifies against.
    // The old fixture stored '{"profile":"shipstation_usps","revision":1}' and
    // called it "sealed": that payload has no `declaration` key, so the real
    // mapper REJECTS it. It is now used only where corruption is the point.
    const sealedOrder2 = sealHazmatDeclaration({
      declaration: activeDeclaration({ emergencyContactName: 'Sealed At Purchase' }),
      revision: 4,
      profile: 'shipstation_usps',
    });
    const staleSealOrder5 = sealHazmatDeclaration({
      declaration: activeDeclaration({ emergencyContactName: 'Older Shipment Seal' }),
      revision: 5,
      profile: 'walmart',
    });
    const corruptSnapshotJson = { profile: 'shipstation_usps', revision: 1 };

    await pg.insert(orderHazmatDeclarations).values([
      declarationRow(1, 1, order1Declaration),
      declarationRow(2, 7, order2Declaration),
      declarationRow(4, 2, order4Declaration),
      declarationRow(5, 6, order5Declaration),
    ]);
    await pg.insert(orderHazmatMaterials).values([
      {
        orderId: 1,
        sequence: dryIceMaterial.sequence,
        unNaNumber: dryIceMaterial.unNaNumber,
        properShippingName: dryIceMaterial.properShippingName,
        hazardClass: dryIceMaterial.hazardClass,
        amount: String(dryIceMaterial.amount),
        amountUnit: dryIceMaterial.amountUnit,
        quantity: dryIceMaterial.quantity,
        transportMean: dryIceMaterial.transportMean,
        regulationLevel: dryIceMaterial.regulationLevel,
        radioactive: dryIceMaterial.radioactive,
        reportableQuantity: dryIceMaterial.reportableQuantity,
      },
    ]);

    await pg.insert(shipmentHazmatSnapshots).values([
      {
        shipmentId: 20,
        snapshotSchemaVersion: 1,
        orderDeclarationRevision: sealedOrder2.revision,
        snapshotHash: sealedOrder2.snapshotHash,
        summaryIsHazmat: true,
        summaryProfile: sealedOrder2.profile,
        snapshotJson: sealedOrder2 as unknown as Record<string, unknown>,
        captureKind: 'provider_purchase',
      },
      {
        shipmentId: 40,
        snapshotSchemaVersion: 1,
        orderDeclarationRevision: 1,
        snapshotHash: `hz_${'d'.repeat(64)}`,
        summaryIsHazmat: true,
        summaryProfile: 'shipstation_usps',
        snapshotJson: corruptSnapshotJson,
        captureKind: 'provider_purchase',
      },
      {
        shipmentId: 50,
        snapshotSchemaVersion: 1,
        orderDeclarationRevision: staleSealOrder5.revision,
        snapshotHash: staleSealOrder5.snapshotHash,
        summaryIsHazmat: true,
        summaryProfile: staleSealOrder5.profile,
        snapshotJson: staleSealOrder5 as unknown as Record<string, unknown>,
        captureKind: 'provider_purchase',
      },
      {
        shipmentId: 51,
        snapshotSchemaVersion: 1,
        orderDeclarationRevision: 1,
        snapshotHash: `hz_${'e'.repeat(64)}`,
        summaryIsHazmat: true,
        summaryProfile: 'shipstation_usps',
        snapshotJson: corruptSnapshotJson,
        captureKind: 'provider_purchase',
      },
      {
        shipmentId: 60,
        snapshotSchemaVersion: 1,
        orderDeclarationRevision: 1,
        snapshotHash: `hz_${'f'.repeat(64)}`,
        summaryIsHazmat: true,
        summaryProfile: 'shipstation_ups_dry_ice',
        snapshotJson: corruptSnapshotJson,
        captureKind: 'provider_purchase',
      },
    ]);

    // ONE batch, all five orders together: the corrupt rows for 4 and 5 must not
    // disturb 1, 2 or 3.
    const { value: batch, events } = await captureErrorLog(
      () => loadHazmatDisclosureForOrders([1, 2, 3, 4, 5, 6], conn),
    );

    assert.deepEqual(
      [...batch.keys()].sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
      'every requested order gets an entry',
    );

    // PS-479 added `declaration` — the content a terminal view should render,
    // chosen by the backend instead of by React. The deepEqual assertions below
    // stay strict about the FACT (they still fail on any unexpected field) and
    // check the content separately, where its identity is what matters rather
    // than its full body being retyped into six fixtures.
    const fact = (orderId: number) => {
      const entry = batch.get(orderId);
      assert.ok(entry, `order ${orderId} must resolve`);
      const { declaration: _displayed, ...rest } = entry;
      return rest;
    };

    // 1. THE PS-477 CASE. A shipment PrepShip did not buy is still dangerous goods.
    assert.deepEqual(fact(1), {
      isHazmat: true,
      profile: null,
      provenance: 'declared_unsealed',
      snapshotHash: null,
      declarationRevision: 1,
    }, 'order 1: active declaration, no snapshot -> declared_unsealed, hazmat, no invented profile');

    // 2. Sealed wins over a declaration edited after purchase, and reports the
    //    SNAPSHOT's revision/profile/hash -- proof the loader read the seal.
    assert.deepEqual(fact(2), {
      isHazmat: true,
      profile: 'shipstation_usps',
      provenance: 'sealed',
      snapshotHash: sealedOrder2.snapshotHash,
      declarationRevision: 4,
    }, 'order 2: a verifiable seal wins over the later declaration edit');

    // 3. Nothing declared, nothing sealed.
    assert.deepEqual(fact(3), {
      isHazmat: false,
      profile: null,
      provenance: 'none',
      snapshotHash: null,
      declarationRevision: null,
    }, 'order 3: no declaration and no snapshot -> none');

    // 4. A corrupt snapshot must NOT abort the batch and must NOT downgrade to
    //    none. It falls through to the live declaration.
    assert.deepEqual(fact(4), {
      isHazmat: true,
      // PS-478: summary_profile survives a corrupt snapshot_json -- it is its
      // own column with its own CHECK constraint -- so an unreadable seal can
      // still name the carrier profile it was sealed under.
      profile: 'shipstation_usps',
      provenance: 'sealed_unreadable',
      // Null: the hash describes bytes that failed validation, so presenting it
      // would offer proof of something nobody could read.
      snapshotHash: null,
      declarationRevision: 2,
    }, 'order 4: an unreadable seal is its own state, never none and never a plain unsealed order');

    // 5. Latest-wins is keyed on the ORDER, not on whether facts were produced:
    //    a corrupt latest snapshot must not expose the older shipment's seal.
    assert.deepEqual(fact(5), {
      isHazmat: true,
      profile: 'shipstation_usps',
      provenance: 'sealed_unreadable',
      snapshotHash: null,
      declarationRevision: 6,
    }, 'order 5: a corrupt LATEST snapshot must not fall back to a stale older seal');
    assert.notEqual(
      batch.get(5)?.snapshotHash,
      staleSealOrder5.snapshotHash,
      'order 5 must never present the second-latest shipment seal as current proof',
    );

    // 6. PS-478's reason for existing. A corrupt seal with NO live declaration
    //    used to resolve to `none` / isHazmat false: a shipment that went out
    //    sealed as dangerous goods read back as not dangerous goods. The
    //    surviving summary columns now carry the answer on their own.
    assert.deepEqual(fact(6), {
      isHazmat: true,
      profile: 'shipstation_ups_dry_ice',
      provenance: 'sealed_unreadable',
      snapshotHash: null,
      // Null, not 0: there is no declaration row to take a revision from.
      declarationRevision: null,
    }, 'order 6: an unreadable seal with no live declaration must still report dangerous goods');

    // Corruption is surfaced, never swallowed.
    const corruptEvents = events.filter((event) => event.event === 'hazmat_disclosure_snapshot_corrupt');
    assert.deepEqual(
      corruptEvents.map((event) => event.orderId).sort((a, b) => Number(a) - Number(b)),
      [4, 5, 6],
      'each corrupt snapshot is reported once, structurally, with its order id',
    );
    assert.deepEqual(
      corruptEvents.map((event) => event.shipmentId).sort((a, b) => Number(a) - Number(b)),
      [40, 51, 60],
      'the corruption report names the LATEST offending shipment, not the older clean one',
    );
    assert.ok(
      corruptEvents.every((event) => event.level === 'error' && String(event.error).length > 0),
      'corruption is reported at error level with the underlying message',
    );

    // Single-order loader: same answers through the same owner.
    const single1 = await loadHazmatDisclosureForOrder(1, conn);
    assert.deepEqual(single1, batch.get(1), 'single-order loader agrees with the batch for the PS-477 shape');
    const single2 = await loadHazmatDisclosureForOrder(2, conn);
    assert.deepEqual(single2, batch.get(2), 'single-order loader agrees with the batch for the sealed shape');
    const single3 = await loadHazmatDisclosureForOrder(3, conn);
    assert.equal(single3.provenance, 'none');
    const { value: single5 } = await captureErrorLog(() => loadHazmatDisclosureForOrder(5, conn));
    assert.deepEqual(single5, batch.get(5), 'single-order loader agrees with the batch for the corrupt-latest shape');

    // An order that does not exist at all is not hazmat.
    const missing = await loadHazmatDisclosureForOrder(9_999, conn);
    assert.deepEqual(missing, {
      isHazmat: false,
      profile: null,
      provenance: 'none',
      snapshotHash: null,
      declarationRevision: null,
      declaration: null,
    }, 'an unknown order id resolves to none, not undefined');

    assert.equal((await loadHazmatDisclosureForOrders([], conn)).size, 0, 'an empty batch queries nothing');

    // ---- The Print Queue DTO, built by the real listQueue ------------------
    //
    // Everything above proves the OWNER. This proves the CALLER: the exact
    // function whose hand-rolled snapshot join dropped the hazmat fields for
    // five shipped orders. The Playwright suite stubs this endpoint's response,
    // so without this section nothing in the plan ever ran the builder.
    await client.exec(`
      INSERT INTO public.print_queue_orders
        (id, client_id, order_id, order_number, label_url, sku_group_id, primary_sku, status)
      VALUES
        ('pq-unsealed', 1, '1', 'HZ-UNSEALED', 'https://example.test/1.pdf', 'HZ', 'HZ-SKU', 'queued'),
        ('pq-sealed',   1, '2', 'HZ-SEALED',   'https://example.test/2.pdf', 'HZ', 'HZ-SKU', 'queued'),
        ('pq-clear',    1, '3', 'HZ-CLEAR',    'https://example.test/3.pdf', 'HZ', 'HZ-SKU', 'queued');
    `);

    const queue = await listQueue(undefined, false, {}, pg as unknown as QueueConn);
    const queueByOrderId = new Map(queue.queuedOrders.map((row) => [Number(row.order_id), row]));
    assert.deepEqual(
      [...queueByOrderId.keys()].sort((a, b) => a - b),
      [1, 2, 3],
      'a shipped order keeps its queue entry -- local_shipped is not a print-queue hold',
    );
    assert.equal(queue.totalOrders, 3);

    // THE PS-477 CASE, end to end: order 1 is shipped, its label was bought in
    // ShipStation, and no snapshot exists. The wire DTO must still say hazmat.
    assert.equal(queueByOrderId.get(1)?.shipping_hold, false, 'the shipped order really did reach the DTO');
    assert.deepEqual(hazmatDto(queueByOrderId.get(1)!), {
      hazmat_is_hazmat: true,
      hazmat_provenance: 'declared_unsealed',
      hazmat_profile: null,
      hazmat_snapshot_hash: null,
      hazmat_declaration_revision: 1,
    }, 'order 1: the queue DTO discloses an unsealed declaration, with a null profile it did not invent');

    // A sealed order carries the SNAPSHOT's profile, hash and revision --
    // proof the DTO reports the owner's answer rather than the live declaration
    // (which sits at revision 7).
    assert.deepEqual(hazmatDto(queueByOrderId.get(2)!), {
      hazmat_is_hazmat: true,
      hazmat_provenance: 'sealed',
      hazmat_profile: 'shipstation_usps',
      hazmat_snapshot_hash: sealedOrder2.snapshotHash,
      hazmat_declaration_revision: 4,
    }, 'order 2: the queue DTO carries the seal, not the later declaration edit');

    // A non-hazmat order carries no hazmat_* field at all. This is the shape the
    // frontend keys "no badge" on, so it has to stay absent, not become false.
    assert.deepEqual(
      hazmatDto(queueByOrderId.get(3)!),
      {},
      'order 3: a clear order emits no hazmat fields whatsoever',
    );

    console.log('PS-477 hazmat disclosure PGlite integration passed');
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
