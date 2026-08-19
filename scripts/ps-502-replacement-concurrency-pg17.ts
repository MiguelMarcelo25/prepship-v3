#!/usr/bin/env tsx
/**
 * PS-502 — GENUINE multi-backend concurrency proof against real PostgreSQL 17.
 *
 * The PGlite lane proves the optimistic-concurrency PREDICATE rejects a stale update, by
 * interleaving deterministically. It cannot prove more: PGlite is a single backend, so two
 * transactions never actually overlap and an advisory lock there is trivially satisfied.
 *
 * This file proves the separate claim — that the advisory lock and transactional rollback
 * hold under REAL contention, with separate backend sessions running at the same time.
 * AC-12 says CONCURRENT, so it cannot be satisfied without this.
 *
 * Assertions count PERSISTED ROWS and inspect their identities. "Both promises resolved" is
 * not evidence: two callers can both succeed and still have left two references, two
 * shipments, or two creation events behind.
 *
 * Ephemeral databases only, created and dropped per case. No production database, provider,
 * label, postage, inventory or marketplace side effect is reachable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';
import {
  PS_502_MIGRATIONS,
  PS_502_PREREQUISITE_DDL,
  PS_502_SEED_SQL,
} from './lib/ps-502-test-schema.js';

// Reuses the PS-488 lane's admin URL when a PS-502-specific one is not set, so this runs in
// CI wherever that lane already runs rather than waiting on a new secret.
const ADMIN_URL = process.env.PS502_PG17_ADMIN_URL ?? process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error(
    'FAIL: neither PS502_PG17_ADMIN_URL nor PS488_PG17_ADMIN_URL is set.\n' +
    '      This proof is unskippable — AC-12 requires genuine multi-backend concurrency,\n' +
    '      and silently passing without a server would be worse than not running.',
  );
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error(`FAIL: refusing non-ephemeral host "${host}"`);
    process.exit(1);
  }
}

let passed = 0;
let counter = 0;
const check = (name: string, condition: boolean, detail?: string): void => {
  if (!condition) {
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`ok   ${name}`);
};

const admin = () => postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });

type Lane = {
  name: string;
  raw: postgres.Sql;
  db: ReturnType<typeof drizzle>;
};

/**
 * A fresh database with a MULTI-CONNECTION pool.
 *
 * `max` above one is the entire point: postgres.js hands each concurrent transaction its own
 * backend, so the callers below genuinely overlap. With `max: 1` they would queue and this
 * file would prove nothing the PGlite lane does not already prove.
 */
/**
 * Prove the server really is PostgreSQL 17 before a single statement is written.
 *
 * The loopback check above proves LOCATION, not version — and this file's entire claim is
 * "AC-12 proven on PostgreSQL 17". On 2026-08-19 a PostgreSQL 18.3 server was found listening
 * on 127.0.0.1:5432 of a developer machine: it would have passed the host gate, run green, and
 * reported a PG17 proof that never happened. A guard whose headline claim is a version must
 * check the version.
 *
 * Deliberately placed on the admin connection BEFORE `drop database`/`create database`: a
 * wrong-major server must be refused without any DDL being issued against it.
 */
async function assertPostgres17(a: postgres.Sql): Promise<void> {
  const [row] = await a.unsafe('show server_version_num');
  const raw = (row as Record<string, unknown> | undefined)?.server_version_num;
  const version = Number(raw);
  if (!Number.isFinite(version) || version < 170000 || version >= 180000) {
    console.error(
      `FAIL: server_version_num ${String(raw)} is not PostgreSQL 17.\n`
      + '      AC-12 claims multi-backend concurrency on PostgreSQL 17 specifically, so a\n'
      + '      different major would produce a green run that proves something else.\n'
      + '      Nothing was created or dropped on this server.',
    );
    await a.end({ timeout: 5 });
    process.exit(1);
  }
  console.log(`ok   server is PostgreSQL 17 (server_version_num ${version})`);
}

async function fresh(): Promise<Lane> {
  counter += 1;
  const name = `ps502_conc_${process.pid}_${counter}`;
  const a = admin();
  try {
    await assertPostgres17(a);
    await a.unsafe(`drop database if exists ${name}`);
    await a.unsafe(`create database ${name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const raw = postgres(url.toString(), { max: 8, prepare: false, onnotice: () => {} });
  await raw.unsafe(PS_502_PREREQUISITE_DDL);
  for (const file of PS_502_MIGRATIONS) {
    await raw.unsafe(readFileSync(file, 'utf8'));
  }
  await raw.unsafe(PS_502_SEED_SQL);
  return { name, raw, db: drizzle(raw, { schema, casing: 'snake_case' }) };
}

async function drop(lane: Lane): Promise<void> {
  await lane.raw.end({ timeout: 5 });
  const a = admin();
  try {
    await a.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${lane.name}' and pid <> pg_backend_pid()`,
    );
    await a.unsafe(`drop database if exists ${lane.name}`);
  } finally {
    await a.end({ timeout: 5 });
  }
}

const actor = {
  email: 'op@example.test',
  type: 'operator',
  permissions: ['replacements:create', 'replacements:label'],
};

const PURCHASE_INPUTS = {
  address: {
    value: {
      name: 'Jane Roe', line1: '1 Test Way', city: 'Springfield',
      state: 'IL', postalCode: '62704', country: 'US',
    },
    source: 'operator_override' as const,
    chosenBy: actor.email,
    reason: 'customer confirmed address',
  },
  carrier: {
    value: { carrierCode: 'ups', serviceCode: 'ups_ground', providerAccountId: 7 },
    source: 'operator_override' as const,
    chosenBy: actor.email,
    reason: 'same service as the original',
  },
  package: {
    value: { packageId: 'box-a', weightOz: 32, dimsL: 10, dimsW: 8, dimsH: 6 },
    source: 'operator_override' as const,
    chosenBy: actor.email,
    reason: 'recalculated from the replacement items',
  },
};

/**
 * The vessel the purchase will be checked against, DERIVED from PURCHASE_INPUTS.
 *
 * readyForLabel() attached a shipment with no carrier, service, account or dimensions,
 * while the purchase asked for ups/ups_ground/account 7 — so the request/shipment identity
 * check added with the frozen-request work refused all eight fields and case 5a died on a
 * mismatch instead of the crash it was written to exercise. The PGlite suite passed because
 * its fixture supplies this payload; this lane predates the check and never ran on PG17.
 *
 * Deriving the values means a future change to PURCHASE_INPUTS cannot silently desynchronise
 * the fixture from the request again.
 */
const PURCHASE_SHIPMENT = {
  carrierCode: PURCHASE_INPUTS.carrier.value.carrierCode,
  serviceCode: PURCHASE_INPUTS.carrier.value.serviceCode,
  providerAccountId: PURCHASE_INPUTS.carrier.value.providerAccountId,
  selectedPackageId: PURCHASE_INPUTS.package.value.packageId,
  weightOz: PURCHASE_INPUTS.package.value.weightOz,
  dimsL: PURCHASE_INPUTS.package.value.dimsL,
  dimsW: PURCHASE_INPUTS.package.value.dimsW,
  dimsH: PURCHASE_INPUTS.package.value.dimsH,
};

const FULL_PROVIDER_RECEIPT = {
  providerTransactionId: 'txn-ps502-race',
  providerLabelId: 'lbl-ps502-race',
  providerShipmentId: 'shp-ps502-race',
  trackingNumber: '1Z-PS502-RACE',
  labelUrl: 'https://example.test/ps502-race-label.pdf',
  shipmentCost: 8.25,
  otherCost: 1.5,
};

/** Releases every caller at once, so they contend rather than queue behind each other. */
function barrier(count: number): { wait: () => Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived = 0;
  let ready!: () => void;
  const allArrived = new Promise<void>((resolve) => { ready = resolve; });
  return {
    wait: async () => {
      arrived += 1;
      if (arrived === count) ready();
      await gate;
    },
    release: () => { void allArrived.then(() => release()); },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withoutDeadlock<T>(label: string, work: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after 30s — probable deadlock`)),
      30_000,
    );
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hold one selected transaction callback until every contender has a live PostgreSQL
 * transaction. Each wrapper has its own call counter: label purchase and reconciliation both
 * use transaction 1 to read/claim and transaction 2 to persist the provider result.
 */
function barrierOnTransaction(
  base: Lane['db'],
  transactionNumber: number,
  gate: { wait: () => Promise<void> },
): {
  conn: { transaction: (callback: (tx: any) => unknown | Promise<unknown>) => Promise<unknown> };
  calls: () => number;
} {
  let calls = 0;
  return {
    conn: {
      transaction: async (callback) => {
        calls += 1;
        const thisCall = calls;
        return (base as any).transaction(async (tx: any) => {
          if (thisCall === transactionNumber) await gate.wait();
          return callback(tx);
        });
      },
    },
    calls: () => calls,
  };
}

async function main(): Promise<void> {
  process.env.SUPABASE_URL = 'https://example.test';
  process.env.SUPABASE_ANON_KEY = 'test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.NODE_ENV = 'test';
  // Do not leave the lazily-created singleton client pointed at any ambient database. Every
  // command below receives a fresh lane explicitly; this loopback admin URL makes an accidental
  // connection escape fail locally instead of making a non-ephemeral database reachable.
  process.env.DATABASE_URL = ADMIN_URL!;
  // Test-process scope only. Production/default configuration stays dark; this must be set
  // before the dynamic import that parses env so no test mutates the exported runtime object.
  process.env.REPLACEMENTS_LABEL_ENABLED = 'true';

  const { createReplacement, ReplacementCreateError } =
    await import('../src/services/replacement-create-command.js');
  const { insertReplacementShipment } =
    await import('../src/services/replacement-shipment-command.js');
  const { purchaseReplacementLabel } =
    await import('../src/services/replacement-label-purchase-command.js');
  const { reconcileReplacementPurchaseIntent } =
    await import('../src/services/replacement-label-void-command.js');

  const readyForLabel = async (lane: Lane, requestKey: string) => {
    const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
    const created = await createReplacement({
      orderId: 1321,
      reason: 'damaged',
      liabilityOwner: 'operator',
      items: [{ orderLineIndex: 1, quantity: 1 }],
      requestIdempotencyKey: requestKey,
      actor,
    }, conn);
    await lane.db.update(schema.replacements)
      .set({ status: 'approved' })
      .where(eq(schema.replacements.id, created.replacement.id));
    const attached = await insertReplacementShipment({
      replacementId: created.replacement.id,
      actor: { email: actor.email, type: actor.type },
      shipment: PURCHASE_SHIPMENT,
    }, conn);
    return {
      replacementId: created.replacement.id,
      shipmentId: attached.shipmentId,
      conn,
    };
  };

  // ── Case 1 — concurrent creation allocates REFERENCE and REFERENCE-2 ───────
  console.log('\ncase 1 — concurrent reference allocation');
  {
    const lane = await fresh();
    try {
      const gate = barrier(4);
      const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
      const attempts = [0, 1, 2, 3].map(async (i) => {
        await gate.wait();
        return createReplacement({
          orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
          items: [{ orderLineIndex: 0, quantity: 1 }],
          requestIdempotencyKey: `conc-${i}`, actor,
        }, conn);
      });
      gate.release();
      const results = await Promise.allSettled(attempts);

      const failed = results.filter((r) => r.status === 'rejected');
      check('four genuinely concurrent creates all succeed', failed.length === 0,
        failed.map((r) => String((r as PromiseRejectedResult).reason?.message)).join(' | '));

      const rows = await lane.db.select({ reference: schema.replacements.reference })
        .from(schema.replacements);
      const refs = rows.map((r) => r.reference).sort();
      check('exactly four replacements persisted', rows.length === 4, `got ${rows.length}`);
      check('references are the canonical sequence with no collision and no gap',
        refs.join(',') === '1321-REPLACE,1321-REPLACE-2,1321-REPLACE-3,1321-REPLACE-4',
        refs.join(','));
      check('the bare form was allocated exactly once',
        refs.filter((r) => r === '1321-REPLACE').length === 1);
    } finally {
      await drop(lane);
    }
  }

  // ── Case 2 — concurrent identical idempotency key ──────────────────────────
  console.log('\ncase 2 — concurrent same-key requests');
  {
    const lane = await fresh();
    try {
      const gate = barrier(4);
      const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
      const attempts = [0, 1, 2, 3].map(async () => {
        await gate.wait();
        return createReplacement({
          orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
          items: [{ orderLineIndex: 0, quantity: 1 }],
          requestIdempotencyKey: 'same-key', actor,
        }, conn);
      });
      gate.release();
      const results = await Promise.all(attempts);

      const ids = new Set(results.map((r) => r.replacement.id));
      check('every caller receives the SAME replacement identity', ids.size === 1,
        `distinct ids: ${[...ids].join(',')}`);
      check('exactly one caller reports created=true',
        results.filter((r) => r.created).length === 1,
        `created flags: ${results.map((r) => r.created).join(',')}`);

      const rows = await lane.db.select().from(schema.replacements);
      check('exactly one replacement persisted', rows.length === 1, `got ${rows.length}`);

      const items = await lane.db.select().from(schema.replacementItems);
      check('exactly one item set persisted', items.length === 1, `got ${items.length}`);

      const events = await lane.db.select().from(schema.replacementActivityEvents);
      const creations = events.filter((e) => e.eventType === 'replacement_requested');
      check('exactly one creation event appended', creations.length === 1,
        `got ${creations.length}`);
    } finally {
      await drop(lane);
    }
  }

  // ── Case 3 — allowance contention ──────────────────────────────────────────
  console.log('\ncase 3 — allowance contention');
  {
    const lane = await fresh();
    try {
      const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
      // Consume the whole line with a SHIPPED replacement, so nothing remains.
      const consumed = await createReplacement({
        orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
        items: [{ orderLineIndex: 0, quantity: 3 }],
        requestIdempotencyKey: 'consume-all', actor,
      }, conn);
      await lane.db.update(schema.replacements)
        .set({ status: 'shipped', shippedAt: new Date() })
        .where(eq(schema.replacements.id, consumed.replacement.id));

      const gate = barrier(3);
      const attempts = [0, 1, 2].map(async (i) => {
        await gate.wait();
        return createReplacement({
          orderId: 1321, reason: 'other', liabilityOwner: 'operator',
          items: [{ orderLineIndex: 0, quantity: 1 }],
          requestIdempotencyKey: `over-${i}`, actor,
        }, conn);
      });
      gate.release();
      const results = await Promise.allSettled(attempts);

      const refusals = results.filter(
        (r) => r.status === 'rejected'
          && (r as PromiseRejectedResult).reason instanceof ReplacementCreateError
          && (r as PromiseRejectedResult).reason.code === 'REPLACEMENT_ALLOWANCE_EXCEEDED',
      );
      check('every concurrent request over an exhausted allowance is refused',
        refusals.length === 3, `refused ${refusals.length} of 3`);

      const rows = await lane.db.select().from(schema.replacements);
      check('no replacement was persisted past the cap under contention',
        rows.length === 1, `got ${rows.length}`);

      // Stated plainly rather than implied: only SHIPPED units consume, by decision 5. Two
      // concurrent PENDING requests may therefore both be accepted, and the cap is enforced
      // again at ship. This case proves the read is consistent under contention, not that
      // pending requests are serialised against each other.
      console.log('     note: pending requests consume nothing by design (decision 5);');
      console.log('           the cap binds again in the atomic shipped command.');
    } finally {
      await drop(lane);
    }
  }

  // ── Case 4 — the two-transaction gap in shipment insertion ─────────────────
  console.log('\ncase 4 — concurrent shipment attachment');
  {
    const lane = await fresh();
    try {
      const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
      const created = await createReplacement({
        orderId: 1321, reason: 'damaged', liabilityOwner: 'operator',
        items: [{ orderLineIndex: 0, quantity: 1 }],
        requestIdempotencyKey: 'attach', actor,
      }, conn);
      await lane.db.update(schema.replacements).set({ status: 'approved' })
        .where(eq(schema.replacements.id, created.replacement.id));

      const gate = barrier(4);
      const attempts = [0, 1, 2, 3].map(async () => {
        await gate.wait();
        return insertReplacementShipment({
          replacementId: created.replacement.id,
          actor: { email: actor.email, type: actor.type },
        }, conn);
      });
      gate.release();
      const results = await Promise.allSettled(attempts);

      // THE ASSERTION THAT MATTERS. A loser whose shipment row survived would show up here,
      // and no amount of "the call threw" would reveal it.
      const shipments = await lane.db.select().from(schema.shipments);
      check('exactly ONE shipment row exists after four concurrent attaches',
        shipments.length === 1, `got ${shipments.length} — a loser's orphan survived`);

      const [replacement] = await lane.db.select().from(schema.replacements)
        .where(eq(schema.replacements.id, created.replacement.id));
      check('the replacement points at that one shipment',
        replacement!.replacementShipmentId === shipments[0]!.id);

      const conflicts = results.filter(
        (r) => r.status === 'rejected'
          && String((r as PromiseRejectedResult).reason?.code) === 'REPLACEMENT_STATE_CONFLICT',
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      check('losers either conflict or return the winner\'s shipment — never a second one',
        conflicts.length + succeeded.length === 4
        && succeeded.every((r) => (r as PromiseFulfilledResult<{ shipmentId: number }>).value.shipmentId === shipments[0]!.id),
        `conflicts=${conflicts.length} fulfilled=${succeeded.length}`);

      const createdCount = results.filter(
        (r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ created: boolean }>).value.created,
      );
      check('exactly one caller actually created the shipment', createdCount.length === 1,
        `got ${createdCount.length}`);
    } finally {
      await drop(lane);
    }
  }

  // ── Case 5a — reconciliation races reconciliation for one receipt ─────────
  console.log('\ncase 5a — concurrent reconciliation of one orphaned label purchase');
  {
    const lane = await fresh();
    try {
      const ready = await readyForLabel(lane, 'reconcile-race');
      let providerPurchaseCalls = 0;
      let purchaseTransactions = 0;
      const crashingConn = {
        transaction: async (callback: (tx: any) => unknown | Promise<unknown>) => {
          purchaseTransactions += 1;
          if (purchaseTransactions === 2) {
            throw new Error('simulated process death before receipt persistence');
          }
          return (ready.conn as any).transaction(callback);
        },
      } as unknown as Parameters<typeof purchaseReplacementLabel>[2];
      const purchaseProvider = {
        purchase: async () => {
          providerPurchaseCalls += 1;
          return { ...FULL_PROVIDER_RECEIPT };
        },
      };

      await assert.rejects(
        () => purchaseReplacementLabel({
          replacementId: ready.replacementId,
          actor,
          purchaseInputs: PURCHASE_INPUTS,
        }, purchaseProvider, crashingConn),
        /simulated process death/,
      );

      const [orphan] = await lane.db.select()
        .from(schema.replacementLabelPurchaseIntents)
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, ready.replacementId));
      assert.ok(orphan, 'the provider call must leave one durable intent behind');
      assert.equal(orphan.state, 'provider_pending');

      const providerGate = barrier(2);
      const persistGate = barrier(2);
      const left = barrierOnTransaction(lane.db, 2, persistGate);
      const right = barrierOnTransaction(lane.db, 2, persistGate);
      let providerLookupCalls = 0;
      const recoveryProvider = {
        voidLabel: async () => { throw new Error('void is unreachable in purchase recovery'); },
        lookupPurchase: async ({ idempotencyKey }: { idempotencyKey: string }) => {
          providerLookupCalls += 1;
          assert.equal(idempotencyKey, orphan.providerIdempotencyKey);
          await providerGate.wait();
          return { ...FULL_PROVIDER_RECEIPT };
        },
      };

      const recoveries = [left, right].map((wrapped, index) =>
        reconcileReplacementPurchaseIntent({
          replacementId: ready.replacementId,
          intentId: orphan.id,
          actor,
          reason: `concurrent recovery ${index + 1}`,
        }, recoveryProvider, wrapped.conn as Parameters<typeof reconcileReplacementPurchaseIntent>[2]));
      providerGate.release();
      persistGate.release();
      const results = await withoutDeadlock(
        'reconciliation/reconciliation race',
        Promise.all(recoveries),
      );

      check('both reconciliation callers complete with two genuinely overlapping Phase 3 transactions',
        results.length === 2 && left.calls() === 2 && right.calls() === 2,
        `results=${results.length} txCalls=${left.calls()},${right.calls()}`);
      check('both reconciliation callers return the exact same durable full receipt',
        results.every((result) =>
          result.outcome === 'purchased'
          && result.intentId === orphan.id
          && result.shipmentId === ready.shipmentId
          && result.recorded === 'label_created'
          && isDeepStrictEqual(result.receipt, FULL_PROVIDER_RECEIPT)),
        JSON.stringify(results));
      check('reconciliation performed one original purchase and two read-only provider lookups',
        providerPurchaseCalls === 1 && providerLookupCalls === 2,
        `purchases=${providerPurchaseCalls} lookups=${providerLookupCalls}`);

      const intents = await lane.db.select().from(schema.replacementLabelPurchaseIntents)
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, ready.replacementId));
      const shipments = await lane.db.select().from(schema.shipments);
      const events = await lane.db.select().from(schema.replacementActivityEvents)
        .where(eq(schema.replacementActivityEvents.replacementId, ready.replacementId));
      const labelFacts = events.filter((event) => event.eventType === 'replacement_label_created');
      const reconciliationFacts = events.filter(
        (event) => event.eventType === 'replacement_purchase_reconciled_found',
      );
      check('the reconciliation race persists one purchased intent and one replacement shipment',
        intents.length === 1
          && intents[0]!.state === 'purchased'
          && intents[0]!.providerTransactionId === FULL_PROVIDER_RECEIPT.providerTransactionId
          && shipments.length === 1
          && shipments[0]!.id === ready.shipmentId,
        `intents=${intents.length} shipments=${shipments.length}`);
      check('the reconciliation race appends one label-created fact and one recovery fact',
        labelFacts.length === 1 && reconciliationFacts.length === 1,
        `label=${labelFacts.length} recovery=${reconciliationFacts.length}`);
      const eventKeys = events.map((event) => event.idempotencyKey).filter(Boolean);
      check('the reconciliation race leaves no duplicate activity facts',
        new Set(eventKeys).size === eventKeys.length,
        eventKeys.join(','));
      const blocked = await lane.raw.unsafe(
        'select count(*)::int as c from pg_locks where not granted',
      ) as unknown as { c: number }[];
      check('the reconciliation race leaves no PostgreSQL backend waiting', blocked[0]!.c === 0);
    } finally {
      await drop(lane);
    }
  }

  // ── Case 5b — ordinary purchase Phase 3 races reconciliation Phase 3 ──────
  console.log('\ncase 5b — purchase persistence races recovery persistence');
  {
    const lane = await fresh();
    try {
      const ready = await readyForLabel(lane, 'purchase-reconcile-race');
      const providerGate = barrier(2);
      const persistGate = barrier(2);
      const purchaseConn = barrierOnTransaction(lane.db, 2, persistGate);
      const recoveryConn = barrierOnTransaction(lane.db, 2, persistGate);
      const purchaseEntered = deferred();
      let providerPurchaseCalls = 0;
      let providerLookupCalls = 0;
      let providerIdempotencyKey = '';
      const purchaseProvider = {
        purchase: async ({ idempotencyKey }: { idempotencyKey: string }) => {
          providerPurchaseCalls += 1;
          providerIdempotencyKey = idempotencyKey;
          purchaseEntered.resolve();
          await providerGate.wait();
          return { ...FULL_PROVIDER_RECEIPT };
        },
      };

      const purchase = purchaseReplacementLabel({
        replacementId: ready.replacementId,
        actor,
        purchaseInputs: PURCHASE_INPUTS,
      }, purchaseProvider, purchaseConn.conn as Parameters<typeof purchaseReplacementLabel>[2]);

      // Phase 1 has committed and Phase 2 is held outside a transaction. Recovery can now read
      // the exact same provider_pending intent before both callers enter their persist phase.
      await purchaseEntered.promise;
      const [intent] = await lane.db.select()
        .from(schema.replacementLabelPurchaseIntents)
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, ready.replacementId));
      assert.ok(intent, 'ordinary purchase must commit the intent before provider dispatch');
      assert.equal(intent.state, 'provider_pending');

      const recoveryProvider = {
        voidLabel: async () => { throw new Error('void is unreachable in purchase recovery'); },
        lookupPurchase: async ({ idempotencyKey }: { idempotencyKey: string }) => {
          providerLookupCalls += 1;
          assert.equal(idempotencyKey, providerIdempotencyKey);
          await providerGate.wait();
          return { ...FULL_PROVIDER_RECEIPT };
        },
      };
      const recovery = reconcileReplacementPurchaseIntent({
        replacementId: ready.replacementId,
        intentId: intent.id,
        actor,
        reason: 'recover while ordinary purchase is persisting',
      }, recoveryProvider, recoveryConn.conn as Parameters<typeof reconcileReplacementPurchaseIntent>[2]);

      providerGate.release();
      persistGate.release();
      const [purchaseResult, recoveryResult] = await withoutDeadlock(
        'purchase/reconciliation Phase 3 race',
        Promise.all([purchase, recovery]),
      );

      check('purchase and reconciliation both reach genuinely overlapping Phase 3 transactions',
        purchaseConn.calls() === 2 && recoveryConn.calls() === 2,
        `txCalls=${purchaseConn.calls()},${recoveryConn.calls()}`);
      check('purchase and reconciliation resolve to the same intent, shipment and full receipt',
        purchaseResult.intentId === recoveryResult.intentId
          && purchaseResult.intentId === intent.id
          && purchaseResult.shipmentId === recoveryResult.shipmentId
          && purchaseResult.shipmentId === ready.shipmentId
          && recoveryResult.outcome === 'purchased'
          && recoveryResult.recorded === 'label_created'
          && isDeepStrictEqual(purchaseResult.receipt, FULL_PROVIDER_RECEIPT)
          && isDeepStrictEqual(recoveryResult.receipt, FULL_PROVIDER_RECEIPT),
        JSON.stringify({ purchaseResult, recoveryResult }));
      check('the purchase/reconciliation race performs exactly one purchase and one lookup',
        providerPurchaseCalls === 1 && providerLookupCalls === 1,
        `purchases=${providerPurchaseCalls} lookups=${providerLookupCalls}`);

      const intents = await lane.db.select().from(schema.replacementLabelPurchaseIntents)
        .where(eq(schema.replacementLabelPurchaseIntents.replacementId, ready.replacementId));
      const shipments = await lane.db.select().from(schema.shipments);
      const events = await lane.db.select().from(schema.replacementActivityEvents)
        .where(eq(schema.replacementActivityEvents.replacementId, ready.replacementId));
      const labelFacts = events.filter((event) => event.eventType === 'replacement_label_created');
      const reconciliationFacts = events.filter(
        (event) => event.eventType === 'replacement_purchase_reconciled_found',
      );
      check('the mixed race persists one purchased intent and one complete shipment receipt',
        intents.length === 1
          && intents[0]!.state === 'purchased'
          && intents[0]!.providerTransactionId === FULL_PROVIDER_RECEIPT.providerTransactionId
          && shipments.length === 1
          && shipments[0]!.id === ready.shipmentId
          && shipments[0]!.labelTracking === FULL_PROVIDER_RECEIPT.trackingNumber
          && Number(shipments[0]!.cost) === FULL_PROVIDER_RECEIPT.shipmentCost
          && Number(shipments[0]!.otherCost) === FULL_PROVIDER_RECEIPT.otherCost,
        `intents=${intents.length} shipments=${shipments.length}`);
      check('the mixed race appends one label-created fact and at most one recovery annotation',
        labelFacts.length === 1 && reconciliationFacts.length <= 1,
        `label=${labelFacts.length} recovery=${reconciliationFacts.length}`);
      const eventKeys = events.map((event) => event.idempotencyKey).filter(Boolean);
      check('the mixed race leaves no duplicate activity facts',
        new Set(eventKeys).size === eventKeys.length,
        eventKeys.join(','));
      const blocked = await lane.raw.unsafe(
        'select count(*)::int as c from pg_locks where not granted',
      ) as unknown as { c: number }[];
      check('the mixed label race leaves no PostgreSQL backend waiting', blocked[0]!.c === 0);
    } finally {
      await drop(lane);
    }
  }

  // ── Case 6 — no deadlock or lock-order inversion ───────────────────────────
  console.log('\ncase 6 — lock discipline');
  {
    const lane = await fresh();
    try {
      const conn = lane.db as unknown as Parameters<typeof createReplacement>[1];
      // Creates and attaches interleaved on one order. Both commands take the SAME
      // order-scoped lock first and hold no other lock across it, so there is no ordering to
      // invert; this proves that empirically rather than by inspection.
      const gate = barrier(6);
      const work = [0, 1, 2, 3, 4, 5].map(async (i) => {
        await gate.wait();
        const made = await createReplacement({
          orderId: 1321, reason: 'other', liabilityOwner: 'operator',
          items: [{ orderLineIndex: 1, quantity: 1 }],
          requestIdempotencyKey: `mix-${i}`, actor,
        }, conn);
        await lane.db.update(schema.replacements).set({ status: 'approved' })
          .where(eq(schema.replacements.id, made.replacement.id));
        return insertReplacementShipment({
          replacementId: made.replacement.id,
          actor: { email: actor.email, type: actor.type },
        }, conn);
      });
      gate.release();

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out — probable deadlock')), 30_000).unref());
      const results = await Promise.race([Promise.allSettled(work), timeout]) as PromiseSettledResult<unknown>[];

      const failed = results.filter((r) => r.status === 'rejected');
      check('six interleaved create+attach flows complete with no deadlock',
        failed.length === 0,
        failed.map((r) => String((r as PromiseRejectedResult).reason?.message)).join(' | '));

      const shipments = await lane.db.select().from(schema.shipments);
      check('each replacement got exactly one shipment', shipments.length === 6,
        `got ${shipments.length}`);

      const refs = (await lane.db.select({ reference: schema.replacements.reference })
        .from(schema.replacements)).map((r) => r.reference);
      check('every allocated reference is unique', new Set(refs).size === refs.length,
        refs.join(','));

      const blocked = await lane.raw.unsafe(
        "select count(*)::int as c from pg_locks where not granted",
      ) as unknown as { c: number }[];
      check('no lock is left waiting after the run', blocked[0]!.c === 0);
    } finally {
      await drop(lane);
    }
  }

  console.log(
    `\nPS-502 PG17 concurrency: ${passed} checks against genuine multi-backend PostgreSQL.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
