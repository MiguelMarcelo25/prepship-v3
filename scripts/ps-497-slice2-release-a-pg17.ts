/**
 * PS-497 Slice 2 (Release A) — the canonical occurrence resolver + the 0105 quantity-state replacement,
 * proven against REAL PostgreSQL 17. Composes on the real 0070 + 0090 + 0104 migrations.
 *
 * Resolver: 3-class key derivation, provider identity read ONLY from the locked shipment, concurrent
 * single-winner, provider-collapse (two shipments one provider label -> one occurrence), and key-stability
 * under provider enrichment (shipment-first lookup). 0105: the guarded runner (subprocess) upgrades the
 * quantity-state contract so 'not_applicable' and 'superseded' may carry a NULL quantity while nothing
 * executable can.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readVerifiedMigration, splitMigration } from './ps-497-fulfillment-occurrences-digest.js';
import { resolveFulfillmentOccurrence, deriveOccurrenceKey } from '../src/services/fulfillment/resolve-fulfillment-occurrence.js';

const ADMIN_URL = process.env.PS497_PG17_ADMIN_URL || process.env.PS487_PG17_ADMIN_URL || process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) { console.error('FAIL: PS497_PG17_ADMIN_URL not set. Unskippable.'); process.exit(1); }
const ADMIN: string = ADMIN_URL;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mig = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

async function setupSchema(db: postgres.Sql): Promise<void> {
  await db.unsafe(`
    create table orders (id integer primary key);
    create table shipments (id integer primary key);
    create table inventory (id integer primary key);
    insert into orders (id) values (1);
  `);
  await db.unsafe(mig('drizzle/0070_order_lifecycle_commands.sql'));
  await db.unsafe(mig('drizzle/0090_fulfillment_claim_nullable_quantity.sql'));
  const { transactional, concurrent } = splitMigration(readVerifiedMigration().text);
  await db.begin(async (tx) => { await tx.unsafe(transactional); });
  for (const stmt of concurrent) await db.unsafe(stmt);
}

function runRunner(dbUrl: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/apply-ps-497-claim-not-applicable-status.ts', ...args], {
      cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, shell: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

async function main(): Promise<void> {
  const hard = setTimeout(() => { console.error('HANG: exceeded 120s'); process.exit(3); }, 120_000);
  hard.unref();
  const admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => {} });
  const [ver] = await admin<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
  const v = Number(ver?.v ?? 0);
  if (v < 170000 || v >= 180000) { console.error(`FAIL: not PG17 (${v})`); await admin.end({ timeout: 5 }); process.exit(1); }
  const dbName = `ps497_relA_${v}_${process.pid}`;
  await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
  await admin.unsafe(`create database "${dbName}"`);
  const base = ADMIN.replace(/\/[^/]*$/, `/${dbName}`);
  const sql = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  await setupSchema(sql);

  let passed = 0;
  const ok = (m: string) => { passed += 1; console.log('ok   ' + m); };
  const ctxBase = { orderId: 1, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date('2026-08-25T00:00:00Z') };

  // 1) 3-class key derivation (pure).
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: 555, source: 'ShipStation' } }).key, 'ord:1|pship:shipstation:555');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: null, source: 's' } }).key, 'ord:1|ship:10');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, transition: 'external_shipped', external: true, lockedShipment: null }).key, 'ord:1|ext');
  assert.equal(deriveOccurrenceKey({ ...ctxBase, external: false, lockedShipment: null }).key, 'ord:1|whole');
  ok('key derivation: provider_shipment / local_shipment / |ext / |whole all correct; provider from the locked shipment source');

  // 2) provider_shipment resolve creates one occurrence with the derived key + kind.
  const r1 = await resolveFulfillmentOccurrence(sql, { ...ctxBase, external: false, lockedShipment: { id: 10, labelShipmentId: 555, source: 'shipstation' } });
  assert.equal(r1.created, true);
  assert.equal(r1.occurrenceKey, 'ord:1|pship:shipstation:555');
  assert.equal(r1.discriminatorKind, 'provider_shipment');
  ok('resolve: a shipment-backed writer creates a provider_shipment occurrence');

  // 3) shipment-less split -> two DISTINCT occurrences (|ext external, |whole unknown).
  const rExt = await resolveFulfillmentOccurrence(sql, { ...ctxBase, transition: 'external_shipped', external: true, lockedShipment: null });
  const rWhole = await resolveFulfillmentOccurrence(sql, { ...ctxBase, external: false, lockedShipment: null });
  assert.notEqual(rExt.occurrenceId, rWhole.occurrenceId);
  assert.equal(rExt.occurrenceKey, 'ord:1|ext');
  assert.equal(rWhole.occurrenceKey, 'ord:1|whole');
  ok('shipment-less split: external -> ord:1|ext and status-projection -> ord:1|whole are DISTINCT occurrences');

  // 4) concurrent single-winner on the same key.
  const cA = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const cB = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  const raceCtx = { orderId: 1, transition: 'external_shipped' as const, source: 'webhook', effectiveAt: new Date(), external: true, lockedShipment: null };
  // seed a fresh order to avoid colliding with rExt
  await sql`insert into orders (id) values (2)`;
  const [ra, rb] = await Promise.all([
    resolveFulfillmentOccurrence(cA, { ...raceCtx, orderId: 2 }),
    resolveFulfillmentOccurrence(cB, { ...raceCtx, orderId: 2 }),
  ]);
  assert.equal(ra.occurrenceId, rb.occurrenceId, 'both racers resolve the same occurrence id');
  const [nRow] = await sql<{ n: number }[]>`select count(*)::int as n from fulfillment_occurrences where occurrence_key = 'ord:2|ext'`;
  assert.equal(nRow?.n, 1, 'exactly one occurrence exists for the raced key');
  ok('concurrency: two writers racing one occurrence_key -> one canonical occurrence, both read the winner');

  // 5) provider-collapse: two DIFFERENT shipments sharing one provider label -> one occurrence.
  await sql`insert into orders (id) values (3)`;
  const cShip = { orderId: 3, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date(), external: false };
  const pc1 = await resolveFulfillmentOccurrence(sql, { ...cShip, lockedShipment: { id: 71, labelShipmentId: 999, source: 'shipstation' } });
  const pc2 = await resolveFulfillmentOccurrence(sql, { ...cShip, lockedShipment: { id: 72, labelShipmentId: 999, source: 'shipstation' } });
  assert.equal(pc1.occurrenceId, pc2.occurrenceId, 'two shipments with one provider label collapse to one occurrence');
  assert.equal(pc2.created, false);
  ok('provider-collapse: two local shipment rows sharing one labelShipmentId -> one provider_shipment occurrence');

  // 6) key stability under provider enrichment: local-key first, then enriched -> same occurrence.
  await sql`insert into orders (id) values (4)`;
  const cEnr = { orderId: 4, transition: 'shipped' as const, source: 'shipstation', effectiveAt: new Date(), external: false };
  const before = await resolveFulfillmentOccurrence(sql, { ...cEnr, lockedShipment: { id: 88, labelShipmentId: null, source: 'shipstation' } });
  assert.equal(before.discriminatorKind, 'local_shipment');
  const afterEnrich = await resolveFulfillmentOccurrence(sql, { ...cEnr, lockedShipment: { id: 88, labelShipmentId: 4242, source: 'shipstation' } });
  assert.equal(afterEnrich.occurrenceId, before.occurrenceId, 'enrichment resolves the ORIGINAL occurrence (shipment-first lookup)');
  assert.equal(afterEnrich.created, false);
  const [cRow] = await sql<{ c: number }[]>`select count(*)::int as c from fulfillment_occurrences where shipment_id = 88`;
  assert.equal(cRow?.c, 1, 'no second occurrence for the enriched shipment');
  ok('key stability: a local occurrence enriched with a provider id resolves the original — no second occurrence, no uniqueness error');

  await cA.end({ timeout: 5 }); await cB.end({ timeout: 5 });

  // 7) 0105 runner: dry-run then apply, then prove not_applicable/superseded may carry NULL quantity.
  await sql.unsafe(`
    insert into order_lifecycle_events (order_id, command_key, transition, source, effective_at)
      values (1, 'seed', 'shipped', 'test', now());
    insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'sku:0', 2, 'deduct', 'applied', 'seed:a'),
             (1, 1, 'sku:1', 1, 'deduct', 'review', 'seed:b');
  `);
  const dry = await runRunner(base, []);
  assert.equal(dry.code, 0, `0105 dry-run exits 0 (${dry.err})`);
  assert.ok(/DRY RUN/.test(dry.out) && /unknown_statuses=0 v2_violations=0/.test(dry.out), '0105 dry-run pre-audits cleanly');
  const applied = await runRunner(base, ['--apply', '--confirm=apply-ps-497-claim-not-applicable-status-0105']);
  assert.equal(applied.code, 0, `0105 apply exits 0 (${applied.err})`);
  assert.ok(/phase=0105/.test(applied.out) && /claims_unchanged=true/.test(applied.out), '0105 reaches phase 0105 with claims unchanged');
  const again = await runRunner(base, ['--apply', '--confirm=apply-ps-497-claim-not-applicable-status-0105']);
  assert.ok(/already_applied=true/.test(again.out), '0105 rerun is idempotent (already phase 0105)');
  ok('0105 runner: dry-run pre-audit clean, apply reaches phase 0105 (byte-identical), rerun idempotent');

  // not_applicable + NULL quantity is now legal; superseded + NULL is legal; pending + NULL is rejected.
  await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (1, 1, 'ext', null, 'deduct', 'not_applicable', 'na:1')`;
  await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
    values (1, 1, 'sup', null, 'deduct', 'superseded', 'sup:1')`;
  let rejected = false;
  try {
    await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'bad', null, 'deduct', 'pending', 'bad:1')`;
  } catch (e) { rejected = (e as { code?: string }).code === '23514'; if (!rejected) throw e; }
  assert.ok(rejected, 'a pending claim with NULL quantity is still rejected after 0105');
  const [h0090] = await sql<{ has0090: boolean }[]>`select exists(select 1 from pg_constraint where conname='fulfillment_line_claims_quantity_state_check') as "has0090"`;
  assert.equal(h0090?.has0090, false, '0090 quantity_state_check has been dropped (replaced)');
  const [hStatus] = await sql<{ hasOld: boolean }[]>`select exists(select 1 from pg_constraint where conname='fulfillment_line_claims_status_check') as "hasOld"`;
  assert.equal(hStatus?.hasOld, false, "0070's inline status_check (5-value) has been dropped");
  const [hDomain] = await sql<{ present: boolean; validated: boolean }[]>`
    select true as present, convalidated as validated from pg_constraint where conname='fulfillment_line_claims_status_domain_check'`;
  assert.ok(hDomain?.present && hDomain?.validated, 'the 6-value status_domain_check is present and validated');
  // A status outside the six-value domain is rejected by the new domain check (proves it is enforced).
  let domainRejected = false;
  try {
    await sql`insert into fulfillment_line_claims (lifecycle_event_id, order_id, line_key, quantity, direction, status, idempotency_key)
      values (1, 1, 'nope', 1, 'deduct', 'bogus_status', 'bogus:1')`;
  } catch (e) { domainRejected = (e as { code?: string }).code === '23514'; if (!domainRejected) throw e; }
  assert.ok(domainRejected, 'a status outside the six-value domain is rejected by status_domain_check');
  ok('post-0105: not_applicable(NULL)+superseded(NULL) allowed; pending(NULL) rejected; 0090 + 5-value status_check replaced by the 6-value domain');

  clearTimeout(hard);
  await sql.end({ timeout: 5 });
  await admin.unsafe(`drop database "${dbName}" with (force)`);
  await admin.end({ timeout: 5 });
  console.log(`\nPASS PS-497 Slice 2 Release A (PostgreSQL ${v}) — ${passed}/${passed} checks`);
}

main().catch((error) => { console.error(error); process.exit(1); });
