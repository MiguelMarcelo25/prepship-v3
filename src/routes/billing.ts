import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingConfig,
  billingRefRates,
  clientPackagePrices,
} from '../db/schema/billing';
import { clients } from '../db/schema/clients';
import {
  billingDetails,
  billingSummary,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';

const app = new Hono();

app.get('/config', async (c) => {
  // v2-parity: join clients so the frontend can render the CLIENT column.
  // Exclude is_test and Api Shipments — they never bill.
  const rows = await db
    .select({
      clientId: billingConfig.clientId,
      clientName: clients.name,
      pickPackFee: billingConfig.pickPackFee,
      pickPackMaxUnits: billingConfig.pickPackMaxUnits,
      additionalUnitFee: billingConfig.additionalUnitFee,
      packageCostMarkup: billingConfig.packageCostMarkup,
      shippingMarkupPct: billingConfig.shippingMarkupPct,
      shippingMarkupFlat: billingConfig.shippingMarkupFlat,
      storageFeePerCuFt: billingConfig.storageFeePerCuFt,
      billingMode: billingConfig.billingMode,
      active: billingConfig.active,
      createdAt: billingConfig.createdAt,
      updatedAt: billingConfig.updatedAt,
    })
    .from(billingConfig)
    .innerJoin(clients, eq(clients.id, billingConfig.clientId))
    .where(
      and(
        eq(clients.isTest, false),
        sql`lower(${clients.name}) <> 'api shipments'`
      )
    )
    .orderBy(asc(clients.name));
  return c.json({ data: rows });
});

const configBody = z.object({
  pickPackFee: z.coerce.number().nonnegative().optional(),
  pickPackMaxUnits: z.coerce.number().int().positive().optional(),
  additionalUnitFee: z.coerce.number().nonnegative().optional(),
  packageCostMarkup: z.coerce.number().nonnegative().optional(),
  shippingMarkupPct: z.coerce.number().nonnegative().optional(),
  shippingMarkupFlat: z.coerce.number().nonnegative().optional(),
  storageFeePerCuFt: z.coerce.number().nonnegative().optional(),
  billingMode: z
    .enum(['per_shipment', 'monthly', 'label_cost', 'ss_ref_rate'])
    .optional(),
  active: z.boolean().optional(),
});

app.put(
  '/config/:clientId{[0-9]+}',
  zValidator('json', configBody),
  async (c) => {
    const clientId = Number(c.req.param('clientId'));
    const body = c.req.valid('json');
    const row = await upsertBillingConfig(clientId, {
      pickPackFee:
        body.pickPackFee !== undefined ? body.pickPackFee.toFixed(2) : undefined,
      pickPackMaxUnits: body.pickPackMaxUnits,
      additionalUnitFee:
        body.additionalUnitFee !== undefined
          ? body.additionalUnitFee.toFixed(2)
          : undefined,
      packageCostMarkup:
        body.packageCostMarkup !== undefined
          ? body.packageCostMarkup.toFixed(2)
          : undefined,
      shippingMarkupPct:
        body.shippingMarkupPct !== undefined
          ? body.shippingMarkupPct.toFixed(2)
          : undefined,
      shippingMarkupFlat:
        body.shippingMarkupFlat !== undefined
          ? body.shippingMarkupFlat.toFixed(2)
          : undefined,
      storageFeePerCuFt:
        body.storageFeePerCuFt !== undefined
          ? body.storageFeePerCuFt.toFixed(4)
          : undefined,
      billingMode: body.billingMode,
      active: body.active,
    });
    return c.json(row);
  }
);

// Accepts v2's short param names (from/to, plain YYYY-MM-DD) and v4's
// long names (dateFrom/dateTo, ISO datetime). Coerces YYYY-MM-DD to an
// ISO datetime anchored at start/end-of-day.
function coerceIsoDay(raw: string | undefined, endOfDay: boolean): string | undefined {
  if (!raw) return undefined;
  if (raw.includes('T')) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(
      `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    ).toISOString();
  }
  return raw;
}

const generateRawSchema = z.object({
  clientId: z.coerce.number().int().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const generateSchema = generateRawSchema
  .transform((v) => ({
    clientId: v.clientId,
    dateFrom: coerceIsoDay(v.dateFrom ?? v.from, false),
    dateTo: coerceIsoDay(v.dateTo ?? v.to, true),
  }))
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

const detailsSchema = generateRawSchema
  .extend({ limit: z.coerce.number().int().max(2000).optional() })
  .transform((v) => ({
    clientId: v.clientId,
    dateFrom: coerceIsoDay(v.dateFrom ?? v.from, false),
    dateTo: coerceIsoDay(v.dateTo ?? v.to, true),
    limit: v.limit,
  }))
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

app.post('/generate', zValidator('json', generateSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await generateLineItems({
    clientId: body.clientId,
    dateFrom: body.dateFrom!,
    dateTo: body.dateTo!,
  });
  return c.json(result);
});

app.get('/summary', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const summary = await billingSummary({
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  });
  return c.json(summary);
});

app.get('/details', zValidator('query', detailsSchema), async (c) => {
  const q = c.req.valid('query');
  const rows = await billingDetails({
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
    limit: q.limit,
  });
  return c.json({ data: rows });
});

// ─── Invoice (HTML) ────────────────────────────────────────────────────
// v2-parity: GET /billing/invoice?clientId=N&dateFrom=ISO&dateTo=ISO
// Returns a full HTML invoice for a single client + date range. The
// browser opens it and the user can Ctrl+P → Save as PDF. Mirrors the
// template from v2 billing-routes.ts:19-128 exactly.

const invoiceQuery = z.object({
  clientId: z.coerce.number().int().positive(),
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
});

function escHtml(s: string | number | null | undefined): string {
  const str = s === null || s === undefined ? '' : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/invoice', zValidator('query', invoiceQuery), async (c) => {
  const { clientId, dateFrom, dateTo } = c.req.valid('query');

  const clientRow = await db.execute<{ id: number; name: string }>(
    sql`select id, name from clients where id = ${clientId} limit 1`
  );
  if (!clientRow.length) return c.text('Client not found', 404);

  const summaryRow = await db.execute<{
    pickpack_total: string;
    additional_total: string;
    package_total: string;
    shipping_total: string;
    storage_total: string;
    order_count: number;
    grand_total: string;
  }>(sql`
    select
      coalesce(sum(case when line_type = 'pick_pack' then total_cost else 0 end), 0)::text as pickpack_total,
      coalesce(sum(case when line_type = 'additional' then total_cost else 0 end), 0)::text as additional_total,
      coalesce(sum(case when line_type = 'package' then total_cost else 0 end), 0)::text as package_total,
      coalesce(sum(case when line_type = 'shipping' then total_cost else 0 end), 0)::text as shipping_total,
      coalesce(sum(case when line_type = 'storage' then total_cost else 0 end), 0)::text as storage_total,
      count(distinct case when line_type = 'pick_pack' then order_id end)::int as order_count,
      coalesce(sum(total_cost), 0)::text as grand_total
    from billing_line_items
    where client_id = ${clientId}
      and ship_date >= ${dateFrom}::timestamptz
      and ship_date <= ${dateTo}::timestamptz
  `);
  const s = summaryRow[0];

  const details = await db.execute<{
    order_id: number | null;
    order_number: string | null;
    ship_date: string | null;
    base_qty: string;
    addl_qty: string;
    pickpack_amt: string;
    additional_amt: string;
    shipping_amt: string;
    storage_amt: string;
    row_total: string;
    skus: string | null;
  }>(sql`
    select
      b.order_id,
      b.order_number,
      to_char(b.ship_date, 'YYYY-MM-DD') as ship_date,
      coalesce(sum(case when b.line_type = 'pick_pack' then b.qty else 0 end), 0)::text as base_qty,
      coalesce(sum(case when b.line_type = 'additional' then b.qty else 0 end), 0)::text as addl_qty,
      coalesce(sum(case when b.line_type = 'pick_pack' then b.total_cost else 0 end), 0)::text as pickpack_amt,
      coalesce(sum(case when b.line_type = 'additional' then b.total_cost else 0 end), 0)::text as additional_amt,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_amt,
      coalesce(sum(case when b.line_type = 'storage' then b.total_cost else 0 end), 0)::text as storage_amt,
      sum(b.total_cost)::text as row_total,
      (
        select string_agg(item->>'sku', ', ')
        from orders o2, jsonb_array_elements(o2.items) item
        where o2.id = b.order_id
          and coalesce((item->>'adjustment')::boolean, false) = false
      ) as skus
    from billing_line_items b
    where b.client_id = ${clientId}
      and b.ship_date >= ${dateFrom}::timestamptz
      and b.ship_date <= ${dateTo}::timestamptz
    group by b.order_id, b.order_number, b.ship_date
    order by b.ship_date asc, b.order_id asc
  `);

  const fmt = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`;
  const fromDisplay = dateFrom.slice(0, 10);
  const toDisplay = dateTo.slice(0, 10);
  const generated = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const orderCount = s?.order_count ?? 0;
  const pickPackTotal = Number(s?.pickpack_total ?? 0);
  const additionalTotal = Number(s?.additional_total ?? 0);
  const packageTotal = Number(s?.package_total ?? 0);
  const shippingTotal = Number(s?.shipping_total ?? 0);
  const storageTotal = Number(s?.storage_total ?? 0);
  const grandTotal = Number(s?.grand_total ?? 0);
  const clientName = clientRow[0]!.name;

  const rowsHtml = details
    .map((d) => {
      const baseQty = Number(d.base_qty);
      const addlQty = Number(d.addl_qty);
      const pickpackAmt = Number(d.pickpack_amt);
      const additionalAmt = Number(d.additional_amt);
      const shippingAmt = Number(d.shipping_amt);
      const storageAmt = Number(d.storage_amt);
      const rowTotal = Number(d.row_total);
      return `
      <tr>
        <td>${escHtml(d.ship_date ?? '')}</td>
        <td class="mono">${escHtml(d.order_number ?? d.order_id ?? '')}</td>
        <td class="sku">${escHtml(d.skus ?? '—')}</td>
        <td class="num">${baseQty}</td>
        <td class="num">${fmt(pickpackAmt)}</td>
        <td class="num">${addlQty > 0 ? `${addlQty} (${fmt(additionalAmt)})` : '—'}</td>
        <td class="num">${shippingAmt > 0 ? fmt(shippingAmt) : '—'}</td>
        <td class="num">${storageAmt > 0 ? fmt(storageAmt) : '—'}</td>
        <td class="num bold">${fmt(rowTotal)}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invoice — ${escHtml(clientName)} — ${fromDisplay} to ${toDisplay}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #111; background: #fff; padding: 40px 48px; max-width: 1100px; margin: 0 auto; }
    .print-tip { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 10px 16px; margin-bottom: 24px; font-size: 12px; color: #1d4ed8; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 2px solid #e5e7eb; }
    .brand h1 { font-size: 22px; font-weight: 800; color: #111; letter-spacing: -.3px; }
    .brand .sub { font-size: 11px; color: #9ca3af; margin-top: 3px; }
    .meta { text-align: right; }
    .meta .client-name { font-size: 18px; font-weight: 700; color: #111; }
    .meta .date-range { font-size: 12px; color: #6b7280; margin-top: 2px; }
    .meta .gen-date { font-size: 10px; color: #9ca3af; margin-top: 2px; }
    .summary-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; }
    .card .cl { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 3px; }
    .card .cv { font-size: 16px; font-weight: 700; color: #111; }
    .grand-total { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .grand-total .gtl { font-size: 13px; font-weight: 600; color: #166534; }
    .grand-total .gtv { font-size: 24px; font-weight: 800; color: #166534; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th { background: #f9fafb; border: 1px solid #e5e7eb; padding: 7px 10px; font-weight: 700; color: #374151; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; }
    thead th.num { text-align: right; }
    tbody td { border: 1px solid #e5e7eb; padding: 6px 10px; color: #374151; vertical-align: middle; }
    tbody tr:nth-child(even) { background: #fafafa; }
    td.num { text-align: right; }
    td.mono { font-family: monospace; font-size: 11px; color: #2563eb; }
    td.sku { font-family: monospace; font-size: 10px; color: #6b7280; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.bold { font-weight: 700; }
    tfoot td { border: 1px solid #d1d5db; padding: 8px 10px; font-weight: 700; background: #f3f4f6; }
    tfoot td.num { text-align: right; }
    .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #9ca3af; text-align: center; }
  </style>
</head>
<body>
  <div class="print-tip">To save as PDF: press <strong>Ctrl+P</strong> or <strong>⌘P</strong>, then choose <strong>Save as PDF</strong>.</div>
  <div class="header">
    <div class="brand">
      <h1>Invoice</h1>
      <div class="sub">DR Prepper 3PL Services · 14924 S Figueroa St, Gardena CA 90248</div>
    </div>
    <div class="meta">
      <div class="client-name">Bill To: ${escHtml(clientName)}</div>
      <div class="date-range">Period: ${fromDisplay} → ${toDisplay}</div>
      <div class="gen-date">Generated ${generated}</div>
    </div>
  </div>
  <div class="summary-grid">
    <div class="card"><div class="cl">Orders</div><div class="cv">${orderCount}</div></div>
    <div class="card"><div class="cl">Pick &amp; Pack</div><div class="cv">${fmt(pickPackTotal)}</div></div>
    <div class="card"><div class="cl">Add'l Units</div><div class="cv">${fmt(additionalTotal)}</div></div>
    <div class="card"><div class="cl">Packages</div><div class="cv">${packageTotal > 0 ? fmt(packageTotal) : '—'}</div></div>
    <div class="card"><div class="cl">Shipping</div><div class="cv">${fmt(shippingTotal)}</div></div>
    <div class="card"><div class="cl">Storage</div><div class="cv">${storageTotal > 0 ? fmt(storageTotal) : '—'}</div></div>
  </div>
  <div class="grand-total">
    <div class="gtl">Total Amount Due — ${fromDisplay} → ${toDisplay}</div>
    <div class="gtv">${fmt(grandTotal)}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Ship Date</th>
        <th>Order #</th>
        <th>SKU(s)</th>
        <th class="num">Base Qty</th>
        <th class="num">Pick &amp; Pack</th>
        <th class="num">Add'l Units</th>
        <th class="num">Shipping</th>
        <th class="num">Storage</th>
        <th class="num">Row Total</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Totals — ${orderCount} orders</td>
        <td class="num">${fmt(pickPackTotal)}</td>
        <td class="num">${fmt(additionalTotal)}</td>
        <td class="num">${fmt(shippingTotal)}</td>
        <td class="num">${storageTotal > 0 ? fmt(storageTotal) : '—'}</td>
        <td class="num" style="font-size:14px">${fmt(grandTotal)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">PrepShip · Invoice generated ${generated} · Not a formal tax document · ${orderCount} orders · ${fromDisplay} → ${toDisplay}</div>
</body>
</html>`;

  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(html);
});

// ─── Client package prices ────────────────────────────────────────────

app.get(
  '/package-prices',
  zValidator('query', z.object({ clientId: z.coerce.number().int() })),
  async (c) => {
    const { clientId } = c.req.valid('query');
    const rows = await db
      .select()
      .from(clientPackagePrices)
      .where(eq(clientPackagePrices.clientId, clientId));
    return c.json({ data: rows });
  }
);

const pricesBody = z.object({
  clientId: z.number().int(),
  prices: z
    .array(
      z.object({
        packageId: z.number().int(),
        price: z.number().nonnegative(),
        isCustom: z.boolean().optional(),
      })
    )
    .min(1)
    .max(500),
});

app.put('/package-prices', zValidator('json', pricesBody), async (c) => {
  const { clientId, prices } = c.req.valid('json');
  let updated = 0;
  for (const row of prices) {
    await db
      .insert(clientPackagePrices)
      .values({
        clientId,
        packageId: row.packageId,
        price: row.price.toFixed(2),
        isCustom: row.isCustom ?? true,
      })
      .onConflictDoUpdate({
        target: [clientPackagePrices.clientId, clientPackagePrices.packageId],
        set: {
          price: row.price.toFixed(2),
          isCustom: row.isCustom ?? true,
          updatedAt: new Date(),
        },
      });
    updated += 1;
  }
  return c.json({ updated });
});

app.post(
  '/package-prices/set-default',
  zValidator(
    'json',
    z.object({ packageId: z.number().int(), price: z.number().nonnegative() })
  ),
  async (c) => {
    const { packageId, price } = c.req.valid('json');
    // Mark this package's default price across all clients that haven't
    // customized it.
    const result = await db
      .update(clientPackagePrices)
      .set({ price: price.toFixed(2), updatedAt: new Date() })
      .where(
        and(
          eq(clientPackagePrices.packageId, packageId),
          eq(clientPackagePrices.isCustom, false)
        )
      )
      .returning({ clientId: clientPackagePrices.clientId });
    return c.json({ updated: result.length, packageId, price });
  }
);

// ─── Reference rates ──────────────────────────────────────────────────
// CRUD only for now — actual fetch-from-RateShopper job lives in a
// follow-up. Backfill endpoint accepts a manual array of rates.

app.get(
  '/ref-rates',
  zValidator(
    'query',
    z.object({
      weightOz: z.coerce.number().optional(),
      zipTo: z.string().optional(),
      carrier: z.string().optional(),
    })
  ),
  async (c) => {
    const q = c.req.valid('query');
    const conditions = [
      q.weightOz !== undefined ? eq(billingRefRates.weightOz, q.weightOz) : undefined,
      q.zipTo ? eq(billingRefRates.zipTo, q.zipTo.toUpperCase()) : undefined,
      q.carrier ? eq(billingRefRates.carrier, q.carrier) : undefined,
    ].filter(<T>(x: T | undefined): x is T => x !== undefined);
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db
      .select()
      .from(billingRefRates)
      .where(where)
      .orderBy(asc(billingRefRates.weightOz), asc(billingRefRates.zipTo))
      .limit(500);
    return c.json({ data: rows });
  }
);

const refRatesUpsertBody = z.object({
  rates: z
    .array(
      z.object({
        weightOz: z.number().int().nonnegative(),
        zipTo: z.string(),
        carrier: z.string(),
        service: z.string().nullable().optional(),
        cost: z.number().nonnegative(),
        source: z.string().nullable().optional(),
      })
    )
    .min(1)
    .max(1000),
});

// Unified backfill endpoint — accepts two shapes:
//
//   A) { rates: [{weightOz, zipTo, carrier, ...}] }  → manual CSV upload
//      Inserts those rates directly into billing_ref_rates.
//
//   B) { from, to, clientId? }                       → cache-driven backfill
//      Walks orders in the range missing ref_usps_rate / ref_ups_rate,
//      looks them up in billing_ref_rates by (weight, zip5), and saves
//      the cheapest USPS + UPS rates onto order_overrides. Returns the
//      {ok, filled, missing, total, message?} shape the BillingView
//      expects (mirrors v2's backfillReferenceRates).
app.post('/backfill-ref-rates', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  // Shape A: explicit rates array
  if (Array.isArray(body?.rates) && body.rates.length) {
    const parsed = refRatesUpsertBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    }
    await db.insert(billingRefRates).values(
      parsed.data.rates.map((r) => ({
        weightOz: r.weightOz,
        zipTo: r.zipTo.toUpperCase(),
        carrier: r.carrier,
        service: r.service ?? null,
        cost: r.cost.toFixed(2),
        source: r.source ?? 'manual',
        fetchedAt: new Date(),
      }))
    );
    return c.json({ ok: true, inserted: parsed.data.rates.length });
  }

  // Shape B: range-driven cache backfill
  const from = typeof body?.from === 'string' ? body.from : null;
  const to = typeof body?.to === 'string' ? body.to : null;
  const clientId =
    typeof body?.clientId === 'number' && body.clientId > 0
      ? body.clientId
      : null;

  const orders_missing = await db.execute<{
    order_id: number;
    weight_oz: number | null;
    zip5: string | null;
  }>(sql`
    select o.id as order_id, o.weight_oz as weight_oz,
           substring(regexp_replace(coalesce(o.ship_to_postal_code, ''), '\\D', '', 'g') from 1 for 5) as zip5
    from orders o
    left join order_overrides ov on ov.order_id = o.id
    where (ov.ref_usps_rate is null or ov.ref_ups_rate is null)
      and o.weight_oz is not null
      and o.ship_to_postal_code is not null
      ${from ? sql`and o.order_date >= ${from}::timestamptz` : sql``}
      ${to ? sql`and o.order_date <= ${to}::timestamptz` : sql``}
      ${clientId ? sql`and o.client_id = ${clientId}` : sql``}
    limit 5000
  `);

  if (orders_missing.length === 0) {
    return c.json({
      ok: true,
      filled: 0,
      missing: 0,
      total: 0,
      message: 'All orders already have reference rates',
    });
  }

  let filled = 0;
  let missing = 0;

  for (const row of orders_missing) {
    const weightOz = Math.round(Number(row.weight_oz ?? 1));
    const zip5 = row.zip5 ?? '';
    if (!zip5 || zip5.length !== 5) {
      missing += 1;
      continue;
    }

    const cached = await db.execute<{
      carrier: string;
      cost: string;
    }>(sql`
      select carrier, cost from billing_ref_rates
      where weight_oz = ${weightOz} and zip_to = ${zip5}
      order by fetched_at desc
      limit 20
    `);

    if (!cached.length) {
      missing += 1;
      continue;
    }

    let bestUsps: number | null = null;
    let bestUps: number | null = null;
    for (const r of cached) {
      const cost = Number(r.cost);
      const carrier = (r.carrier || '').toLowerCase();
      if (carrier.includes('usps') || carrier.includes('stamps')) {
        if (bestUsps === null || cost < bestUsps) bestUsps = cost;
      } else if (carrier.includes('ups')) {
        if (bestUps === null || cost < bestUps) bestUps = cost;
      }
    }

    if (bestUsps === null && bestUps === null) {
      missing += 1;
      continue;
    }

    await db.execute(sql`
      insert into order_overrides (order_id, ref_usps_rate, ref_ups_rate, updated_at)
      values (${row.order_id}, ${bestUsps?.toFixed(2) ?? null}, ${bestUps?.toFixed(2) ?? null}, now())
      on conflict (order_id) do update set
        ref_usps_rate = coalesce(order_overrides.ref_usps_rate, excluded.ref_usps_rate),
        ref_ups_rate = coalesce(order_overrides.ref_ups_rate, excluded.ref_ups_rate),
        updated_at = now()
    `);
    filled += 1;
  }

  return c.json({
    ok: true,
    filled,
    missing,
    total: orders_missing.length,
  });
});


// Live rate-shopper job — walks recent shipments, calls ShipStation for the
// cheapest rate per carrier at the same weight+zip, stores in billing_ref_rates.
// Used by the billing UI to compare "what did we pay" vs "what we could've paid".
app.post(
  '/fetch-ref-rates',
  zValidator(
    'json',
    z
      .object({
        daysBack: z.number().int().positive().max(180).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      })
      .optional()
  ),
  async (c) => {
    const body = c.req.valid('json') ?? {};
    const { startRefRatesFetch, getActiveRefRatesJob } = await import(
      '../services/ref-rates-fetch'
    );
    const existing = getActiveRefRatesJob();
    if (existing && existing.status === 'running') {
      return c.json({
        ok: false,
        message: 'Already running',
        jobId: existing.jobId,
        total: existing.total,
        orders: existing.total,
        queued: existing.total,
      });
    }
    const job = startRefRatesFetch(body);
    // job.total isn't populated until the job's first tick; best-effort
    // fill from the current state. Frontend polls /status for the real
    // numbers as the worker progresses.
    return c.json({
      ok: true,
      jobId: job.jobId,
      status: job.status,
      total: job.total,
      orders: job.total,
      queued: job.total,
    });
  }
);

// Response shape: {running, done, total, errors, status, message, totalRefRates}
// — matches v2's BillingReferenceRateFetchStatusDto so the frontend's
// progress + done toasts render with real numbers instead of "undefined".
app.get('/fetch-ref-rates/status', async (c) => {
  const [{ getActiveRefRatesJob }, rows] = await Promise.all([
    import('../services/ref-rates-fetch'),
    db.select({ count: sql<number>`count(*)::int` }).from(billingRefRates),
  ]);
  const job = getActiveRefRatesJob();
  const isRunning = job?.status === 'running' || job?.status === 'pending';
  return c.json({
    running: isRunning,
    done: job?.processed ?? 0,
    total: job?.total ?? 0,
    errors: job?.failed ?? 0,
    inserted: job?.inserted ?? 0,
    status: job?.status ?? 'idle',
    message: job?.message ?? null,
    error: job?.error ?? null,
    failureSamples: job?.failureSamples ?? [],
    totalRefRates: rows[0]?.count ?? 0,
    job,
  });
});

export default app;
