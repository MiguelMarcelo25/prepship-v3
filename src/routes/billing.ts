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
import {
  billingDetails,
  billingSummary,
  generateLineItems,
  upsertBillingConfig,
} from '../services/billing';

const app = new Hono();

app.get('/config', async (c) => {
  const rows = await db
    .select()
    .from(billingConfig)
    .orderBy(desc(billingConfig.updatedAt));
  return c.json({ data: rows });
});

const configBody = z.object({
  pickPackFee: z.coerce.number().nonnegative().optional(),
  additionalUnitFee: z.coerce.number().nonnegative().optional(),
  packageCostMarkup: z.coerce.number().nonnegative().optional(),
  shippingMarkupPct: z.coerce.number().nonnegative().optional(),
  shippingMarkupFlat: z.coerce.number().nonnegative().optional(),
  billingMode: z.enum(['per_shipment', 'monthly']).optional(),
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
      billingMode: body.billingMode,
      active: body.active,
    });
    return c.json(row);
  }
);

const generateSchema = z.object({
  clientId: z.coerce.number().int().optional(),
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
});

app.post('/generate', zValidator('json', generateSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await generateLineItems(body);
  return c.json(result);
});

app.get('/summary', zValidator('query', generateSchema), async (c) => {
  const q = c.req.valid('query');
  const summary = await billingSummary(q);
  return c.json(summary);
});

app.get(
  '/details',
  zValidator('query', generateSchema.extend({ limit: z.coerce.number().int().max(2000).optional() })),
  async (c) => {
    const q = c.req.valid('query');
    const rows = await billingDetails(q);
    return c.json({ data: rows });
  }
);

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

app.post('/backfill-ref-rates', zValidator('json', refRatesUpsertBody), async (c) => {
  const { rates } = c.req.valid('json');
  await db.insert(billingRefRates).values(
    rates.map((r) => ({
      weightOz: r.weightOz,
      zipTo: r.zipTo.toUpperCase(),
      carrier: r.carrier,
      service: r.service ?? null,
      cost: r.cost.toFixed(2),
      source: r.source ?? 'manual',
      fetchedAt: new Date(),
    }))
  );
  return c.json({ inserted: rates.length });
});

// In-process fetch job tracker (placeholder — actual carrier-rate
// fetcher is a future follow-up; this just reports "no job running"
// so the legacy UI's poll loop doesn't choke).
app.post('/fetch-ref-rates', async (c) => {
  return c.json({
    job_id: null,
    status: 'not_implemented',
    message:
      'Live RateShopper fetch is not wired yet. Use POST /billing/backfill-ref-rates with a static array for now.',
  });
});

app.get('/fetch-ref-rates/status', async (c) => {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(billingRefRates);
  return c.json({
    status: 'idle',
    total_ref_rates: rows[0]?.count ?? 0,
  });
});

export default app;
