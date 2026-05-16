import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { packages } from '../db/schema/packages';
import { packageLedger } from '../db/schema/package-ledger';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';
import { importStandardPackageDimensions } from '../services/package-dimension-importer';

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
  stockQty: z.number().int().nonnegative().optional(),
  reorderLevel: z.number().int().nonnegative().optional(),
  unitCost: z.string().optional(),
  isDefault: z.boolean().optional(),
});

function invalidatePackagesCache() {
  packagesCache = null;
  packagesInflight = null;
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
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  if (!row) return c.json({ error: 'Package not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(packages).values(v).returning();
  invalidatePackagesCache();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(packages)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(packages.id, id))
    .returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(packages).where(eq(packages.id, id)).returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ deleted: true });
});

// Sync carrier-default packages from ShipStation. Pulls /v2/carriers and
// upserts each carrier's package list into our packages table.
// Dimensions stay 0 — ShipStation's API doesn't expose them; user fills in.
app.post('/sync', async (c) => {
  const res = await ssRequest<CarriersResponse>('/v2/carriers', {
    dedupeKey: 'carriers:list',
  });

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

app.post('/backfill-start-date', async (c) => {
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
});

const receiveBody = z.object({
  qty: z.number().int().positive(),
  unitCost: z.number().nonnegative().optional(),
  note: z.string().max(500).optional(),
});

app.post('/:id{[0-9]+}/receive', zValidator('json', receiveBody), async (c) => {
  const id = Number(c.req.param('id'));
  const { qty, unitCost, note } = c.req.valid('json');

  const result = await db.transaction(async (tx) => {
    const [pkg] = await tx
      .select()
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    if (!pkg) return null;

    const balanceAfter = pkg.stockQty + qty;
    const patch: Record<string, unknown> = {
      stockQty: balanceAfter,
      updatedAt: new Date(),
    };
    if (unitCost !== undefined) patch.unitCost = String(unitCost);

    const [updated] = await tx
      .update(packages)
      .set(patch)
      .where(eq(packages.id, id))
      .returning();

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

    return { package: updated, ledgerEntry: entry };
  });

  if (!result) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ data: result });
});

const adjustBody = z.object({
  qtyDelta: z.number().int().refine((n) => n !== 0, 'qtyDelta cannot be 0'),
  note: z.string().max(500).optional(),
});

app.post('/:id{[0-9]+}/adjust', zValidator('json', adjustBody), async (c) => {
  const id = Number(c.req.param('id'));
  const { qtyDelta, note } = c.req.valid('json');

  const result = await db.transaction(async (tx) => {
    const [pkg] = await tx
      .select()
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    if (!pkg) return null;

    const balanceAfter = pkg.stockQty + qtyDelta;
    const [updated] = await tx
      .update(packages)
      .set({ stockQty: balanceAfter, updatedAt: new Date() })
      .where(eq(packages.id, id))
      .returning();

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

    return { package: updated, ledgerEntry: entry };
  });

  if (!result) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json({ data: result });
});

app.get('/:id{[0-9]+}/ledger', async (c) => {
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

  return c.json({ data: rows });
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
  const rawDays = Number(c.req.query('days'));
  const days = Number.isFinite(rawDays) && rawDays > 0
    ? Math.min(Math.floor(rawDays), 365)
    : 30;

  const rows = await db.execute<{ package_id: number; used: string }>(sql`
    select
      package_id,
      coalesce(sum(case when qty_delta < 0 then -qty_delta else 0 end), 0)::text as used
    from package_ledger
    where created_at >= now() - (interval '1 day' * ${days})
    group by package_id
    having coalesce(sum(case when qty_delta < 0 then -qty_delta else 0 end), 0) > 0
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
app.put('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(packages)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(packages.id, id))
    .returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
  invalidatePackagesCache();
  return c.json(row);
});

// v2-parity: PATCH /packages/:id/reorder-level {reorderLevel}. Dedicated path so
// v2 callers don't need to know the generic PATCH shape.
app.patch(
  '/:id{[0-9]+}/reorder-level',
  zValidator('json', z.object({ reorderLevel: z.number().int().nonnegative() })),
  async (c) => {
    const id = Number(c.req.param('id'));
    const { reorderLevel } = c.req.valid('json');
    const [row] = await db
      .update(packages)
      .set({ reorderLevel, updatedAt: new Date() })
      .where(eq(packages.id, id))
      .returning();
    if (!row) return c.json({ error: 'Package not found' }, 404);
    invalidatePackagesCache();
    return c.json(row);
  }
);

// v2-parity: POST /packages/auto-create {length, width, height, name?, ...}
// Looks up by dims first (same tolerance as /find-by-dims); if a match exists
// returns it, otherwise creates a new "custom" package with the given dims.
app.post(
  '/auto-create',
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
    if (existing) return c.json({ data: existing, created: false });

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
    invalidatePackagesCache();
    return c.json({ data: row, created: true }, 201);
  }
);

// Adds the saved DR PREPPER custom box-size library. The importer is
// idempotent: exact/fuzzy dimension matches are skipped instead of duplicated.
app.post('/import-standard-dimensions', async (c) => {
  const result = await importStandardPackageDimensions();
  if (result.inserted > 0) invalidatePackagesCache();
  return c.json({
    ...result,
    message: `Added ${result.inserted} package sizes (${result.skippedExisting} already existed)`,
  });
});

// v2-parity: GET /packages/low-stock — packages whose stockQty is at or
// below reorderLevel. Used by the Packages view's "needs reorder" badge.
app.get('/low-stock', async (c) => {
  const rows = await db
    .select()
    .from(packages)
    .where(lte(packages.stockQty, packages.reorderLevel))
    .orderBy(packages.stockQty);
  return c.json({ data: rows });
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
    return c.json({ package: row ?? null });
  }
);

export default app;
