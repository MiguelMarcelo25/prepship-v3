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

/**
 * Money that MUST NOT reach the customer, and the two rules that stop it.
 *
 * Measured on HUGRAB's real August 2026 invoice: the Client Portal, which had no copy of
 * either rule, billed the customer for 8 CANCELLED orders ($27.00) and a DUPLICATE COPY of
 * order 3629 ($3.50) — $30.50 over, and one order too many (581 vs 580). Nothing executed
 * either rule end to end, so nothing would have caught it re-breaking here either.
 *
 * Distinctive amounts on purpose: a substring search for them must find NOTHING, and values
 * like 77.77 cannot be confused with a legitimate figure elsewhere in the document.
 */
const suppressed = {
  /** A cancelled order's fees are zeroed, but the ORDER still exists (rows stay, amounts go). */
  cancelledPickPack: 77.77,
  /** One of two copies of one order number. PS-491 case B: NO copy carries paid shipping. */
  duplicateCopyPickPack: 11.11,
};

/**
 * The period boundary, executed. The Client Portal once sent an EXCLUSIVE instant where this
 * API expects an inclusive day, and the row window silently opened a day wider than the totals
 * on the same page — an August invoice listed 9/1 rows. Review noted no fixture ever placed
 * one row on the last included day and one on the first excluded day and proved which is
 * absent. These two do. Distinctive amounts, like the suppression fixtures above.
 */
const boundary = {
  /** 2026-07-31T23:59:59Z — the last second of TO_DAY. Must be IN the invoice. */
  lastDayPickPack: 44.44,
  /** 2026-08-01T00:00:00Z — the exclusive upper bound itself. Must be OUT. */
  nextDayPickPack: 55.55,
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

  // ── Money the invoice must REFUSE to charge ─────────────────────────────────
  //
  // 1. A CANCELLED order. cancelled-no-charge zeroes its fees while the order itself remains,
  //    so the order COUNT is unchanged and only the money disappears.
  const [cancelled] = await sql`
    insert into orders (order_number, order_status, client_id, ship_to_name)
    values ('PS520-CANCELLED', 'cancelled', ${clientId}, 'PS-520 Cancelled Customer') returning id`;
  await sql`
    insert into billing_line_items
      (client_id, order_id, order_number, ship_date, line_type, description, qty, unit_cost, total_cost)
    values (${clientId}, ${Number(cancelled!.id)}, 'PS520-CANCELLED', ${SHIP_AT},
            'pick_pack', 'cancelled order pick_pack', 1,
            ${suppressed.cancelledPickPack}, ${suppressed.cancelledPickPack})`;

  // 2. A DUPLICATE ORDER NUMBER — two `orders` rows for one order number, PS-491 case B:
  //    NEITHER copy carries paid shipping, so only pick/pack was duplicated. Exactly one copy
  //    is authoritative; the other must be charged nothing AND must not inflate the order
  //    count. Both copies are seeded identically so the test cannot pass by accident of which
  //    one the classifier happens to pick.
  const dupIds: number[] = [];
  for (const suffix of ['a', 'b']) {
    const [dup] = await sql`
      insert into orders (order_number, order_status, client_id, ship_to_name)
      values ('PS520-DUPLICATE', 'shipped', ${clientId}, ${`PS-520 Duplicate ${suffix}`}) returning id`;
    dupIds.push(Number(dup!.id));
    await sql`
      insert into billing_line_items
        (client_id, order_id, order_number, ship_date, line_type, description, qty, unit_cost, total_cost)
      values (${clientId}, ${Number(dup!.id)}, 'PS520-DUPLICATE', ${SHIP_AT},
              'pick_pack', ${`duplicate copy ${suffix} pick_pack`}, 1,
              ${suppressed.duplicateCopyPickPack}, ${suppressed.duplicateCopyPickPack})`;
  }

  // 3. THE DAY BOUNDARY: one order at the last second of the period, one at the exclusive
  //    upper bound. The invoice must carry the first and refuse the second.
  for (const [orderNumber, shipAt, amount] of [
    ['PS520-LASTDAY', '2026-07-31T23:59:59Z', boundary.lastDayPickPack],
    ['PS520-NEXTDAY', '2026-08-01T00:00:00Z', boundary.nextDayPickPack],
  ] as const) {
    const [o] = await sql`
      insert into orders (order_number, order_status, client_id, ship_to_name)
      values (${orderNumber}, 'shipped', ${clientId}, ${`PS-520 ${orderNumber}`}) returning id`;
    await sql`
      insert into billing_line_items
        (client_id, order_id, order_number, ship_date, line_type, description, qty, unit_cost, total_cost)
      values (${clientId}, ${Number(o!.id)}, ${orderNumber}, ${shipAt},
              'pick_pack', ${`${orderNumber} pick_pack`}, 1, ${amount}, ${amount})`;
  }

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

/**
 * The invoice's money components, and what each format calls them.
 *
 * FIELD-BOUND on purpose. The first version of this proof compared unstructured SETS of numbers,
 * which is far weaker than it reads: a value satisfies the check by appearing ANYWHERE in the
 * document, in any column. Review then showed the XLSX was not compared at all — changing the
 * workbook's Shipping cell to 999.99 left the whole suite green. Binding by header means a value
 * has to be in the RIGHT COLUMN of the RIGHT ROW in every format.
 *
 * The header text genuinely differs between the two exports, which is exactly why a shared field
 * key is needed rather than matching on the label.
 */
// ONE header name per column, for all three formats.
//
// This used to carry three spellings per field — csv 'Pick & Pack Fee' / xlsx 'Pick & Pack' /
// html 'Pick & Pack', and 'Additional Units' / 'Addl Units' / "Add'l Units" — because the three
// renderers each owned their own column list and had drifted apart. They now render from one
// contract (billing-invoice-columns.ts), so a single name binds all three. This collapse IS the
// evidence: if the formats ever diverge again, this table cannot be written.
//
// `dash` is what an em-dash means in the HTML for that column: base columns render
// `x > 0 ? fmt(x) : '—'` while the CSV writes a numeric 0 there; return/replace columns are
// blank-when-absent everywhere. Getting it wrong would make the formats disagree for a
// formatting reason and bury a real disagreement in the noise.
const MONEY_FIELDS = [
  { field: 'pickPack', header: 'Pick & Pack Fee', dash: 0 },
  { field: 'additional', header: 'Additional Units', dash: 0 },
  { field: 'boxCost', header: 'Box Cost', dash: 0 },
  { field: 'shipping', header: 'Shipping', dash: 0 },
  { field: 'storage', header: 'Storage', dash: 0 },
  { field: 'total', header: 'Total', dash: 0 },
  { field: 'returnPostage', header: 'Return Postage', dash: null },
  { field: 'returnProcessing', header: 'Return Processing', dash: null },
  { field: 'replacePostage', header: 'Replace Postage', dash: null },
  { field: 'replacePickPack', header: 'Replace Pick&Pack', dash: null },
] as const;

type MoneyRow = Record<string, number | null>;

/** null means the cell is EMPTY (never charged); 0 means an explicit charged-zero. PS-488 M3. */
const cellNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const text = String(typeof raw === 'object' && raw !== null && 'result' in raw
    ? (raw as { result: unknown }).result
    : raw).trim();
  if (text === '') return null;
  const n = Number(text.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function csvMoneyRows(csv: string, orderNumber: string): MoneyRow[] {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const header = lines[0]!.split(',').map((h) => h.trim());
  return lines.slice(1)
    .filter((l) => l.includes(orderNumber))
    .map((line) => {
      const cells = line.split(',');
      const row: MoneyRow = {};
      for (const f of MONEY_FIELDS) row[f.field] = cellNumber(cells[header.indexOf(f.header)]);
      return row;
    });
}

/**
 * The operator-facing HTML invoice, read the same way — by column header, into the same
 * field-keyed shape as the CSV and the workbook.
 *
 * Checking that the HTML merely CONTAINS "$8.25" somewhere is what let a wrong workbook stay
 * green: a value present in the document says nothing about which column it landed in. All
 * three formats are parsed into comparable rows so the assertion can be about the same
 * FIELD of the same ROW in each.
 */
const unescapeHtml = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const tagText = (cell: string) => unescapeHtml(cell.replace(/<[^>]*>/g, '')).trim();

/**
 * The HTML footer's totals, bound to the same headers — COLSPAN-AWARE.
 *
 * The footer's first cell spans four columns, so a cell's POSITION is not its header's position.
 * This is not hypothetical: billing.ts carries a PS-505 comment about a footer that spanned 5 and
 * "pushed every total one cell right of the column it totals". Expanding colspans is the whole
 * reason this reads the right column.
 */
function htmlFooterCells(html: string): Map<string, string> {
  const header = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => tagText(m[1]!));
  const foot = html.slice(html.indexOf('<tfoot>'), html.indexOf('</tfoot>'));
  const cells = new Map<string, string>();
  let column = 0;
  for (const m of foot.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
    const span = Number((m[1]!.match(/colspan=["']?(\d+)/) ?? [])[1] ?? 1);
    const name = header[column];
    if (name && !cells.has(name)) cells.set(name, tagText(m[2]!));
    column += span;
  }
  return cells;
}

function htmlMoneyRows(html: string, orderNumber: string): MoneyRow[] {
  const header = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => tagText(m[1]!));
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => m[1]!)
    .filter((tr) => tr.includes(orderNumber))
    .map((tr) => {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => tagText(m[1]!));
      const row: MoneyRow = {};
      for (const f of MONEY_FIELDS) {
        const text = cells[header.indexOf(f.header)] ?? '';
        row[f.field] = text === '—' || text === '' ? f.dash : cellNumber(text);
      }
      return row;
    });
}

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
      console.log('--- HTML money values ---', [...moneySet(html)].join(' '));
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
      console.log('--- CSV money values ---', [...moneySet(csv)].join(' '));
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

    // ── Parse the workbook. Status + ZIP magic prove a file arrived, NOT that its numbers are
    //    right: review changed the Shipping cell to 999.99 and this suite stayed green.
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    // When the route 500s, the body is an error page and ExcelJS reports "can't find end of
    // central directory" — true, useless, and three steps from the cause. Say what arrived.
    let loadError: string | null = null;
    try {
      await workbook.xlsx.load(xlsxBuf as unknown as ArrayBuffer);
    } catch (error) {
      loadError = `${String(error).split('\n')[0]} — body began: ${xlsxBuf.subarray(0, 160).toString('utf8')}`;
    }
    check('the XLSX body parses as a workbook', loadError === null, loadError ?? '');
    const sheet = workbook.getWorksheet('Invoice');
    check('the XLSX contains an "Invoice" worksheet', sheet !== undefined,
      `sheets: ${workbook.worksheets.map((w) => w.name).join(', ')}`);

    let xlsxRows: MoneyRow[] = [];
    // Hoisted: the Totals row below is checked AGAINST this binding, so it must outlive the block.
    let headerRowNumber = 0;
    const headerIndex = new Map<string, number>();
    if (sheet) {
      // Bind columns by HEADER TEXT, not position — a reordered export must not silently pass.
      sheet.eachRow((row, n) => {
        if (headerRowNumber) return;
        const labels = (row.values as unknown[]).map((v) => (v == null ? '' : String(v).trim()));
        if (labels.includes('Shipping') && labels.includes('Total')) {
          headerRowNumber = n;
          labels.forEach((label, i) => { if (label) headerIndex.set(label, i); });
        }
      });
      check('the XLSX header row binds every money column by name',
        headerRowNumber > 0 && MONEY_FIELDS.every((f) => headerIndex.has(f.header)),
        `missing: ${MONEY_FIELDS.filter((f) => !headerIndex.has(f.header)).map((f) => f.header).join(', ')}`);

      const orderCol = headerIndex.get('Order #');
      sheet.eachRow((row, n) => {
        if (n <= headerRowNumber || orderCol === undefined) return;
        if (String(row.getCell(orderCol).value ?? '').trim() !== 'PS520-1001') return;
        const parsed: MoneyRow = {};
        for (const f of MONEY_FIELDS) parsed[f.field] = cellNumber(row.getCell(headerIndex.get(f.header)!).value);
        xlsxRows.push(parsed);
      });
    }

    // ── The bold Totals row ────────────────────────────────────────────────
    // Its cells are SUM formulas addressed by COLUMN LETTER, and billing.ts states the cost of
    // getting one wrong: "A stale letter here does not error — it silently sums the neighbouring
    // column." Review pointed the Shipping total at the Storage column and all 35 checks stayed
    // green, because nothing parsed the totals row at all — every row filter here keeps only rows
    // carrying the seeded order number, and the totals row carries none.
    //
    // Assert each total sums ITS OWN column, derived from the header binding. Pinning the literal
    // letters instead would just re-encode the bug the PS-505 comment describes.
    const colLetter = (n: number): string => {
      let out = '';
      for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
      return out;
    };
    let totalsRowNumber = 0;
    const totalsIssues: string[] = [];
    if (sheet) {
      sheet.eachRow((row, n) => {
        if (totalsRowNumber || n <= headerRowNumber) return;
        if ((row.values as unknown[]).some((v) => typeof v === 'string' && /^Totals\b/.test(v.trim()))) {
          totalsRowNumber = n;
        }
      });
      if (totalsRowNumber) {
        const totalsRow = sheet.getRow(totalsRowNumber);
        for (const header of ['Box Cost', 'Qty', 'Pick & Pack Fee', 'Additional Units', 'Shipping', 'Storage', 'Total']) {
          const idx = headerIndex.get(header);
          if (idx === undefined) { totalsIssues.push(`${header}: no such column`); continue; }
          const cell = totalsRow.getCell(idx).value as { formula?: string } | null;
          const formula = cell && typeof cell === 'object' && 'formula' in cell ? String(cell.formula) : '';
          const want = colLetter(idx);
          const m = formula.match(/^SUM\(([A-Z]+)\d+:([A-Z]+)\d+\)$/);
          if (!m || m[1] !== want || m[2] !== want) {
            totalsIssues.push(`${header}: expected SUM(${want}..) but found ${formula || '(no formula)'}`);
          }
        }
      }
    }
    check('the XLSX carries a Totals row', totalsRowNumber > 0, `header row=${headerRowNumber}`);
    check('EVERY XLSX totals-row formula sums its OWN column, not a neighbour',
      totalsRowNumber > 0 && totalsIssues.length === 0, totalsIssues.join(' | '));

    // ── THE OPERATOR'S REQUIREMENT: one invoice, one shape, whichever button you press ──
    // "it must always the same data same all what ever export/invoce, excel or CSV."
    // The three renderers used to own three column lists and had drifted into different
    // columns, in a different order, under different names. They now derive from one contract;
    // this asserts that on the RENDERED artifacts, not on the contract they were built from —
    // a shared constant proves nothing if a renderer stops using it.
    const csvHeaderRow = csv.replace(/^﻿/, '').split('\r\n')[0]!.split(',')
      .map((h) => h.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const htmlHeaderRow = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => tagText(m[1]!));
    const xlsxHeaderRow = sheet && headerRowNumber
      ? (sheet.getRow(headerRowNumber).values as unknown[])
        .slice(1).map((v) => (v == null ? '' : String(v).trim()))
      : [];
    check('the CSV and the operator HTML carry IDENTICAL columns, in identical order',
      JSON.stringify(csvHeaderRow) === JSON.stringify(htmlHeaderRow),
      `csv:  ${csvHeaderRow.join(' | ')}\n       html: ${htmlHeaderRow.join(' | ')}`);
    check('the XLSX carries those same columns, in that same order',
      JSON.stringify(xlsxHeaderRow) === JSON.stringify(csvHeaderRow),
      `xlsx: ${xlsxHeaderRow.join(' | ')}\n       csv:  ${csvHeaderRow.join(' | ')}`);

    const csvRows = csvMoneyRows(csv, 'PS520-1001');
    const htmlRows = htmlMoneyRows(html, 'PS520-1001');
    if (process.env.PS520_DEBUG === '1') {
      console.log('--- CSV rows ---', JSON.stringify(csvRows));
      console.log('--- XLSX rows ---', JSON.stringify(xlsxRows));
      console.log('--- HTML rows ---', JSON.stringify(htmlRows));
    }

    // ── THE three-format claim, actually tested ─────────────────────────────
    check('all three formats carry the same number of billing rows',
      xlsxRows.length === csvRows.length && htmlRows.length === csvRows.length && csvRows.length === 3,
      `html=${htmlRows.length} csv=${csvRows.length} xlsx=${xlsxRows.length}`);

    const byTotal = (rows: MoneyRow[]) => [...rows].sort((a, b) => (a.total ?? 0) - (b.total ?? 0));
    const csvSorted = byTotal(csvRows);
    const xlsxSorted = byTotal(xlsxRows);
    const htmlSorted = byTotal(htmlRows);
    const disagree = (other: MoneyRow[], label: string) => {
      const out: string[] = [];
      csvSorted.forEach((csvRow, i) => {
        const row = other[i];
        if (!row) { out.push(`row ${i} missing in ${label}`); return; }
        for (const f of MONEY_FIELDS) {
          if (csvRow[f.field] !== row[f.field]) {
            out.push(`row ${i} ${f.field}: csv=${csvRow[f.field]} ${label}=${row[f.field]}`);
          }
        }
      });
      return out;
    };
    const xlsxMismatches = disagree(xlsxSorted, 'xlsx');
    const htmlMismatches = disagree(htmlSorted, 'html');
    check('EVERY money cell agrees between CSV and XLSX, field by field',
      xlsxMismatches.length === 0, xlsxMismatches.slice(0, 6).join(' | '));
    check('EVERY money cell agrees between CSV and the operator HTML, field by field',
      htmlMismatches.length === 0, htmlMismatches.slice(0, 6).join(' | '));

    // ── The seeded components, asserted in the WORKBOOK itself ──────────────
    const xOutbound = xlsxSorted.find((r) => r.storage === money.storage);
    const xReturn = xlsxSorted.find((r) => r.returnPostage === money.returnPostage);
    const xReplace = xlsxSorted.find((r) => r.replacePostage === money.replacePostage);
    check('the XLSX outbound row carries every seeded outbound component',
      xOutbound !== undefined
      && xOutbound.pickPack === money.pickPack + money.additional
      && xOutbound.additional === money.additional
      && xOutbound.boxCost === money.packageCost
      && xOutbound.shipping === money.shipping
      && xOutbound.storage === money.storage
      && xOutbound.total === money.pickPack + money.additional + money.packageCost
        + money.shipping + money.storage,
      JSON.stringify(xOutbound));
    check('the XLSX replacement row carries both replacement components',
      xReplace !== undefined
      && xReplace.replacePostage === money.replacePostage
      && xReplace.replacePickPack === money.replacePickPack,
      JSON.stringify(xReplace));
    // PS-488 M3 in the WORKBOOK: charged-zero is a numeric 0, never-charged is an EMPTY cell.
    check('the XLSX return row shows postage AND an explicit numeric zero processing fee',
      xReturn !== undefined && xReturn.returnPostage === money.returnPostage
      && xReturn.returnProcessing === 0,
      JSON.stringify(xReturn));
    check('the XLSX outbound row leaves BOTH return cells empty (never charged is not zero)',
      xOutbound !== undefined
      && xOutbound.returnPostage === null && xOutbound.returnProcessing === null,
      `postage=${xOutbound?.returnPostage} processing=${xOutbound?.returnProcessing}`);

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
    // Plus ONE authoritative duplicate copy, and nothing at all from the cancelled order —
    // if either rule regressed, this figure is the first thing that moves.
    const grandTotal = money.pickPack + money.additional + money.packageCost + money.shipping
      + money.storage + money.returnPostage + money.returnProcessingZero
      + money.replacePostage + money.replacePickPack
      + suppressed.duplicateCopyPickPack
      // ...plus the last-second-of-the-period order, and NOT the one at the exclusive bound.
      + boundary.lastDayPickPack;
    check(`the HTML invoice totals to the seeded money (${grandTotal.toFixed(2)})`,
      htmlMoney.has(grandTotal.toFixed(2)),
      `expected ${grandTotal.toFixed(2)} among: ${[...htmlMoney].join(' ')}`);
    const outboundRowTotal = money.pickPack + money.additional + money.packageCost
      + money.shipping + money.storage;
    check(`the outbound row total agrees across HTML and CSV (${outboundRowTotal.toFixed(2)})`,
      htmlMoney.has(outboundRowTotal.toFixed(2)) && csvMoney.has(outboundRowTotal.toFixed(2)));

    // ── The footer, against the rows it claims to total ─────────────────────
    // The two checks above ask only whether a number appears ANYWHERE in the document — the same
    // weakness that let a wrong workbook pass. Review swapped the footer's Shipping total for the
    // Storage total and both stayed green, because 8.25 and 2.00 are still somewhere on the page.
    // Foot the footer against the parsed rows instead.
    const footer = htmlFooterCells(html);
    // Foot against EVERY billed row, not just the seeded order's three. The invoice also carries
    // the cancelled order (at zero) and the one authoritative duplicate copy, and the footer
    // totals them too — comparing a whole-table footer against a subset of rows would fail for a
    // reason that has nothing to do with the footer being wrong.
    const allCsvRows = csvMoneyRows(csv, '');
    const columnSum = (field: string) => allCsvRows.reduce((sum, r) => sum + (r[field] ?? 0), 0);
    const footIssues: string[] = [];
    for (const [header, field] of [
      ['Box Cost', 'boxCost'], ['Pick & Pack Fee', 'pickPack'], ['Additional Units', 'additional'],
      ['Shipping', 'shipping'], ['Storage', 'storage'], ['Total', 'total'],
    ] as const) {
      const text = footer.get(header);
      if (text === undefined) { footIssues.push(`${header}: no footer cell`); continue; }
      const got = text === '—' || text === '' ? 0 : cellNumber(text);
      const want = columnSum(field);
      if (got === null || Math.abs(got - want) > 0.005) {
        footIssues.push(`${header}: footer says ${text}, the column above sums to ${want.toFixed(2)}`);
      }
    }
    check('EVERY HTML footer total equals the sum of the column above it',
      footIssues.length === 0, footIssues.join(' | '));

    // ── The two money rules the Client Portal did not have ──────────────────
    // Both are asserted on the RENDERED DOCUMENT, not on a service return value, because the
    // customer-visible failure was a document that charged for things the backend had already
    // decided not to charge for.
    const cancelledAmount = suppressed.cancelledPickPack.toFixed(2);
    check('a CANCELLED order contributes no money to the invoice',
      !html.includes(cancelledAmount) && !csv.includes(cancelledAmount)
      && !xlsxSorted.some((r) => Object.values(r).includes(suppressed.cancelledPickPack)),
      `${cancelledAmount} must appear in no format`);
    // ...but the order itself is still a real order. cancelled-no-charge zeroes the MONEY, it
    // does not delete history — conflating the two would hide a cancellation from the customer.
    check('the cancelled order still appears on the invoice, at zero',
      html.includes('PS520-CANCELLED') && csv.includes('PS520-CANCELLED'));

    // The duplicate: BOTH copies stay visible, but only one is charged.
    //
    // Suppression zeroes the copy, it does not delete the row — and that is the right design:
    // the suppressed copy is rendered with every money cell at 0 and its reference labelled
    // "(Duplicate of order N)", which matches the badge the Billing table already shows. Hiding
    // it would turn a flagged, explainable condition into a silent gap in the customer's
    // itemization. So the invariant is about the MONEY, not the row count.
    const dupRows = csvMoneyRows(csv, 'PS520-DUPLICATE');
    const dupCharged = dupRows.reduce((sum, r) => sum + (r.total ?? 0), 0);
    check('a DUPLICATE order number is CHARGED exactly once, though both copies are shown',
      dupRows.length === 2 && Math.abs(dupCharged - suppressed.duplicateCopyPickPack) < 0.005,
      `${dupRows.length} rows charging ${dupCharged.toFixed(2)}; `
      + `${(suppressed.duplicateCopyPickPack * 2).toFixed(2)} = double-charged, 0.00 = over-suppressed`);
    check('the suppressed copy is labelled as a duplicate rather than silently zeroed',
      /PS520-DUPLICATE \(Duplicate of order \d+\)/.test(csv)
      && /PS520-DUPLICATE \(Duplicate of order \d+\)/.test(html),
      'a $0.00 row with no explanation reads as a billing error to a customer');

    // ── The day boundary, on the rendered documents ─────────────────────────
    const lastDay = boundary.lastDayPickPack.toFixed(2);
    const nextDay = boundary.nextDayPickPack.toFixed(2);
    check('an order at the LAST SECOND of the period is on the invoice, in every format',
      html.includes('PS520-LASTDAY') && csv.includes('PS520-LASTDAY')
      && html.includes(lastDay) && csv.includes(lastDay)
      && allCsvRows.some((r) => r.pickPack === boundary.lastDayPickPack),
      `${lastDay} must appear in HTML and CSV`);
    check('an order at the EXCLUSIVE upper bound is on NO format — the window is not a day too wide',
      !html.includes('PS520-NEXTDAY') && !csv.includes('PS520-NEXTDAY')
      && !html.includes(nextDay) && !csv.includes(nextDay)
      && !xlsxSorted.some((r) => Object.values(r).includes(boundary.nextDayPickPack)),
      `${nextDay} (2026-08-01T00:00Z) must appear nowhere for a 2026-07-01..2026-07-31 invoice`);

    // The headline the customer reads first must agree with the table it summarises.
    const headline = html.match(/class="gtv">([^<]*)</)?.[1] ?? '';
    check('the "Total Amount Due" headline equals the footer Total and the seeded grand total',
      cellNumber(headline) === grandTotal && cellNumber(footer.get('Total') ?? '') === grandTotal,
      `headline=${headline} footer=${footer.get('Total')} expected=${grandTotal.toFixed(2)}`);

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
    // ── /billing/invoice-totals: the Billing LIST reads the invoice's money ──
    // The portal's Billing list used to total its rows with its own aggregation, which has
    // neither suppression rule. This endpoint exists so the list and the invoice a customer
    // opens from it cannot disagree, so it is asserted to return EXACTLY the invoice's totals —
    // including the cancelled order contributing nothing and the duplicate charged once.
    const totalsRes = await staff.request(
      `/billing/invoice-totals?clientIds=${clientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`,
    );
    check('GET /invoice-totals returns HTTP 200', totalsRes.status === 200, `got ${totalsRes.status}`);
    const totalsBody = await totalsRes.json() as {
      data: Array<{ clientId: number; totals: Record<string, number> }>;
    };
    const listTotals = totalsBody.data?.[0]?.totals;
    check('the list totals cover the requested client', totalsBody.data?.[0]?.clientId === clientId,
      JSON.stringify(totalsBody.data?.[0]?.clientId));
    check('the LIST grand total equals the INVOICE grand total, to the cent',
      listTotals !== undefined && Math.abs(listTotals.grandTotal - grandTotal) < 0.005,
      `list=${listTotals?.grandTotal} invoice=${grandTotal.toFixed(2)}`);
    // pick_pack the list may charge: the seeded order, ONE duplicate copy, and the last-day
    // order. NOT the cancelled 77.77, NOT the second copy, NOT the next-day 55.55.
    const listPickPack = money.pickPack + suppressed.duplicateCopyPickPack + boundary.lastDayPickPack;
    check('the list applies cancelled-no-charge (the 77.77 order contributes nothing)',
      listTotals !== undefined && Math.abs(listTotals.pickPackTotal - listPickPack) < 0.005,
      `pickPackTotal=${listTotals?.pickPackTotal} expected=${listPickPack.toFixed(2)}`);
    // Orders the list counts: PS520-1001, PS520-CANCELLED (still an order, at zero), ONE of the
    // two PS520-DUPLICATE copies, and PS520-LASTDAY. The next-day order is outside the window.
    check('the list applies duplicate suppression to its ORDER COUNT too',
      listTotals !== undefined && listTotals.orderCount === 4,
      `orderCount=${listTotals?.orderCount} (5 = the suppressed copy or the next-day order was counted)`);

    const foreign = appFor({ global: false, clientIds: [otherClientId] }, billingRoute);

    // The totals endpoint is a NEW money surface, so it gets its own scope proof rather than
    // inheriting confidence from the invoice routes. It takes a LIST of client ids, which is a
    // shape that invites a leak: asking about someone else's client alongside your own must not
    // return theirs. Out-of-scope ids are dropped silently — a 403 would confirm the id exists.
    const foreignTotals = await foreign.request(
      `/billing/invoice-totals?clientIds=${clientId},${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`,
    );
    const foreignTotalsBody = await foreignTotals.json() as {
      data: Array<{ clientId: number; totals: Record<string, number> }>;
    };
    check('a scoped caller asking for BOTH clients receives only its own totals',
      foreignTotals.status === 200
      && foreignTotalsBody.data.length === 1
      && foreignTotalsBody.data[0]?.clientId === otherClientId,
      JSON.stringify(foreignTotalsBody.data?.map((d) => d.clientId)));
    check('the totals endpoint leaks none of the other client\'s money',
      !foreignTotalsBody.data.some((d) => Math.abs(d.totals.grandTotal - grandTotal) < 0.005),
      JSON.stringify(foreignTotalsBody.data));
    // Scoping is a property of each ROUTE, not of the invoice: all three handlers call
    // billingScopeFromContext separately. Review's proof exercised only the HTML one, so deleting
    // the scope from /invoice.csv left every check green while that route served any client's
    // billing to any caller. A leak in the customer's spreadsheet is still a leak.
    for (const [label, path] of [
      ['HTML', `/billing/invoice?${qs}`],
      ['XLSX', `/billing/invoice.xlsx?${qs}`],
      ['CSV', `/billing/invoice.csv?${qs}`],
    ] as const) {
      const res = await foreign.request(path);
      const body = await res.text();
      check(`a caller scoped to ANOTHER client cannot read this invoice via ${label}`,
        res.status === 404, `got ${res.status}`);
      check(`the ${label} refusal carries neither this client's name nor its money`,
        !body.includes('PS-520 Invoice Client')
        && !/(^|[^\d])18\.75([^\d]|$)/.test(body)
        && !/(^|[^\d])33\.50([^\d]|$)/.test(body),
        `${res.status}: ${body.slice(0, 100)}`);
    }
    // Anchored, not a bare substring: `includes('99.99')` also matches 999.99, so a mutation
    // that inflated a legitimate cell tripped this as a cross-client LEAK. A scope check that
    // fires on the wrong evidence is a scope check nobody can read.
    check("the invoice never contains the other client's money (99.99)",
      !/(^|[^\d])99\.99([^\d]|$)/.test(html));

    // Its OWN invoice still works, so the 404 above is scoping and not a broken route.
    const ownRes = await foreign.request(
      `/billing/invoice?clientId=${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    check('that same scoped caller CAN read its own invoice (so 404 was scope, not breakage)',
      ownRes.status === 200, `got ${ownRes.status}`);

    // ── FINALIZATION: the persisted amount is the rendered amount ─────────────
    //
    // The close workflow snapshots billingInvoiceHeaderTotals into billing_finalizations. Every
    // check above proves what the CUSTOMER sees; nothing proved what the BOOKS record. Review
    // rated that PLAUSIBLE: ps-433 calls the totals owner directly and never finalizes.
    //
    // LAST, deliberately. Finalizing stamps invoiced=true on every line in the period, and the
    // duplicate loader never suppresses an already-invoiced copy — so any render AFTER this
    // point would legitimately show different money. Order matters here, and it is not a
    // detail: it is the same rule that stops a fix from restating an invoice a customer holds.
    delete process.env.BILLING_WEEKEND_ROLLFORWARD_EFFECTIVE_DATE; // the weekday gate must not make CI flaky
    const { finalizeBillingPeriod } = await import('../src/services/billing-finalization-policy.js');
    const period = { clientId, dateFrom: `${FROM_DAY}T00:00:00.000Z`, dateTo: '2026-08-01T00:00:00.000Z' };
    const first = await finalizeBillingPeriod({ ...period, actorId: 'ps-520', actorEmail: 'ps-520@test' });
    check('finalizeBillingPeriod runs against the same seeded period', !first.alreadyFinalized);
    check('the PERSISTED subtotal equals the invoice grand total the customer was shown',
      Number(first.finalization.subtotal) === grandTotal,
      `persisted=${first.finalization.subtotal} rendered=${grandTotal.toFixed(2)}`);
    const [persisted] = await seeded`
      select subtotal::text, line_count, order_count from billing_finalizations
      where client_id = ${clientId}`;
    check('the billing_finalizations ROW carries that same subtotal (read back, not returned)',
      persisted !== undefined && Number(persisted.subtotal) === grandTotal,
      JSON.stringify(persisted));
    // Line/order counts are LINE-derived and PRE-suppression: every line in the window is
    // stamped, including the cancelled order's and BOTH duplicate copies'. So order_count here
    // is 5 where the invoice and the list say 4. That is the current, documented behaviour of
    // the close record — asserted as-is, and flagged in the report rather than silently changed.
    // 9 lines on PS520-1001 + cancelled + two duplicate copies + last-day = 13; next-day is OUT.
    check('the close record counts every line in the window (13) and none outside it',
      persisted?.line_count === 13, `line_count=${persisted?.line_count}`);
    check('the close record order_count is LINE-derived (5), which differs from the invoice (4) — flagged',
      persisted?.order_count === 5, `order_count=${persisted?.order_count}`);
    const [stamped] = await seeded`
      select
        count(*) filter (where invoiced and order_number <> 'PS520-NEXTDAY')::int as in_window,
        count(*) filter (where invoiced and order_number = 'PS520-NEXTDAY')::int as next_day,
        count(*) filter (where not invoiced and order_number <> 'PS520-NEXTDAY' and client_id = ${clientId})::int as unstamped
      from billing_line_items where client_id = ${clientId}`;
    check('every in-window line is stamped invoiced=true; the next-day line is NOT',
      stamped?.in_window === 13 && stamped?.next_day === 0 && stamped?.unstamped === 0,
      JSON.stringify(stamped));
    // Replay is idempotent: same id, no second record.
    const again = await finalizeBillingPeriod({ ...period, actorId: 'ps-520', actorEmail: 'ps-520@test' });
    const [{ n }] = await seeded`select count(*)::int as n from billing_finalizations where client_id = ${clientId}`;
    check('finalizing the same period again returns the SAME finalization and creates no second record',
      again.alreadyFinalized && again.finalization.id === first.finalization.id && n === 1,
      `alreadyFinalized=${again.alreadyFinalized} sameId=${again.finalization.id === first.finalization.id} rows=${n}`);
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
