import { Hono, type Context } from 'hono';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingConfig,
  billingLineItems,
  billingRefRates,
  clientPackagePrices,
} from '../db/schema/billing';
import { clients } from '../db/schema/clients';
import {
  billingDetails,
  billingGenerationStatus,
  billingInvoiceHeaderTotals,
  billingSummary,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { billingDayRange, formatBillingDay } from '../lib/time/billing-day';
import { requirePermission } from '../middleware/auth';
// PS-132: synthetic/system clients excluded from Config + Summary grids — single source.
import { SYSTEM_CLIENT_NAMES } from '../lib/system-clients';
// PS-134: reference-rate backfill ETL is owned by the billing service.
import { backfillReferenceRates } from '../services/billing-ref-rates';

const app = new Hono();

app.use('*', requirePermission('financials:read'));

function billingScopeFromContext(c: Context): ClientStoreScope {
  return getClientStoreScope({
    email: c.get('email' as never) as string | undefined,
    role: c.get('role' as never) as string | undefined,
    permissions: c.get('permissions' as never) as string[] | undefined,
    clientIds: c.get('clientIds' as never) as number[] | undefined,
    storeIds: c.get('storeIds' as never) as number[] | undefined,
  });
}

function billingClientScopePredicate(scope: ClientStoreScope): SQL {
  if (scope.isGlobal) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(scope.clientIds);
  const storeIds = normalizeScopeIds(scope.storeIds);

  if (clientIds.length) {
    predicates.push(sql`${clients.id} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`${clients.storeIds} && ${intArraySql(storeIds)}`);
  }
  if (!predicates.length) {
    return scope.isRestricted ? sql`false` : sql`true`;
  }
  if (predicates.length === 1) return predicates[0]!;
  return sql`(${sql.join(predicates, sql` or `)})`;
}

function withBillingScope<T extends object>(c: Context, q: T): T & {
  scopeClientIds: number[];
  scopeStoreIds: number[];
  scopeIsGlobal: boolean;
  scopeRestricted: boolean;
} {
  const scope = billingScopeFromContext(c);
  return {
    ...q,
    scopeClientIds: scope.clientIds,
    scopeStoreIds: scope.storeIds,
    scopeIsGlobal: scope.isGlobal,
    scopeRestricted: scope.isRestricted,
  };
}

app.get('/config', async (c) => {
  const configScope = billingScopeFromContext(c);
  // v2 parity: the Config grid is keyed on `clients`, not `billing_config`.
  // Every active non-system client appears — clients without a billing_config
  // row surface with defaults (pickPackFee: 0, pickPackMaxUnits: 1, etc.) so
  // the user can fill them in. Previously v4 used INNER JOIN which silently
  // dropped clients that had never been configured (TEST_CLIENT_998,
  // TEST_DUAL_WRITE, TEST_SCHEMA3_DW_FULL in the screenshot).
  const rows = await db
    .select({
      clientId: clients.id,
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
    .from(clients)
    .leftJoin(billingConfig, eq(billingConfig.clientId, clients.id))
    .where(
      and(
        eq(clients.active, true),
        notInArray(clients.name, SYSTEM_CLIENT_NAMES),
        billingClientScopePredicate(configScope)
      )
    )
    .orderBy(asc(clients.name));

  const data = rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    pickPackFee: r.pickPackFee ?? '0.00',
    pickPackMaxUnits: r.pickPackMaxUnits ?? 1,
    additionalUnitFee: r.additionalUnitFee ?? '0.00',
    packageCostMarkup: r.packageCostMarkup ?? '0.00',
    shippingMarkupPct: r.shippingMarkupPct ?? '0.00',
    shippingMarkupFlat: r.shippingMarkupFlat ?? '0.00',
    storageFeePerCuFt: r.storageFeePerCuFt ?? '0.0000',
    billingMode: r.billingMode ?? 'per_shipment',
    active: r.active ?? true,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return c.json({ data });
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
    .enum(['per_shipment', 'monthly', 'label_cost', 'ss_ref_rate', 'reference_rate'])
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

// PS-208: billing ranges are CALENDAR DAYS (the canonical owner is
// src/lib/time/billing-day.ts). Accepts v2's short names (from/to) and v4's
// long names (dateFrom/dateTo), plain YYYY-MM-DD or legacy ISO instants — in
// every shape the LEADING date is the operator-picked day. The transform
// yields UTC-midnight bounds (dateTo EXCLUSIVE: first day AFTER the range) so
// every billing endpoint agrees on exactly which days belong to the month;
// the previous California-day coercion EXCLUDED UTC-midnight rows like
// 2026-05-01T00:00:00Z from May.
const generateRawSchema = z.object({
  clientId: z.coerce.number().int().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
const generateSchema = generateRawSchema
  .transform((v) => {
    const range = billingDayRange(v.dateFrom ?? v.from ?? '', v.dateTo ?? v.to ?? '');
    return {
      clientId: v.clientId,
      dateFrom: range?.fromUtc,
      dateTo: range?.toUtcExclusive,
      fromDay: range?.fromDay,
      toDay: range?.toDay,
    };
  })
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

const detailsSchema = generateRawSchema
  .extend({ limit: z.coerce.number().int().max(2000).optional() })
  .transform((v) => {
    const range = billingDayRange(v.dateFrom ?? v.from ?? '', v.dateTo ?? v.to ?? '');
    return {
      clientId: v.clientId,
      dateFrom: range?.fromUtc,
      dateTo: range?.toUtcExclusive,
      limit: v.limit,
    };
  })
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

const detailPatchSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  pickPack: z.coerce.number().nonnegative().optional(),
  additional: z.coerce.number().nonnegative().optional(),
  packageCost: z.coerce.number().nonnegative().optional(),
  shipping: z.coerce.number().nonnegative().optional(),
  // PS — billing-line-only box override. When provided, stamp this package id
  // on the order's billing lines so the box name/dims reflect the chosen box
  // (never touches the shipment's selectedPackageId). null clears the override.
  packageId: z.coerce.number().int().positive().nullable().optional(),
});

const EDITABLE_BILLING_LINES = [
  ['pickPack', 'pick_pack', 'Pick & Pack'],
  ['additional', 'additional_unit', 'Additional Units'],
  ['packageCost', 'package_cost', 'Package Cost'],
  ['shipping', 'shipping', 'Shipping'],
] as const;

function money(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

app.post('/generate', zValidator('json', generateSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await generateLineItems(withBillingScope(c, {
    clientId: body.clientId,
    dateFrom: body.dateFrom!,
    dateTo: body.dateTo!,
  }));
  return c.json(result);
});

app.get('/generate/status', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const result = await billingGenerationStatus(withBillingScope(c, {
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  }));
  return c.json(result);
});

app.get('/summary', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const summary = await billingSummary(withBillingScope(c, {
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  }));
  // v2 parity: the primary consumer (v2 BillingView via v2-apiClient shim)
  // reads `data: []` as a flat list with clientName + per-type totals.
  // Keep `clients` + `grandTotal` around for back-compat with the old v4
  // `pages/Billing.tsx` that still reads them.
  return c.json({
    data: summary.clients,
    clients: summary.clients,
    grandTotal: summary.grandTotal,
  });
});

app.get('/details', zValidator('query', detailsSchema), async (c) => {
  const q = c.req.valid('query');
  const rows = await billingDetails(withBillingScope(c, {
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
    limit: q.limit,
  }));
  return c.json({ data: rows });
});

// ─── Invoice (HTML) ────────────────────────────────────────────────────
// v2-parity: GET /billing/invoice?clientId=N&dateFrom=ISO&dateTo=ISO
// Returns a full HTML invoice for a single client + date range. The
// browser opens it and the user can Ctrl+P → Save as PDF. Mirrors the
// template from v2 billing-routes.ts:19-128 exactly.

app.patch('/details/:orderId{[0-9]+}', zValidator('json', detailPatchSchema), async (c) => {
  const orderId = Number(c.req.param('orderId'));
  const body = c.req.valid('json');
  const scope = billingScopeFromContext(c);

  const [base] = await db
    .select({
      id: billingLineItems.id,
      clientId: billingLineItems.clientId,
      orderId: billingLineItems.orderId,
      orderNumber: billingLineItems.orderNumber,
      shipmentId: billingLineItems.shipmentId,
      shipDate: billingLineItems.shipDate,
    })
    .from(billingLineItems)
    .innerJoin(clients, eq(billingLineItems.clientId, clients.id))
    .where(
      and(
        eq(billingLineItems.clientId, body.clientId),
        eq(billingLineItems.orderId, orderId),
        eq(clients.active, true),
        billingClientScopePredicate(scope)
      )
    )
    .limit(1);

  if (!base) return c.json({ error: 'Billing line item not found' }, 404);

  let updated = 0;
  let inserted = 0;

  // Only generated billing_line_items are changed here. Source order,
  // shipment, package, and marketplace fields remain read-only.
  for (const [bodyKey, lineType, description] of EDITABLE_BILLING_LINES) {
    const value = body[bodyKey];
    if (value === undefined) continue;

    const amount = money(value);
    const rows = await db
      .update(billingLineItems)
      .set({
        qty: '1.00',
        unitCost: amount,
        totalCost: amount,
      })
      .where(
        and(
          eq(billingLineItems.clientId, body.clientId),
          eq(billingLineItems.orderId, orderId),
          eq(billingLineItems.lineType, lineType)
        )
      )
      .returning({ id: billingLineItems.id });

    updated += rows.length;

    if (rows.length === 0 && value > 0) {
      await db.insert(billingLineItems).values({
        clientId: body.clientId,
        orderId,
        orderNumber: base.orderNumber,
        shipmentId: base.shipmentId,
        shipDate: base.shipDate,
        lineType,
        description,
        qty: '1.00',
        unitCost: amount,
        totalCost: amount,
      });
      inserted += 1;
    }
  }

  // PS — billing-line-only Box Size override. Stamp the chosen package id on
  // every billing line for this order so billingDetails renders the new box
  // name/dims. Does NOT touch shipments.selectedPackageId (source of truth).
  if (body.packageId !== undefined) {
    const pkgRows = await db
      .update(billingLineItems)
      .set({ packageId: body.packageId })
      .where(
        and(
          eq(billingLineItems.clientId, body.clientId),
          eq(billingLineItems.orderId, orderId)
        )
      )
      .returning({ id: billingLineItems.id });
    updated += pkgRows.length;
  }

  return c.json({ ok: true, orderId, clientId: body.clientId, updated, inserted });
});

// PS-208: accept plain YYYY-MM-DD (canonical) AND legacy ISO instants — the
// route normalizes through billingDayRange like every other billing endpoint.
const invoiceQuery = z.object({
  clientId: z.coerce.number().int().positive(),
  dateFrom: z.string().min(10),
  dateTo: z.string().min(10),
});

function escHtml(s: string | number | null | undefined): string {
  const str = s === null || s === undefined ? '' : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// PS-208: invoice dates are CALENDAR DAYS — formatted by formatBillingDay
// (component split, no Date round-trip, no timezone). The old
// formatInvoiceDate here converted to America/Los_Angeles, which shifted a
// UTC-midnight May 1 row to "April 30" — and stacked on the SQL-side LA
// conversion it rendered April 29 (SP6447: stored 2026-05-04, displayed
// May 02). Deleted; nothing in billing may timezone-convert a ship day.

type InvoiceTotals = {
  orderCount: number;
  pickPackTotal: number;
  additionalTotal: number;
  pickPackFeeTotal: number;
  packageTotal: number;
  shippingTotal: number;
  storageTotal: number;
  grandTotal: number;
  fulfillmentFeeTotal: number;
};

type InvoiceDetailRow = {
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
};

// PS-134 (slice 2, extract-only): the /invoice DATA layer. Runs the invoice's OWN summary +
// per-order aggregates VERBATIM (full-precision ::text sums, raw ::timestamptz bounds, client_id
// scope behind the billingClientScopePredicate(invoiceScope) gate). NOT delegated to billingSummary()
// — that unify is a contingent, customer-facing $ behavior change (client-scope filter + date-key
// granularity divergences) deferred per scoping. Kept in routes/billing.ts so the billing scope
// guard's pinned literals stay in-file. Returns null when the client is out of scope (route -> 404).
async function billingInvoiceData(
  invoiceScope: ReturnType<typeof billingScopeFromContext>,
  clientId: number,
  dateFrom: string,
  dateTo: string,
): Promise<{ clientName: string; totals: InvoiceTotals; details: InvoiceDetailRow[] } | null> {
  const clientRow = await db.execute<{ id: number; name: string }>(
    sql`
      select id, name from clients
      where id = ${clientId}
        and active = true
        and ${billingClientScopePredicate(invoiceScope)}
      limit 1
    `
  );
  if (!clientRow.length) return null;

  // PS-134 (slice 2): the invoice HEADER totals are now owned by the billing service
  // (billingInvoiceHeaderTotals — the same aggregate SQL, co-located with billingSummary as the
  // single source of truth). Byte-identical to the prior inline query. The per-order breakdown
  // below stays here (billingSummary/the service has no per-order representation to delegate to).
  const totals = await billingInvoiceHeaderTotals(clientId, dateFrom, dateTo);

  const details = await db.execute<InvoiceDetailRow>(sql`
    select
      b.order_id,
      b.order_number,
      -- PS-208: ship_date is a calendar day stored at UTC midnight — extract
      -- the day AT UTC. The previous America/Los_Angeles conversion turned a
      -- May 1 row into April 30 before display even started.
      to_char(b.ship_date at time zone 'UTC', 'YYYY-MM-DD') as ship_date,
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then b.qty else 0 end), 0)::text as base_qty,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then b.qty else 0 end), 0)::text as addl_qty,
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then b.total_cost else 0 end), 0)::text as pickpack_amt,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then b.total_cost else 0 end), 0)::text as additional_amt,
      coalesce(sum(case when b.line_type = 'shipping' then b.total_cost else 0 end), 0)::text as shipping_amt,
      coalesce(sum(case when b.line_type = 'storage' then b.total_cost else 0 end), 0)::text as storage_amt,
      sum(b.total_cost)::text as row_total,
      (
        select string_agg(oi.sku, ', ' order by oi.line_index)
        from order_items oi
        where oi.order_id = b.order_id
          and oi.quantity > 0
      ) as skus
    from billing_line_items b
    where b.client_id = ${clientId}
      -- PS-208: identical date-only bounds as every billing endpoint — UTC
      -- midnight inclusive lower, EXCLUSIVE day-after upper.
      and b.ship_date >= ${dateFrom}::timestamptz
      and b.ship_date < ${dateTo}::timestamptz
    group by b.order_id, b.order_number, b.ship_date
    order by b.ship_date asc, b.order_id asc
  `);

  return {
    clientName: clientRow[0]!.name,
    totals,
    details,
  };
}

// PS-134 (slice 2, extract-only): pure HTML renderer — behavior-identical to the prior inline
// template (fmt / >0 dash guards / `|| grandTotal` fallbacks / escHtml call sites kept verbatim;
// the guard-pinned `const totalQty = baseQty + addlQty`, `<th class="num">Qty</th>`, and addl-fee
// ternary stay in-file). `generated` (Date.now()) is computed once per render, same as before.
function renderInvoiceHtml(args: {
  clientName: string;
  /** PS-208: the operator-picked calendar days (plain YYYY-MM-DD), not instants. */
  fromDay: string;
  toDay: string;
  totals: InvoiceTotals;
  details: InvoiceDetailRow[];
}): string {
  const { clientName, fromDay, toDay, totals, details } = args;
  const {
    orderCount,
    additionalTotal,
    pickPackFeeTotal,
    packageTotal,
    shippingTotal,
    storageTotal,
    grandTotal,
    fulfillmentFeeTotal,
  } = totals;
  const fmt = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`;
  // PS-208: header shows the operator-picked days verbatim — "May 01, 2026 →
  // May 31, 2026" for a 05/01→05/31 selection, never the previous day.
  const fromDisplay = formatBillingDay(fromDay);
  const toDisplay = formatBillingDay(toDay);
  const generated = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const rowsHtml = details
    .map((d) => {
      const baseQty = Number(d.base_qty);
      const addlQty = Number(d.addl_qty);
      const totalQty = baseQty + addlQty;
      const pickpackAmt = Number(d.pickpack_amt);
      const additionalAmt = Number(d.additional_amt);
      const pickPackFeeAmt = pickpackAmt + additionalAmt;
      const shippingAmt = Number(d.shipping_amt);
      const storageAmt = Number(d.storage_amt);
      const rowTotal = Number(d.row_total);
      const fulfillmentFeeAmt = rowTotal > 0
        ? rowTotal
        : pickPackFeeAmt + shippingAmt + storageAmt;
      const shipDate = formatBillingDay(d.ship_date);
      return `
      <tr>
        <td>${escHtml(shipDate)}</td>
        <td class="mono">${escHtml(d.order_number ?? d.order_id ?? '')}</td>
        <td class="sku">${escHtml(d.skus ?? '—')}</td>
        <td class="num">${totalQty}</td>
        <td class="num">${fmt(pickPackFeeAmt)}</td>
        <td class="num">${addlQty > 0 ? fmt(additionalAmt) : '—'}</td>
        <td class="num">${shippingAmt > 0 ? fmt(shippingAmt) : '—'}</td>
        <td class="num">${storageAmt > 0 ? fmt(storageAmt) : '—'}</td>
        <td class="num bold">${fmt(fulfillmentFeeAmt)}</td>
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
    .summary-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin-bottom: 20px; }
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
    <div class="card"><div class="cl">Pick &amp; Pack</div><div class="cv">${fmt(pickPackFeeTotal)}</div></div>
    <div class="card"><div class="cl">Add'l Units</div><div class="cv">${fmt(additionalTotal)}</div></div>
    <div class="card"><div class="cl">Packages</div><div class="cv">${packageTotal > 0 ? fmt(packageTotal) : '—'}</div></div>
    <div class="card"><div class="cl">Shipping</div><div class="cv">${fmt(shippingTotal)}</div></div>
    <div class="card"><div class="cl">Storage</div><div class="cv">${storageTotal > 0 ? fmt(storageTotal) : '—'}</div></div>
    <div class="card"><div class="cl">Fulfillment Fee</div><div class="cv">${fmt(fulfillmentFeeTotal || grandTotal)}</div></div>
  </div>
  <div class="grand-total">
    <div class="gtl">Total Amount Due — ${fromDisplay} → ${toDisplay}</div>
    <div class="gtv">${fmt(fulfillmentFeeTotal || grandTotal)}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Ship Date</th>
        <th>Order #</th>
        <th>SKU(s)</th>
        <th class="num">Qty</th>
        <th class="num">Pick &amp; Pack</th>
        <th class="num">Add'l Units</th>
        <th class="num">Shipping</th>
        <th class="num">Storage</th>
        <th class="num">Fulfillment Fee</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="4">Totals — ${orderCount} orders</td>
        <td class="num">${fmt(pickPackFeeTotal)}</td>
        <td class="num">${fmt(additionalTotal)}</td>
        <td class="num">${fmt(shippingTotal)}</td>
        <td class="num">${storageTotal > 0 ? fmt(storageTotal) : '—'}</td>
        <td class="num" style="font-size:14px">${fmt(fulfillmentFeeTotal || grandTotal)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">PrepShip · Invoice generated ${generated} · Not a formal tax document · ${orderCount} orders · ${fromDisplay} → ${toDisplay}</div>
</body>
</html>`;

  return html;
}

app.get('/invoice', zValidator('query', invoiceQuery), async (c) => {
  const { clientId, dateFrom, dateTo } = c.req.valid('query');
  // PS-208: normalize to canonical calendar-day bounds (UTC midnight, upper
  // EXCLUSIVE) — the same range semantics as /generate, /summary, /details.
  const range = billingDayRange(dateFrom, dateTo);
  if (!range) return c.text('Invalid dateFrom/dateTo — expected YYYY-MM-DD', 400);
  const invoiceScope = billingScopeFromContext(c);
  const data = await billingInvoiceData(invoiceScope, clientId, range.fromUtc, range.toUtcExclusive);
  if (!data) return c.text('Client not found', 404);
  const html = renderInvoiceHtml({
    clientName: data.clientName,
    fromDay: range.fromDay,
    toDay: range.toDay,
    totals: data.totals,
    details: data.details,
  });
  c.header('Content-Type', 'text/html; charset=utf-8');
  return c.body(html);
});

// ─── Invoice (XLSX) ───────────────────────────────────────────────────
// PS-208: Excel export of the SAME invoice. Built from billingInvoiceData —
// the exact dataset behind the HTML invoice (no forked query, so the two
// exports can never disagree about rows, totals, or which days are in range).

/** UTC-midnight Date for a YYYY-MM-DD day. exceljs serializes Date cells via
 * pure epoch math (dateToExcel = 25569 + ms/86400000), so a UTC-midnight Date
 * renders as exactly that calendar day in Excel on every machine. */
function excelDayCell(day: string | null | undefined): Date | string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day ?? ''));
  if (!match) return String(day ?? '');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

async function renderInvoiceXlsx(args: {
  clientName: string;
  fromDay: string;
  toDay: string;
  totals: InvoiceTotals;
  details: InvoiceDetailRow[];
}): Promise<Buffer> {
  // Lazy import: exceljs is heavy and only this route needs it.
  const { default: ExcelJS } = await import('exceljs');
  const { clientName, fromDay, toDay, totals, details } = args;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PrepShip';

  const MONEY_FMT = '"$"#,##0.00';
  const DATE_FMT = 'mmm dd, yyyy';

  // ── Sheet 1: Summary ──
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 26 }, { width: 22 }];
  const addSummaryRow = (label: string, value: unknown, fmt?: string) => {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (fmt) row.getCell(2).numFmt = fmt;
    return row;
  };
  addSummaryRow('Client', clientName);
  addSummaryRow('Period start', excelDayCell(fromDay), DATE_FMT);
  addSummaryRow('Period end', excelDayCell(toDay), DATE_FMT);
  addSummaryRow('Orders', totals.orderCount);
  summary.addRow([]);
  addSummaryRow('Pick & Pack fees', totals.pickPackFeeTotal, MONEY_FMT);
  addSummaryRow('Additional units', totals.additionalTotal, MONEY_FMT);
  addSummaryRow('Package cost', totals.packageTotal, MONEY_FMT);
  addSummaryRow('Shipping', totals.shippingTotal, MONEY_FMT);
  addSummaryRow('Storage', totals.storageTotal, MONEY_FMT);
  // Same fallback as the HTML tfoot: fulfillmentFeeTotal || grandTotal.
  const grand = addSummaryRow('Total', totals.fulfillmentFeeTotal || totals.grandTotal, MONEY_FMT);
  grand.getCell(2).font = { bold: true };

  // ── Sheet 2: Line Items (one row per order, mirroring the HTML table) ──
  const items = workbook.addWorksheet('Line Items', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  items.columns = [
    { header: 'Ship Date', key: 'shipDate', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Order #', key: 'orderNumber', width: 20 },
    { header: 'SKUs', key: 'skus', width: 40 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Pick & Pack Fee', key: 'pickPackFee', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Additional Units', key: 'additional', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Shipping', key: 'shipping', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Storage', key: 'storage', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: MONEY_FMT } },
  ];
  items.getRow(1).font = { bold: true };
  for (const d of details) {
    // Identical derivation to the HTML rows — qty/fee composition and the
    // rowTotal>0 fallback must stay in lockstep with renderInvoiceHtml.
    const baseQty = Number(d.base_qty);
    const addlQty = Number(d.addl_qty);
    const pickPackFeeAmt = Number(d.pickpack_amt) + Number(d.additional_amt);
    const shippingAmt = Number(d.shipping_amt);
    const storageAmt = Number(d.storage_amt);
    const rowTotal = Number(d.row_total);
    items.addRow({
      shipDate: excelDayCell(d.ship_date),
      orderNumber: String(d.order_number ?? d.order_id ?? ''),
      skus: d.skus ?? '',
      qty: baseQty + addlQty,
      pickPackFee: pickPackFeeAmt,
      additional: addlQty > 0 ? Number(d.additional_amt) : 0,
      shipping: shippingAmt,
      storage: storageAmt,
      total: rowTotal > 0 ? rowTotal : pickPackFeeAmt + shippingAmt + storageAmt,
    });
  }
  if (details.length) {
    const first = 2;
    const last = first + details.length - 1;
    const totalsRow = items.addRow({
      skus: `Totals — ${totals.orderCount} orders`,
      qty: { formula: `SUM(D${first}:D${last})` },
      pickPackFee: { formula: `SUM(E${first}:E${last})` },
      additional: { formula: `SUM(F${first}:F${last})` },
      shipping: { formula: `SUM(G${first}:G${last})` },
      storage: { formula: `SUM(H${first}:H${last})` },
      total: { formula: `SUM(I${first}:I${last})` },
    });
    totalsRow.font = { bold: true };
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

app.get('/invoice.xlsx', zValidator('query', invoiceQuery), async (c) => {
  const { clientId, dateFrom, dateTo } = c.req.valid('query');
  const range = billingDayRange(dateFrom, dateTo);
  if (!range) return c.text('Invalid dateFrom/dateTo — expected YYYY-MM-DD', 400);
  const invoiceScope = billingScopeFromContext(c);
  const data = await billingInvoiceData(invoiceScope, clientId, range.fromUtc, range.toUtcExclusive);
  if (!data) return c.text('Client not found', 404);
  const bytes = await renderInvoiceXlsx({
    clientName: data.clientName,
    fromDay: range.fromDay,
    toDay: range.toDay,
    totals: data.totals,
    details: data.details,
  });
  const safeClient = data.clientName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || String(clientId);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="invoice-${safeClient}-${range.fromDay}-${range.toDay}.xlsx"`,
      'content-length': String(bytes.byteLength),
      'x-content-type-options': 'nosniff',
    },
  });
});

// ─── Client package prices ────────────────────────────────────────────

app.get(
  '/package-prices',
  zValidator('query', z.object({ clientId: z.coerce.number().int() })),
  async (c) => {
    const { clientId } = c.req.valid('query');
    const packagePriceScope = billingScopeFromContext(c);
    const packagePriceScopePredicate = billingClientScopePredicate(packagePriceScope);
    const rows = await db
      .select()
      .from(clientPackagePrices)
      .where(
        and(
          eq(clientPackagePrices.clientId, clientId),
          sql`exists (
            select 1 from ${clients}
            where ${clients.id} = ${clientPackagePrices.clientId}
              and ${packagePriceScopePredicate}
          )`
        )
      );
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

  // Shape B: range-driven cache backfill — PS-134: owned by the billing service.
  const result = await backfillReferenceRates({
    from: typeof body?.from === 'string' ? body.from : null,
    to: typeof body?.to === 'string' ? body.to : null,
    clientId:
      typeof body?.clientId === 'number' && body.clientId > 0 ? body.clientId : null,
  });
  return c.json(result);
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
  const [{ getActiveRefRatesJob, getLatestRefRatesJobSnapshot }, rows] = await Promise.all([
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
    durableJob: await getLatestRefRatesJobSnapshot(),
  });
});

export default app;
