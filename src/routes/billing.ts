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
  billingStorageProof,
  clientPackagePrices,
} from '../db/schema/billing';
import { clients } from '../db/schema/clients';
import { packages } from '../db/schema/packages';
import { shipments } from '../db/schema/shipments';
import {
  billingDetails,
  billingGenerationStatus,
  billingSummary,
  ensureBillingBoxResolutionsSchema,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';
import { billingInvoiceHeaderTotals } from '../services/billing-invoice-totals';
import { resolveBillingInvoiceRowTotal } from '../services/billing-invoice-row-total';
import { shippingMarginAnalytics } from '../services/shipping-margin-analytics';
import { houseAccountEnabledClientIds, shippingMarginPolicyModeFromEnabled } from '../services/house-account-opt-in';
import { getClientStoreScope, type ClientStoreScope } from '../lib/client-store-scope';
import { billingDayRange, formatBillingDay } from '../lib/time/billing-day';
import { billingLineEffectiveDaySql } from '../services/billing-calendar-policy';
import { logStructured, reportError } from '../lib/structured-log';
import { requirePermission } from '../middleware/auth';
// PS-234: durable audit trail for billing generation.
import { recordAuditEvent, auditActorFromContext } from '../services/audit-log';
// PS-132: synthetic/system clients excluded from Config + Summary grids — single source.
import { SYSTEM_CLIENT_NAMES } from '../lib/system-clients';
// PS-134: reference-rate backfill ETL is owned by the billing service.
import { backfillReferenceRates } from '../services/billing-ref-rates';
import { upsertBillingReferenceRates } from '../services/billing-ref-rate-store';
// PS-275/PS-389: durable, reversible prep-fee waiver state.
import {
  ensureBillingFeeWaiverSchema,
  upsertBillingFeeWaiver,
  readBillingFeeWaivers,
} from '../services/billing-fee-waiver-store';
import {
  ensureBillingManualOverridesSchema,
  upsertBillingManualOverride,
  type ManualBillingOverrideLineType,
} from '../services/billing-manual-overrides';
import { PREP_FEE_LINE_TYPES } from '../services/billing-shipping-policy';
import { summarizeBillingItemsForDetail } from '../services/billing-detail-utils';
import {
  asBillingCloseWorkflowError,
  assertBillingOrdersEditable,
  BillingFinalizedLockError,
  createBillingCreditNote,
  ensureBillingFinalizationPolicySchema,
  finalizeBillingPeriod,
  isBillingFinalizedLockError,
  listBillingCreditNotes,
  listBillingFinalizations,
  setBillingOrdersDirty,
} from '../services/billing-finalization-policy';
import { previewBulkBoxCost, applyBulkBoxCostResolutions } from '../services/billing-box-cost-bulk';
import { resolveBillingRowStatus } from '../services/billing-row-status';
import {
  cancelledNoChargeBillingAmountSql,
  isCancelledBillingStatus,
} from '../services/billing-cancelled-no-charge';
import {
  resolveShippedPackageId,
  resolvedPackageDisplayName,
  type BoxLookups,
} from '../services/billing-box-policy';
// PS-311b: the dims-based companion — sweep the SAME unmatched box size across a date range.
import { previewBulkBoxCostByDims, applyBulkBoxCostByDimsResolutions, revertBulkBoxCostByDimsResolutions } from '../services/billing-box-cost-by-dims';
import { clientUsedPackagePricingRows } from '../services/billing-client-package-pricing';
import {
  applyHugrabBillingShippingFloor,
  HugrabBillingShippingFloorCountMismatchError,
  listHugrabBillingShippingFloorCandidates,
} from '../services/hugrab-billing-shipping-floor';
import {
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
  DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
  ensureHugrabShippingRateOverrideColumns,
  hugrabShippingRateOverrideConfigsByClientId,
  setClientHugrabShippingRateOverrideConfig,
} from '../services/billing-hugrab-shipping-rate-override';
// PS-468: CSV export of the SAME invoice dataset — thin serializer, no fork.
import { renderInvoiceCsv } from './billing-invoice-csv';
import {
  INVOICE_SHIP_DATE_HEADER,
  INVOICE_XLSX_SHIP_DATE_HEADER,
  invoiceBillingActivityDateCell,
  invoiceOneLineCell,
  invoiceShipDateTimeCell,
} from './billing-invoice-text';
import { applyInvoiceXlsxReadableLayout } from './billing-invoice-xlsx-layout';
import { invoiceCarrierCell } from './billing-invoice-xlsx-row';
// PS-275 item 2: the shared owner of the prep-fee WAIVER period note rendered
// from the fee_waived flag billingInvoiceData stamps from the SOT.
import { waivedSummaryNote } from './billing-invoice-waiver-indicator';
import {
  isBillingRegenerationBlockedError,
  requireBillingRegenerationRead,
} from '../services/billing-regeneration-readiness';
import { isBillingCalendarPolicyError } from '../services/billing-calendar-policy';
import {
  resolveBillingPresetWindow,
  type BillingWindowPreset,
} from '../services/reporting-window-presets';

const app = new Hono();

app.use('*', requirePermission('financials:read'));

const billingPresetWindowQuery = z.object({
  preset: z.enum(['all', 'this_month', 'last_month', 'last_30', 'last_90']),
});

app.get('/preset-window', zValidator('query', billingPresetWindowQuery), (c) => {
  const { preset } = c.req.valid('query');
  return c.json(resolveBillingPresetWindow(preset as BillingWindowPreset));
});

function billingOrderIdFromPath(path: string): number | null {
  const match = /\/(?:details|zero-shipping-review)\/(\d+)(?:\/|$)/.exec(path);
  if (!match) return null;
  const orderId = Number(match[1]);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

app.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    const path = new URL(c.req.url).pathname;
    const logFields = {
      method: c.req.method,
      path,
      orderId: billingOrderIdFromPath(path),
    };
    // Per user override unlock shipped data on 2026-07-11: PS-416 exposes the
    // backend block without letting callers proceed with shipped billing.
    if (isBillingRegenerationBlockedError(error)) {
      logStructured('warn', 'billing.request.rejected', {
        ...logFields,
        status: 503,
        errorCode: error.code,
      });
      return c.json({
        error: error.message,
        code: error.code,
        regenerationAllowed: error.regenerationAllowed,
        source: error.source,
      }, 503);
    }
    if (isBillingCalendarPolicyError(error)) {
      logStructured('warn', 'billing.request.rejected', {
        ...logFields,
        status: error.status,
        errorCode: error.code,
      });
      return c.json({
        error: error.message,
        code: error.code,
        operationDay: error.operationDay,
      }, error.status);
    }
    const closeError = asBillingCloseWorkflowError(error);
    if (closeError) {
      logStructured('warn', 'billing.request.rejected', {
        ...logFields,
        status: closeError.status,
        errorCode: closeError.code,
      });
      return c.json({
        error: closeError.message,
        code: closeError.code,
        ...closeError.details,
      }, closeError.status);
    }
    if (!isBillingFinalizedLockError(error)) {
      reportError('billing.request.failed', error, logFields);
      throw error;
    }
    const lockError = error instanceof BillingFinalizedLockError
      ? error
      : new BillingFinalizedLockError();
    logStructured('warn', 'billing.request.rejected', {
      ...logFields,
      status: 409,
      errorCode: lockError.code,
    });
    return c.json({
      error: lockError.message,
      code: lockError.code,
      finalized: true,
      finalizedOrderIds: lockError.finalizedOrderIds,
    }, 409);
  }
});

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

async function canAccessBillingClient(clientId: number, scope: ClientStoreScope): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), billingClientScopePredicate(scope)))
    .limit(1);
  return Boolean(row);
}

// Like billingClientScopePredicate, but keyed on billing_line_items.client_id — for queries that
// SELECT FROM billing_line_items WITHOUT joining `clients`. The storeIds branch wraps `clients` in an
// EXISTS subquery so that table is referenced only INSIDE the subquery (valid regardless of the outer
// FROM). The box-cost bulk/by-dims queries never join `clients`, so they MUST use this variant — the
// clients-rooted billingClientScopePredicate would raise "missing FROM-clause entry for table clients"
// for any restricted (non-global) caller. (PS-311b review fix; mirrors billingLineItemScopePredicate
// in services/billing.ts.)
function billingLineItemClientScopePredicate(scope: ClientStoreScope): SQL {
  if (scope.isGlobal) return sql`true`;

  const predicates: SQL[] = [];
  const clientIds = normalizeScopeIds(scope.clientIds);
  const storeIds = normalizeScopeIds(scope.storeIds);

  if (clientIds.length) {
    predicates.push(sql`${billingLineItems.clientId} = any(${intArraySql(clientIds)})`);
  }
  if (storeIds.length) {
    predicates.push(sql`exists (
      select 1 from clients scoped_client
      where scoped_client.id = ${billingLineItems.clientId}
        and scoped_client.store_ids && ${intArraySql(storeIds)}
    )`);
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
  await ensureHugrabShippingRateOverrideColumns();
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
  const hugrabOverrideByClient = await hugrabShippingRateOverrideConfigsByClientId(rows.map((r) => r.clientId));

  const data = rows.map((r) => {
    const houseAccountEnabled = houseAccountIds.has(r.clientId);
    const hugrabOverride = hugrabOverrideByClient.get(r.clientId) ?? {
      enabled: String(r.clientName ?? '').trim().toUpperCase() === 'HUGRAB',
      threshold: DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_THRESHOLD,
      amount: DEFAULT_HUGRAB_SHIPPING_RATE_OVERRIDE_AMOUNT,
    };
    return {
      clientId: r.clientId,
      clientName: r.clientName,
      houseAccountEnabled,
      shippingMarginPolicyMode: shippingMarginPolicyModeFromEnabled(houseAccountEnabled),
      hugrabShippingRateOverrideEnabled: hugrabOverride.enabled,
      hugrabShippingRateOverrideThreshold: hugrabOverride.threshold.toFixed(2),
      hugrabShippingRateOverrideAmount: hugrabOverride.amount.toFixed(2),
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
    };
  });
  return c.json({ data });
});

const configBody = z.object({
  pickPackFee: z.coerce.number().nonnegative().optional(),
  pickPackMaxUnits: z.coerce.number().int().positive().optional(),
  additionalUnitFee: z.coerce.number().nonnegative().optional(),
  packageCostMarkup: z.coerce.number().nonnegative().optional(),
  shippingMarkupPct: z.coerce.number().nonnegative().optional(),
  shippingMarkupFlat: z.coerce.number().nonnegative().optional(),
  hugrabShippingRateOverrideEnabled: z.boolean().optional(),
  hugrabShippingRateOverrideThreshold: z.coerce.number().positive().optional(),
  hugrabShippingRateOverrideAmount: z.coerce.number().positive().optional(),
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
    // Audit B-6 (2026-07-13): financials:write alone is not enough — a
    // client-scoped operator must not rewrite another tenant's fee schedule.
    // Same scope gate as PUT /package-prices.
    const configScope = billingScopeFromContext(c);
    if (!(await canAccessBillingClient(clientId, configScope))) {
      return c.json({ error: 'Client not found' }, 404);
    }
    const body = c.req.valid('json');
    // Audit B-7 (2026-07-13): fee-schedule changes are money-determining and were
    // unaudited — capture before/after so invoice-total changes are explainable.
    const [beforeConfig] = await db
      .select()
      .from(billingConfig)
      .where(eq(billingConfig.clientId, clientId))
      .limit(1);
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
    const hasHugrabOverridePatch =
      body.hugrabShippingRateOverrideEnabled !== undefined ||
      body.hugrabShippingRateOverrideThreshold !== undefined ||
      body.hugrabShippingRateOverrideAmount !== undefined;
    const hugrabOverride = hasHugrabOverridePatch
      ? await setClientHugrabShippingRateOverrideConfig(clientId, {
          enabled: body.hugrabShippingRateOverrideEnabled,
          threshold: body.hugrabShippingRateOverrideThreshold,
          amount: body.hugrabShippingRateOverrideAmount,
        })
      : (await hugrabShippingRateOverrideConfigsByClientId([clientId])).get(clientId);
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_config',
      resourceId: clientId,
      action: 'config_upsert',
      details: {
        clientId,
        before: beforeConfig ?? null,
        after: row,
        submitted: body,
      },
    });
    return c.json({
      ...row,
      ...(hugrabOverride ? {
        hugrabShippingRateOverrideEnabled: hugrabOverride.enabled,
        hugrabShippingRateOverrideThreshold: hugrabOverride.threshold.toFixed(2),
        hugrabShippingRateOverrideAmount: hugrabOverride.amount.toFixed(2),
      } : {}),
    });
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
function parseClientIds(raw: string | null | undefined): number[] | undefined {
  const ids = String(raw ?? '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return ids.length ? [...new Set(ids)] : undefined;
}

const generateRawSchema = z.object({
  clientId: z.coerce.number().int().optional(),
  clientIds: z.string().optional(),
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
      clientIds: parseClientIds(v.clientIds),
      dateFrom: range?.fromUtc,
      dateTo: range?.toUtcExclusive,
      fromDay: range?.fromDay,
      toDay: range?.toDay,
    };
  })
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

const finalizeRawSchema = generateRawSchema.extend({
  clientId: z.coerce.number().int().positive(),
});
const finalizeSchema = finalizeRawSchema
  .transform((v) => {
    const range = billingDayRange(v.dateFrom ?? v.from ?? '', v.dateTo ?? v.to ?? '');
    return {
      clientId: v.clientId,
      dateFrom: range?.fromUtc,
      dateTo: range?.toUtcExclusive,
    };
  })
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom/from and dateTo/to are required',
  });

const creditNoteSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  finalizationId: z.string().trim().min(1).max(100),
  amount: z.union([z.string(), z.number()]).transform((value) => String(value)),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(100),
});

const creditNoteQuerySchema = z.object({
  clientId: z.coerce.number().int().positive(),
  finalizationId: z.string().trim().min(1).max(100),
});

const detailsSchema = generateRawSchema
  .transform((v) => {
    const range = billingDayRange(v.dateFrom ?? v.from ?? '', v.dateTo ?? v.to ?? '');
    return {
      clientId: v.clientId,
      clientIds: parseClientIds(v.clientIds),
      dateFrom: range?.fromUtc,
      dateTo: range?.toUtcExclusive,
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

const hugrabShippingFloorRawSchema = z.object({
  action: z.enum(['floor', 'revert']).default('floor'),
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1),
  selectedRateBelow: z.coerce.number().positive().optional(),
  targetShipping: z.coerce.number().positive().optional(),
  apply: z.boolean().optional().default(false),
  expectedCount: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

function normalizeHugrabShippingFloorRange<T extends { dateFrom: string; dateTo: string }>(v: T) {
  const range = billingDayRange(v.dateFrom, v.dateTo);
  return { ...v, dateFrom: range?.fromUtc, dateTo: range?.toUtcExclusive };
}

const hugrabShippingFloorSchema = hugrabShippingFloorRawSchema
  .transform(normalizeHugrabShippingFloorRange)
  .refine((v) => v.dateFrom !== undefined && v.dateTo !== undefined, {
    message: 'dateFrom and dateTo are required (YYYY-MM-DD)',
  });

const EDITABLE_BILLING_LINES = [
  ['pickPack', 'pick_pack', 'Pick & Pack'],
  ['additional', 'additional_unit', 'Additional Units'],
  ['packageCost', 'package_cost', 'Package Cost'],
  ['shipping', 'shipping', 'Shipping'],
] as const;

const MANUAL_BILLING_OVERRIDE_LINES = [
  ['pickPack', 'pick_pack', 'Pick & Pack'],
  ['additional', 'additional_unit', 'Additional Units'],
  ['shipping', 'shipping', 'Shipping'],
] as const satisfies ReadonlyArray<readonly [keyof z.infer<typeof detailPatchSchema>, ManualBillingOverrideLineType, string]>;

function money(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

// Per user override unlock shipped data on 2026-07-16: billing generation remains
// canonical and scope-filtered; clients receive only the narrow generate
// capability, never financials:write.
app.post('/generate', requirePermission('billing:generate'), zValidator('json', generateSchema), async (c) => {
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

// Audit 3.6 / PS-412: period close is a backend-owned money mutation. The
// route supplies authenticated intent; the policy owner freezes the exact
// invoice dataset and writes the immutable close record in one transaction.
app.post(
  '/finalize',
  requirePermission('financials:write'),
  zValidator('json', finalizeSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    if (!(await canAccessBillingClient(body.clientId, scope))) {
      return c.json({ error: 'Client not found' }, 404);
    }
    const actor = auditActorFromContext(c);
    if (!actor.actorId) {
      return c.json({ error: 'Authenticated actor is required' }, 401);
    }
    const result = await finalizeBillingPeriod({
      clientId: body.clientId,
      dateFrom: body.dateFrom!,
      dateTo: body.dateTo!,
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
    });
    await recordAuditEvent({
      ...actor,
      eventType: 'billing',
      resourceType: 'billing_finalization',
      resourceId: result.finalization.id,
      action: result.alreadyFinalized ? 'period_finalize_replay' : 'period_finalize',
      details: {
        clientId: body.clientId,
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        lineCount: result.finalization.lineCount,
        orderCount: result.finalization.orderCount,
        subtotal: result.finalization.subtotal,
      },
    });
    return c.json({ data: result });
  },
);

app.get('/finalizations', zValidator('query', finalizeSchema), async (c) => {
  const query = c.req.valid('query');
  const scope = billingScopeFromContext(c);
  if (!(await canAccessBillingClient(query.clientId, scope))) {
    return c.json({ error: 'Client not found' }, 404);
  }
  const rows = await listBillingFinalizations({
    clientId: query.clientId,
    dateFrom: query.dateFrom!,
    dateTo: query.dateTo!,
  });
  return c.json({ data: rows });
});

// Corrections never rewrite an invoice. They append a reasoned, idempotent
// credit against the frozen close record and cannot exceed its balance.
app.post(
  '/credit-notes',
  requirePermission('financials:write'),
  zValidator('json', creditNoteSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    if (!(await canAccessBillingClient(body.clientId, scope))) {
      return c.json({ error: 'Client not found' }, 404);
    }
    const actor = auditActorFromContext(c);
    if (!actor.actorId) {
      return c.json({ error: 'Authenticated actor is required' }, 401);
    }
    const result = await createBillingCreditNote({
      ...body,
      actorId: actor.actorId,
      actorEmail: actor.actorEmail,
    });
    await recordAuditEvent({
      ...actor,
      eventType: 'billing',
      resourceType: 'billing_credit_note',
      resourceId: result.creditNote.id,
      action: result.alreadyCreated ? 'credit_note_replay' : 'credit_note_create',
      details: {
        clientId: body.clientId,
        finalizationId: body.finalizationId,
        amount: result.creditNote.amount,
      },
    });
    return c.json({ data: result });
  },
);

app.get('/credit-notes', zValidator('query', creditNoteQuerySchema), async (c) => {
  const query = c.req.valid('query');
  const scope = billingScopeFromContext(c);
  if (!(await canAccessBillingClient(query.clientId, scope))) {
    return c.json({ error: 'Client not found' }, 404);
  }
  const rows = await listBillingCreditNotes(query);
  return c.json({ data: rows });
});

app.get('/generate/status', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const result = await requireBillingRegenerationRead(
    'billing freshness status',
    () => billingGenerationStatus(withBillingScope(c, {
      clientId: q.clientId,
      dateFrom: q.dateFrom!,
      dateTo: q.dateTo!,
    })),
  );
  return c.json(result);
});

app.get('/summary', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const summary = await billingSummary(withBillingScope(c, {
    clientId: q.clientId,
    clientIds: q.clientIds,
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
    clientIds: q.clientIds,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  }));
  // The analytics object (summary + clients + carriers + the full rows array)
  // used to be serialized TWICE — under `data` AND spread at the top level.
  // The one consumer (v2-apiClient) reads `res?.data ?? res`, so `data` alone
  // halves the JSON work and response bytes for the largest billing payload.
  return c.json({ data: analytics });
});

app.get('/details', zValidator('query', detailsSchema), async (c) => {
  const q = c.req.valid('query');
  if (q.clientId != null && !(await canAccessBillingClient(q.clientId, billingScopeFromContext(c)))) {
    return c.json({ error: 'Billing details not found' }, 404);
  }
  const rows = await billingDetails(withBillingScope(c, {
    clientId: q.clientId,
    dateFrom: q.dateFrom!,
    dateTo: q.dateTo!,
  }));
  const totals = q.clientId == null
    ? null
    : await billingInvoiceHeaderTotals(q.clientId, q.dateFrom!, q.dateTo!);
  return c.json({ data: rows, totals });
});

// ─── Storage-fee PROOF drilldown (admin) ───────────────────────────────
// PS-373 (slice 2): return the FROZEN per-SKU / per-interval evidence behind a
// client's single storage line for a billing period. financials:read-gated (the
// global app.use above) + per-client scope. The period is matched on the SAME
// canonical UTC-midnight [dateFrom, dateTo) bounds generateSchema produces — the
// exact instants billing froze at generate time. The route only reads and
// returns the sidecar row; the FE renders it verbatim and never recomputes
// storage (the backend rate owner stays the source of truth).
app.get('/storage-proof', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  if (q.clientId == null) {
    return c.json({ error: 'clientId is required' }, 400);
  }
  const scope = billingScopeFromContext(c);
  if (!(await canAccessBillingClient(q.clientId, scope))) {
    // Same opaque 404 as other out-of-scope billing reads — don't leak existence.
    return c.json({ found: false, proof: null }, 404);
  }
  const [row] = await db
    .select()
    .from(billingStorageProof)
    .where(
      and(
        eq(billingStorageProof.clientId, q.clientId),
        sql`${billingStorageProof.periodStart} = ${q.dateFrom}::timestamptz`,
        sql`${billingStorageProof.periodEnd} = ${q.dateTo}::timestamptz`,
      ),
    )
    .limit(1);
  if (!row) {
    // 200 with found:false — a valid period that simply has no storage proof yet
    // (no storage rate, or billing not generated for this range). Not an error.
    return c.json({ found: false, proof: null });
  }
  return c.json({ found: true, ...row });
});

// ─── Invoice (HTML) ────────────────────────────────────────────────────
// v2-parity: GET /billing/invoice?clientId=N&dateFrom=ISO&dateTo=ISO
// Returns a full HTML invoice for a single client + date range. The
// browser opens it and the user can Ctrl+P → Save as PDF. Mirrors the
// template from v2 billing-routes.ts:19-128 exactly.

// HUGRAB-only bulk shipping adjustment for already-generated billing rows.
// Source-of-truth lives in src/services/hugrab-billing-shipping-floor.ts: the route only
// normalizes the calendar-day range, enforces write permission/scope, and delegates.
app.post(
  '/hugrab-shipping-floor',
  requirePermission('financials:write'),
  zValidator('json', hugrabShippingFloorSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const serviceScope = {
      action: body.action,
      dateFrom: body.dateFrom!,
      dateTo: body.dateTo!,
      selectedRateBelow: body.selectedRateBelow,
      targetShipping: body.targetShipping,
      limit: body.limit,
    };
    const clientScopePredicate = billingLineItemClientScopePredicate(scope);

    try {
      if (!body.apply) {
        const preview = await listHugrabBillingShippingFloorCandidates(serviceScope, clientScopePredicate);
        return c.json({ data: preview });
      }

      if (body.expectedCount === undefined) {
        return c.json({ error: 'expectedCount is required before applying HUGRAB billing changes. Preview first.' }, 400);
      }

      const result = await applyHugrabBillingShippingFloor(
        { ...serviceScope, expectedCount: body.expectedCount },
        clientScopePredicate,
      );

      await recordAuditEvent({
        eventType: 'billing',
        ...auditActorFromContext(c),
        resourceType: 'billing_hugrab_shipping_floor',
        resourceId: 'HUGRAB',
        action: body.action === 'revert' ? 'hugrab_shipping_floor_revert' : 'hugrab_shipping_floor_apply',
        details: {
          action: body.action,
          dateFrom: body.dateFrom,
          dateTo: body.dateTo,
          expectedCount: body.expectedCount,
          selectedRateBelow: result.selectedRateBelow,
          targetShipping: result.targetShipping,
          count: result.count,
          updatedCount: result.updatedCount,
          currentTotal: result.currentTotal,
          newTotal: result.newTotal,
          delta: result.delta,
        },
      });

      return c.json({ data: result });
    } catch (error) {
      if (error instanceof HugrabBillingShippingFloorCountMismatchError) {
        return c.json(
          {
            error: error.message,
            expectedCount: error.expectedCount,
            currentCount: error.currentCount,
          },
          409,
        );
      }
      throw error;
    }
  },
);

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
      billingEffectiveDate: billingLineItems.billingEffectiveDate,
      billingPolicyVersion: billingLineItems.billingPolicyVersion,
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
  const prepFeePatchTouched = body.pickPack !== undefined || body.additional !== undefined;
  const manualBillingPatchTouched =
    body.pickPack !== undefined ||
    body.additional !== undefined ||
    body.shipping !== undefined;
  const manualPrepFeeAuditRef: {
    current: {
      decision: 'waived' | 'not_waived';
      originalPrepAmount: number | null;
    } | null;
  } = { current: null };
  const manualBillingOverrideAuditRefs: Array<{
    lineType: ManualBillingOverrideLineType;
    amount: string;
    note: string | null;
  }> = [];
  // Audit B-7 (2026-07-13): box/price decisions overwrite billing_box_resolutions
  // in place — without an audit event the prior directive (packageId/overridePrice/
  // resolvedBy) was destroyed with no history, making "why did this invoice total
  // change between exports" unanswerable for box-driven changes.
  const boxResolutionAuditRef: {
    current: {
      before: { packageId: number | null; overridePrice: string | null; resolvedBy: string | null } | null;
      after: { packageId: number | null; overridePrice: string | null; note: string | null; resolvedBy: string | null };
    } | null;
  } = { current: null };

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
  await ensureBillingFinalizationPolicySchema();
  await ensureBillingBoxResolutionsSchema();
  if (prepFeePatchTouched) await ensureBillingFeeWaiverSchema();
  if (manualBillingPatchTouched) await ensureBillingManualOverridesSchema();

  await db.transaction(async (tx) => {
    await assertBillingOrdersEditable(
      {
        orderIds: [orderId],
        clientId: body.clientId,
        scopePredicate: billingLineItemClientScopePredicate(scope),
      },
      tx,
    );

    const [currentPackageCostLineBeforeEdit] = await tx
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
    const currentBoxAmountBeforeEdit = currentPackageCostLineBeforeEdit
      ? money(Number(currentPackageCostLineBeforeEdit.totalCost))
      : null;

    let manualPrepFeeDecision: 'waived' | 'not_waived' | null = null;
    let originalPrepAmount: number | null = null;
    if (prepFeePatchTouched) {
      const [prepSumRow] = await tx.execute<{ original_prep_amount: string | null }>(sql`
        select coalesce(sum(total_cost), 0)::text as original_prep_amount
        from billing_line_items
        where client_id = ${body.clientId}
          and order_id = ${orderId}
          and line_type in (${sql.join(PREP_FEE_LINE_TYPE_LIST.map((t) => sql`${t}`), sql`, `)})
      `);
      originalPrepAmount = prepSumRow?.original_prep_amount != null
        ? Number(prepSumRow.original_prep_amount)
        : null;

      // PS-389: a manual Pick & Pack $0 save is the same durable business
      // decision as the $0-shipping review waiver. A later positive prep edit
      // clears the waiver so regeneration does not silently re-zero the row.
      if (body.pickPack !== undefined && money(body.pickPack) === '0.00') {
        manualPrepFeeDecision = 'waived';
      } else if (
        (body.pickPack !== undefined && money(body.pickPack) !== '0.00') ||
        (body.additional !== undefined && money(body.additional) !== '0.00')
      ) {
        manualPrepFeeDecision = 'not_waived';
      }
    }

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

      // PS-375: insert a line when none exists yet. For a FEE line (pick_pack /
      // additional_unit / shipping) only a POSITIVE value creates one — a $0
      // there just means "no such fee". But for the BOX COST a saved $0 is a
      // DELIBERATE resolved-zero decision (the operator confirmed a free box), so
      // emit an explicit $0 package_cost line: the row then reads resolved
      // (hasPackageCostLine=true, packageTotal=0 → resolveBillingBoxCostAlert's
      // resolved-zero branch, no NO_BOX_COST alert) instead of missing. Without
      // this the package_cost_missing line was deleted below but nothing replaced
      // it, so the missing-cost alert re-fired and the row still showed review.
      if (rows.length === 0 && (value > 0 || lineType === 'package_cost')) {
        await tx.insert(billingLineItems).values({
          clientId: body.clientId,
          orderId,
          orderNumber: base.orderNumber,
          shipmentId: base.shipmentId,
          shipDate: base.shipDate,
          billingEffectiveDate: base.billingEffectiveDate,
          billingPolicyVersion: base.billingPolicyVersion,
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
    // PS-392: manual Billing edits are durable backend decisions, not just
    // generated-row edits. Store pick/pack, addl units, and customer-billed
    // shipping overrides in the same transaction as the visible row update so
    // range regeneration can replay them before billing_line_items are frozen.
    if (manualBillingPatchTouched) {
      const reviewer = (c.get('email' as never) as string | undefined) ?? null;
      for (const [bodyKey, lineType, label] of MANUAL_BILLING_OVERRIDE_LINES) {
        const value = body[bodyKey];
        if (typeof value !== 'number') continue;
        const amount = money(value);
        const note = body.note ?? `Manual Billing edit set ${label} to $${amount}`;
        await upsertBillingManualOverride(
          {
            orderId,
            clientId: body.clientId,
            lineType,
            amount: Number(amount),
            reviewer,
            note,
          },
          tx,
        );
        manualBillingOverrideAuditRefs.push({ lineType, amount, note });
      }
    }

    // PS-395: a manual Shipping save is an operator resolution of the shipping
    // review state. Even an explicit $0.00 override is durable in
    // billing_manual_overrides, so stale shipping_missing rows must disappear
    // immediately instead of waiting for range regeneration.
    if (body.shipping !== undefined) {
      await tx
        .delete(billingLineItems)
        .where(
          and(
            eq(billingLineItems.clientId, body.clientId),
            eq(billingLineItems.orderId, orderId),
            eq(billingLineItems.lineType, 'shipping_missing')
          )
        );
    }

    // Box Size override below is billing-line-only; it does not touch the
    // shipment-selected package source of truth.
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

    // PS-389: persist the manual prep-fee decision in the same transaction as
    // the generated line edit. Range regeneration consults billing_fee_waivers
    // before final billing_line_items are written.
    if (manualPrepFeeDecision != null) {
      await upsertBillingFeeWaiver(
        {
          orderId,
          decision: manualPrepFeeDecision,
          reviewer: (c.get('email' as never) as string | undefined) ?? null,
          note:
            body.note ??
            (manualPrepFeeDecision === 'waived'
              ? 'Manual Billing edit set Pick & Pack to $0.00'
              : 'Manual Billing edit restored prep fee'),
          originalPrepAmount: Number.isFinite(originalPrepAmount as number)
            ? originalPrepAmount
            : null,
        },
        tx,
      );
      manualPrepFeeAuditRef.current = { decision: manualPrepFeeDecision, originalPrepAmount };
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

      const priceChanged =
        body.packageCost !== undefined && money(body.packageCost) !== currentBoxAmountBeforeEdit;

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
        // Audit B-7: capture before/after for the post-commit audit event (the
        // upsert above just destroyed the only stored copy of `before`).
        boxResolutionAuditRef.current = {
          before: existing
            ? {
                packageId: existing.packageId ?? null,
                overridePrice: existing.overridePrice ?? null,
                resolvedBy: existing.resolvedBy ?? null,
              }
            : null,
          after: { packageId: newPackageId, overridePrice, note: body.note ?? null, resolvedBy },
        };

        const [shipmentBoxFacts] = base.shipmentId != null
          ? await tx
              .select({
                selectedPid: shipments.selectedPid,
                selectedPackageId: shipments.selectedPackageId,
                dimsL: shipments.dimsL,
                dimsW: shipments.dimsW,
                dimsH: shipments.dimsH,
              })
              .from(shipments)
              .where(eq(shipments.id, base.shipmentId))
              .limit(1)
          : [];
        const packageRows = newPackageId != null
          ? await tx
              .select({
                id: packages.id,
                name: packages.name,
                packageCode: packages.packageCode,
                length: packages.length,
                width: packages.width,
                height: packages.height,
                source: packages.source,
              })
              .from(packages)
              .where(eq(packages.id, newPackageId))
          : [];
        const boxLookups: BoxLookups = {
          byId: new Map(packageRows.map((pkg) => [pkg.id, pkg])),
          byCode: new Map(packageRows.filter((pkg) => pkg.packageCode).map((pkg) => [pkg.packageCode!, pkg])),
          byDims: new Map(),
        };
        const boxResolution = resolveShippedPackageId({
          operator: {
            packageId: newPackageId,
            overridePrice: overridePrice != null ? Number(overridePrice) : null,
            note: body.note ?? existing?.note ?? null,
          },
          selectedPid: shipmentBoxFacts?.selectedPid ?? null,
          selectedPackageId: shipmentBoxFacts?.selectedPackageId ?? null,
          dimsL: shipmentBoxFacts?.dimsL ?? null,
          dimsW: shipmentBoxFacts?.dimsW ?? null,
          dimsH: shipmentBoxFacts?.dimsH ?? null,
          lookups: boxLookups,
        });
        if (boxResolution.status === 'resolved') {
          await tx
            .update(billingLineItems)
            .set({ description: `Box (${resolvedPackageDisplayName(boxResolution, 'Package Cost')})` })
            .where(
              and(
                eq(billingLineItems.clientId, body.clientId),
                eq(billingLineItems.orderId, orderId),
                eq(billingLineItems.lineType, 'package_cost')
              )
            );
        }

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

  const manualPrepFeeAudit = manualPrepFeeAuditRef.current;
  if (manualPrepFeeAudit) {
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_fee_waiver',
      resourceId: orderId,
      action: manualPrepFeeAudit.decision,
      details: {
        source: 'billing_details_patch',
        clientId: body.clientId,
        orderId,
        decision: manualPrepFeeAudit.decision,
        originalPrepAmount: manualPrepFeeAudit.originalPrepAmount,
      },
    });
  }

  for (const manualOverrideAudit of manualBillingOverrideAuditRefs) {
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_manual_override',
      resourceId: orderId,
      action: 'manual_override',
      details: {
        source: 'billing_details_patch',
        clientId: body.clientId,
        orderId,
        lineType: manualOverrideAudit.lineType,
        amount: manualOverrideAudit.amount,
        note: manualOverrideAudit.note,
      },
    });
  }

  // Audit B-7 (2026-07-13): box-resolution changes now leave a before/after trail.
  const boxResolutionAudit = boxResolutionAuditRef.current;
  if (boxResolutionAudit) {
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_box_resolution',
      resourceId: orderId,
      action: 'box_resolution_upsert',
      details: {
        source: 'billing_details_patch',
        clientId: body.clientId,
        orderId,
        before: boxResolutionAudit.before,
        after: boxResolutionAudit.after,
      },
    });
  }

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

// PS-311: bulk-apply a reviewed box cost to every order in a (client + date range + box) scope.
// Slice 1 — the read-only PREVIEW (dry-run). The backend re-derives the affected orders from the
// body + the caller's billing scope; it NEVER trusts an FE-supplied order list. No writes; edits
// only billing_box_resolutions + billing_line_items on apply (awaiting/billing data — NOT shipped
// orders/shipments) so no lockdown override is needed.
const bulkBoxCostScopeRawSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1),
  packageId: z.coerce.number().int().positive(),
  newCost: z.coerce.number().min(0),
});

// PS-311 date fix: normalize the operator-selected day range to the CANONICAL billing calendar-day
// bounds (PS-208 / billingDayRange) BEFORE the scope reaches the service — fromUtc (inclusive lower)
// and toUtcExclusive (UTC midnight of the day AFTER the last selected day). Pre-fix the routes
// passed the raw inclusive "YYYY-MM-DD" dateTo straight through, and the service's
// lt(shipDate, dateTo) then compared against e.g. 2026-01-05T00:00:00Z — silently EXCLUDING every
// order shipped on the last selected day, so a "Jan 1 → Jan 5" bulk apply only re-priced Jan 1–4.
// Every other billing endpoint (/generate, /invoice) already normalizes through billingDayRange;
// the bulk preview/apply were the lone exception. The same normalized bounds flow into the
// post-apply generateLineItems() call, so fetch + regenerate + invoice all agree on the range.
function normalizeBulkBoxCostRange<T extends { dateFrom: string; dateTo: string }>(v: T) {
  const range = billingDayRange(v.dateFrom, v.dateTo);
  return { ...v, dateFrom: range?.fromUtc, dateTo: range?.toUtcExclusive };
}
const bulkBoxCostRangeRequired = { message: 'dateFrom and dateTo are required (YYYY-MM-DD)' } as const;
const hasNormalizedBulkRange = (v: { dateFrom?: string; dateTo?: string }) =>
  v.dateFrom !== undefined && v.dateTo !== undefined;

const bulkBoxCostScopeSchema = bulkBoxCostScopeRawSchema
  .transform(normalizeBulkBoxCostRange)
  .refine(hasNormalizedBulkRange, bulkBoxCostRangeRequired);

app.post(
  '/box-cost/bulk/preview',
  requirePermission('financials:write'),
  zValidator('json', bulkBoxCostScopeSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const preview = await previewBulkBoxCost(
      {
        clientId: body.clientId,
        dateFrom: body.dateFrom!,
        dateTo: body.dateTo!,
        packageId: body.packageId,
        newCost: body.newCost,
      },
      billingLineItemClientScopePredicate(scope),
    );
    return c.json({ data: preview });
  },
);

// PS-311 (slice 2): APPLY the reviewed box cost to every editable order in scope. Writes
// billing_box_resolutions (PS-207 directive) + regenerates the scoped line items; SKIPS finalized
// (invoiced) orders; audits the bulk money action. NEVER writes client_package_prices. The backend
// re-derives the scope — it never trusts an FE-supplied order list.
const bulkBoxCostApplySchema = bulkBoxCostScopeRawSchema
  .extend({ note: z.string().max(500).optional() })
  .transform(normalizeBulkBoxCostRange)
  .refine(hasNormalizedBulkRange, bulkBoxCostRangeRequired);

app.post(
  '/box-cost/bulk/apply',
  requirePermission('financials:write'),
  zValidator('json', bulkBoxCostApplySchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const resolvedBy = (c.get('email' as never) as string | undefined) ?? null;
    const result = await applyBulkBoxCostResolutions(
      {
        clientId: body.clientId,
        dateFrom: body.dateFrom!,
        dateTo: body.dateTo!,
        packageId: body.packageId,
        newCost: body.newCost,
      },
      billingLineItemClientScopePredicate(scope),
      resolvedBy,
      body.note ?? null,
    );
    // Regenerate the scoped line items so the package_cost lines reflect the new resolutions.
    // The resolutions survive regeneration (PS-207). Only when something actually changed.
    // Uses the SAME normalized [fromUtc, toUtcExclusive) bounds as the fetch above, so the
    // regenerated range matches exactly what was re-priced (and what the invoice shows).
    if (result.appliedOrderCount > 0) {
      await generateLineItems(
        withBillingScope(c, { clientId: body.clientId, dateFrom: body.dateFrom!, dateTo: body.dateTo! }),
      );
    }
    // Append-only audit of the bulk money action (actor + scope + result; secrets auto-redacted).
    await recordAuditEvent({
      eventType: 'billing',
      ...auditActorFromContext(c),
      resourceType: 'billing_box_cost_bulk',
      resourceId: `client:${body.clientId}:pkg:${body.packageId}`,
      action: 'bulk_box_cost_apply',
      details: {
        clientId: body.clientId,
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        packageId: body.packageId,
        ...result,
      },
    });
    return c.json({ data: result });
  },
);

// PS-311b: the NEEDS-REVIEW sweep. Operators start from one unmatched/custom-dims box (e.g. Custom
// 6.5x4x2) in the Edit Billing Detail modal, pick a date range, and apply a reviewed cost to EVERY
// other still-unmatched order that shares the SAME box signature in that (client + range). The
// backend re-derives the box signature from sourceOrderId (it never trusts an FE-supplied dims
// string) and re-derives the scope from the auth context. Same calendar-day normalization as the
// other billing routes (the last selected day is included). Billing/awaiting data only — writes only
// billing_box_resolutions; finalized orders are skipped.
const byDimsScopeRawSchema = z.object({
  clientId: z.coerce.number().int().positive(),
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1),
  sourceOrderId: z.coerce.number().int().positive(),
  newCost: z.coerce.number().min(0),
});
const byDimsScopeSchema = byDimsScopeRawSchema
  .transform(normalizeBulkBoxCostRange)
  .refine(hasNormalizedBulkRange, bulkBoxCostRangeRequired);
// UNDO takes the same scope minus the cost — it removes the sweep, it does not set a value.
const byDimsRevertSchema = byDimsScopeRawSchema
  .omit({ newCost: true })
  .transform(normalizeBulkBoxCostRange)
  .refine(hasNormalizedBulkRange, bulkBoxCostRangeRequired);

app.post(
  '/box-cost/by-dims/preview',
  requirePermission('financials:write'),
  zValidator('json', byDimsScopeSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const preview = await previewBulkBoxCostByDims(
      {
        clientId: body.clientId,
        dateFrom: body.dateFrom!,
        dateTo: body.dateTo!,
        sourceOrderId: body.sourceOrderId,
        newCost: body.newCost,
      },
      billingLineItemClientScopePredicate(scope),
    );
    return c.json({ data: preview });
  },
);

app.post(
  '/box-cost/by-dims/apply',
  requirePermission('financials:write'),
  zValidator('json', byDimsScopeSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const resolvedBy = (c.get('email' as never) as string | undefined) ?? null;
    const result = await applyBulkBoxCostByDimsResolutions(
      {
        clientId: body.clientId,
        dateFrom: body.dateFrom!,
        dateTo: body.dateTo!,
        sourceOrderId: body.sourceOrderId,
        newCost: body.newCost,
      },
      billingLineItemClientScopePredicate(scope),
      resolvedBy,
    );
    // Regenerate so the swept orders' package_cost lines reflect the new resolutions (which survive
    // regeneration — PS-207). Same normalized [fromUtc, toUtcExclusive) bounds as the fetch.
    if (result.appliedOrderCount > 0) {
      await generateLineItems(
        withBillingScope(c, { clientId: body.clientId, dateFrom: body.dateFrom!, dateTo: body.dateTo! }),
      );
    }
    await recordAuditEvent({
      eventType: 'billing',
      ...auditActorFromContext(c),
      resourceType: 'billing_box_cost_bulk',
      resourceId: `client:${body.clientId}:order:${body.sourceOrderId}`,
      action: 'bulk_box_cost_by_dims_apply',
      details: {
        clientId: body.clientId,
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        sourceOrderId: body.sourceOrderId,
        ...result,
      },
    });
    return c.json({ data: result });
  },
);

// PS-311b UNDO: reverse a dims sweep — remove the cost the sweep added and send those bills back to
// needs-review. The backend re-derives the sweep marker from sourceOrderId's own resolution and
// deletes ONLY resolutions carrying it (manual box-cost edits are never touched), scoped to client +
// range + auth. Then regenerates so the needs-review lines reappear. Billing/awaiting data only.
app.post(
  '/box-cost/by-dims/revert',
  requirePermission('financials:write'),
  zValidator('json', byDimsRevertSchema),
  async (c) => {
    const body = c.req.valid('json');
    const scope = billingScopeFromContext(c);
    const result = await revertBulkBoxCostByDimsResolutions(
      {
        clientId: body.clientId,
        dateFrom: body.dateFrom!,
        dateTo: body.dateTo!,
        sourceOrderId: body.sourceOrderId,
      },
      billingLineItemClientScopePredicate(scope),
    );
    if (result.revertedOrderCount > 0) {
      await generateLineItems(
        withBillingScope(c, { clientId: body.clientId, dateFrom: body.dateFrom!, dateTo: body.dateTo! }),
      );
    }
    await recordAuditEvent({
      eventType: 'billing',
      ...auditActorFromContext(c),
      resourceType: 'billing_box_cost_bulk',
      resourceId: `client:${body.clientId}:order:${body.sourceOrderId}`,
      action: 'bulk_box_cost_by_dims_revert',
      details: {
        clientId: body.clientId,
        dateFrom: body.dateFrom,
        dateTo: body.dateTo,
        sourceOrderId: body.sourceOrderId,
        ...result,
      },
    });
    return c.json({ data: result });
  },
);

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

    await ensureBillingFinalizationPolicySchema();
    await ensureBillingFeeWaiverSchema();

    let originalPrepAmount: number | null = null;
    await db.transaction(async (tx) => {
      await assertBillingOrdersEditable(
        {
          orderIds: [orderId],
          clientId: body.clientId,
          scopePredicate: billingLineItemClientScopePredicate(scope),
        },
        tx,
      );

      // Capture the current prep total under the same group/row locks used for
      // the waiver write, so direct finalization cannot race this decision.
      const [prepSumRow] = await tx.execute<{ original_prep_amount: string | null }>(sql`
        select coalesce(sum(total_cost), 0)::text as original_prep_amount
        from billing_line_items
        where client_id = ${body.clientId}
          and order_id = ${orderId}
          and line_type in (${sql.join(PREP_FEE_LINE_TYPE_LIST.map((t) => sql`${t}`), sql`, `)})
      `);
      const currentPrepAmount = prepSumRow?.original_prep_amount != null
        ? Number(prepSumRow.original_prep_amount)
        : null;
      originalPrepAmount = Number.isFinite(currentPrepAmount as number) ? currentPrepAmount : null;

      await upsertBillingFeeWaiver({
        orderId,
        decision: body.decision,
        reviewer: (c.get('email' as never) as string | undefined) ?? null,
        note: body.note ?? null,
        originalPrepAmount,
      }, tx);
      await setBillingOrdersDirty(
        {
          orderIds: [orderId],
          dirty: true,
          clientId: body.clientId,
          scopePredicate: billingLineItemClientScopePredicate(scope),
        },
        tx,
      );
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

// PS-217/PS-425: the renderer-facing per-shipment invoice row. box_cost is the BILLED
// package_cost line value (never a current price-table guess); box_label is the
// human-readable billed box; box_review marks an unresolved/mismatched box so
// the export shows the review reason instead of a silent blank.
type InvoiceDetailRow = {
  order_id: number | null;
  order_number: string | null;
  shipment_id: number | null;
  ship_date: string | null;
  billing_effective_date: string | null;
  billing_policy_version: string | null;
  base_qty: string;
  addl_qty: string;
  pickpack_amt: string;
  additional_amt: string;
  shipping_amt: string;
  storage_amt: string;
  row_total: string;
  billing_status_label: string;
  item_names: string | null;
  skus: string | null;
  carrier_code: string | null;
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
type InvoiceDetailSqlRow = Omit<InvoiceDetailRow, 'box_label' | 'box_review' | 'fee_waived' | 'item_names' | 'billing_status_label'> & {
  billed_package_id: number | null;
  box_cost_desc: string | null;
  box_review_reason: string | null;
  billing_line_types: unknown;
  order_status: string | null;
  canonical_status: string | null;
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
  const parsed = row.box_cost_desc
    ? /^Box\s+\((.+)\)(?:\s+·\s+(?:shipment #\d+|external fulfillment))?$/i.exec(
        row.box_cost_desc.trim(),
      )
    : null;
  if (parsed?.[1]) return { box_label: parsed[1], box_review: false };
  if (row.box_review_reason && row.box_review_reason.trim()) {
    return { box_label: row.box_review_reason.trim(), box_review: true };
  }
  return { box_label: '—', box_review: false };
}

// PS-134 (slice 2, extract-only): the /invoice DATA layer. Runs the invoice's OWN summary +
// per-shipment aggregates VERBATIM (full-precision ::text sums, raw ::timestamptz bounds, client_id
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

  // PS-134/Audit 3.6: the invoice header and close workflow share this exact
  // frozen-total owner. The per-shipment breakdown stays here because the summary
  // service has no per-shipment representation to delegate to.
  const totals = await billingInvoiceHeaderTotals(clientId, dateFrom, dateTo);
  const detailAmount = cancelledNoChargeBillingAmountSql({
    lineType: sql`b.line_type`,
    orderStatus: sql`o.order_status`,
    canonicalStatus: sql`o.canonical_status`,
    totalCost: sql`b.total_cost`,
  });
  const invoiceEffectiveDay = billingLineEffectiveDaySql(
    sql`b.billing_effective_date`,
    sql`b.ship_date`,
  );

  const rawDetails = await db.execute<InvoiceDetailSqlRow>(sql`
    select
      b.order_id,
      b.order_number,
      -- PS-425: invoice cardinality follows the frozen shipment-scoped lines.
      b.shipment_id,
      -- PS-208: ship_date is a calendar day stored at UTC midnight — extract
      -- the day AT UTC. The previous America/Los_Angeles conversion turned a
      -- May 1 row into April 30 before display even started.
      to_char(b.ship_date at time zone 'UTC', 'YYYY-MM-DD') as ship_date,
      to_char(${invoiceEffectiveDay} at time zone 'UTC', 'YYYY-MM-DD') as billing_effective_date,
      b.billing_policy_version,
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then b.qty else 0 end), 0)::text as base_qty,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then b.qty else 0 end), 0)::text as addl_qty,
      coalesce(sum(case when b.line_type in ('pick_pack', 'pickpack') then ${detailAmount} else 0 end), 0)::text as pickpack_amt,
      coalesce(sum(case when b.line_type in ('additional_unit', 'additional') then ${detailAmount} else 0 end), 0)::text as additional_amt,
      coalesce(sum(case when b.line_type = 'shipping' then ${detailAmount} else 0 end), 0)::text as shipping_amt,
      coalesce(sum(case when b.line_type = 'storage' then ${detailAmount} else 0 end), 0)::text as storage_amt,
      max(coalesce(nullif(s.label_carrier, ''), nullif(s.carrier_code, ''), nullif(s.carrier_provider, ''))) as carrier_code,
      -- PS-217: the BILLED box cost is the generated package_cost line value for
      -- this order in the period — never the current package price table, and
      -- never the package_cost_missing $0.00 review rows. The stamped package_id
      -- (PS-207 puts the same billedPackageId on every line of the order) and the
      -- line descriptions carry the human box label + review reason.
      coalesce(sum(case when b.line_type = 'package_cost' then ${detailAmount} else 0 end), 0)::text as package_cost_amt,
      max(b.package_id) as billed_package_id,
      max(case when b.line_type = 'package_cost' then b.description else null end) as box_cost_desc,
      max(case when b.line_type = 'package_cost_missing' then b.description else null end) as box_review_reason,
      sum(${detailAmount})::text as row_total,
      array_agg(distinct b.line_type) as billing_line_types,
      max(o.order_status) as order_status,
      max(o.canonical_status) as canonical_status,
      (
        select string_agg(oi.sku, ', ' order by oi.line_index)
        from order_items oi
        where oi.order_id = b.order_id
          and oi.quantity > 0
      ) as skus,
      -- PS-310/PS-362: per-SKU rows so the EXPORT reuses the SAME canonical summarizer the
      -- Billing detail SCREEN uses (summarizeBillingItemsForDetail) -> xN quantity +
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
    left join shipments s on s.id = b.shipment_id
    left join orders o on o.id = b.order_id
    where b.client_id = ${clientId}
      -- PS-208: identical date-only bounds as every billing endpoint — UTC
      -- midnight inclusive lower, EXCLUSIVE day-after upper.
      and ${invoiceEffectiveDay} >= ${dateFrom}::timestamptz
      and ${invoiceEffectiveDay} < ${dateTo}::timestamptz
    group by b.order_id, b.order_number, b.shipment_id, b.ship_date,
      b.billing_effective_date, b.billing_policy_version
    order by ${invoiceEffectiveDay} desc, b.order_id desc, b.shipment_id desc nulls last
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
    const itemSummary = summarizeBillingItemsForDetail(r.item_rows);
    const orderLifecycleStatus = isCancelledBillingStatus(r.canonical_status)
      ? 'upstream_cancelled'
      : null;
    const billingStatus = resolveBillingRowStatus({
      lineTypes: Array.isArray(r.billing_line_types) ? r.billing_line_types : [],
      orderStatus: r.order_status,
      orderLifecycleStatus,
      totalCost: r.row_total,
    });
    const cancelledNoCharge = billingStatus.billingLifecycleStatus === 'cancelled_no_charge';
    return {
      order_id: r.order_id,
      order_number: r.order_number,
      shipment_id: r.shipment_id,
      ship_date: r.ship_date,
      billing_effective_date: r.billing_effective_date,
      billing_policy_version: r.billing_policy_version,
      base_qty: r.base_qty,
      addl_qty: r.addl_qty,
      pickpack_amt: r.pickpack_amt,
      additional_amt: r.additional_amt,
      shipping_amt: r.shipping_amt,
      storage_amt: r.storage_amt,
      row_total: r.row_total,
      billing_status_label: billingStatus.billingStatusLabel,
      item_names: itemSummary.itemNames,
      // PS-310/PS-362: build the export SKU string from the SAME summarizer the detail screen
      // uses (Excel-safe xN per SKU, duplicate aggregation); fall back to the bare string_agg when
      // the order has no order_items rows so legacy/imported orders still show their SKUs.
      skus: itemSummary.itemSkus ?? r.skus,
      carrier_code: r.carrier_code,
      package_cost_amt: r.package_cost_amt,
      box_label: cancelledNoCharge ? '—' : box_label,
      box_review: cancelledNoCharge ? false : box_review,
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
export function renderInvoiceHtml(args: {
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
      const packageCostAmt = Number(d.package_cost_amt);
      const shippingAmt = Number(d.shipping_amt);
      const storageAmt = Number(d.storage_amt);
      // Per user override unlock shipped data on 2026-07-14 (Audit B-9):
      // export display delegates the read-only legacy fallback to the backend
      // invoice owner; no order/shipment row is changed.
      const fulfillmentFeeAmt = resolveBillingInvoiceRowTotal({
        rowTotal: d.row_total,
        pickPackFee: pickPackFeeAmt,
        packageCost: packageCostAmt,
        shipping: shippingAmt,
        storage: storageAmt,
      });
      const billingDate = invoiceShipDateTimeCell(
        d.billing_effective_date ?? d.ship_date,
      );
      const actualDate = invoiceShipDateTimeCell(d.ship_date);
      const dateCell =
        d.ship_date &&
        d.billing_effective_date &&
        d.ship_date !== d.billing_effective_date
          ? `Billed ${billingDate}<br><small>Fulfilled ${actualDate}</small>`
          : billingDate;
      return `
      <tr>
        <td class="ship-date">${dateCell}</td>
        <td class="mono">${escHtml(d.order_number ?? d.order_id ?? '')}</td>
        <td>${escHtml(d.billing_status_label || 'Fulfilled')}</td>
        <td class="sku">${escHtml(d.skus ?? '—')}</td>
        <td${d.box_review ? ' class="review"' : ''}>${escHtml(d.box_label)}</td>
        <td class="num">${packageCostAmt > 0 ? fmt(packageCostAmt) : '—'}</td>
        <td class="num">${totalQty}</td>
        <td class="num">${fmt(pickPackFeeAmt)}</td>
        <td class="num">${addlQty > 0 ? fmt(additionalAmt) : '—'}</td>
        <td class="num">${shippingAmt > 0 ? fmt(shippingAmt) : '—'}</td>
        <td class="num">${storageAmt > 0 ? fmt(storageAmt) : '—'}</td>
        <td class="num bold">${fmt(fulfillmentFeeAmt)}</td>
        <td class="mono">${escHtml(d.shipment_id == null ? 'External' : `#${d.shipment_id}`)}</td>
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
        <th class="ship-date">${escHtml(INVOICE_SHIP_DATE_HEADER)}</th>
        <th>Order #</th>
        <th>Status</th>
        <th>SKU(s)</th>
        <th>Box Size</th>
        <th class="num">Box Cost</th>
        <th class="num">Qty</th>
        <th class="num">Pick &amp; Pack</th>
        <th class="num">Add'l Units</th>
        <th class="num">Shipping</th>
        <th class="num">Storage</th>
        <th class="num">Fulfillment Fee</th>
        <th>Shipment #</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="5">Totals — ${orderCount} orders</td>
        <td class="num">${packageTotal > 0 ? fmt(packageTotal) : '—'}</td>
        <td></td>
        <td class="num">${fmt(pickPackFeeTotal)}</td>
        <td class="num">${fmt(additionalTotal)}</td>
        <td class="num">${fmt(shippingTotal)}</td>
        <td class="num">${storageTotal > 0 ? fmt(storageTotal) : '—'}</td>
        <td class="num" style="font-size:14px">${fmt(fulfillmentFeeTotal || grandTotal)}</td>
        <td></td>
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

export async function renderInvoiceXlsx(args: {
  clientName: string;
  fromDay: string;
  toDay: string;
  totals: InvoiceTotals;
  details: InvoiceDetailRow[];
}): Promise<Buffer> {
  // Lazy import: exceljs is heavy and only this route needs it.
  const { default: ExcelJS } = await import('exceljs');
  const { totals, details } = args;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PrepShip';

  const NUMBER_FMT = '0.00';

  const invoice = workbook.addWorksheet('Invoice');
  invoice.views = [{ state: 'frozen', ySplit: 1 }];
  // PS-425: one operator-facing row per frozen shipment identity.
  invoice.columns = [
    { header: 'Order #', key: 'orderNumber', width: 12 },
    { header: 'Status', key: 'status', width: 18 },
    { header: INVOICE_XLSX_SHIP_DATE_HEADER, key: 'shipDate', width: 12 },
    { header: 'Carrier', key: 'carrier', width: 12 },
    { header: 'Item Name', key: 'itemName', width: 36 },
    { header: 'SKU', key: 'sku', width: 30 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Pick & Pack', key: 'pickPackFee', width: 12, style: { numFmt: NUMBER_FMT } },
    { header: 'Addl Units', key: 'additional', width: 12, style: { numFmt: NUMBER_FMT } },
    // PS-217: billed box cost is the package_cost line value; it is displayed
    // separately, already included in Fulfillment Fee.
    { header: 'Box Cost', key: 'boxCost', width: 10, style: { numFmt: NUMBER_FMT } },
    { header: 'Box Size', key: 'boxSize', width: 14 },
    { header: 'Shipping', key: 'shipping', width: 12, style: { numFmt: NUMBER_FMT } },
    { header: 'Storage', key: 'storage', width: 10, style: { numFmt: NUMBER_FMT } },
    { header: 'Fulfillment Fee', key: 'fulfillmentFee', width: 16, style: { numFmt: NUMBER_FMT } },
    { header: 'Shipment #', key: 'shipmentId', width: 14 },
  ];
  invoice.getRow(1).font = { bold: true };
  for (const d of details) {
    // Per user override unlock shipped data on 2026-07-14 (Audit B-9):
    // XLSX consumes the same backend compatibility total as HTML/CSV.
    // Identical derivation to the HTML rows — qty/fee composition and the
    // rowTotal>0 fallback must stay in lockstep with renderInvoiceHtml.
    const baseQty = Number(d.base_qty);
    const addlQty = Number(d.addl_qty);
    const pickPackFeeAmt = Number(d.pickpack_amt) + Number(d.additional_amt);
    const packageCostAmt = Number(d.package_cost_amt);
    const shippingAmt = Number(d.shipping_amt);
    const storageAmt = Number(d.storage_amt);
    const fulfillmentFeeAmt = resolveBillingInvoiceRowTotal({
      rowTotal: d.row_total,
      pickPackFee: pickPackFeeAmt,
      packageCost: packageCostAmt,
      shipping: shippingAmt,
      storage: storageAmt,
    });
    invoice.addRow({
      orderNumber: String(d.order_number ?? d.order_id ?? ''),
      status: d.billing_status_label || 'Fulfilled',
      shipDate: invoiceBillingActivityDateCell(
        d.ship_date,
        d.billing_effective_date,
      ),
      carrier: invoiceCarrierCell(d.carrier_code),
      itemName: invoiceOneLineCell(d.item_names),
      sku: invoiceOneLineCell(d.skus),
      qty: baseQty + addlQty,
      pickPackFee: pickPackFeeAmt,
      additional: addlQty > 0 ? Number(d.additional_amt) : 0,
      boxCost: packageCostAmt,
      boxSize: invoiceOneLineCell(d.box_label),
      shipping: shippingAmt,
      storage: storageAmt,
      fulfillmentFee: fulfillmentFeeAmt,
      shipmentId: d.shipment_id == null ? 'External' : `#${d.shipment_id}`,
    });
  }
  if (details.length) {
    const first = 2;
    const last = first + details.length - 1;
    const totalsRow = invoice.addRow({
      itemName: `Totals - ${totals.orderCount} orders`,
      // Box Cost is display-only here; it is already inside each row's
      // Fulfillment Fee, so it is never added a second time.
      boxCost: { formula: `SUM(J${first}:J${last})` },
      qty: { formula: `SUM(G${first}:G${last})` },
      pickPackFee: { formula: `SUM(H${first}:H${last})` },
      additional: { formula: `SUM(I${first}:I${last})` },
      shipping: { formula: `SUM(L${first}:L${last})` },
      storage: { formula: `SUM(M${first}:M${last})` },
      fulfillmentFee: { formula: `SUM(N${first}:N${last})` },
    });
    totalsRow.font = { bold: true };
  }
  applyInvoiceXlsxReadableLayout(invoice);

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
    if (!(await canAccessBillingClient(clientId, packagePriceScope))) {
      return c.json({ data: [] });
    }
    const rows = await clientUsedPackagePricingRows(clientId);
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
  const packagePriceScope = billingScopeFromContext(c);
  if (!(await canAccessBillingClient(clientId, packagePriceScope))) {
    return c.json({ error: 'Client not found' }, 404);
  }

  const visiblePackageIds = new Set(
    (await clientUsedPackagePricingRows(clientId)).map((row) => row.packageId)
  );
  const scopedPrices = prices.filter((row) => visiblePackageIds.has(row.packageId));
  let updated = 0;
  for (const row of scopedPrices) {
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
  // Audit B-7 (2026-07-13): per-client box prices are money-determining.
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'billing',
    resourceType: 'client_package_prices',
    resourceId: clientId,
    action: 'package_prices_put',
    details: {
      clientId,
      updated,
      skipped: prices.length - scopedPrices.length,
      // Bounded payload: prices are validated <=500 rows; store the applied set.
      prices: scopedPrices.map((row) => ({
        packageId: row.packageId,
        price: row.price.toFixed(2),
        isCustom: row.isCustom ?? true,
      })),
    },
  });
  return c.json({ updated, skipped: prices.length - scopedPrices.length });
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
    // Audit B-6 (2026-07-13): this write touches EVERY client's non-custom
    // price row — only global-scope operators may run it.
    const setDefaultScope = billingScopeFromContext(c);
    if (!setDefaultScope.isGlobal) {
      return c.json({ error: 'Default package prices require global billing scope' }, 403);
    }
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
    // Audit B-7 (2026-07-13): this touched every non-custom client's price row.
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'client_package_prices',
      resourceId: packageId,
      action: 'package_price_set_default',
      details: {
        packageId,
        price: price.toFixed(2),
        updatedClientIds: result.map((r) => r.clientId),
      },
    });
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
//      Upserts those rates through the canonical reference-rate store.
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
    const persistedCount = await upsertBillingReferenceRates(
      parsed.data.rates.map((r) => ({
        weightOz: r.weightOz,
        zipTo: r.zipTo,
        carrier: r.carrier,
        service: r.service ?? null,
        cost: r.cost,
        source: r.source ?? 'manual',
        fetchedAt: new Date(),
      }))
    );
    // Audit B-7 (2026-07-13): manual ref-rate uploads change "could've paid"
    // comparisons; record who loaded how many rows.
    await recordAuditEvent({
      ...auditActorFromContext(c),
      eventType: 'billing',
      resourceType: 'billing_ref_rates',
      resourceId: null,
      action: 'ref_rates_manual_backfill',
      details: { inserted: persistedCount, shape: 'manual_rows' },
    });
    return c.json({ ok: true, inserted: persistedCount });
  }

  // Shape B: range-driven cache backfill — PS-134: owned by the billing service.
  const result = await backfillReferenceRates({
    from: typeof body?.from === 'string' ? body.from : null,
    to: typeof body?.to === 'string' ? body.to : null,
    clientId:
      typeof body?.clientId === 'number' && body.clientId > 0 ? body.clientId : null,
  });
  await recordAuditEvent({
    ...auditActorFromContext(c),
    eventType: 'billing',
    resourceType: 'billing_ref_rates',
    resourceId: typeof body?.clientId === 'number' ? body.clientId : null,
    action: 'ref_rates_range_backfill',
    details: { shape: 'range', request: { from: body?.from ?? null, to: body?.to ?? null, clientId: body?.clientId ?? null }, result },
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
