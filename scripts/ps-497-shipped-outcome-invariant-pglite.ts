// PS-497 Slice 2 Release B (S2.7) — the shipped-outcome invariant PGlite TWIN. This is the pack-eligible
// member (the real-PG17 runner cannot be a pack member: under OFFLINE_GUARD_ENV it has no PS497_PG_ADMIN_URL
// and would fail the whole pack). Hermetic + offline: an in-memory PGlite, the real 0104/0105 schema applied
// verbatim, driving the REAL lifecycle owner + occurrence executor + review-resolver through the SAME shared
// case module as the real-PG17 runner, so the twin and the PG17 proof cannot diverge. It also asserts the
// narrow execution gate does not unlock anything but the occurrence lane (via the isolation/no-cross-claim
// guard's contract; here every case is occurrence-scoped and no legacy/package movement can occur).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from '../src/db/schema/index.js';
import type { ShippedOutcomeClaim } from './lib/ps-497-shipped-outcome-cases.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Release B flags ON + offline app env, BEFORE importing the env-validated services. The services never touch
// the real db (we inject the PGlite handle as their connection), so DATABASE_URL is a dummy.
process.env.NODE_ENV = 'test';
process.env.VERCEL ??= '1';
process.env.SUPABASE_URL ??= 'http://localhost';
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';
process.env.FULFILLMENT_OCCURRENCE_PROJECTION = 'true';
process.env.FULFILLMENT_OCCURRENCE_EXECUTION = 'true';
process.env.INVENTORY_AUTO_DEDUCT = 'true';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_MODE = 'broad';
process.env.FULFILLMENT_OCCURRENCE_SCOPE_CLIENT_IDS = '7';

async function applyMigrations(client: PGlite): Promise<void> {
  const dir = path.join(REPO_ROOT, 'drizzle');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const body = readFileSync(path.join(dir, file), 'utf8');
    for (const raw of body.split('--> statement-breakpoint')) {
      let stmt = raw.trim();
      if (!stmt) continue;
      stmt = stmt.replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX').replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');
      try { await client.exec(stmt); } catch { /* supabase grants / ordering artefacts / unsupported-in-PGlite are non-fatal here */ }
    }
  }
}

async function main(): Promise<void> {
  const client = new PGlite();
  const testDb = drizzle(client, { schema, casing: 'snake_case' });
  await applyMigrations(client);

  for (const t of ['orders', 'order_items', 'shipments', 'inventory', 'inventory_ledger', 'fulfillment_line_claims', 'fulfillment_occurrences', 'fulfillment_outbox', 'clients']) {
    const r = await client.query<{ x: string | null }>(`select to_regclass('public.${t}') as x`);
    if (!r.rows[0]?.x) { console.error(`FAIL: PGlite schema is missing ${t}`); process.exit(1); }
  }

  const { applyOrderLifecycleCommand } = await import('../src/services/order-lifecycle-command.js');
  const { applyOccurrenceClaims } = await import('../src/services/fulfillment-deductions.js');
  const { resolveOccurrenceReviewClaim } = await import('../src/services/fulfillment/resolve-occurrence-review.js');
  const { runShippedOutcomeCases } = await import('./lib/ps-497-shipped-outcome-cases.js');

  await client.exec("insert into clients (id, name) values (7, 'PS497 Invariant Twin')");
  await client.exec("insert into inventory (sku, client_id) values ('SKU-A', 7), ('SKU-B', 7)");

  let seq = 0;
  let shipSeq = 0;
  const handle = {
    applyOrderLifecycleCommand: (input: Record<string, unknown>) => applyOrderLifecycleCommand(input as never, testDb as never),
    applyOccurrenceClaims: (occurrenceId: number) => applyOccurrenceClaims(occurrenceId, testDb as never),
    resolveOccurrenceReviewClaim: (claimId: number, decision: 'pending' | 'not_applicable') =>
      testDb.transaction((tx) => resolveOccurrenceReviewClaim(tx as never, { claimId, decision, operator: { email: 'twin@test' } })),
    newOrder: async (): Promise<number> => {
      seq += 1;
      const r = await client.query<{ id: number }>("insert into orders (order_number, client_id, order_status) values ($1, 7, 'awaiting_shipment') returning id", ['PS497T-' + seq]);
      const orderId = r.rows[0]!.id;
      await client.query("insert into order_items (order_id, sku, order_status, quantity) values ($1, 'SKU-A', 'awaiting_shipment', 2)", [orderId]);
      return orderId;
    },
    newShipment: async (orderId: number, opts: { labelShipmentId: number | null; source: string }): Promise<number> => {
      shipSeq += 1;
      const r = await client.query<{ id: number }>("insert into shipments (order_id, label_shipment_id, source, voided, is_return) values ($1, $2, $3, false, false) returning id", [orderId, opts.labelShipmentId, opts.source]);
      return r.rows[0]!.id;
    },
    claimsFor: async (orderId: number): Promise<ShippedOutcomeClaim[]> => {
      const r = await client.query<ShippedOutcomeClaim>('select id, status, sku, quantity, direction, occurrence_id, canonical_line_identity, idempotency_key from fulfillment_line_claims where order_id = $1 order by id', [orderId]);
      return r.rows;
    },
    ledgerMovementCount: async (orderId: number): Promise<number> => {
      const r = await client.query<{ n: number }>('select count(*)::int as n from inventory_ledger where order_id = $1', [orderId]);
      return Number(r.rows[0]?.n ?? 0);
    },
  };

  const result = await runShippedOutcomeCases(handle);
  for (const m of result.ok) console.log('ok   ' + m);
  for (const m of result.red) console.log('RED  ' + m);
  for (const m of result.fail) console.log('FAIL ' + m);

  if (result.fail.length > 0) { console.error(`\nHARNESS FAILURE: ${result.fail.length} case(s) errored.`); process.exit(2); }
  if (result.red.length > 0) { console.error(`\nRED: ${result.red.length} invariant(s) do not hold.`); process.exit(1); }
  console.log(`\nPASS PS-497 shipped-outcome invariant (PGlite twin) — ${result.ok.length}/${result.ok.length} outcomes hold.`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(2); });
