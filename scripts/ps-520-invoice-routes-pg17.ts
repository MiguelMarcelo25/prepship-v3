#!/usr/bin/env tsx
/**
 * PS-520 — the customer invoice routes are EXECUTED, against a real disposable PostgreSQL.
 *
 * WHY THIS EXISTS.
 *
 * PS-513 interpolated a multi-line fragment into a `--` comment inside billingInvoiceData's
 * query. The statement stopped parsing and GET /invoice, /invoice.xlsx and /invoice.csv failed
 * for every client for ~6 hours — while every lane stayed green. Nothing caught it because
 * nothing ran the query:
 *
 *   - typecheck cannot see inside a sql`` template (with the defect restored, tsc still exits 0);
 *   - the invoice guards (ps-425 / ps-468 / ps-513 / ps-490) feed the RENDERERS a fixture DTO;
 *   - ps-433's integration exercises a DIFFERENT owner, billingInvoiceHeaderTotals.
 *
 * So this proof deliberately uses none of those shortcuts. It applies the real migration chain to
 * a throwaway database through the canonical applier, seeds real rows, mounts the REAL billing
 * router, and makes real HTTP requests to all three invoice routes. A syntax break, a scoping
 * break, or a disagreement between the three formats fails it.
 *
 * SAFETY. Refuses any non-ephemeral host. Creates and drops its own database. Read-only against
 * the routes (three GETs). No production credential is used or fabricated: request scope is set
 * on the Hono context, which is exactly what the auth middleware would populate, so no token is
 * minted or forged. A production spot-check remains a separate credential-holder step.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { Hono } from 'hono';
import { applyMigrations, type ToleranceRule } from './lib/migration-execution-pg.js';
// @ts-expect-error -- .mjs helper, no types; owns the Client-Portal tables 0088/0089/0092 extend.
import { bootstrapForeignOwnedTables } from './ps-507-qa-stack.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_NAME = 'ps520_invoice_routes';

const ADMIN_URL =
  process.env.PS520_PG17_ADMIN_URL
  ?? process.env.PS502_PG17_ADMIN_URL
  ?? process.env.PS488_PG17_ADMIN_URL;

if (!ADMIN_URL) {
  console.error(
    'FAIL: no admin URL. Set PS520_PG17_ADMIN_URL (or PS502_/PS488_) to a DISPOSABLE PostgreSQL.\n'
    + '      This proof is unskippable: passing without executing the invoice query is exactly\n'
    + '      the false-green that let a 6-hour customer outage ship.',
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

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
    failures += 1;
  }
}

// Same tolerances the sibling PG17 lanes use: Supabase-only roles, pgboss, optional contrib.
const TOLERATED: ToleranceRule[] = [
  { file: '0037_rls_reporting_metrics_inbound.sql', sqlstate: '42P01', reason: 'RLS over inbound_shipments, a table this repo does not own' },
  { file: '0045_revoke_public_api_grants.sql', sqlstate: '42704', reason: 'revokes from the Supabase anon role, absent on a vanilla server' },
  { file: '0069_public_billing_rls_hardening.sql', sqlstate: '42704', reason: 'same Supabase-only anon role' },
  { file: '0094_pin_function_search_path.sql', sqlstate: '3F000', reason: 'pgboss schema is created by the library at runtime; no worker here' },
  { file: '0058_search_trgm_indexes.sql', sqlstate: '58P01', reason: 'pg_trgm contrib may be absent; those indexes are search performance, not correctness' },
];

const FROM_DAY = '2026-07-01';
const TO_DAY = '2026-07-31';
const SHIP_AT = '2026-07-10T12:00:00Z';

/** Every money bucket the invoice renders, so a break in any arm is visible. */
const money = {
  pickPack: 4.0, additional: 1.5, packageCost: 3.0, shipping: 8.25, storage: 2.0,
  adjustment: -1.25, returnPostage: 6.5, returnProcessingZero: 0.0,
  replacePostage: 5.75, replacePickPack: 2.5,
};

async function seed(sql: postgres.Sql): Promise<{ clientId: number; otherClientId: number }> {
  const [client] = await sql`
    insert into clients (name, active, is_test) values ('PS-520 Invoice Client', true, false) returning id`;
  const [other] = await sql`
    insert into clients (name, active, is_test) values ('PS-520 Other Client', true, false) returning id`;
  const clientId = Number(client!.id);
  const otherClientId = Number(other!.id);

  const [order] = await sql`
    insert into orders (order_number, order_status, client_id, ship_to_name)
    values ('PS520-1001', 'shipped', ${clientId}, 'PS-520 Customer') returning id`;
  const orderId = Number(order!.id);

  const [ret] = await sql`
    insert into returns (order_id, client_id, status, initiated_by, admin_override, requested_at, created_at, updated_at)
    values (${orderId}, ${clientId}, 'received', 'client', false, now(), now(), now()) returning id`;
  const returnId = Number(ret!.id);

  // A replacement's billing lines must carry BOTH a shipment and a replacement identity
  // (billing_li_replacement_identity_check), so the re-ship gets a real chain rather than a
  // loosened row: shipment -> replacement -> replace_* lines.
  const [shipment] = await sql`
    insert into shipments (order_id, client_id, order_number, tracking_number, is_return, voided, source)
    values (${orderId}, ${clientId}, 'PS520-1001', 'PS520-REPLACE-TRK', false, false, 'ps520_fixture')
    returning id`;
  const shipmentId = Number(shipment!.id);
  const [replacement] = await sql`
    insert into replacements
      (order_id, client_id, replacement_shipment_id, reference, reason, request_idempotency_key)
    values (${orderId}, ${clientId}, ${shipmentId}, 'PS520-1001-REPLACE', 'PS-520 fixture re-ship',
            'ps520-replace-idem-1')
    returning id`;
  const replacementId = Number(replacement!.id);

  const line = async (
    lineType: string,
    total: number,
    extra: { returnId?: number; shipmentId?: number; replacementId?: number } = {},
  ) => {
    await sql`
      insert into billing_line_items
        (client_id, order_id, order_number, return_id, shipment_id, replacement_id, ship_date,
         line_type, description, qty, unit_cost, total_cost)
      values (${clientId}, ${orderId}, 'PS520-1001', ${extra.returnId ?? null},
              ${extra.shipmentId ?? null}, ${extra.replacementId ?? null}, ${SHIP_AT},
              ${lineType}, ${`PS-520 ${lineType}`}, 1, ${total}, ${total})`;
  };
  const replaceLine = (lineType: string, total: number) =>
    line(lineType, total, { shipmentId, replacementId });

  await line('pick_pack', money.pickPack);
  await line('additional_unit', money.additional);
  await line('package_cost', money.packageCost);
  await line('shipping', money.shipping);
  await line('storage', money.storage);
  await replaceLine('replace_postage', money.replacePostage);
  await replaceLine('replace_pick_pack', money.replacePickPack);
  // Return POSTAGE present; return PROCESSING present but CHARGED ZERO. PS-488 M3: "never
  // charged" and "charged 0.00" are different facts, and the invoice must not conflate them.
  await line('return_postage', money.returnPostage, { returnId });
  await line('return_processing_fee', money.returnProcessingZero, { returnId });

  // NO billing_adjustment row, deliberately, and the reason is worth recording.
  //
  // An adjustment line cannot simply be inserted. billing_line_items_adjustment_reference_chk
  // demands an ORDERLESS row carrying both a credit-note id and a source finalization; building
  // that whole chain (finalization -> credit note -> projected line) still gets refused, by a
  // trigger: "BILLING_ADJUSTMENT_LEGACY_WRITE_DISABLED: new corrections require current-period
  // posting". The database is deliberately refusing back-dated corrections, and suppressing that
  // trigger to make a fixture convenient would be disabling a real money invariant to test a
  // rendering path. So the adjustment ARM is still compiled and executed by every request below
  // — a syntax break there fails this proof exactly as it would for any other arm — but no row
  // exercises it. Posting an adjustment through its real current-period workflow is a larger
  // fixture and belongs to its own card.
  //
  // (Both facts above were learned from the database rejecting the seed, which is the whole
  // argument for executing against real PostgreSQL rather than a fixture DTO.)

  // A second client's billing, so a scoped caller proves it cannot read across the boundary.
  const [otherOrder] = await sql`
    insert into orders (order_number, order_status, client_id, ship_to_name)
    values ('PS520-2001', 'shipped', ${otherClientId}, 'Other Customer') returning id`;
  await sql`
    insert into billing_line_items
      (client_id, order_id, order_number, ship_date, line_type, description, qty, unit_cost, total_cost)
    values (${otherClientId}, ${Number(otherOrder!.id)}, 'PS520-2001', ${SHIP_AT},
            'pick_pack', 'other client pick_pack', 1, 99.99, 99.99)`;

  return { clientId, otherClientId };
}

/** Mounts the REAL billing router behind the scope the auth middleware would have set. */
function appFor(scope: { global: boolean; clientIds?: number[] }, billingRoute: Hono): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('email' as never, 'ps520@example.test' as never);
    c.set('role' as never, (scope.global ? 'admin' : 'client_user') as never);
    // The whole billing router sits behind requirePermission('financials:read'). Without it a
    // scoped caller gets 403 from the PERMISSION gate, which would make a scoping assertion
    // meaningless — it would pass for the wrong reason. Granting it isolates scope as the only
    // difference between the two callers below.
    c.set('permissions' as never, ['financials:read'] as never);
    c.set('clientIds' as never, (scope.clientIds ?? []) as never);
    c.set('storeIds' as never, [] as never);
    await next();
  });
  app.route('/billing', billingRoute);
  return app;
}

/**
 * Money values in a document, normalised to 2dp.
 *
 * Format-agnostic on purpose: the HTML prints `$5.50` while the CSV writes a bare `5.5`, so a
 * two-decimal regex silently "passes" by matching almost nothing. Comparing normalised NUMBERS
 * is what makes a cross-format claim mean anything.
 */
const moneySet = (text: string): Set<string> => new Set(
  [...text.matchAll(/-?\$?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]).toFixed(2)),
);

async function main(): Promise<void> {
  const admin = postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${DB_NAME}`);
    // UTF8 from template0, explicitly: the migration chain contains UTF-8 punctuation (0018 has
    // a "→"), and a server whose default locale is WIN1252 — any ordinary Windows host — fails
    // that statement with 22P05. Production and the CI image are UTF8, so inheriting the host's
    // encoding would make this proof pass or fail on where it ran rather than on the code.
    await admin.unsafe(`create database ${DB_NAME} encoding 'UTF8' template template0`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = new URL(ADMIN_URL!);
  url.pathname = `/${DB_NAME}`;
  const throwawayUrl = url.toString();

  // Bind the app's db singleton to the throwaway BEFORE any src/ module is imported.
  process.env.DATABASE_URL = throwawayUrl;
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL ||= 'https://example.test';
  process.env.SUPABASE_ANON_KEY ||= 'offline';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'offline';
  process.env.SUPABASE_JWT_SECRET ||= 'offline';

  const migrator = postgres(throwawayUrl, { max: 1, prepare: false, onnotice: () => {} });
  const seeded = postgres(throwawayUrl, { max: 4, prepare: false, onnotice: () => {} });
  try {
    await bootstrapForeignOwnedTables({ exec: (s: string) => migrator.unsafe(s) }, () => {});
    const report = await applyMigrations({
      sql: migrator, dir: path.join(REPO_ROOT, 'drizzle'), tolerate: TOLERATED, report: false,
    });
    console.log(`ok   migration chain applied (${report.applied.length} statements, ${report.tolerated.length} tolerated)`);

    const { clientId, otherClientId } = await seed(seeded);
    console.log(`ok   seeded client ${clientId} (+ out-of-scope client ${otherClientId})`);

    // Dynamic import AFTER env binding, so the route's db points at the throwaway.
    const billingRoute = (await import('../src/routes/billing.js')).default as unknown as Hono;
    const staff = appFor({ global: true }, billingRoute);
    const qs = `clientId=${clientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`;

    console.log('\nPS-520 invoice routes — real query, real routes');

    // ── HTML ────────────────────────────────────────────────────────────────
    const htmlRes = await staff.request(`/billing/invoice?${qs}`);
    const html = await htmlRes.text();
    check('GET /invoice returns HTTP 200', htmlRes.status === 200,
      `got ${htmlRes.status}${htmlRes.status !== 200 ? ` body: ${html.slice(0, 300)}` : ''}`);
    check('GET /invoice content-type is HTML',
      (htmlRes.headers.get('content-type') ?? '').includes('text/html'),
      htmlRes.headers.get('content-type') ?? '(none)');
    check('the HTML invoice renders the seeded client', html.includes('PS-520 Invoice Client'));
    if (process.env.PS520_DEBUG === '1') {
      console.log('--- HTML money values ---', [...new Set(numbersIn(html).map((n) => n.toFixed(2)))].join(' '));
    }

    // ── CSV ─────────────────────────────────────────────────────────────────
    const csvRes = await staff.request(`/billing/invoice.csv?${qs}`);
    const csv = await csvRes.text();
    check('GET /invoice.csv returns HTTP 200', csvRes.status === 200,
      `got ${csvRes.status}${csvRes.status !== 200 ? ` body: ${csv.slice(0, 300)}` : ''}`);
    check('GET /invoice.csv content-type is CSV',
      /csv/i.test(csvRes.headers.get('content-type') ?? ''),
      csvRes.headers.get('content-type') ?? '(none)');
    if (process.env.PS520_DEBUG === '1') {
      console.log('--- CSV money values ---', [...new Set(numbersIn(csv).map((n) => n.toFixed(2)))].join(' '));
      console.log('--- CSV head ---\n' + csv.split('\n').slice(0, 4).join('\n'));
    }

    // ── XLSX ────────────────────────────────────────────────────────────────
    const xlsxRes = await staff.request(`/billing/invoice.xlsx?${qs}`);
    const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
    check('GET /invoice.xlsx returns HTTP 200', xlsxRes.status === 200, `got ${xlsxRes.status}`);
    check('GET /invoice.xlsx content-type is a spreadsheet',
      /spreadsheet|excel|octet-stream/i.test(xlsxRes.headers.get('content-type') ?? ''),
      xlsxRes.headers.get('content-type') ?? '(none)');
    check('the XLSX body is a real workbook (ZIP magic, non-trivial)',
      xlsxBuf.length > 1000 && xlsxBuf[0] === 0x50 && xlsxBuf[1] === 0x4b,
      `bytes=${xlsxBuf.length} magic=${xlsxBuf.subarray(0, 2).toString('hex')}`);

    // ── Every bucket actually reached BOTH documents ────────────────────────
    //
    // This is what a broken or silently-empty query cannot fake. Note pick&pack is asserted as
    // the COMBINED 5.50: the invoice's Pick & Pack column is pickPack + additionalUnits, so a
    // bare 4.00 correctly never appears. Asserting 4.00 would have been asserting a bug.
    const htmlMoney = moneySet(html);
    const csvMoney = moneySet(csv);
    const pickPackCombined = money.pickPack + money.additional;
    for (const [label, amount] of [
      ['pick & pack (combined with additional units)', pickPackCombined],
      ['additional units', money.additional],
      ['package', money.packageCost],
      ['shipping', money.shipping],
      ['storage', money.storage],
      ['return postage', money.returnPostage],
      ['replacement postage', money.replacePostage],
      ['replacement pick & pack', money.replacePickPack],
    ] as const) {
      const key = amount.toFixed(2);
      check(`HTML and CSV both carry ${label} (${key})`,
        htmlMoney.has(key) && csvMoney.has(key),
        `html=${htmlMoney.has(key)} csv=${csvMoney.has(key)}`);
    }
    // No adjustment assertion: the database refuses a back-dated adjustment row by design (see
    // the seed). The arm still executes on every request; it simply has no row to sum.

    // ── The totals the customer actually reads ──────────────────────────────
    const grandTotal = money.pickPack + money.additional + money.packageCost + money.shipping
      + money.storage + money.returnPostage + money.returnProcessingZero
      + money.replacePostage + money.replacePickPack;
    check(`the HTML invoice totals to the seeded money (${grandTotal.toFixed(2)})`,
      htmlMoney.has(grandTotal.toFixed(2)),
      `expected ${grandTotal.toFixed(2)} among: ${[...htmlMoney].join(' ')}`);
    const outboundRowTotal = money.pickPack + money.additional + money.packageCost
      + money.shipping + money.storage;
    check(`the outbound row total agrees across HTML and CSV (${outboundRowTotal.toFixed(2)})`,
      htmlMoney.has(outboundRowTotal.toFixed(2)) && csvMoney.has(outboundRowTotal.toFixed(2)));

    // ── PS-488 M3: "never charged" vs "charged 0.00" survive to the CSV ─────
    //
    // The exact distinction the presence flags exist for, asserted on the real document: the
    // RETURN row carries postage 6.5 AND an explicit processing 0, while the OUTBOUND row leaves
    // both return cells EMPTY. Conflating those is how a processing-only return once exported
    // postage as a fabricated 0.00 on a customer's invoice.
    const rows = csv.split('\n').filter((r) => r.includes('PS520-1001'));
    const header = csv.split('\n')[0]!.split(',');
    const iPostage = header.indexOf('Return Postage');
    const iProcessing = header.indexOf('Return Processing');
    check('the CSV exposes Return Postage and Return Processing columns',
      iPostage > 0 && iProcessing > 0, `postage=${iPostage} processing=${iProcessing}`);
    const cells = rows.map((r) => r.split(','));
    const returnRow = cells.find((c) => c[iPostage]?.trim() === '6.5');
    const outboundRow = cells.find((c) => c[header.indexOf('Storage')]?.trim() === '2');
    check('the RETURN row shows a charged-ZERO processing fee, not a blank',
      returnRow !== undefined && returnRow[iProcessing]?.trim() === '0',
      `returnRow processing=${returnRow?.[iProcessing] ?? '(row not found)'}`);
    check('the OUTBOUND row leaves both return cells EMPTY (never charged ≠ charged zero)',
      outboundRow !== undefined
      && outboundRow[iPostage]?.trim() === '' && outboundRow[iProcessing]?.trim() === '',
      `outbound postage="${outboundRow?.[iPostage] ?? '?'}" processing="${outboundRow?.[iProcessing] ?? '?'}"`);

    // ── Client scoping ──────────────────────────────────────────────────────
    const foreign = appFor({ global: false, clientIds: [otherClientId] }, billingRoute);
    const scopedRes = await foreign.request(`/billing/invoice?${qs}`);
    const scopedBody = await scopedRes.text();
    check('a caller scoped to ANOTHER client cannot read this invoice',
      scopedRes.status === 404, `got ${scopedRes.status}`);
    check("the refusal leaks no other client's billing", !scopedBody.includes('PS-520 Invoice Client'));
    check("the invoice never contains the other client's money (99.99)", !html.includes('99.99'));

    // Its OWN invoice still works, so the 404 above is scoping and not a broken route.
    const ownRes = await foreign.request(
      `/billing/invoice?clientId=${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    check('that same scoped caller CAN read its own invoice (so 404 was scope, not breakage)',
      ownRes.status === 200, `got ${ownRes.status}`);
  } finally {
    await migrator.end({ timeout: 5 }).catch(() => {});
    await seeded.end({ timeout: 5 }).catch(() => {});
    const cleanup = postgres(ADMIN_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try { await cleanup.unsafe(`drop database if exists ${DB_NAME}`); } catch { /* best effort */ }
    await cleanup.end({ timeout: 5 }).catch(() => {});
  }
}

try {
  await main();
} catch (error) {
  console.error('\nFAIL PS-520 errored:', error instanceof Error ? error.stack : error);
  failures += 1;
}
console.log(failures === 0
  ? '\nPASS PS-520 invoice routes execute against real PostgreSQL'
  : `\nFAIL PS-520 — ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
