import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { packages } from '../db/schema/packages';
import { packageLedger } from '../db/schema/package-ledger';
import { ssRequest } from '../lib/shipstation';
import type { CarriersResponse } from '../lib/shipstation/types';

const app = new Hono();

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

app.get('/', async (c) => {
  const rows = await db.select().from(packages);
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
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(packages).where(eq(packages.id, id)).returning();
  if (!row) return c.json({ error: 'Package not found' }, 404);
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

  return c.json({
    inserted,
    skipped,
    message: `Synced ${inserted} new packages from ShipStation (${skipped} already existed)`,
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

export default app;
