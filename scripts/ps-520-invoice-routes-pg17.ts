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
import { mkdirSync, writeFileSync } from 'node:fs';
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

/** Optional: PS520_DUMP_DIR=<dir> writes the rendered artifacts so the invoice can be opened as a
 *  human sees it (screen and print) without a database. Never affects a check. */
const DUMP_DIR = process.env.PS520_DUMP_DIR;
const dump = (name: string, body: string | Buffer): void => {
  if (!DUMP_DIR) return;
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(path.join(DUMP_DIR, name), body);
};

const FROM_DAY = '2026-07-01';
const TO_DAY = '2026-07-31';
const SHIP_AT = '2026-07-10T12:00:00Z';
// Text columns were BLANK in every fixture row, so the 19-column parity for SKUs, Box Size,
// Carrier and Item Name was vacuous — a renderer corrupting them survived. Real values now,
// asserted by value. The item NAME is formula-shaped with a quote and a comma on purpose: it is
// exactly what the CSV sanitizer exists for, and it exercises the CSV quoting and every parser.
const STORE_ID = 520001;
const OTHER_STORE_ID = 520002;
const SKU = 'PS520-SKU-A';
const ITEM_NAME = '=Widget "Blue", 12in';
const BOX_LABEL = 'PS520 12x10x3';
const CARRIER_CODE = 'usps';

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

async function seed(sql: postgres.Sql): Promise<{ clientId: number; otherClientId: number; shipmentId: number }> {
  const [client] = await sql`
    insert into clients (name, active, is_test, store_ids) values ('PS-520 Invoice Client', true, false, array[${STORE_ID}]::int[]) returning id`;
  const [other] = await sql`
    insert into clients (name, active, is_test, store_ids) values ('PS-520 Other Client', true, false, array[${OTHER_STORE_ID}]::int[]) returning id`;
  const clientId = Number(client!.id);
  const otherClientId = Number(other!.id);

  const [order] = await sql`
    insert into orders (order_number, order_status, client_id, ship_to_name)
    values ('PS520-1001', 'shipped', ${clientId}, 'PS-520 Customer') returning id`;
  const orderId = Number(order!.id);
  await sql`
    insert into order_items (order_id, line_index, sku, name, quantity, unit_price, line_total, client_id, order_status)
    values (${orderId}, 0, ${SKU}, ${ITEM_NAME}, 2, 10, 20, ${clientId}, 'shipped')`;

  const [ret] = await sql`
    insert into returns (order_id, client_id, status, initiated_by, admin_override, requested_at, created_at, updated_at)
    values (${orderId}, ${clientId}, 'received', 'client', false, now(), now(), now()) returning id`;
  const returnId = Number(ret!.id);

  // A replacement's billing lines must carry BOTH a shipment and a replacement identity
  // (billing_li_replacement_identity_check), so the re-ship gets a real chain rather than a
  // loosened row: shipment -> replacement -> replace_* lines.
  const [shipment] = await sql`
    insert into shipments (order_id, client_id, order_number, tracking_number, is_return, voided, source, label_carrier)
    values (${orderId}, ${clientId}, 'PS520-1001', 'PS520-REPLACE-TRK', false, false, 'ps520_fixture', ${CARRIER_CODE})
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
              ${lineType}, ${lineType === 'package_cost' ? `Box (${BOX_LABEL})` : `PS-520 ${lineType}`}, 1, ${total}, ${total})`;
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
  //    They also carry a ship-to COUNTRY (the outbound order deliberately has none), so the
  //    Destination column can be asserted by VALUE for all three classes the canonical
  //    classifier owns: no country → Needs Review, US → Domestic, CA → International.
  for (const [orderNumber, shipAt, amount, country] of [
    ['PS520-LASTDAY', '2026-07-31T23:59:59Z', boundary.lastDayPickPack, 'US'],
    ['PS520-NEXTDAY', '2026-08-01T00:00:00Z', boundary.nextDayPickPack, 'CA'],
  ] as const) {
    const [o] = await sql`
      insert into orders (order_number, order_status, client_id, ship_to_name, raw)
      values (${orderNumber}, 'shipped', ${clientId}, ${`PS-520 ${orderNumber}`},
              ${sql.json({ shipTo: { country } })}) returning id`;
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

  return { clientId, otherClientId, shipmentId };
}

/** Mounts the REAL billing router behind the scope the auth middleware would have set. */
function appFor(scope: { global: boolean; clientIds?: number[]; storeIds?: number[] }, billingRoute: Hono): Hono {
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
    c.set('storeIds' as never, (scope.storeIds ?? []) as never);
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
/**
 * RFC-4180 split of ONE line: a quoted comma and a doubled quote are DATA, not separators.
 * Every CSV reader in this proof used a naive split(','), which was fail-closed only while no
 * fixture cell contained a comma; the seeded item name now does.
 */
const splitCsvLine = (line: string): string[] => {
  const src = line.replace(/\r$/, '');
  const out: string[] = []; let cur = ''; let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

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
  // NO read-through of a leading apostrophe: since DJ's numeric-money ruling (2026-09-02) a
  // bare signed decimal must arrive as a NUMBER in the CSV, and an apostrophe-prefixed money
  // cell is a type disagreement this parser must not paper over.
  const n = Number(text.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function csvMoneyRows(csv: string, orderNumber: string): MoneyRow[] {
  const lines = csv.split('\n').filter((l) => l.trim() !== '');
  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  return lines.slice(1)
    .filter((l) => l.includes(orderNumber))
    .map((line) => {
      const cells = splitCsvLine(line);
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
const unescapeHtml = (s: string) => s
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
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

    const { clientId, otherClientId, shipmentId } = await seed(seeded);
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
        // The ROWS a formula sums matter as much as the column. Review moved the range start
        // from 2 to 3 — skipping the first detail row — and this check stayed green, because it
        // matched the digits and then discarded them. ExcelJS writes no computed result, so a
        // wrong range is invisible to every value check that follows. The interval is derived
        // from the sheet, not typed: first detail row is the header's successor, last is the
        // totals row's predecessor, and every summed column must use exactly that interval.
        const firstDetail = headerRowNumber + 1;
        const lastDetail = totalsRowNumber - 1;
        if (lastDetail < firstDetail) totalsIssues.push(`no detail rows between header ${headerRowNumber} and totals ${totalsRowNumber}`);
        for (const header of ['Box Cost', 'Qty', 'Pick & Pack Fee', 'Additional Units', 'Shipping', 'Storage', 'Total']) {
          const idx = headerIndex.get(header);
          if (idx === undefined) { totalsIssues.push(`${header}: no such column`); continue; }
          const cell = totalsRow.getCell(idx).value as { formula?: string } | null;
          const formula = cell && typeof cell === 'object' && 'formula' in cell ? String(cell.formula) : '';
          const want = colLetter(idx);
          const m = formula.match(/^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/);
          if (!m || m[1] !== want || m[3] !== want) {
            totalsIssues.push(`${header}: expected SUM(${want}..) but found ${formula || '(no formula)'}`);
          } else if (Number(m[2]) !== firstDetail || Number(m[4]) !== lastDetail) {
            totalsIssues.push(`${header}: sums rows ${m[2]}..${m[4]} but the detail rows are ${firstDetail}..${lastDetail}`);
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
    const csvHeaderRow = splitCsvLine(csv.replace(/^\uFEFF/, '').split('\r\n')[0]!);
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

    // ── EVERY column, EVERY row, all three formats ──────────────────────────
    //
    // The money comparison above covers ten columns. Review set the XLSX Qty cell to 999 and
    // all 65 checks stayed green: identical HEADERS say nothing about identical VALUES, and a
    // column nobody parses is a column nobody can defend. So every contract column is parsed
    // from every data row of every format and compared row by row, field by field.
    //
    // Normalisation is BY KIND, and presence-aware where the contract is. The two RETURN
    // columns distinguish "never charged" (blank) from "charged zero" (0) in all three formats
    // — PS-488 M3's presence flags, a customer-visible fact about money. The two REPLACE
    // columns carry NO presence flag: PS-513 renders them blank when zero, in all three, by
    // design, so `presence` there asserts only that the formats agree on blank-vs-number. A previous
    // version folded blank→0 for every money column; review made the XLSX render a numeric 0
    // where CSV/HTML were blank on the cancelled row and the fold hid it. The six BASE money
    // columns are folded on purpose: for the same zero the CSV writes 0 and the HTML '—', by
    // contract, so there blank and zero are one fact. Dates reduce to the billing DAY because
    // the XLSX cell is date-only while HTML/CSV carry time-of-day — a disclosed difference, not
    // timestamp parity. Text folds '—' and '' to one "not applicable".
    //
    // This is a FUNCTION, not inline code, so the August adjustment invoice below goes through
    // exactly the same comparator — review found that document checked by a two-column parser.
    type Kind = 'money' | 'presence' | 'qty' | 'day' | 'text';
    const ALL_FIELDS: ReadonlyArray<{ header: string; kind: Kind }> = [
      { header: 'Billing / Activity Date (Los Angeles)', kind: 'day' },
      { header: 'Order #', kind: 'text' }, { header: 'SKUs', kind: 'text' },
      { header: 'Box Size', kind: 'text' }, { header: 'Box Cost', kind: 'money' },
      { header: 'Qty', kind: 'qty' }, { header: 'Pick & Pack Fee', kind: 'money' },
      { header: 'Additional Units', kind: 'money' }, { header: 'Shipping', kind: 'money' },
      { header: 'Storage', kind: 'money' }, { header: 'Total', kind: 'money' },
      { header: 'Shipment #', kind: 'text' }, { header: 'Destination', kind: 'text' },
      { header: 'Return Postage', kind: 'presence' }, { header: 'Return Processing', kind: 'presence' },
      { header: 'Replace Postage', kind: 'presence' }, { header: 'Replace Pick&Pack', kind: 'presence' },
      { header: 'Carrier', kind: 'text' }, { header: 'Item Name', kind: 'text' },
    ];
    const toDay = (raw: unknown): string => {
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      const s = String(raw ?? '');
      const iso = s.match(/\d{4}-\d{2}-\d{2}/); if (iso) return iso[0];
      const us = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      return us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : s.trim();
    };
    // The apostrophe read-through is the CSV's spelling and ONLY the CSV's: applied to every
    // format, a renderer that started writing '=Widget into the workbook or the page would be
    // stripped to the same value and pass. The format is passed in, and only 'csv' reads through.
    const norm = (kind: Kind, raw: unknown, format: 'csv' | 'html' | 'xlsx'): string | number | null => {
      const text = raw instanceof Date ? raw.toISOString() : String(raw ?? '').replace(/\u00a0/g, ' ').trim();
      if (kind === 'day') return toDay(raw);
      const blank = text === '—' || text === '';
      if (kind === 'text') {
        // The CSV neutralises a formula-shaped TEXT cell with a leading apostrophe (PS-468). That
        // is the CSV's disclosed spelling of the same value, read through ONLY when the value is
        // formula-shaped; a raw-cell check below asserts the apostrophe is actually there.
        return blank ? '' : (format === 'csv' ? text.replace(/^'(?=[=+\-@\t\r])/, '') : text);
      }
      // A blank Qty is not a zero Qty and a blank presence cell is "never charged"; only the
      // base money columns fold blank→0, by contract (the HTML prints '—' where the CSV writes 0).
      if (blank) return kind === 'money' ? 0 : null;
      // NO read-through for a money/qty cell: a bare signed decimal must be a NUMBER in every
      // format (DJ's numeric-money ruling). An apostrophe here is a TYPE disagreement and is
      // returned as text so the comparison fails on it.
      const n = Number(text.replace(/[$,]/g, '')); return Number.isFinite(n) ? n : text;
    };
    type FullRow = Record<string, string | number | null>;
    // Identity = order label + rendered shipment identity + total. Order label alone is not
    // unique (a return and its outbound share it); order+total is not guaranteed unique either
    // (two shipments of one order with identical money). Shipment # is the rendered identity
    // the invoice itself groups by. Uniqueness is ASSERTED per artifact below, so a collision
    // fails loudly instead of pairing the wrong rows.
    const rowKey = (r: FullRow) => `${r['Order #']}|${r['Shipment #']}|${r['Total']}`;
    const csvFullRows = (doc: string): FullRow[] => doc.replace(/^﻿/, '').split('\r\n')
      .filter((l) => l.trim() !== '').slice(1)
      .map((line) => { const cells = splitCsvLine(line); const r: FullRow = {};
        ALL_FIELDS.forEach((f, i) => { r[f.header] = norm(f.kind, cells[i], 'csv'); }); return r; });
    const htmlFullRows = (doc: string): FullRow[] => [...doc.slice(doc.indexOf('<tbody>'), doc.indexOf('</tbody>'))
      .matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((m) => { const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => tagText(c[1]!.replace(/<br\s*\/?>/g, ' ')));
        const r: FullRow = {}; ALL_FIELDS.forEach((f, i) => { r[f.header] = norm(f.kind, cells[i], 'html'); }); return r; });
    // Self-locating: finds the header row by its labels and the totals row by its label, so
    // the same parser serves any invoice sheet rather than the one whose numbers happened to
    // be in scope.
    const xlsxFullRows = (ws: NonNullable<typeof sheet> | undefined): FullRow[] => {
      if (!ws) return [];
      let hdr = 0; let tot = 0; const idx = new Map<string, number>();
      ws.eachRow((row, rn) => {
        const labels = (row.values as unknown[]).map((v) => (v == null ? '' : String(v).trim()));
        if (!hdr && labels.includes('Shipping') && labels.includes('Total')) { hdr = rn; labels.forEach((l, i) => { if (l) idx.set(l, i); }); return; }
        if (hdr && !tot && labels.some((l) => /^Totals\b/.test(l))) tot = rn;
      });
      const out: FullRow[] = [];
      if (!hdr || !tot) return out;
      for (let n = hdr + 1; n < tot; n += 1) {
        const row = ws.getRow(n); const r: FullRow = {};
        for (const f of ALL_FIELDS) {
          const col = idx.get(f.header); const v = col === undefined ? undefined : (row.getCell(col).value as unknown);
          const raw = v && typeof v === 'object' && !(v instanceof Date) && 'result' in (v as object) ? (v as { result: unknown }).result : v;
          r[f.header] = norm(f.kind, raw, 'xlsx');
        }
        out.push(r);
      }
      return out;
    };
    const bySort = (rows: FullRow[]) => [...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
    const compareArtifacts = (label: string, docs: { csv: string; html: string; sheet: NonNullable<typeof sheet> | undefined }, minRows: number) => {
      const csvS = bySort(csvFullRows(docs.csv)); const htmlS = bySort(htmlFullRows(docs.html)); const xlsxS = bySort(xlsxFullRows(docs.sheet));
      check(`${label}: all three formats carry the same number of DATA rows`,
        csvS.length === htmlS.length && csvS.length === xlsxS.length && csvS.length >= minRows,
        `csv=${csvS.length} html=${htmlS.length} xlsx=${xlsxS.length}`);
      for (const [name, rows] of [['csv', csvS], ['html', htmlS], ['xlsx', xlsxS]] as const) {
        const keys = rows.map(rowKey);
        check(`${label}: every ${name} row has a unique (order, shipment, total) identity`,
          new Set(keys).size === keys.length, keys.filter((k, i) => keys.indexOf(k) !== i).join(' | '));
      }
      const diffs: string[] = [];
      csvS.forEach((c, i) => {
        for (const [name, o] of [['html', htmlS[i]], ['xlsx', xlsxS[i]]] as const) {
          if (!o) { diffs.push(`row ${i} missing in ${name}`); continue; }
          for (const f of ALL_FIELDS) if (c[f.header] !== o[f.header]) diffs.push(`${rowKey(c)} ${f.header}: csv=${JSON.stringify(c[f.header])} ${name}=${JSON.stringify(o[f.header])}`);
        }
      });
      check(`${label}: EVERY one of the 19 columns agrees across CSV, HTML and XLSX on EVERY data row (blank ≠ 0 where the contract says so)`,
        diffs.length === 0, diffs.slice(0, 8).join('\n       '));
      return { csvS, htmlS, xlsxS };
    };
    dump('july.html', html); dump('july.csv', csv); dump('july.xlsx', xlsxBuf);
    const july = compareArtifacts('July', { csv, html, sheet }, 6);
    // "EVERY one of the 19 columns" is bounded by ALL_FIELDS. Make ALL_FIELDS answer to the
    // rendered header, so a twentieth column cannot arrive unseen and a renamed one cannot be
    // compared by position under its old name.
    const csvHeaderCells = splitCsvLine(csv.replace(/^\uFEFF/, '').split('\r\n')[0]!);
    check('the comparator\'s column list IS the rendered header row, in order (nothing is compared by stale position)',
      csvHeaderCells.length === ALL_FIELDS.length && csvHeaderCells.every((h, i) => h === ALL_FIELDS[i]!.header),
      `header=${csvHeaderCells.join('|')}`);
    // The text columns and the day, asserted to their seeded VALUES in all three formats. Both
    // were agreement-only: every fixture row had blank text columns, and a day shifted by one in
    // the SQL shifted it identically in all three.
    const DAY_HEADER = 'Billing / Activity Date (Los Angeles)';
    const outboundFull = (rows: FullRow[]) => rows.find((r) => r['Order #'] === 'PS520-1001' && r['Storage'] === money.storage);
    const replacementFull = (rows: FullRow[]) => rows.find((r) => r['Order #'] === 'PS520-1001' && r['Shipment #'] === `#${shipmentId}`);
    const lastDayFull = (rows: FullRow[]) => rows.find((r) => r['Order #'] === 'PS520-LASTDAY');
    for (const [name, rows] of [['csv', july.csvS], ['html', july.htmlS], ['xlsx', july.xlsxS]] as const) {
      const o = outboundFull(rows); const rep = replacementFull(rows); const ld = lastDayFull(rows);
      check(`${name}: the outbound row carries the seeded SKU, box label and (formula-shaped) item name`,
        o !== undefined && String(o['SKUs']).includes(SKU) && o['Box Size'] === BOX_LABEL && String(o['Item Name']).includes('Widget "Blue", 12in'),
        `sku=${JSON.stringify(o?.['SKUs'])} box=${JSON.stringify(o?.['Box Size'])} item=${JSON.stringify(o?.['Item Name'])}`);
      check(`${name}: the replacement shipment row carries its carrier (USPS)`,
        rep !== undefined && rep['Carrier'] === 'USPS', `carrier=${JSON.stringify(rep?.['Carrier'])} shipment=#${shipmentId}`);
      check(`${name}: the outbound row is billed on the seeded day 2026-07-10 and the last-second order on 2026-07-31`,
        o?.[DAY_HEADER] === '2026-07-10' && ld?.[DAY_HEADER] === '2026-07-31',
        `outbound=${String(o?.[DAY_HEADER])} lastday=${String(ld?.[DAY_HEADER])}`);
    }
    // Destination was agreement-only: forcing every row to 'Domestic' left all three formats
    // agreeing on the same wrong value (the r6.2 audit's delta — PS-490's guard catches that
    // route bypass, this proof did not). Asserted by VALUE for the classes the classifier owns.
    check('Destination is a VALUE in all three formats: no country → Needs Review, US → Domestic',
      [july.csvS, july.htmlS, july.xlsxS].every((rows) => outboundFull(rows)?.['Destination'] === 'Needs Review' && lastDayFull(rows)?.['Destination'] === 'Domestic'),
      [july.csvS, july.htmlS, july.xlsxS].map((rows) => `${String(outboundFull(rows)?.['Destination'])}/${String(lastDayFull(rows)?.['Destination'])}`).join(' | '));
    // RAW CSV: the formula-shaped item name must arrive NEUTRALISED (leading apostrophe) and
    // quoted — the comparator reads through the apostrophe, so it must be asserted on the raw cell.
    const itemIdx = ALL_FIELDS.findIndex((f) => f.header === 'Item Name');
    const rawItemCells = csv.replace(/^\uFEFF/, '').split('\r\n').slice(1).filter((l) => l.trim() !== '')
      .map((l) => splitCsvLine(l)[itemIdx] ?? '').filter((c) => c.includes('Widget'));
    check('the CSV neutralises the formula-shaped item name with a leading apostrophe on every row that carries it',
      rawItemCells.length > 0 && rawItemCells.every((c) => c.startsWith("'=")), JSON.stringify(rawItemCells.slice(0, 2)));
    // The workbook's cell TYPES. Every comparator reads through Number(), so a Total written as
    // the STRING '18.75' agreed with the other formats while Excel's SUM over that column scored
    // it 0. Numeric columns must hold NUMBERS, or be empty where blank is the contract.
    const locateSheet = (ws: NonNullable<typeof sheet>) => {
      let hdr = 0; let tot = 0; const idx = new Map<string, number>();
      ws.eachRow((row, rn) => {
        const labels = (row.values as unknown[]).map((v) => (v == null ? '' : String(v).trim()));
        if (!hdr && labels.includes('Shipping') && labels.includes('Total')) { hdr = rn; labels.forEach((l, i) => { if (l) idx.set(l, i); }); return; }
        if (hdr && !tot && labels.some((l) => /^Totals\b/.test(l))) tot = rn;
      });
      return { hdr, tot, idx };
    };
    const xlsxTypeIssues = (ws: NonNullable<typeof sheet> | undefined, label: string): string[] => {
      if (!ws) return [`${label}: no sheet`];
      const { hdr, tot, idx } = locateSheet(ws); const issues: string[] = [];
      if (!hdr || !tot) return [`${label}: header/totals row not found`];
      for (let n = hdr + 1; n < tot; n += 1) for (const f of ALL_FIELDS) {
        if (f.kind === 'text' || f.kind === 'day') continue;
        const col = idx.get(f.header); if (col === undefined) { issues.push(`${label}: no ${f.header} column`); continue; }
        const v = ws.getRow(n).getCell(col).value;
        if (!(v === null || v === undefined || typeof v === 'number')) issues.push(`${label} row ${n} ${f.header}: ${typeof v} ${JSON.stringify(v)}`);
      }
      return issues;
    };
    const julyTypes = xlsxTypeIssues(sheet, 'July');
    check('every numeric XLSX cell is a NUMBER (or empty), never text — so Excel can SUM it', julyTypes.length === 0, julyTypes.slice(0, 5).join(' | '));
    // The totals-row interval check above is inline July code. The same rule, self-locating,
    // so the August workbook is held to it too (a SUM range that dropped the adjustment row
    // survived while only July was checked).
    const xlsxTotalsIssues = (ws: NonNullable<typeof sheet> | undefined, label: string): string[] => {
      if (!ws) return [`${label}: no sheet`];
      const { hdr, tot, idx } = locateSheet(ws); const issues: string[] = [];
      if (!hdr || !tot) return [`${label}: header/totals row not found`];
      const totalsRow = ws.getRow(tot);
      for (const header of ['Box Cost', 'Qty', 'Pick & Pack Fee', 'Additional Units', 'Shipping', 'Storage', 'Total']) {
        const col = idx.get(header); if (col === undefined) { issues.push(`${header}: no such column`); continue; }
        const cell = totalsRow.getCell(col).value as { formula?: string } | null;
        const formula = cell && typeof cell === 'object' && 'formula' in cell ? String(cell.formula) : '';
        const want = colLetter(col);
        const m = formula.match(/^SUM\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/);
        if (!m || m[1] !== want || m[3] !== want) issues.push(`${header}: expected SUM(${want}..) but found ${formula || '(no formula)'}`);
        else if (Number(m[2]) !== hdr + 1 || Number(m[4]) !== tot - 1) issues.push(`${header}: sums rows ${m[2]}..${m[4]} but the detail rows are ${hdr + 1}..${tot - 1}`);
      }
      return issues;
    };
    // The outbound row's Qty is base 1 + additional 1 = 2 — asserted as a VALUE, in every
    // format, because "the three agree" is also true when all three are 999.
    const outboundQty = (rows: FullRow[]) => rows.find((r) => r['Order #'] === 'PS520-1001' && r['Storage'] === money.storage)?.['Qty'];
    check('the seeded outbound row carries Qty 2 in all three formats (the column review set to 999)',
      [july.csvS, july.htmlS, july.xlsxS].every((rows) => outboundQty(rows) === 2),
      `csv=${outboundQty(july.csvS)} html=${outboundQty(july.htmlS)} xlsx=${outboundQty(july.xlsxS)}`);
    // The cancelled row was review's vehicle: its replacement cells are "never charged" and must
    // be BLANK — null after presence-aware normalisation — in all three, never a numeric 0.
    const cancelledRow = (rows: FullRow[]) => rows.find((r) => r['Order #'] === 'PS520-CANCELLED');
    check('the cancelled row\'s four return/replace cells are BLANK (never charged), not zero, in all three formats',
      [july.csvS, july.htmlS, july.xlsxS].every((rows) => { const r = cancelledRow(rows); return r !== undefined
        && r['Return Postage'] === null && r['Return Processing'] === null && r['Replace Postage'] === null && r['Replace Pick&Pack'] === null; }),
      [july.csvS, july.htmlS, july.xlsxS].map((rows) => JSON.stringify(cancelledRow(rows)?.['Replace Postage'])).join(' / '));

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
    const header = splitCsvLine(csv.split('\n')[0]!);
    const iPostage = header.indexOf('Return Postage');
    const iProcessing = header.indexOf('Return Processing');
    check('the CSV exposes Return Postage and Return Processing columns',
      iPostage > 0 && iProcessing > 0, `postage=${iPostage} processing=${iProcessing}`);
    const cells = rows.map((r) => splitCsvLine(r));
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
      listTotals !== undefined && Math.abs((listTotals.grandTotal ?? NaN) - grandTotal) < 0.005,
      `list=${listTotals?.grandTotal} invoice=${grandTotal.toFixed(2)}`);
    // pick_pack the list may charge: the seeded order, ONE duplicate copy, and the last-day
    // order. NOT the cancelled 77.77, NOT the second copy, NOT the next-day 55.55.
    const listPickPack = money.pickPack + suppressed.duplicateCopyPickPack + boundary.lastDayPickPack;
    check('the list applies cancelled-no-charge (the 77.77 order contributes nothing)',
      listTotals !== undefined && Math.abs((listTotals.pickPackTotal ?? NaN) - listPickPack) < 0.005,
      `pickPackTotal=${listTotals?.pickPackTotal} expected=${listPickPack.toFixed(2)}`);
    // Orders the list counts: PS520-1001, PS520-CANCELLED (still an order, at zero), ONE of the
    // two PS520-DUPLICATE copies, and PS520-LASTDAY. The next-day order is outside the window.
    check('the list applies duplicate suppression to its ORDER COUNT too',
      listTotals !== undefined && listTotals.orderCount === 4,
      `orderCount=${listTotals?.orderCount} (5 = the suppressed copy or the next-day order was counted)`);

    // Every seeded figure, not two hand-typed ones: the refusal check pinned 33.50, a grand total
    // this fixture stopped having two rounds ago, so a refusal body printing the REAL grand
    // total (89.05) would have passed. Built from the rendered July rows plus the grand total.
    const seededMoney = new Set<string>([grandTotal.toFixed(2),
      ...allCsvRows.flatMap((r) => Object.values(r).filter((v): v is number => typeof v === 'number' && v !== 0).map((v) => v.toFixed(2)))]);
    const leaksSeededMoney = (body: string) => [...seededMoney].some((m) => new RegExp(`(^|[^\\d])${m.replace('.', '\\.')}([^\\d]|$)`).test(body));
    // The invariant is stronger than "none of the seeded figures": a refusal carries NO amount at
    // all. The first version of this check let a 404 body leak 44.61 — a real total of this
    // client's, over a window nobody seeded — because it only knew the figures it had planted.
    const refusalIsClean = (body: string) => !body.includes('PS-520 Invoice Client') && !leaksSeededMoney(body) && !/\d+\.\d{2}/.test(body);

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
      !foreignTotalsBody.data.some((d) => Math.abs((d.totals.grandTotal ?? NaN) - grandTotal) < 0.005),
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
      check(`the ${label} refusal carries neither this client's name nor ANY amount at all`,
        refusalIsClean(body), `${res.status}: ${body.slice(0, 100)}`);
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

    // Two scope SHAPES this proof never exercised, both real in production. A STORE-scoped
    // caller (a portal user whose JWT carries store ids, not client ids) reaches the storeIds
    // branch of billingClientScopePredicate; a RESTRICTED caller with NO ids at all reaches its
    // no-ids branch. Either branch replaced by `true` served every client's invoice to that
    // caller with every check green.
    const invoicePaths = [['HTML', `/billing/invoice?${qs}`], ['XLSX', `/billing/invoice.xlsx?${qs}`], ['CSV', `/billing/invoice.csv?${qs}`]] as const;
    const storeScoped = appFor({ global: false, storeIds: [OTHER_STORE_ID] }, billingRoute);
    for (const [label, path] of invoicePaths) {
      const res = await storeScoped.request(path); const body = await res.text();
      check(`a caller scoped to ANOTHER client's STORE cannot read this invoice via ${label}`,
        res.status === 404 && refusalIsClean(body), `got ${res.status}: ${body.slice(0, 80)}`);
    }
    const storeOwn = await storeScoped.request(`/billing/invoice?clientId=${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    check('that store-scoped caller CAN read the client its store belongs to (so 404 was scope)', storeOwn.status === 200, `got ${storeOwn.status}`);
    const storeTotals = await storeScoped.request(`/billing/invoice-totals?clientIds=${clientId},${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    const storeTotalsBody = await storeTotals.json() as { data: Array<{ clientId: number }> };
    check('the totals endpoint honours STORE scope: only the store\'s own client comes back',
      storeTotals.status === 200 && storeTotalsBody.data.length === 1 && storeTotalsBody.data[0]?.clientId === otherClientId,
      JSON.stringify(storeTotalsBody.data?.map((d) => d.clientId)));
    const noScope = appFor({ global: false }, billingRoute);
    for (const [label, path] of invoicePaths) {
      const res = await noScope.request(path); const body = await res.text();
      check(`a restricted caller with NO client or store ids is refused via ${label} (fails closed)`,
        res.status === 404 && refusalIsClean(body), `got ${res.status}: ${body.slice(0, 80)}`);
    }
    const noScopeTotals = await noScope.request(`/billing/invoice-totals?clientIds=${clientId},${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    const noScopeText = await noScopeTotals.text();
    const noScopeData = (() => { try { return (JSON.parse(noScopeText) as { data?: unknown[] }).data; } catch { return undefined; } })();
    check('the totals endpoint returns NOTHING to a restricted caller with no ids',
      !leaksSeededMoney(noScopeText) && ((noScopeTotals.status === 200 && Array.isArray(noScopeData) && noScopeData.length === 0) || (noScopeTotals.status >= 400 && noScopeTotals.status < 500)),
      `${noScopeTotals.status}: ${noScopeText.slice(0, 120)}`);

    // A principal carrying BOTH claims, where each client is authorised by exactly ONE axis:
    // this client by its client id (its store is not in the caller's store list), the other
    // client by its store id (its id is not in the caller's client list). The contract is
    // client OR store. The r6.2 audit found the predicate's OR→AND surviving every gate: with
    // no such principal, a false denial had nothing to fail against.
    const both = appFor({ global: false, clientIds: [clientId], storeIds: [OTHER_STORE_ID] }, billingRoute);
    for (const [label, path] of invoicePaths) {
      const res = await both.request(path);
      check(`a caller with BOTH claims reads this client's invoice by CLIENT id via ${label} (client OR store, never AND)`, res.status === 200, `got ${res.status}`);
    }
    const bothOther = await both.request(`/billing/invoice?clientId=${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    check('that same caller reads the OTHER client by STORE id (the second axis authorises on its own)', bothOther.status === 200, `got ${bothOther.status}`);
    const bothTotals = await both.request(`/billing/invoice-totals?clientIds=${clientId},${otherClientId}&dateFrom=${FROM_DAY}&dateTo=${TO_DAY}`);
    const bothBody = await bothTotals.json() as { data: Array<{ clientId: number }> };
    check('the totals endpoint returns BOTH clients to the caller with both claims',
      bothTotals.status === 200 && bothBody.data.length === 2 && new Set(bothBody.data.map((d) => d.clientId)).size === 2
      && bothBody.data.every((d) => d.clientId === clientId || d.clientId === otherClientId),
      JSON.stringify(bothBody.data?.map((d) => d.clientId)));

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
    check('the close record order_count is LINE-derived (5) where the invoice says 4 — DJ ruled: leave, documented at the schema',
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
    const countRow = (await seeded`select count(*)::int as n from billing_finalizations where client_id = ${clientId}`)[0];
    const n = Number(countRow?.n ?? NaN);
    check('finalizing the same period again returns the SAME finalization and creates no second record',
      again.alreadyFinalized && again.finalization.id === first.finalization.id && n === 1,
      `alreadyFinalized=${again.alreadyFinalized} sameId=${again.finalization.id === first.finalization.id} rows=${n}`);

    // ── ADJUSTMENT, through the REAL workflow ─────────────────────────────────
    //
    // The card's fixture list includes an adjustment, and this harness could not seed one: the
    // database refuses a hand-inserted billing_adjustment row (BILLING_ADJUSTMENT_LEGACY_WRITE_
    // DISABLED — corrections must be posted through current-period posting, against a
    // finalization). Review was right that "the arm executes with no row" is not proof. Now
    // that the harness FINALIZES the period, it can post a credit note against that
    // finalization exactly as an operator would, and the policy projects the adjustment line
    // into the billing day of `now`. That day is placed in AUGUST, so the August invoice is
    // where the adjustment must appear — in all three formats — next to the next-day order.
    const { createBillingCreditNote } = await import('../src/services/billing-finalization-policy.js');
    const ADJUSTMENT = '12.34';
    const posted = await createBillingCreditNote({
      clientId,
      finalizationId: first.finalization.id,
      amount: ADJUSTMENT,
      reason: 'PS-520 fixture: a real current-period credit against the finalized period',
      idempotencyKey: 'ps520-credit-note-1',
      actorId: 'ps-520',
      actorEmail: 'ps-520@test',
      now: new Date('2026-08-05T12:00:00Z'),
    });
    check('a credit note posts through the real current-period workflow', !posted.alreadyCreated,
      `alreadyCreated=${posted.alreadyCreated}`);
    const [projected] = await seeded`
      select line_type, total_cost::text, billing_adjustment_id, order_id, shipment_id
      from billing_line_items where client_id = ${clientId} and line_type = 'billing_adjustment'`;
    check('the policy projected ONE billing_adjustment line, orderless, bound to the credit note',
      projected !== undefined && projected.order_id === null && projected.billing_adjustment_id === posted.creditNote.id
      && Math.abs(Math.abs(Number(projected.total_cost)) - Number(ADJUSTMENT)) < 0.005,
      JSON.stringify(projected));
    const adjSigned = Number(projected?.total_cost ?? 0);

    const augQs = `clientId=${clientId}&dateFrom=2026-08-01&dateTo=2026-08-31`;
    const [augHtmlRes, augCsvRes, augXlsxRes] = await Promise.all([
      staff.request(`/billing/invoice?${augQs}`), staff.request(`/billing/invoice.csv?${augQs}`), staff.request(`/billing/invoice.xlsx?${augQs}`),
    ]);
    check('the August invoice renders in all three formats', augHtmlRes.status === 200 && augCsvRes.status === 200 && augXlsxRes.status === 200,
      `${augHtmlRes.status}/${augCsvRes.status}/${augXlsxRes.status}`);
    const augHtml = await augHtmlRes.text();
    const augCsv = await augCsvRes.text();
    const augWb = new ExcelJS.Workbook(); await augWb.xlsx.load(Buffer.from(await augXlsxRes.arrayBuffer()) as unknown as ArrayBuffer);
    const augSheet = augWb.getWorksheet('Invoice');
    // The SAME 19-column comparator as July. Review changed the XLSX adjustment Destination to
    // "WRONG DESTINATION" and the previous two-column parser (Shipment #, Total) let it through.
    // August holds two rows: the next-day order and the adjustment.
    dump('august.html', augHtml); dump('august.csv', augCsv);
    const aug = compareArtifacts('August', { csv: augCsv, html: augHtml, sheet: augSheet }, 2);
    // August holds EXACTLY two rows — the next-day order and the adjustment — and NOTHING July
    // already billed and finalized. compareArtifacts proves the three formats agree on whatever
    // rows they carry; the pre-audit widened the query's LOWER bound by a day and the finalized
    // July-31 order re-appeared on the August invoice in all three formats, agreeing perfectly.
    // Absence and count are asserted here, as values.
    check('August carries exactly 2 data rows (the next-day order and the adjustment) in all three formats',
      aug.csvS.length === 2 && aug.htmlS.length === 2 && aug.xlsxS.length === 2, `csv=${aug.csvS.length} html=${aug.htmlS.length} xlsx=${aug.xlsxS.length}`);
    const julyOrder = /^PS520-(1001|CANCELLED|DUPLICATE|LASTDAY)\b/;
    check('no order July billed and finalized appears on the August invoice, in any format (no double-billing)',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => !rows.some((r) => julyOrder.test(String(r['Order #'])))),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => rows.map((r) => r['Order #']).join(',')).join(' / '));
    check('August carries the next-day order (2026-08-01T00:00Z belongs to August) in all three formats',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => rows.some((r) => r['Order #'] === 'PS520-NEXTDAY' && r['Pick & Pack Fee'] === boundary.nextDayPickPack)));
    check('August: the next-day order shipped to CA is International in all three formats (a value, not agreement)',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => rows.find((r) => r['Order #'] === 'PS520-NEXTDAY')?.['Destination'] === 'International'),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => String(rows.find((r) => r['Order #'] === 'PS520-NEXTDAY')?.['Destination'])).join(' / '));
    // The August TOTALS the customer reads — headline, footer, the Billing list, the workbook's
    // SUM range — against the August rows. The pre-audit clipped the canonical grand total at
    // zero (credits vanished from the headline) and dropped the adjustment row from the
    // workbook's SUM range; both survived because these were July-only checks.
    const augGrand = boundary.nextDayPickPack + adjSigned;
    const augFooter = htmlFooterCells(augHtml);
    const augHeadline = augHtml.match(/class="gtv">([^<]*)</)?.[1] ?? '';
    check(`August "Total Amount Due" headline and footer Total both equal next-day + credit (${augGrand.toFixed(2)})`,
      Math.abs((cellNumber(augHeadline) ?? NaN) - augGrand) < 0.005 && Math.abs((cellNumber(augFooter.get('Total') ?? '') ?? NaN) - augGrand) < 0.005,
      `headline=${augHeadline} footer=${augFooter.get('Total')}`);
    const augSum = (header: string) => aug.csvS.reduce((sum, r) => sum + (typeof r[header] === 'number' ? (r[header] as number) : 0), 0);
    const augFootIssues: string[] = [];
    for (const header of ['Box Cost', 'Pick & Pack Fee', 'Additional Units', 'Shipping', 'Storage', 'Total']) {
      const text = augFooter.get(header); if (text === undefined) { augFootIssues.push(`${header}: no footer cell`); continue; }
      const got = text === '—' || text === '' ? 0 : cellNumber(text); const want = augSum(header);
      if (got === null || Math.abs(got - want) > 0.005) augFootIssues.push(`${header}: footer ${text} vs rows ${want.toFixed(2)}`);
    }
    check('EVERY August HTML footer total equals the sum of the August column above it', augFootIssues.length === 0, augFootIssues.join(' | '));
    const augTotalsRes = await staff.request(`/billing/invoice-totals?clientIds=${clientId}&dateFrom=2026-08-01&dateTo=2026-08-31`);
    const augTotalsBody = await augTotalsRes.json() as { data: Array<{ clientId: number; totals: Record<string, number> }> };
    const augList = augTotalsBody.data?.[0]?.totals;
    check(`the Billing LIST's August grand total is next-day + credit (${augGrand.toFixed(2)}), signed — a credit is not clipped`,
      augList !== undefined && Math.abs((augList.grandTotal ?? NaN) - augGrand) < 0.005 && Math.abs((augList.adjustmentTotal ?? NaN) - adjSigned) < 0.005,
      `grandTotal=${augList?.grandTotal} adjustmentTotal=${augList?.adjustmentTotal}`);
    const augTotalsIssues = xlsxTotalsIssues(augSheet, 'August');
    check('EVERY August XLSX totals-row formula sums its own column over EXACTLY the August detail rows (the adjustment included)',
      augTotalsIssues.length === 0, augTotalsIssues.join(' | '));
    // The July header-parity check does not cover August, and xlsxTypeIssues skipping a column it
    // cannot find would have passed vacuously: the August CSV header must be the contract and
    // the August workbook must carry every one of its headers.
    const augCsvHeader = splitCsvLine(augCsv.replace(/^\uFEFF/, '').split('\r\n')[0]!);
    const augIdx = augSheet ? locateSheet(augSheet).idx : new Map<string, number>();
    check('August: the CSV header is the 19-column contract and the workbook carries every one of its headers',
      augCsvHeader.length === ALL_FIELDS.length && augCsvHeader.every((h, i) => h === ALL_FIELDS[i]!.header) && ALL_FIELDS.every((f) => augIdx.has(f.header)),
      `csv=${augCsvHeader.join('|')} xlsx-missing=${ALL_FIELDS.filter((f) => !augIdx.has(f.header)).map((f) => f.header).join(',')}`);
    const augTypes = xlsxTypeIssues(augSheet, 'August');
    check('every numeric August XLSX cell is a NUMBER (the credit is a real negative number)', augTypes.length === 0, augTypes.slice(0, 5).join(' | '));
    const adjRow = (rows: FullRow[]) => rows.find((r) => r['Shipment #'] === 'Adjustment');
    check('the adjustment row exists in all three August formats',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => adjRow(rows) !== undefined));
    check('the adjustment Total is the signed credit in all three formats',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => Math.abs(Number(adjRow(rows)?.['Total'] ?? NaN) - adjSigned) < 0.005),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => String(adjRow(rows)?.['Total'])).join(' / '));
    // Asserted as a VALUE, not only as cross-format agreement: an adjustment has no shipment and
    // therefore no destination, and all three must say so with a blank rather than a guess.
    check('the adjustment Destination is BLANK in all three formats',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => adjRow(rows)?.['Destination'] === ''),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => JSON.stringify(adjRow(rows)?.['Destination'])).join(' / '));
    check('the adjustment row carries the credit\'s reason as its Item Name in all three formats (a value, not agreement)',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => String(adjRow(rows)?.['Item Name'] ?? '').includes('PS-520 fixture')),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => JSON.stringify(adjRow(rows)?.['Item Name'])).join(' / '));
    check('the adjustment is billed on the day it was posted (2026-08-05) in all three formats',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => adjRow(rows)?.[DAY_HEADER] === '2026-08-05'),
      [aug.csvS, aug.htmlS, aug.xlsxS].map((rows) => String(adjRow(rows)?.[DAY_HEADER])).join(' / '));
    // The customer-facing SIGN: the HTML printed `$-12.34`, a token neither the CSV nor the
    // workbook carries. A credit reads `-$12.34`.
    check('HTML prints the credit as -$12.34 (sign before the currency symbol), never $-12.34',
      augHtml.includes('-$12.34') && !augHtml.includes('$-12.34'), `has -$: ${augHtml.includes('-$12.34')} has $-: ${augHtml.includes('$-12.34')}`);
    check('the adjustment row is orderless in every format: Qty 0 and no outbound money',
      [aug.csvS, aug.htmlS, aug.xlsxS].every((rows) => { const r = adjRow(rows); return r !== undefined && r['Qty'] === 0
        && r['Pick & Pack Fee'] === 0 && r['Shipping'] === 0 && r['Storage'] === 0 && r['Box Cost'] === 0; }));
    // NUMERIC-MONEY CONTRACT, asserted on the RAW CSV cell (the comparator above reads through
    // any prefix, so it cannot see this). This fixture found the CSV writing a credit as the
    // text cell `'-12.34` — PS-468's injection guard prefixing every leading '-' — while HTML
    // and XLSX carried a real negative number. DJ ruled (2026-09-02) that a strictly validated
    // signed decimal is data and stays numeric; the guard keeps neutralising formula-shaped
    // text. So the raw cell must be exactly the bare signed decimal, summable in a spreadsheet.
    const totIdx = ALL_FIELDS.findIndex((f) => f.header === 'Total'); const shipIdx = ALL_FIELDS.findIndex((f) => f.header === 'Shipment #');
    const rawCsvAdj = augCsv.replace(/^﻿/, '').split('\r\n').map((l) => splitCsvLine(l)).find((c) => c[shipIdx] === 'Adjustment');
    check('the CSV writes the credit as a bare signed decimal (-12.34), not an apostrophe-prefixed text cell',
      rawCsvAdj !== undefined && /^-\d+(\.\d+)?$/.test(rawCsvAdj[totIdx] ?? '') && Number(rawCsvAdj[totIdx]) === adjSigned,
      `raw cell=${JSON.stringify(rawCsvAdj?.[totIdx])}`);
    const adjCard = augHtml.match(/Adjustments<\/div><div class="cv">([^<]*)</)?.[1] ?? '';
    check('HTML: the Adjustments summary card shows the credit, not a dash',
      adjCard !== '-' && Math.abs((cellNumber(adjCard) ?? 0) - adjSigned) < 0.005, `card=${JSON.stringify(adjCard)}`);
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
