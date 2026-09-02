#!/usr/bin/env tsx
/**
 * Latency evidence for the canonical invoice-totals path, against real PostgreSQL 17.
 *
 * Review's re-audit scored performance 0/3: the grouped totals query and the Billing list's new
 * upstream hop were never measured. This measures the parts that can be measured honestly from
 * a workstation — SERVER-SIDE time, on a real schema, at a volume comparable to a real busy
 * month (HUGRAB Aug 2026: 581 orders). It does NOT measure the Render→Render network hop; that
 * is stated in the output rather than guessed.
 *
 * Four timings, min / median over REPS runs each:
 *   grouped   billingInvoiceHeaderTotalsByClient + loadDuplicateOrderDecisionsForClients for
 *             ALL clients — two queries, the path the Billing list uses now
 *   per-client N × (loadDuplicateOrderDecisions + billingInvoiceHeaderTotals) — the path the
 *             list would have needed without the grouped owner
 *   route     GET /billing/invoice-totals for all clients through the real router — the
 *             server side of the list's added hop
 *   invoice   GET /billing/invoice for one client — scale reference for a single document
 *
 * Same boot as ps-520-invoice-routes-pg17: throwaway DB, real migration chain, real router.
 * Refuses non-ephemeral hosts. Creates and drops its own database.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { Hono } from 'hono';
import { applyMigrations, type ToleranceRule } from './lib/migration-execution-pg.js';
// @ts-expect-error -- .mjs helper, no types
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'ps520_latency';
const ADMIN_URL = process.env.PS520_PG17_ADMIN_URL ?? process.env.PS502_PG17_ADMIN_URL ?? process.env.PS488_PG17_ADMIN_URL;
if (!ADMIN_URL) { console.error('FAIL: set PS520_PG17_ADMIN_URL to a DISPOSABLE PostgreSQL 17'); process.exit(1); }
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) { console.error(`FAIL: refusing non-ephemeral host "${host}"`); process.exit(1); }
}

const TOLERATED: ToleranceRule[] = [
  { file: '0037_rls_reporting_metrics_inbound.sql', sqlstate: '42P01', reason: 'RLS over a table this repo does not own' },
  { file: '0045_revoke_public_api_grants.sql', sqlstate: '42704', reason: 'Supabase anon role absent on a vanilla server' },
  { file: '0069_public_billing_rls_hardening.sql', sqlstate: '42704', reason: 'same Supabase-only role' },
  { file: '0094_pin_function_search_path.sql', sqlstate: '3F000', reason: 'pgboss schema is created by the library at runtime' },
  { file: '0058_search_trgm_indexes.sql', sqlstate: '58P01', reason: 'pg_trgm contrib may be absent' },
];

const CLIENTS = Number(process.env.LATENCY_CLIENTS ?? 8);
const ORDERS_PER_CLIENT = Number(process.env.LATENCY_ORDERS ?? 600);
const REPS = Number(process.env.LATENCY_REPS ?? 5);
const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-09-01T00:00:00.000Z';

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const ms = (x: number) => `${x.toFixed(1)}ms`;
async function time(label: string, fn: () => Promise<unknown>): Promise<number[]> {
  const runs: number[] = [];
  await fn(); // warm (plan cache, pool)
  for (let i = 0; i < REPS; i += 1) { const t = performance.now(); await fn(); runs.push(performance.now() - t); }
  console.log(`  ${label.padEnd(58)} min ${ms(Math.min(...runs)).padStart(9)}   median ${ms(median(runs)).padStart(9)}`);
  return runs;
}

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${DB_NAME}`);
    await admin.unsafe(`create database ${DB_NAME} encoding 'UTF8' template template0`);
  } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(ADMIN_URL!); url.pathname = `/${DB_NAME}`; const dbUrl = url.toString();
  process.env.DATABASE_URL = dbUrl; process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL ||= 'https://example.test'; process.env.SUPABASE_ANON_KEY ||= 'offline';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'offline'; process.env.SUPABASE_JWT_SECRET ||= 'offline';

  const migrator = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
  const sql = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  try {
    await bootstrapForeignOwnedTables({ exec: (s: string) => migrator.unsafe(s) }, () => {});
    await applyMigrations({ sql: migrator, dir: path.join(REPO_ROOT, 'drizzle'), tolerate: TOLERATED, report: false });

    // ── seed: CLIENTS × ORDERS_PER_CLIENT orders, 4 lines each, in August; plus per client
    //    12 duplicate order numbers (PS-491 case B) and 8 cancelled orders, like HUGRAB had.
    const clientIds: number[] = [];
    for (let c = 0; c < CLIENTS; c += 1) {
      const [row] = await sql`insert into clients (name, active, is_test) values (${`Latency Client ${c}`}, true, false) returning id`;
      clientIds.push(Number(row!.id));
    }
    let lineCount = 0;
    for (const clientId of clientIds) {
      const orders: Array<{ order_number: string; order_status: string; client_id: number; ship_to_name: string }> = [];
      for (let o = 0; o < ORDERS_PER_CLIENT; o += 1) {
        orders.push({ order_number: `L${clientId}-${o}`, order_status: o < 8 ? 'cancelled' : 'shipped', client_id: clientId, ship_to_name: 'Latency' });
      }
      for (let d = 0; d < 12; d += 1) orders.push({ order_number: `L${clientId}-${100 + d}`, order_status: 'shipped', client_id: clientId, ship_to_name: 'Latency dup' });
      const inserted = await sql`insert into orders ${sql(orders, 'order_number', 'order_status', 'client_id', 'ship_to_name')} returning id, order_number`;
      const lines: Array<Record<string, unknown>> = [];
      for (const [i, o] of inserted.entries()) {
        const day = 1 + (i % 28);
        const shipAt = `2026-08-${String(day).padStart(2, '0')}T12:00:00Z`;
        const isDup = String(o.order_number).includes('-1') && Number(String(o.order_number).split('-')[1]) >= 100 && Number(String(o.order_number).split('-')[1]) < 112;
        const types: Array<[string, number]> = isDup
          ? [['pick_pack', 2.5], ['additional_unit', 1.0]]                      // no shipping: PS-491 case B
          : [['pick_pack', 2.5], ['additional_unit', 1.0], ['package_cost', 0.99], ['shipping', 6.77]];
        for (const [lineType, amt] of types) {
          lines.push({ client_id: clientId, order_id: Number(o.id), order_number: o.order_number, ship_date: shipAt, line_type: lineType, description: lineType, qty: 1, unit_cost: amt, total_cost: amt });
        }
      }
      for (let i = 0; i < lines.length; i += 2000) {
        const chunk = lines.slice(i, i + 2000);
        await sql`insert into billing_line_items ${sql(chunk, 'client_id', 'order_id', 'order_number', 'ship_date', 'line_type', 'description', 'qty', 'unit_cost', 'total_cost')}`;
      }
      lineCount += lines.length;
    }
    await sql`analyze billing_line_items`; await sql`analyze orders`;
    console.log(`seeded ${CLIENTS} clients × ${ORDERS_PER_CLIENT + 12} orders, ${lineCount} billing lines (Aug 2026), PostgreSQL ${(await sql`show server_version`)[0]!.server_version}`);
    console.log(`REPS=${REPS}; times are SERVER-SIDE on this workstation — the Render→Render network hop is NOT measured here.\n`);

    // Dynamic imports AFTER env binding.
    const totals = await import('../src/services/billing-invoice-totals.js');
    const loader = await import('../src/services/billing-duplicate-order-loader.js');
    const billingRoute = (await import('../src/routes/billing.js')).default as unknown as Hono;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('email' as never, 'latency@example.test' as never); c.set('role' as never, 'admin' as never);
      c.set('permissions' as never, ['financials:read'] as never); c.set('clientIds' as never, [] as never); c.set('storeIds' as never, [] as never);
      await next();
    });
    app.route('/billing', billingRoute);

    const grouped = await time(`grouped owner: ${CLIENTS} clients, 2 queries`, async () => {
      const d = await loader.loadDuplicateOrderDecisionsForClients(clientIds, FROM, TO);
      return totals.billingInvoiceHeaderTotalsByClient(clientIds, FROM, TO, undefined, d);
    });
    const perClient = await time(`per-client path: ${CLIENTS} × (decisions + totals) = ${CLIENTS * 2} queries`, async () => {
      for (const id of clientIds) {
        const d = await loader.loadDuplicateOrderDecisions(id, FROM, TO);
        await totals.billingInvoiceHeaderTotals(id, FROM, TO, undefined, d);
      }
    });
    const route = await time(`GET /billing/invoice-totals (all ${CLIENTS} clients, real router)`, async () => {
      const r = await app.request(`/billing/invoice-totals?clientIds=${clientIds.join(',')}&dateFrom=2026-08-01&dateTo=2026-08-31`);
      if (r.status !== 200) throw new Error(`route returned ${r.status}`);
      return r.json();
    });
    const invoice = await time(`GET /billing/invoice (one client, ${ORDERS_PER_CLIENT + 12} orders) — reference`, async () => {
      const r = await app.request(`/billing/invoice?clientId=${clientIds[0]}&dateFrom=2026-08-01&dateTo=2026-08-31`);
      if (r.status !== 200) throw new Error(`invoice returned ${r.status}`);
      return r.text();
    });
    console.log(`\ngrouped is ${(median(perClient) / median(grouped)).toFixed(1)}× faster than per-client at ${CLIENTS} clients; `
      + `the route adds ${ms(median(route) - median(grouped))} of server-side overhead over the raw owner calls; `
      + `one full invoice render is ${ms(median(invoice))}.`);
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => {}); await sql.end({ timeout: 5 }).catch(() => {});
    const cleanup = postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try { await cleanup.unsafe(`drop database if exists ${DB_NAME}`); } catch { /* best effort */ }
    await cleanup.end({ timeout: 5 }).catch(() => {});
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
