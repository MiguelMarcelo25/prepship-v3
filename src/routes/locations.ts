import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { locations } from '../db/schema/locations';
import { setDefaultLocation } from '../services/locations';
import { ssV1Request } from '../lib/shipstation/v1-client';

const app = new Hono();

const body = z.object({
  name: z.string().min(1),
  company: z.string().nullable().optional(),
  street1: z.string().nullable().optional(),
  street2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().default('US'),
  phone: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

app.get('/', async (c) => {
  const rows = await db
    .select()
    .from(locations)
    .orderBy(desc(locations.isDefault), desc(locations.updatedAt));
  return c.json(rows);
});

app.get('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.select().from(locations).where(eq(locations.id, id)).limit(1);
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json(row);
});

app.post('/', zValidator('json', body), async (c) => {
  const v = c.req.valid('json');
  const [row] = await db.insert(locations).values(v).returning();
  return c.json(row, 201);
});

app.patch('/:id{[0-9]+}', zValidator('json', body.partial()), async (c) => {
  const id = Number(c.req.param('id'));
  const v = c.req.valid('json');
  const [row] = await db
    .update(locations)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(locations.id, id))
    .returning();
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json(row);
});

app.delete('/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const [row] = await db.delete(locations).where(eq(locations.id, id)).returning();
  if (!row) return c.json({ error: 'Location not found' }, 404);
  return c.json({ deleted: true });
});

app.post('/:id{[0-9]+}/default', async (c) => {
  const id = Number(c.req.param('id'));
  const row = await setDefaultLocation(id);
  return c.json(row);
});

// Pull warehouses from ShipStation v1 and upsert into locations.
app.post('/sync', async (c) => {
  type SSWarehouse = {
    warehouseId: number;
    warehouseName: string;
    isDefault?: boolean;
    originAddress?: {
      name?: string;
      company?: string | null;
      street1?: string;
      street2?: string | null;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
      phone?: string | null;
    };
  };

  const warehouses = await ssV1Request<SSWarehouse[]>('/warehouses', {
    dedupeKey: 'warehouses:list',
  });

  let inserted = 0;
  let updated = 0;

  for (const w of warehouses) {
    const a = w.originAddress ?? {};
    const values = {
      name: w.warehouseName,
      company: a.company ?? null,
      street1: a.street1 ?? null,
      street2: a.street2 ?? null,
      city: a.city ?? null,
      state: a.state ?? null,
      postalCode: a.postalCode ?? null,
      country: a.country ?? 'US',
      phone: a.phone ?? null,
    };

    const [existing] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.name, w.warehouseName))
      .limit(1);

    if (existing) {
      await db
        .update(locations)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(locations.id, existing.id));
      updated += 1;
    } else {
      await db.insert(locations).values(values);
      inserted += 1;
    }
  }

  // If exactly one location now exists and none is marked default, mark it.
  const all = await db.select().from(locations);
  if (all.length === 1 && !all[0]!.isDefault) {
    await db
      .update(locations)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(locations.id, all[0]!.id));
  }

  return c.json({
    inserted,
    updated,
    message: `Synced ${inserted + updated} warehouses (${inserted} new, ${updated} updated)`,
  });
});

export default app;
