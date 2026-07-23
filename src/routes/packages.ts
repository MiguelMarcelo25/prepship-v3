import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { packages } from '../db/schema/packages';
import { packageLedger } from '../db/schema/package-ledger';
import type { CarriersResponse } from '../lib/shipstation/types';
import { importStandardPackageDimensions } from '../services/package-dimension-importer';
import { ensurePackageConsumptionSchema } from '../services/package-consumption-schema';
import {
  PACKAGE_CONSUMPTION_REVIEW_STATUSES,
  listPackageConsumptionReviews,
  type PackageConsumptionReviewStatus,
} from '../services/package-consumption-review-read-model';
import { listCarrierAccounts } from '../services/carrier-connector-orchestrator';
import {
  hasAppPermission,
  hasInternalAppPermission,
  requireBusinessRoutePolicy,
} from '../middleware/auth';

const app = new Hono();
const PACKAGE_START_BACKFILL_DATE = new Date('2026-04-01T00:00:00.000Z');
const PACKAGES_CACHE_TTL_MS = 60_000;
let packagesCache: { expiresAt: number; rows: Array<typeof packages.$inferSelect> } | null = null;
let packagesInflight: Promise<Array<typeof packages.$inferSelect>> | null = null;

const body = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  length: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  tareWeightOz: z.number().nonnegative().default(0),
  source: z.string().optional(),
  carrierCode: z.string().nullable().optional(),
  packageCode: z.string().nullable().optional(),
  domestic: z.boolean().nullable().optional(),
  international: z.boolean().nullable().optional(),
  // PS-413: stock changes must use receive/adjust/ship ledger workflows.
  // Generic create/edit payloads cannot overwrite stock_qty directly.
  reorderLevel: z.number().int().nonnegative().optional(),
  unitCost: z.string().optional(),
  isDefault: z.boolean().optional(),
});

function invalidatePackagesCache() {
  packagesCache = null;
  packagesInflight = null;
}

function boolQuery(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parsePositiveIntQuery(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function canViewPackageFinancials(c: Context): boolean {
  return hasAppPermission(
    {
      email: c.get('email' as never) as string | undefined,
      role: c.get('role' as never) as string | undefined,
      permissions: c.get('permissions' as never) as string[] | undefined,
    },
    'financials:read'
  );
}

function publicPackageRow(row: typeof packages.$inferSelect, canViewFinancials: boolean) {
  return {
    ...row,
    unitCost: canViewFinancials ? row.unitCost : null,
  };
}

function publicPackageListRow(row: typeof packages.$inferSelect, canViewFinancials: boolean) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    length: row.length,
    width: row.width,
    height: row.height,
    tareWeightOz: row.tareWeightOz,
    carrierCode: row.carrierCode,
    packageCode: row.packageCode,
    stockQty: row.stockQty,
    reorderLevel: row.reorderLevel,
    unitCost: canViewFinancials ? row.unitCost : null,
    isDefault: row.isDefault,
  };
}

function publicPackageLedgerRow(row: typeof packageLedger.$inferSelect, canViewFinancials: boolean) {
  return {
    ...row,
    unitCost: canViewFinancials ? row.unitCost : null,
  };
}

function redactPackageMutationResult<T extends { package: typeof packages.$inferSelect; ledgerEntry?: typeof packageLedger.$inferSelect }>(
  result: T,
  canViewFinancials: boolean,
) {
  return {
    ...result,
    package: publicPackageRow(result.package, canViewFinancials),
    ledgerEntry: result.ledgerEntry
      ? publicPackageLedgerRow(result.ledgerEntry, canViewFinancials)
      : result.ledgerEntry,
  };
}

async function listPackagesCached() {
  if (packagesCache && packagesCache.expiresAt > Date.now()) return packagesCache.rows;
  if (packagesInflight) return packagesInflight;
  packagesInflight = db.select().from(packages).then((rows) => {
    packagesCache = {
      rows,
      expiresAt: Date.now() + PACKAGES_CACHE_TTL_MS,
    };
    return rows;
  }).finally(() => {
    packagesInflight = null;
  });
  return packagesInflight;
}

app.get('/', async (c) => {
  const rows = await listPackagesCached();
  const canViewFinancials = canViewPackageFinancials(c);
  const wantsPaged =
    c.req.query('page') !== undefined ||
    c.req.query('pageSize') !== undefined ||
    c.req.query('lightweight') !== undefined;
  if (wantsPaged) {
    const page = parsePositiveIntQuery(c.req.query('page'), 1, 100000);
    const pageSize = parsePositiveIntQuery(c.req.query('pageSize'), 100, 500);
    const start = (page - 1) * pageSize;
    const lightweight = boolQuery(c.req.query('lightweight'));
    const data = rows
      .slice(start, start + pageSize)
      .map((row) => (lightweight ? publicPackageListRow(row, canViewFinancials) : publicPackageRow(row, canViewFinancials)));
    return c.json({
      data,
      pagination: {
        page,
        pageSize,
        total: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
      },
    });
  }
  return c.json(rows.map((row) => publicPackageRow(row, canViewFinancials)));
});

// PS-442 operator surface for durable package-consumption review work. This is
// read-only: it never resolves a review, changes stock, or mutates shipment data.
app.get('/consumption-reviews', async (c) => {
  const requestedStatus = c.req.query('status')?.trim().toLowerCase();
  const status = PACKAGE_CONSUMPTION_REVIEW_STATUSES.includes(
    requestedStatus as PackageConsumptionReviewStatus,
  )
    ? requestedStatus as PackageConsumptionReviewStatus
    : 'pending';
  const limit = parsePositiveIntQuery(c.req.query('limit'), 100, 500);
  return c.json(await listPackageConsumptionReviews({ status, limit }));
});

app.get('/:id{[0-9]+}', async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  if (!row) return c.json({ error: 'Package not found' }, 404);
  return c.json(publicPackageRow(row, canViewFinancials));
});

// PS-252 (Card 7 finish): package mutations are internal config — gate create/edit behind
// settings:write (matching DELETE). Warehouse stock is edited via the inventory receive/adjust
// routes, not here, so a single config gate is safe + backward-compatible.
app.post('/', requireBusinessRoutePolicy('packages.catalog.create'), zValidator('json', body), async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const v = c.req.valid('json');
  const [row] = await db.insert(packages).values(v).returning();
  if (!row) return c.json({ error: 'Package could not be created' }, 500);
  invalidatePackagesCache();
  return c.json(publicPackageRow(row, canViewFinancials), 201);
});

app.patch('/:id{[0-9]+}', requireBusinessRoutePolicy('packages.catalog.patch'), zValidator('json', body.partial()), async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(packages)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(packages.id, id))
    .returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json(publicPackageRow(row, canViewFinancials));
});

// PS-252 (Card 7): deleting a package definition is operator/admin config, so it is gated.
// PS-413 removed stockQty from generic create/edit payloads. Package stock is a
// global catalog concern, so only settings-authorized internal callers may use
// receive/adjust; automated shipment-ledger consumption remains a separate path.
app.delete('/:id{[0-9]+}', requireBusinessRoutePolicy('packages.catalog.delete'), async (c) => {
  const id = Number(c.req.param('id'));
  const [history] = await db
    .select({ id: packageLedger.id })
    .from(packageLedger)
    .where(eq(packageLedger.packageId, id))
    .limit(1);
  if (history) {
    return c.json({ error: 'Package has ledger history and cannot be deleted' }, 409);
  }
  const [row] = await db.delete(packages).where(eq(packages.id, id)).returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ deleted: true });
});

// Sync carrier-default packages from ShipStation. Pulls /v2/carriers and
// upserts each carrier's package list into our packages table.
// Dimensions stay 0 — ShipStation's API doesn't expose them; user fills in.
app.post('/sync', requireBusinessRoutePolicy('packages.catalog.sync'), async (c) => {
  const res = await listCarrierAccounts('shipstation', {
    dedupeKey: 'carriers:list',
  }) as CarriersResponse;

  let inserted = 0;
  let skipped = 0;

  for (const carrier of res.carriers) {
    if (carrier.disabled_by_billing_plan) continue;
    for (const pkg of carrier.packages ?? []) {
      const [existing] = await db
        .select({ id: packages.id })
        .from(packages)
        .where(
          and(
            eq(packages.carrierCode, carrier.carrier_code),
            eq(packages.packageCode, pkg.package_code)
          )
        )
        .limit(1);

      if (existing) {
        skipped += 1;
        continue;
      }

      await db.insert(packages).values({
        name: pkg.name,
        type: 'box',
        carrierCode: carrier.carrier_code,
        packageCode: pkg.package_code,
        source: 'shipstation',
        domestic: true,
        international: false,
      });
      inserted += 1;
    }
  }

  if (inserted > 0) invalidatePackagesCache();
  return c.json({
    inserted,
    skipped,
    message: `Synced ${inserted} new packages from ShipStation (${skipped} already existed)`,
  });
});

app.post(
  '/backfill-start-date',
  requireBusinessRoutePolicy('packages.catalog.backfill-start-date'),
  async (c) => {
  const rows = await db
    .update(packages)
    .set({ createdAt: PACKAGE_START_BACKFILL_DATE })
    .where(sql`${packages.createdAt} is distinct from ${PACKAGE_START_BACKFILL_DATE}::timestamptz`)
    .returning({ id: packages.id });

  if (rows.length > 0) invalidatePackagesCache();
  return c.json({
    updated: rows.length,
    startDate: PACKAGE_START_BACKFILL_DATE.toISOString(),
    message: `Backfilled ${rows.length} packages to start 2026-04-01`,
  });
  },
);

const receiveBody = z.object({
  qty: z.number().int().positive(),
  unitCost: z.number().nonnegative().optional(),
  note: z.string().max(500).optional(),
});

app.post(
  '/:id{[0-9]+}/receive',
  requireBusinessRoutePolicy('packages.receive'),
  zValidator('json', receiveBody),
  async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const { qty, unitCost, note } = c.req.valid('json');
  if (
    unitCost !== undefined &&
    !hasInternalAppPermission(
      {
        email: c.get('email' as never) as string | undefined,
        role: c.get('role' as never) as string | undefined,
        permissions: c.get('permissions' as never) as string[] | undefined,
      },
      'financials:write',
    )
  ) {
    return c.json({ error: 'Financial write permission required for package unit cost' }, 403);
  }
  await ensurePackageConsumptionSchema();

  const result = await db.transaction(async (tx) => {
    const patch: Record<string, unknown> = {
      stockQty: sql`${packages.stockQty} + ${qty}`,
      updatedAt: new Date(),
    };
    if (unitCost !== undefined) patch.unitCost = String(unitCost);

    const [updated] = await tx
      .update(packages)
      .set(patch)
      .where(eq(packages.id, id))
      .returning();
    if (!updated) return null;
    const balanceAfter = updated.stockQty;

    const [entry] = await tx
      .insert(packageLedger)
      .values({
        packageId: id,
        changeType: 'receive',
        qtyDelta: qty,
        balanceAfter,
        note: note ?? null,
        unitCost: unitCost !== undefined ? String(unitCost) : null,
      })
      .returning();

    if (!entry) return null;
    return { package: updated, ledgerEntry: entry };
  });

  if (!result) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ data: redactPackageMutationResult(result, canViewFinancials) });
  },
);

const adjustBody = z.object({
  qtyDelta: z.number().int().refine((n) => n !== 0, 'qtyDelta cannot be 0'),
  note: z.string().max(500).optional(),
});

app.post(
  '/:id{[0-9]+}/adjust',
  requireBusinessRoutePolicy('packages.adjust'),
  zValidator('json', adjustBody),
  async (c) => {
  await ensurePackageConsumptionSchema();
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const { qtyDelta, note } = c.req.valid('json');

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(packages)
      .set({ stockQty: sql`${packages.stockQty} + ${qtyDelta}`, updatedAt: new Date() })
      .where(eq(packages.id, id))
      .returning();
    if (!updated) return null;
    const balanceAfter = updated.stockQty;

    const [entry] = await tx
      .insert(packageLedger)
      .values({
        packageId: id,
        changeType: 'adjust',
        qtyDelta,
        balanceAfter,
        note: note ?? null,
      })
      .returning();

    if (!entry) return null;
    return { package: updated, ledgerEntry: entry };
  });

  if (!result) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ data: redactPackageMutationResult(result, canViewFinancials) });
  },
);

app.get('/:id{[0-9]+}/ledger', async (c) => {
  await ensurePackageConsumptionSchema();
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const rawLimit = Number(c.req.query('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 500)
    : 100;

  const rows = await db
    .select()
    .from(packageLedger)
    .where(eq(packageLedger.packageId, id))
    .orderBy(desc(packageLedger.createdAt))
    .limit(limit);

  return c.json({ data: rows.map((row) => publicPackageLedgerRow(row, canViewFinancials)) });
});

// GET /packages/usage-summary?days=30
//
// Returns one row per package with the sum of |qty_delta| over negative
// ledger entries in the last N days. Replaces the N+1 fan-out the
// PackagesView used to do on every mount (one fetchPackageLedger per
// package, then sum client-side). With ~500 packages, that was 500
// round-trips and ~50,000 ledger rows transferred per page visit just
// to compute one number per row. This single SQL aggregate runs in
// one trip and returns ~500 small {packageId, used} pairs.
//
// Defaults to 30 days, capped at 365 to keep the index scan bounded.
// Packages with zero usage in the window are EXCLUDED from the result
// (the FE treats missing entries as 0) — keeps the payload small on
// fresh DBs where most packages haven't shipped anything recently.
app.get('/usage-summary', async (c) => {
  await ensurePackageConsumptionSchema();
  const rawDays = Number(c.req.query('days'));
  const days = Number.isFinite(rawDays) && rawDays > 0
    ? Math.min(Math.floor(rawDays), 365)
    : 30;

  const rows = await db.execute<{ package_id: number; used: string }>(sql`
    select
      package_id,
      greatest(0, coalesce(sum(case
        when change_type = 'ship' then -qty_delta
        when change_type = 'ship_void' then -qty_delta
        else 0
      end), 0))::text as used
    from package_ledger
    where coalesce(effective_at, created_at) >= now() - (interval '1 day' * ${days})
    group by package_id
    having coalesce(sum(case
      when change_type = 'ship' then -qty_delta
      when change_type = 'ship_void' then -qty_delta
      else 0
    end), 0) > 0
  `);

  // db.execute() returns slightly different shapes across drivers
  // (postgres-js has `.rows` synthesized). Normalize either form.
  const list = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
  const data = list.map((r: { package_id: number; used: string }) => ({
    packageId: Number(r.package_id),
    used: Number(r.used) || 0,
  }));

  return c.json({ days, data });
});

// v2-parity: PUT /packages/:id — alias for PATCH. v2 apiClient sends PUT.
app.put('/:id{[0-9]+}', requireBusinessRoutePolicy('packages.catalog.put'), zValidator('json', body.partial()), async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(packages)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(packages.id, id))
    .returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json(publicPackageRow(row, canViewFinancials));
});

// v2-parity: PATCH /packages/:id/reorder-level {reorderLevel}. Dedicated path so
// v2 callers don't need to know the generic PATCH shape.
app.patch(
  '/:id{[0-9]+}/reorder-level',
  requireBusinessRoutePolicy('packages.catalog.reorder-level'),
  zValidator('json', z.object({ reorderLevel: z.number().int().nonnegative() })),
  async (c) => {
    const canViewFinancials = canViewPackageFinancials(c);
    const id = Number(c.req.param('id'));
    const { reorderLevel } = c.req.valid('json');
    const [row] = await db
      .update(packages)
      .set({ reorderLevel, updatedAt: new Date() })
      .where(eq(packages.id, id))
      .returning();
    if (!row) return c.json({ error: 'Package not found' }, 404);
    invalidatePackagesCache();
    return c.json(publicPackageRow(row, canViewFinancials));
  }
);

// v2-parity: POST /packages/auto-create {length, width, height, name?, ...}
// Looks up by dims first (same tolerance as /find-by-dims); if a match exists
// returns it, otherwise creates a new "custom" package with the given dims.
app.post(
  '/auto-create',
  requireBusinessRoutePolicy('packages.catalog.auto-create'),
  zValidator(
    'json',
    z.object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
      name: z.string().optional(),
      tareWeightOz: z.number().nonnegative().optional(),
    })
  ),
  async (c) => {
    const canViewFinancials = canViewPackageFinancials(c);
    const { length, width, height, name, tareWeightOz } = c.req.valid('json');
    const tol = 0.1;
    const [existing] = await db
      .select()
      .from(packages)
      .where(
        and(
          sql`abs(${packages.length} - ${length}) <= ${tol}`,
          sql`abs(${packages.width} - ${width}) <= ${tol}`,
          sql`abs(${packages.height} - ${height}) <= ${tol}`
        )
      )
      .limit(1);
    if (existing) return c.json({ data: publicPackageRow(existing, canViewFinancials), created: false });

    const genName = name ?? `Custom ${length}x${width}x${height}`;
    const [row] = await db
      .insert(packages)
      .values({
        name: genName,
        type: 'box',
        length,
        width,
        height,
        tareWeightOz: tareWeightOz ?? 0,
        source: 'custom',
      })
      .returning();
    if (!row) return c.json({ error: 'Package could not be created' }, 500);
    invalidatePackagesCache();
    return c.json({ data: publicPackageRow(row, canViewFinancials), created: true }, 201);
  }
);

// Adds the saved DR PREPPER custom box-size library. The importer is
// idempotent: exact/fuzzy dimension matches are skipped instead of duplicated.
app.post(
  '/import-standard-dimensions',
  requireBusinessRoutePolicy('packages.catalog.import-dimensions'),
  async (c) => {
  const result = await importStandardPackageDimensions();
  if (result.inserted > 0) invalidatePackagesCache();
  return c.json({
    ...result,
    message: `Added ${result.inserted} package sizes (${result.skippedExisting} already existed)`,
  });
  },
);

// v2-parity: GET /packages/low-stock — packages whose stockQty is at or
// below reorderLevel. Used by the Packages view's "needs reorder" badge.
app.get('/low-stock', async (c) => {
  const canViewFinancials = canViewPackageFinancials(c);
  const rows = await db
    .select()
    .from(packages)
    .where(lte(packages.stockQty, packages.reorderLevel))
    .orderBy(packages.stockQty);
  return c.json({ data: rows.map((row) => publicPackageRow(row, canViewFinancials)) });
});

// v2-parity: GET /packages/find-by-dims?length=&width=&height=
// Fuzzy dimension lookup (±0.1" tolerance) so the rate browser can auto-
// pick a saved package from user-entered dims.
app.get(
  '/find-by-dims',
  zValidator(
    'query',
    z.object({
      length: z.coerce.number().positive(),
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
    })
  ),
  async (c) => {
    const canViewFinancials = canViewPackageFinancials(c);
    const { length, width, height } = c.req.valid('query');
    const tol = 0.1;
    const [row] = await db
      .select()
      .from(packages)
      .where(
        and(
          sql`abs(${packages.length} - ${length}) <= ${tol}`,
          sql`abs(${packages.width} - ${width}) <= ${tol}`,
          sql`abs(${packages.height} - ${height}) <= ${tol}`
        )
      )
      .limit(1);
    return c.json({ package: row ? publicPackageRow(row, canViewFinancials) : null });
  }
);

export default app;
