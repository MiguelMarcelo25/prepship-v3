/**
 * PS-508 — blocker B, closed PROPERLY: the REAL Billing generator emits the frozen line.
 *
 * The Hermes re-audit (2026-08-24, corrections 1-2) refuted the previous blocker-B closure:
 * the behavioural guard tested the pure decision helper, never billing.ts. This test executes
 * the actual generation owner — generateLineItems — against a database built from the real
 * migrations, and reads the billing_line_items rows it persists. No helper short-circuits:
 * source row -> generator -> emitted line.
 *
 * Four scenarios in one process, using TWO clients so the per-client gate is exercised both
 * ways without re-parsing env (the allowlist is read once at import):
 *   S1 gated client,   valid ps-508-v1 tuple, post-boundary -> ONE 'shipping' line carrying the
 *      FROZEN amount and FROZEN suffix (an amount the legacy calculation cannot produce).
 *   S2 gated client,   receipt-only,          post-boundary -> ONE 'shipping_missing' $0 hold
 *      naming post_cutover_shipment_missing_frozen_tuple.
 *   S3 gated client,   receipt-only,          PRE-boundary  -> the EXACT legacy line.
 *   S4 UNGATED client, the SAME valid tuple                 -> the EXACT legacy line — the
 *      gate-off differential.
 *
 * Correction B (82% re-audit): S3/S4 pin the exact legacy amount and description, not merely
 * "not the frozen amount". Correction C: migration failures are allowlisted, not swallowed.
 *
 * UNSKIPPABLE: absent PS508_PG17_ADMIN_URL this FAILS rather than skipping.
 */
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
// The QA stack owns the DDL for tables production created outside drizzle (returns etc.),
// deliberately in their PRE-0088 shape so the real migrations apply on top of them.
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';

const ADMIN_URL = process.env.PS508_PG17_ADMIN_URL;
if (!ADMIN_URL) {
  console.error('FAIL: PS508_PG17_ADMIN_URL is not set. This proof is unskippable.');
  process.exit(1);
}
{
  const host = new URL(ADMIN_URL).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', 'postgres'].includes(host)) {
    console.error('FAIL: refusing non-ephemeral host "' + host + '"');
    process.exit(1);
  }
}

const DB_NAME = 'ps508_billing_' + process.pid;
const dbUrl = (() => {
  const u = new URL(ADMIN_URL as string);
  u.pathname = '/' + DB_NAME;
  return u.toString();
})();

const GATED_CLIENT = 9001;
const UNGATED_CLIENT = 9002;
const FROZEN_AMOUNT = 99.99; // deliberately unreachable by the legacy calculation on these rows
const FROZEN_SUFFIX = ' (FROZEN-PS508)';
const BOUNDARY = '2026-06-01T00:00:00Z';
// Correction B: the EXACT legacy expectation. These clients have no billing_config row, so the
// generator's defaults apply: 0% + $0.00 markup on labelCost 10 -> 10.00, markupApplied=false
// -> the suffix is the empty string (billing-shipping-line.ts:114), so the description is
// exactly 'Shipping · order <n>'.
const LEGACY_AMOUNT = '10.00';
// withShipmentBillingLineage (shipment-aggregate.ts) appends the lineage marker to every
// persisted shipping description — part of the duplicate-suppression key.
const lineDescription = (suffix: string, o: { orderNumber: string; id: number }) =>
  'Shipping' + suffix + ' · order ' + o.orderNumber + ' · shipment #' + o.id;

// Everything below must be set BEFORE the first src/ import — env parses once.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = dbUrl;
process.env.PS508_BILLING_FROZEN_TUPLE_CLIENTS = String(GATED_CLIENT);
process.env.PS508_BILLING_FROZEN_TUPLE_CUTOVER_AT = BOUNDARY;

let failures = 0;
function ok(name: string): void { console.log('ok   ' + name); }
function fail(name: string, detail: string): void { failures += 1; console.log('FAIL ' + name + ' — ' + detail); }

// Correction C (Hermes 82% re-audit): a harness that swallows every migration error cannot
// claim "the actual migrations are applied". Only two failure classes are expected on a bare
// container — Supabase role grants (no anon/authenticated/service_role roles) and the 0037 RLS
// statement for inbound_shipments (created outside drizzle in production). Anything else FAILS.
const EXPECTED_MIGRATION_FAILURES = [
  /role "(anon|authenticated|service_role)" does not exist/,
  /inbound_shipments/,
  // pg-boss creates its own schema at runtime in production; 0094 pins function search paths
  // for it and legitimately has nothing to pin on a bare container.
  /schema "pgboss" does not exist/,
];

async function migrate(sql: postgres.Sql): Promise<void> {
  const dir = 'drizzle';
  const unexpected: string[] = [];
  // ONLY the numbered migrations. The directory also holds operator scripts
  // (apply-test-client-purge.sql etc.) that are not part of the schema lineage — the old
  // swallow-everything loop was silently attempting to EXECUTE those against the test
  // database, which is exactly the class of hidden signal correction C existed to surface.
  for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}.*\.sql$/.test(f)).sort()) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const raw of body.split('--> statement-breakpoint')) {
      let stmt = raw.trim();
      if (!stmt) continue;
      stmt = stmt
        .replace(/CREATE\s+INDEX\s+CONCURRENTLY/gi, 'CREATE INDEX')
        .replace(/DROP\s+INDEX\s+CONCURRENTLY/gi, 'DROP INDEX');
      try {
        await sql.unsafe(stmt);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!EXPECTED_MIGRATION_FAILURES.some((rx) => rx.test(msg))) {
          unexpected.push(file + ': ' + msg.slice(0, 140));
        }
      }
    }
  }
  if (unexpected.length > 0) {
    console.error('FAIL: ' + unexpected.length + ' UNEXPECTED migration failure(s):');
    for (const u of unexpected) console.error('  - ' + u);
    process.exit(1);
  }
}

const TUPLE = {
  selectedRateCost: 10,
  cShippingRateAmount: FROZEN_AMOUNT,
  shippingMarginAmount: 89.99,
  shippingMarginPct: 899.9,
  rateCostSource: 'label_final_cost',
  customerRateSource: 'realized_customer_shipping_rate',
  billingDescriptionSuffix: FROZEN_SUFFIX,
  customerShippingMoneyPolicyVersion: 'ps-508-v1',
};
const RECEIPT_ONLY = { carrierCode: 'ups', serviceCode: 'ups_ground', cost: 10, totalCost: 10, providerLabelId: 'lbl' };

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  const rows = await admin.unsafe("select current_setting('server_version_num') as v");
  const versionNum = Number((rows[0] as { v: string }).v);
  console.log('server_version_num = ' + versionNum);
  if (!Number.isFinite(versionNum) || versionNum < 170000) {
    console.error('FAIL: need PostgreSQL >= 17, got ' + versionNum);
    process.exit(1);
  }
  await admin.unsafe('drop database if exists ' + DB_NAME);
  await admin.unsafe('create database ' + DB_NAME);
  await admin.end({ timeout: 5 });

  const raw = postgres(dbUrl, { max: 4, prepare: false, onnotice: () => {} });
  try {
    await bootstrapForeignOwnedTables({ exec: (sql: string) => raw.unsafe(sql) }, () => {});
    await migrate(raw);
    for (const t of ['clients', 'orders', 'shipments', 'billing_line_items']) {
      const [r] = await raw.unsafe("select to_regclass('public." + t + "') as x");
      if (!(r as { x: string | null }).x) {
        console.error('FAIL: migrated database is missing ' + t);
        process.exit(1);
      }
    }

    // Production carries a handful of billing_config columns applied through the audited
    // runtime-DDL lane rather than a drizzle migration (see RUNTIME_DDL_MIGRATION_AUDIT.md).
    // The generator's config SQL references them unconditionally, so the parse fails without
    // them even though every value is coalesced. Mirror the lane here.
    await raw.unsafe(
      'alter table billing_config add column if not exists return_processing_fee numeric(10,2)',
    );

    // ---- seed --------------------------------------------------------------------------------
    await raw.unsafe(
      "insert into clients (id, name, active) values ($1, 'PS508 Gated', true), ($2, 'PS508 Ungated', true)",
      [GATED_CLIENT, UNGATED_CLIENT],
    );

    let seq = 0;
    async function seedShipment(
      clientId: number,
      shipDate: string,
      rateJson: unknown,
    ): Promise<{ id: number; orderNumber: string }> {
      seq += 1;
      const orderNumber = 'PS508-' + process.pid + '-' + seq;
      const [o] = await raw.unsafe(
        "insert into orders (order_number, client_id, order_status) values ($1, $2, 'shipped') returning id",
        [orderNumber, clientId],
      );
      const orderId = (o as { id: number }).id;
      const [s] = await raw.unsafe(
        'insert into shipments (order_id, client_id, ship_date, label_cost, cost, selected_rate_json) '
        + "values ($1, $2, $3, 10, 10, $4::jsonb) returning id",
        [orderId, clientId, shipDate, JSON.stringify(rateJson)],
      );
      return { id: (s as { id: number }).id, orderNumber };
    }

    const s1 = await seedShipment(GATED_CLIENT, '2026-07-10T12:00:00Z', TUPLE);
    const s2 = await seedShipment(GATED_CLIENT, '2026-07-11T12:00:00Z', RECEIPT_ONLY);
    const s3 = await seedShipment(GATED_CLIENT, '2026-05-15T12:00:00Z', RECEIPT_ONLY);
    const s4 = await seedShipment(UNGATED_CLIENT, '2026-07-12T12:00:00Z', TUPLE);

    // ---- run the REAL generator ---------------------------------------------------------------
    const { generateLineItems } = await import('../src/services/billing.js');
    await generateLineItems({
      clientIds: [GATED_CLIENT, UNGATED_CLIENT],
      dateFrom: '2026-05-01T00:00:00.000Z',
      dateTo: '2026-08-01T00:00:00.000Z',
      scopeIsGlobal: true,
    } as never);

    // ---- read back what Billing actually persisted --------------------------------------------
    const linesFor = async (shipment: { id: number }) =>
      (await raw.unsafe(
        "select line_type, description, unit_cost, total_cost from billing_line_items "
        + "where shipment_id = $1 and line_type in ('shipping','shipping_missing') order by id",
        [shipment.id],
      )) as unknown as Array<{ line_type: string; description: string; unit_cost: string; total_cost: string }>;

    // S1 — the core of blocker B: the generator itself emits the frozen amount and suffix,
    // pinned to the EXACT persisted description.
    {
      const lines = await linesFor(s1);
      if (lines.length === 1 && lines[0].line_type === 'shipping'
          && lines[0].unit_cost === '99.99' && lines[0].total_cost === '99.99'
          && lines[0].description === lineDescription(FROZEN_SUFFIX, s1)) {
        ok('S1 gated + valid tuple: the REAL generator emits ONE shipping line with the EXACT frozen amount and description');
      } else {
        fail('S1 gated + valid tuple: the REAL generator emits ONE shipping line with the EXACT frozen amount and description',
          JSON.stringify(lines));
      }
    }

    // S2 — post-boundary freeze failure is HELD by the generator, not repriced.
    {
      const lines = await linesFor(s2);
      if (lines.length === 1 && lines[0].line_type === 'shipping_missing'
          && lines[0].total_cost === '0.00'
          && lines[0].description.includes('post_cutover_shipment_missing_frozen_tuple')) {
        ok('S2 gated + post-boundary missing tuple: ONE shipping_missing $0 hold naming the reason');
      } else {
        fail('S2 gated + post-boundary missing tuple: ONE shipping_missing $0 hold naming the reason',
          JSON.stringify(lines));
      }
    }

    // S3 — pre-boundary rows keep the EXACT legacy line even for a gated client.
    {
      const lines = await linesFor(s3);
      if (lines.length === 1 && lines[0].line_type === 'shipping'
          && lines[0].unit_cost === LEGACY_AMOUNT && lines[0].total_cost === LEGACY_AMOUNT
          && lines[0].description === lineDescription('', s3)) {
        ok('S3 gated + PRE-boundary missing tuple: the EXACT legacy line (10.00, empty suffix)');
      } else {
        fail('S3 gated + PRE-boundary missing tuple: the EXACT legacy line (10.00, empty suffix)',
          JSON.stringify(lines));
      }
    }

    // S4 — the gate-off differential: same tuple, ungated client, EXACT legacy output.
    {
      const lines = await linesFor(s4);
      if (lines.length === 1 && lines[0].line_type === 'shipping'
          && lines[0].unit_cost === LEGACY_AMOUNT && lines[0].total_cost === LEGACY_AMOUNT
          && lines[0].description === lineDescription('', s4)) {
        ok('S4 UNGATED + the same tuple: the EXACT legacy line — the gate-off path ignores the tuple entirely');
      } else {
        fail('S4 UNGATED + the same tuple: the EXACT legacy line — the gate-off path ignores the tuple entirely',
          JSON.stringify(lines));
      }
    }

    console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILED');
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    await raw.end({ timeout: 5 }).catch(() => {});
    const cleanup = postgres(ADMIN_URL as string, { max: 1, prepare: false, onnotice: () => {} });
    await cleanup.unsafe(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname='" + DB_NAME + "' and pid <> pg_backend_pid()",
    ).catch(() => {});
    await cleanup.unsafe('drop database if exists ' + DB_NAME).catch(() => {});
    await cleanup.end({ timeout: 5 }).catch(() => {});
  }
}

void main();
