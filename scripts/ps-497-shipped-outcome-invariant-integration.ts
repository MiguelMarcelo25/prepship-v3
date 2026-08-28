/**
 * PS-497 — the shipped-outcome invariant, against a migrated disposable PostgreSQL database.
 *
 * PS-497 Slice 2 Release B: this now runs GREEN. It was RED-by-design on stable; the forward fix (the owner
 * cutover + occurrence executor + resolver) makes every shipped transition reach exactly one terminally
 * accountable outcome. It drives the REAL lifecycle owner + occurrence executor + review-resolver (no
 * source-regex) via the shared case module, so the real-PG17 runner and the PGlite twin cannot diverge.
 *
 * THE INVARIANT: every shipped transition reaches exactly one terminally accountable outcome —
 *   1. PrepShip shipment-backed + exact evidence -> one deductible claim, one ledger movement;
 *   2. external-supplied                          -> no movement, terminal not_applicable;
 *   3. unknown / missing line data                -> no movement, a DURABLE occurrence-scoped review a REAL
 *                                                    resolver consumes (never an orphaned unbounded row).
 *
 * Enrolled in the guard pack as its PGlite twin (this real-PG17 runner stays in CI, never in the pack —
 * OFFLINE_GUARD_ENV gives it no PS497_PG_ADMIN_URL). UNSKIPPABLE: absent PS497_PG_ADMIN_URL this FAILS.
 */
import path from 'node:path';
import postgres from 'postgres';
import { applyMigrations, requireCatalog, PS497_0104_CATALOG } from './lib/migration-execution-pg.js';
import { PG17_HOSTED_TOLERANCE } from './lib/pg17-hosted-tolerance.js';
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';
import type { ShippedOutcomeClaim } from './lib/ps-497-shipped-outcome-cases.js';

const ADMIN_URL = process.env.PS497_PG_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS497_PG_ADMIN_URL is not set. This proof is unskippable.');
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error('FAIL: refusing non-ephemeral host "' + host + '"');
    process.exit(1);
  }
}

const DB_NAME = 'ps497_invariant_' + process.pid;
const dbUrl = (() => {
  const u = new URL(ADMIN_URL as string);
  u.pathname = '/' + DB_NAME;
  return u.toString();
})();

// The services read env at import time and refuse an injected connection outside tests. Release B flags ON.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = dbUrl;
process.env.VERCEL ??= '1';
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.FULFILLMENT_OCCURRENCE_PROJECTION = 'true';
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'true';
process.env.INVENTORY_AUTO_DEDUCT = 'true';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_MODE = 'broad';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS = '7';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

async function migrate(sql: postgres.Sql): Promise<void> {
  // PS-510: the canonical owner plans and applies the chain. This caller no longer walks the
  // migration directory, no longer rewrites CONCURRENTLY, and no longer swallows errors.
  // CONCURRENTLY statements are executed outside a transaction as written.
  // 0088/0089/0092/0102 extend `returns`, a Client-Portal-owned table this repo does not
  // create. On a bare PG17 server it does not exist, so those migrations fail with 42P01.
  // Creating it here is what ps-494 and ps-508 already do. The alternative — tolerating the
  // failure — would SKIP four real migrations and leave the schema incomplete, which is the
  // defect PS-510 exists to remove.
  await bootstrapForeignOwnedTables({ exec: (text: string) => sql.unsafe(text) }, () => {});
  await applyMigrations({
    sql,
    dir: path.join(REPO_ROOT, 'drizzle'),
    tolerate: PG17_HOSTED_TOLERANCE,
  });
  // The schema gate runs BEFORE any behaviour assertion below. Asserting behaviour against a
  // schema-fidelity-compromised database is the defect PS-510 exists to remove.
  await requireCatalog(sql, PS497_0104_CATALOG);
}

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe('drop database if exists ' + DB_NAME);
  await admin.unsafe('create database ' + DB_NAME);
  await admin.end({ timeout: 5 });

  const raw = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  try {
    await migrate(raw);
    for (const t of ['orders', 'order_items', 'shipments', 'inventory', 'inventory_ledger', 'fulfillment_line_claims', 'fulfillment_occurrences', 'fulfillment_outbox', 'clients']) {
      const [r] = await raw.unsafe("select to_regclass('public." + t + "') as x");
      if (!(r as { x: string | null }).x) { console.error('FAIL: migrated database is missing ' + t); process.exit(1); }
    }

    const { db } = await import('../src/db/client.js');
    const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');
    const { applyOccurrenceClaims } = await import('../src/services/fulfillment-deductions.js');
    const { resolveOccurrenceReviewClaim } = await import('../src/services/fulfillment/resolve-occurrence-review.js');
    const { runShippedOutcomeCases } = await import('./lib/ps-497-shipped-outcome-cases.js');

    await raw.unsafe("insert into clients (id, name) values (7, 'PS497 Invariant')");
    await raw.unsafe("insert into inventory (sku, client_id) values ('SKU-A', 7), ('SKU-B', 7)");

    let seq = 0;
    let shipSeq = 0;
    const handle = {
      applyOrderLifecycleCommand: (input: Record<string, unknown>) => applyOrderLifecycleCommand(input as never),
      applyOccurrenceClaims: (occurrenceId: number) => db.transaction((tx) => applyOccurrenceClaims(occurrenceId, tx)),
      resolveOccurrenceReviewClaim: (claimId: number, decision: 'pending' | 'not_applicable') =>
        db.transaction((tx) => resolveOccurrenceReviewClaim(tx, { claimId, decision, operator: { email: 'invariant@test' } })),
      newOrder: async (): Promise<number> => {
        seq += 1;
        const [o] = await raw.unsafe("insert into orders (order_number, client_id, order_status) values ($1, 7, 'awaiting_shipment') returning id", ['PS497-' + process.pid + '-' + seq]);
        const orderId = (o as { id: number }).id;
        await raw.unsafe("insert into order_items (order_id, sku, order_status, quantity) values ($1, 'SKU-A', 'awaiting_shipment', 2)", [orderId]);
        return orderId;
      },
      newShipment: async (orderId: number, opts: { labelShipmentId: number | null; source: string }): Promise<number> => {
        shipSeq += 1;
        const [s] = await raw.unsafe("insert into shipments (order_id, label_shipment_id, source, voided, is_return) values ($1, $2, $3, false, false) returning id", [orderId, opts.labelShipmentId, opts.source]);
        return (s as { id: number }).id;
      },
      claimsFor: async (orderId: number): Promise<ShippedOutcomeClaim[]> =>
        (await raw.unsafe('select id, status, sku, quantity, direction, occurrence_id, canonical_line_identity, idempotency_key from fulfillment_line_claims where order_id = $1 order by id', [orderId])) as unknown as ShippedOutcomeClaim[],
      ledgerMovementCount: async (orderId: number): Promise<number> => {
        const [r] = await raw.unsafe('select count(*)::int as n from inventory_ledger where order_id = $1', [orderId]);
        return (r as { n: number }).n;
      },
    };

    const result = await runShippedOutcomeCases(handle);
    for (const m of result.ok) console.log('ok   ' + m);
    for (const m of result.red) console.log('RED  ' + m);
    for (const m of result.fail) console.log('FAIL ' + m);

    if (result.fail.length > 0) { console.error(`\nHARNESS FAILURE: ${result.fail.length} case(s) errored.`); process.exit(2); }
    if (result.red.length > 0) {
      console.error(`\nRED: ${result.red.length} invariant(s) do not hold — the shipped-outcome contract is broken.`);
      process.exit(1);
    }
    console.log(`\nPASS PS-497 shipped-outcome invariant — ${result.ok.length}/${result.ok.length} outcomes hold (Release B).`);
  } finally {
    await raw.end({ timeout: 5 });
  }
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(2); });
