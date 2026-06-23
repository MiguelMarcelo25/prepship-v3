import { Hono, type Context } from 'hono';
import { normalizeScopeIds, intArraySql } from '../lib/scope-sql';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  billingBoxResolutions,
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
  ensureBillingBoxResolutionsSchema,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';
import { shippingMarginAnalytics } from '../services/shipping-margin-analytics';
import { houseAccountEnabledClientIds } from '../services/house-account-opt-in';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { billingDayRange, formatBillingDay } from '../lib/time/billing-day';
import { requirePermission } from '../middleware/auth';
// PS-234: durable audit trail for billing generation.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
// PS-132: synthetic/system clients excluded from Config + Summary grids — single source.
import { SYSTEM_CLIENT_NAMES } from '../lib/system-clients';
// PS-134: reference-rate backfill ETL is owned by the billing service.
import { backfillReferenceRates } from '../services/billing-ref-rates';
// PS-275: durable, reversible prep-fee waiver state ($0-shipping review).
import { upsertBillingFeeWaiver, readBillingFeeWaivers } from '../services/billing-fee-waiver-store';
import { PREP_FEE_LINE_TYPES } from '../services/billing-shipping-policy';
import { summarizeBillingItemsForDetail } from '../services/billing-detail-utils';
// PS-468: CSV export of the SAME invoice dataset — thin serializer, no fork.
import { renderInvoiceCsv } from './billing-invoice-csv';
// PS-275 item 2: the shared owner of the prep-fee WAIVER indicator (column
// title + per-row marker + period note) so the HTML/XLSX/CSV exports render it
// identically off the fee_waived flag billingInvoiceData stamps from the SOT.
import {
  WAIVED_COLUMN_HEADER,
  waivedCellText,
  waivedSummaryNote,
} from './billing-invoice-waiver-indicator';

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

  // PS-220 (P4): the house-account opt-in flag lives off the drizzle schema (raw SQL), so enrich
  // the grid here. Best-effort — an empty set just shows every toggle OFF.
  const houseAccountIds = await houseAccountEnabledClientIds();

  const data = rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    houseAccountEnabled: houseAccountIds.has(r.clientId),
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
  // PS-249 (Card 4): billing MUTATIONS require financials:write (read != write).
  requirePermission('financials:write'),
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
  // PS-207: optional operator note stored on the box resolution.
  note: z.string().max(500).optional(),
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

app.post('/generate', requirePermission('financials:write'), zValidator('json', generateSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await generateLineItems(withBillingScope(c, {
    clientId: body.clientId,
    dateFrom: body.dateFrom!,
    dateTo: body.dateTo!,
  }));
  // PS-234: audit billing generation (request facts only — no PII/secret values).
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'billing',
    resourceType: 'billing_generation',
    resourceId: body.clientId ?? null,
    action: 'generate',
    details: { clientId: body.clientId ?? null, dateFrom: body.dateFrom, dateTo: body.dateTo },
  });
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

app.get('/shipping-margin', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const analytics = await shippingMarginAnalytics(withBillingScope(c, {
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  }));
  return c.json({ data: analytics, ...analytics });
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

app.patch('/details/:orderId{[0-9]+}', requirePermission('financials:write'), zValidator('json', detailPatchSchema), async (c) => {
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
      packageId: billingLineItems.packageId,
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

  // PS-249 (Card 4): a single /details save edits MANY rows for one order — a
  // per-line update/insert loop, a packageId stamp, a box-resolution upsert, and
  // a missing-line cleanup. Pre-PS-249 these ran as separate statements, so a
  // mid-save failure left the order's billing TORN (some lines edited, others
  // not; box resolution maybe unwritten). Wrap them in ONE transaction so the
  // edit is all-or-nothing; reads inside run on `tx` for a consistent snapshot.
  // The idempotent CREATE-TABLE ensure is hoisted ABOVE the txn so DDL stays out
  // of the money transaction. Edits billing_line_items only — never
  // shipments.selectedPackageId (source of truth) — so this is NOT a shipped-data
  // change and needs no lockdown override.
  await ensureBillingBoxResolutionsSchema();

  await db.transaction(async (tx) => {
    // Only generated billing_line_items are changed here. Source order,
    // shipment, package, and marketplace fields remain read-only.
    for (const [bodyKey, lineType, description] of EDITABLE_BILLING_LINES) {
      const value = body[bodyKey];
      if (value === undefined) continue;

      const amount = money(value);
      const rows = await tx
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
        await tx.insert(billingLineItems).values({
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
      const pkgRows = await tx
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

    // ─── PS-207: persist the operator's box decision across regeneration ─────
    // A box change or a box-price change here IS a review resolution. It is
    // written to billing_box_resolutions (which range regeneration NEVER
    // touches) so the directive outlives the line items — pre-PS-207, manual
    // box-line edits were silently wiped by every regenerate.
    //
    // The modal always submits every field, so "decision" is detected by DIFF,
    // not presence: a box is a decision when it differs from the currently
    // stamped box; a price is a decision when it differs from the current
    // package_cost line. A price equal to the chosen box's CONFIGURED price is
    // the modal's autofill — store the box WITHOUT pinning the price, so later
    // client price changes still reflow this order on regenerate.
    {
      const submittedPkgId = body.packageId !== undefined ? body.packageId : undefined;
      const boxChanged =
        submittedPkgId !== undefined && (submittedPkgId ?? null) !== (base.packageId ?? null);

      const [currentPackageCostLine] = await tx
        .select({ totalCost: billingLineItems.totalCost })
        .from(billingLineItems)
        .where(
          and(
            eq(billingLineItems.clientId, body.clientId),
            eq(billingLineItems.orderId, orderId),
            eq(billingLineItems.lineType, 'package_cost')
          )
        )
        .limit(1);
      const currentBoxAmount = currentPackageCostLine
        ? money(Number(currentPackageCostLine.totalCost))
        : null;
      const priceChanged =
        body.packageCost !== undefined && money(body.packageCost) !== currentBoxAmount;

      if (boxChanged || priceChanged) {
        const [existing] = await tx
          .select()
          .from(billingBoxResolutions)
          .where(eq(billingBoxResolutions.orderId, orderId))
          .limit(1);

        const newPackageId =
          submittedPkgId !== undefined ? submittedPkgId : existing?.packageId ?? null;

        // Autofill detection: price equal to the chosen box's configured client
        // price means "price the box from config" — no override pin.
        let configuredRaw: string | null = null;
        if (newPackageId != null && body.packageCost !== undefined) {
          const [priceRow] = await tx
            .select({ price: clientPackagePrices.price })
            .from(clientPackagePrices)
            .where(
              and(
                eq(clientPackagePrices.clientId, body.clientId),
                eq(clientPackagePrices.packageId, newPackageId)
              )
            )
            .limit(1);
          configuredRaw = priceRow ? money(Number(priceRow.price)) : null;
        }
        const submittedAmount =
          body.packageCost !== undefined ? money(body.packageCost) : null;
        const isAutofillOfConfigured =
          submittedAmount !== null && configuredRaw !== null && submittedAmount === configuredRaw;

        const overridePrice = priceChanged && !isAutofillOfConfigured
          ? submittedAmount
          : boxChanged
            ? null
            : existing?.overridePrice ?? null;

        const resolvedBy = (c.get('email' as never) as string | undefined) ?? null;
        await tx
          .insert(billingBoxResolutions)
          .values({
            orderId,
            shipmentId: base.shipmentId,
            packageId: newPackageId,
            overridePrice,
            note: body.note ?? null,
            resolvedBy,
          })
          .onConflictDoUpdate({
            target: billingBoxResolutions.orderId,
            set: {
              shipmentId: base.shipmentId,
              packageId: newPackageId,
              overridePrice,
              ...(body.note !== undefined ? { note: body.note } : {}),
              resolvedBy,
              resolvedAt: new Date(),
              updatedAt: new Date(),
            },
          });

        // The review is resolved — convert the $0.00 package_cost_missing line
        // immediately (regeneration would also do it; this makes the modal save
        // take effect right away). The EDITABLE_BILLING_LINES loop above already
        // wrote the package_cost line itself.
        await tx
          .delete(billingLineItems)
          .where(
            and(
              eq(billingLineItems.clientId, body.clientId),
              eq(billingLineItems.orderId, orderId),
              eq(billingLineItems.lineType, 'package_cost_missing')
            )
          );
      }
    }
  });

  return c.json({ ok: true, orderId, clientId: body.clientId, updated, inserted });
});

// ─── PS-275: $0-shipping review → prep-fee waiver decision ──────────────────
// Thin POST that records the operator's review of a $0-shipping order. The
// DECISION (what may be waived) lives in the pure policy + the durable store;
// this route only validates auth/client-scope, captures the order's CURRENT
// prep total (so the waiver is reversible), and persists. It edits NO billing
// line itself — the next "Update Billing" regenerate applies the waiver via
// the generator's applyPrepFeeWaiver, so details/summary/exports stay in sync
// off the same data. Touches billing_fee_waivers only (never shipments / the
// shipped-data lock), so no lockdown override is needed.
const zeroShippingReviewSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  decision: z.enum(['waived', 'not_waived']),
  note: z.string().max(500).optional(),
});

const PREP_FEE_LINE_TYPE_LIST = [...PREP_FEE_LINE_TYPES];

app.post(
  '/zero-shipping-review/:orderId{[0-9]+}',
  requirePermission('financials:write'),
  zValidator('json', zeroShippingReviewSchema),
  async (c) => {
    const orderId = Number(c.req.param('orderId'));
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);

    // Scope gate — identical posture to the /details PATCH: the order must
    // belong to an active client this caller can see.
    const [base] = await db
      .select({ clientId: billingLineItems.clientId })
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

    // Capture the order's CURRENT prep total so the waiver is reversible
    // (clearing it restores the original charge on the next regenerate). The
    // prep line-type list is the pure policy module's canonical set.
    const [prepSumRow] = await db.execute<{ original_prep_amount: string | null }>(sql`
      select coalesce(sum(total_cost), 0)::text as original_prep_amount
      from billing_line_items
      where client_id = ${body.clientId}
        and order_id = ${orderId}
        and line_type in (${sql.join(PREP_FEE_LINE_TYPE_LIST.map((t) => sql`${t}`), sql`, `)})
    `);
    const originalPrepAmount = prepSumRow?.original_prep_amount != null
      ? Number(prepSumRow.original_prep_amount)
      : null;

    await upsertBillingFeeWaiver({
      orderId,
      decision: body.decision,
      reviewer: (c.get('email' as never) as string | undefined) ?? null,
      note: body.note ?? null,
      originalPrepAmount: Number.isFinite(originalPrepAmount as number) ? originalPrepAmount : null,
    });

    // PS-234: audit the decision (facts only — no PII/secret values).
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_fee_waiver',
      resourceId: orderId,
      action: body.decision,
      details: { clientId: body.clientId, orderId, decision: body.decision, originalPrepAmount },
    });

    return c.json({ ok: true, orderId, clientId: body.clientId, decision: body.decision });
  }
);

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

// PS-217: the renderer-facing per-order invoice row. box_cost is the BILLED
// package_cost line value (never a current price-table guess); box_label is the
// human-readable billed box; box_review marks an unresolved/mismatched box so
// the export shows the review reason instead of a silent blank.
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
  package_cost_amt: string;
  box_label: string;
  box_review: boolean;
  // PS-275 (item 2): true when this order's prep/fulfillment fee was WAIVED ($0-shipping review).
  // A pure READ of billing_fee_waivers — the dollar columns already reflect the regenerate; this
  // flag only drives a visible "Waived" indicator in the exports. False on every non-waived order.
  fee_waived: boolean;
};

// PS-217: the raw SQL shape billingInvoiceData fetches before box resolution.
// fee_waived is NOT from the SQL aggregate (it's a separate billing_fee_waivers read) — omit it here.
type InvoiceDetailSqlRow = Omit<InvoiceDetailRow, 'box_label' | 'box_review' | 'fee_waived'> & {
  billed_package_id: number | null;
  box_cost_desc: string | null;
  box_review_reason: string | null;
  // PS-310: raw per-SKU rows ({ sku, name, quantity }) fed to the canonical export
  // summarizer. `unknown` because summarizeBillingItemsForDetail validates shape itself.
  item_rows: unknown;
};

type InvoicePackageRecord = { name: string; length: number; width: number; height: number };

// PS-217: resolve the operator-facing billed box label with the documented
// precedence, all from the BILLED line items / the package_id PS-207 stamped on
// the order's lines — no shipment re-resolution, no current price-table lookup:
//   (1) the billed package name (+ dims) from the packages catalog;
//   (2) the package_cost line's "Box (...)" description;
//   (3) the package_cost_missing review reason (marked box_review);
//   (4) an em dash when there is no box evidence at all.
function resolveInvoiceBoxLabel(
  row: InvoiceDetailSqlRow,
  packagesById: Map<number, InvoicePackageRecord>,
): { box_label: string; box_review: boolean } {
  const pkg = row.billed_package_id != null ? packagesById.get(row.billed_package_id) : undefined;
  if (pkg?.name) {
    const fmtDim = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2))));
    const hasDims = pkg.length > 0 || pkg.width > 0 || pkg.height > 0;
    const dims = hasDims ? ` (${fmtDim(pkg.length)}x${fmtDim(pkg.width)}x${fmtDim(pkg.height)})` : '';
    return { box_label: `${pkg.name}${dims}`, box_review: false };
  }
  const parsed = row.box_cost_desc ? /^Box\s+\((.+)\)$/i.exec(row.box_cost_desc.trim()) : null;
  if (parsed?.[1]) return { box_label: parsed[1], box_review: false };
  if (row.box_review_reason && row.box_review_reason.trim()) {
    return { box_label: row.box_review_reason.trim(), box_review: true };
  }
  return { box_label: '—', box_review: false };
}

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

  const rawDetails = await db.execute<InvoiceDetailSqlRow>(sql`
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
      -- PS-217: the BILLED box cost is the generated package_cost line value for
      -- this order in the period — never the current package price table, and
      -- never the package_cost_missing $0.00 review rows. The stamped package_id
      -- (PS-207 puts the same billedPackageId on every line of the order) and the
      -- line descriptions carry the human box label + review reason.
      coalesce(sum(case when b.line_type = 'package_cost' then b.total_cost else 0 end), 0)::text as package_cost_amt,
      max(b.package_id) as billed_package_id,
      max(case when b.line_type = 'package_cost' then b.description else null end) as box_cost_desc,
      max(case when b.line_type = 'package_cost_missing' then b.description else null end) as box_review_reason,
      sum(b.total_cost)::text as row_total,
      (
        select string_agg(oi.sku, ', ' order by oi.line_index)
        from order_items oi
        where oi.order_id = b.order_id
          and oi.quantity > 0
      ) as skus,
      -- PS-310: per-SKU rows so the EXPORT reuses the SAME canonical summarizer the
      -- Billing detail SCREEN uses (summarizeBillingItemsForDetail) → ×N quantity +
      -- duplicate-SKU aggregation, and screen vs export can never drift. The bare
      -- skus column above stays as the fallback for orders with no order_items rows.
      (
        select coalesce(
          json_agg(
            json_build_object('sku', oi.sku, 'name', oi.name, 'quantity', oi.quantity)
            order by oi.line_index
          ),
          '[]'::json
        )
        from order_items oi
        where oi.order_id = b.order_id
          and oi.quantity > 0
      ) as item_rows
    from billing_line_items b
    where b.client_id = ${clientId}
      -- PS-208: identical date-only bounds as every billing endpoint — UTC
      -- midnight inclusive lower, EXCLUSIVE day-after upper.
      and b.ship_date >= ${dateFrom}::timestamptz
      and b.ship_date < ${dateTo}::timestamptz
    group by b.order_id, b.order_number, b.ship_date
    order by b.ship_date asc, b.order_id asc
  `);

  // PS-217: resolve the human-readable billed box from the stamped package_id.
  // packages is a shared catalog (no client_id column) — looking up names/dims
  // by id leaks no client scope, and the billed set is exactly the ids stamped
  // on this client's billed lines.
  const billedPackageIds = [
    ...new Set(rawDetails.map((r) => r.billed_package_id).filter((id): id is number => id != null)),
  ];
  const packagesById = new Map<number, InvoicePackageRecord>();
  if (billedPackageIds.length) {
    const pkgRows = await db.execute<{ id: number; name: string; length: number; width: number; height: number }>(sql`
      select id, name, length, width, height from packages where id = any(${intArraySql(billedPackageIds)})
    `);
    for (const p of pkgRows) {
      packagesById.set(p.id, { name: p.name, length: Number(p.length), width: Number(p.width), height: Number(p.height) });
    }
  }

  // PS-275 (item 2): surface the durable prep-fee WAIVER decision so the exports can show a "Waived"
  // indicator. Pure READ of billing_fee_waivers — the dollar columns ALREADY reflect the regenerate;
  // this never re-zeroes anything. Reads only orders already in the scoped detail set (no cross-client
  // leak). Default-inert: no waiver rows => fee_waived false everywhere (readBillingFeeWaivers returns
  // an empty Map on none/error, never throwing into the export path).
  const waiverOrderIds = [
    ...new Set(rawDetails.map((r) => r.order_id).filter((id): id is number => id != null)),
  ];
  const feeWaiverByOrderId = await readBillingFeeWaivers(waiverOrderIds);

  const details: InvoiceDetailRow[] = rawDetails.map((r) => {
    const { box_label, box_review } = resolveInvoiceBoxLabel(r, packagesById);
    return {
      order_id: r.order_id,
      order_number: r.order_number,
      ship_date: r.ship_date,
      base_qty: r.base_qty,
      addl_qty: r.addl_qty,
      pickpack_amt: r.pickpack_amt,
      additional_amt: r.additional_amt,
      shipping_amt: r.shipping_amt,
      storage_amt: r.storage_amt,
      row_total: r.row_total,
      // PS-310: build the export SKU string from the SAME summarizer the detail screen
      // uses (×N per SKU, duplicate aggregation); fall back to the bare string_agg when
      // the order has no order_items rows so legacy/imported orders still show their SKUs.
      skus: summarizeBillingItemsForDetail(r.item_rows).itemSkus ?? r.skus,
      package_cost_amt: r.package_cost_amt,
      box_label,
      box_review,
      fee_waived: r.order_id != null && feeWaiverByOrderId.get(r.order_id)?.decision === 'waived',
    };
  });

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

  // PS-275 item 2: count the orders whose prep fee was WAIVED so the invoice can
  // show a period note without adding a trailing per-row waiver column. Default-inert:
  // 0 waived => waiverNote is '' and no note is rendered.
  const waivedCount = details.filter((d) => d.fee_waived).length;
  const waiverNote = waivedSummaryNote(waivedCount);

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
        <td class="ship-date">${escHtml(shipDate)}</td>
        <td class="mono">${escHtml(d.order_number ?? d.order_id ?? '')}</td>
        <td class="sku">${escHtml(d.skus ?? '—')}</td>
        <td${d.box_review ? ' class="review"' : ''}>${escHtml(d.box_label)}</td>
        <td class="num">${Number(d.package_cost_amt) > 0 ? fmt(d.package_cost_amt) : '—'}</td>
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
    th.ship-date, td.ship-date { width: 118px; min-width: 118px; white-space: nowrap; }
    tbody td { border: 1px solid #e5e7eb; padding: 6px 10px; color: #374151; vertical-align: middle; }
    tbody tr:nth-child(even) { background: #fafafa; }
    td.num { text-align: right; }
    td.mono { font-family: monospace; font-size: 11px; color: #2563eb; }
    td.sku { font-family: monospace; font-size: 10px; color: #6b7280; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    td.bold { font-weight: 700; }
    td.review { color: #b45309; font-size: 11px; }
    .waiver-note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 8px 14px; margin-bottom: 16px; font-size: 11px; color: #92400e; }
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
  ${waiverNote ? `<div class="waiver-note">${escHtml(waiverNote)}</div>` : ''}
  <table>
    <thead>
      <tr>
        <th class="ship-date">Ship Date</th>
        <th>Order #</th>
        <th>SKU(s)</th>
        <th>Box Size</th>
        <th class="num">Box Cost</th>
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
        <td class="num">${packageTotal > 0 ? fmt(packageTotal) : '—'}</td>
        <td></td>
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
  // PS-275 item 2: orders whose prep fee was WAIVED (for the per-row marker +
  // the Summary-sheet note). Default-inert: 0 waived => no note added.
  const waivedCount = details.filter((d) => d.fee_waived).length;
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
  // PS-275 item 2: a Summary-sheet note when any prep fee was waived this period
  // (in addition to the per-row "Waived" marker on the Line Items sheet).
  if (waivedCount > 0) {
    summary.addRow([]);
    const note = addSummaryRow('Prep fee waivers', waivedSummaryNote(waivedCount));
    note.getCell(2).font = { italic: true };
  }

  // ── Sheet 2: Line Items (one row per order, mirroring the HTML table) ──
  const items = workbook.addWorksheet('Line Items', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  items.columns = [
    { header: 'Ship Date', key: 'shipDate', width: 14, style: { numFmt: DATE_FMT } },
    { header: 'Order #', key: 'orderNumber', width: 20 },
    { header: 'SKUs', key: 'skus', width: 40 },
    // PS-217: billed box size (display) + billed box cost (the package_cost line).
    { header: 'Box Size', key: 'boxSize', width: 22 },
    { header: 'Box Cost', key: 'boxCost', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Pick & Pack Fee', key: 'pickPackFee', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Additional Units', key: 'additional', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Shipping', key: 'shipping', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Storage', key: 'storage', width: 12, style: { numFmt: MONEY_FMT } },
    { header: 'Total', key: 'total', width: 14, style: { numFmt: MONEY_FMT } },
    // PS-275 item 2: the prep-fee waiver indicator — "Waived" for a waived
    // order, blank otherwise (so a waived $0 is distinct from a genuine $0).
    { header: WAIVED_COLUMN_HEADER, key: 'waiver', width: 16 },
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
      boxSize: d.box_label,
      boxCost: Number(d.package_cost_amt),
      qty: baseQty + addlQty,
      pickPackFee: pickPackFeeAmt,
      additional: addlQty > 0 ? Number(d.additional_amt) : 0,
      shipping: shippingAmt,
      storage: storageAmt,
      total: rowTotal > 0 ? rowTotal : pickPackFeeAmt + shippingAmt + storageAmt,
      waiver: waivedCellText(d.fee_waived),
    });
  }
  if (details.length) {
    const first = 2;
    const last = first + details.length - 1;
    const totalsRow = items.addRow({
      skus: `Totals — ${totals.orderCount} orders`,
      // PS-217: two columns (Box Size = D, Box Cost = E) were inserted before
      // Qty, shifting every numeric column right by two. Box Cost totals in
      // column E; Qty→F, Pick&Pack→G, Additional→H, Shipping→I, Storage→J,
      // Total→K. Box Cost is DISPLAY-ONLY — it is already inside each row's
      // Total (row_total sums all line types incl. package_cost), so the Total
      // SUM is unchanged in meaning and box cost is never double-counted.
      boxCost: { formula: `SUM(E${first}:E${last})` },
      qty: { formula: `SUM(F${first}:F${last})` },
      pickPackFee: { formula: `SUM(G${first}:G${last})` },
      additional: { formula: `SUM(H${first}:H${last})` },
      shipping: { formula: `SUM(I${first}:I${last})` },
      storage: { formula: `SUM(J${first}:J${last})` },
      total: { formula: `SUM(K${first}:K${last})` },
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

// ─── Invoice (CSV) ────────────────────────────────────────────────────
// PS-468: CSV export of the SAME invoice. Consumes billingInvoiceData — the
// exact dataset behind the HTML + XLSX exports (no forked query) — and
// serializes data.details via renderInvoiceCsv, whose column derivation is
// IDENTICAL to the XLSX Line Items sheet. Auth (financials:read), client-scope
// and financial-visibility gating are exactly the XLSX route's.

app.get('/invoice.csv', zValidator('query', invoiceQuery), async (c) => {
  const { clientId, dateFrom, dateTo } = c.req.valid('query');
  const range = billingDayRange(dateFrom, dateTo);
  if (!range) return c.text('Invalid dateFrom/dateTo — expected YYYY-MM-DD', 400);
  const invoiceScope = billingScopeFromContext(c);
  const data = await billingInvoiceData(invoiceScope, clientId, range.fromUtc, range.toUtcExclusive);
  if (!data) return c.text('Client not found', 404);
  const csv = renderInvoiceCsv(data.details);
  const safeClient = data.clientName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || String(clientId);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="invoice-${safeClient}-${range.fromDay}-${range.toDay}.csv"`,
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

app.put('/package-prices', requirePermission('financials:write'), zValidator('json', pricesBody), async (c) => {
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
  requirePermission('financials:write'),
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
app.post('/backfill-ref-rates', requirePermission('financials:write'), async (c) => {
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
  requirePermission('financials:write'),
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
