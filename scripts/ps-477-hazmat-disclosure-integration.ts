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

  const client = new PGlite();
  const pg = drizzle(client, { schema, casing: 'snake_case' });
  const conn = pg as unknown as Conn;

  try {
    await client.exec(`
      CREATE TABLE public.orders (id serial PRIMARY KEY);
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
    `);
    await client.exec(readFileSync('drizzle/0078_order_hazmat_declarations.sql', 'utf8'));

    await client.exec(`
      INSERT INTO public.orders (id) VALUES (1), (2), (3), (4), (5);
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
    ]);

    // ONE batch, all five orders together: the corrupt rows for 4 and 5 must not
    // disturb 1, 2 or 3.
    const { value: batch, events } = await captureErrorLog(
      () => loadHazmatDisclosureForOrders([1, 2, 3, 4, 5], conn),
    );

    assert.deepEqual(
      [...batch.keys()].sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
      'every requested order gets an entry',
    );

    // 1. THE PS-477 CASE. A shipment PrepShip did not buy is still dangerous goods.
    assert.deepEqual(batch.get(1), {
      isHazmat: true,
      profile: null,
      provenance: 'declared_unsealed',
      snapshotHash: null,
      declarationRevision: 1,
    }, 'order 1: active declaration, no snapshot -> declared_unsealed, hazmat, no invented profile');

    // 2. Sealed wins over a declaration edited after purchase, and reports the
    //    SNAPSHOT's revision/profile/hash -- proof the loader read the seal.
    assert.deepEqual(batch.get(2), {
      isHazmat: true,
      profile: 'shipstation_usps',
      provenance: 'sealed',
      snapshotHash: sealedOrder2.snapshotHash,
      declarationRevision: 4,
    }, 'order 2: a verifiable seal wins over the later declaration edit');

    // 3. Nothing declared, nothing sealed.
    assert.deepEqual(batch.get(3), {
      isHazmat: false,
      profile: null,
      provenance: 'none',
      snapshotHash: null,
      declarationRevision: null,
    }, 'order 3: no declaration and no snapshot -> none');

    // 4. A corrupt snapshot must NOT abort the batch and must NOT downgrade to
    //    none. It falls through to the live declaration.
    assert.deepEqual(batch.get(4), {
      isHazmat: true,
      profile: null,
      provenance: 'declared_unsealed',
      snapshotHash: null,
      declarationRevision: 2,
    }, 'order 4: an unverifiable seal falls back to the live declaration, never to none');

    // 5. Latest-wins is keyed on the ORDER, not on whether facts were produced:
    //    a corrupt latest snapshot must not expose the older shipment's seal.
    assert.deepEqual(batch.get(5), {
      isHazmat: true,
      profile: null,
      provenance: 'declared_unsealed',
      snapshotHash: null,
      declarationRevision: 6,
    }, 'order 5: a corrupt LATEST snapshot must not fall back to a stale older seal');
    assert.notEqual(
      batch.get(5)?.snapshotHash,
      staleSealOrder5.snapshotHash,
      'order 5 must never present the second-latest shipment seal as current proof',
    );

    // Corruption is surfaced, never swallowed.
    const corruptEvents = events.filter((event) => event.event === 'hazmat_disclosure_snapshot_corrupt');
    assert.deepEqual(
      corruptEvents.map((event) => event.orderId).sort((a, b) => Number(a) - Number(b)),
      [4, 5],
      'each corrupt snapshot is reported once, structurally, with its order id',
    );
    assert.deepEqual(
      corruptEvents.map((event) => event.shipmentId).sort((a, b) => Number(a) - Number(b)),
      [40, 51],
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
    }, 'an unknown order id resolves to none, not undefined');

    assert.equal((await loadHazmatDisclosureForOrders([], conn)).size, 0, 'an empty batch queries nothing');

    console.log('PS-477 hazmat disclosure PGlite integration passed');
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
