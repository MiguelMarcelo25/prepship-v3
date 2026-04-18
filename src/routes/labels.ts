import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  createLabelFromRate,
  createLabelFromShipment,
  lookupLabel,
  voidLabel,
} from '../services/labels';

const app = new Hono();

const createFromRate = z.object({
  mode: z.literal('from_rate'),
  rateId: z.string().min(1),
  orderId: z.number().int().positive(),
  clientId: z.number().int().positive().optional(),
});

const addressSchema = z.object({
  name: z.string().optional(),
  company_name: z.string().optional(),
  phone: z.string().optional(),
  address_line1: z.string(),
  address_line2: z.string().optional(),
  city_locality: z.string(),
  state_province: z.string(),
  postal_code: z.string(),
  country_code: z.string().default('US'),
});

const createFromShipment = z.object({
  mode: z.literal('from_shipment'),
  orderId: z.number().int().positive(),
  clientId: z.number().int().positive().optional(),
  weightOz: z.number().positive(),
  dimensions: z
    .object({
      length: z.number().positive(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
  shipTo: addressSchema,
  serviceCode: z.string().min(1),
  residential: z.boolean().optional(),
});

const createBody = z.discriminatedUnion('mode', [createFromRate, createFromShipment]);

app.post('/', zValidator('json', createBody), async (c) => {
  const body = c.req.valid('json');
  const result =
    body.mode === 'from_rate'
      ? await createLabelFromRate(body)
      : await createLabelFromShipment(body);
  return c.json(result, 201);
});

app.get('/:lookup', async (c) => {
  const lookup = c.req.param('lookup');
  const rows = await lookupLabel(lookup);
  if (!rows.length) return c.json({ error: 'No labels found' }, 404);
  return c.json({ data: rows });
});

app.post('/:shipmentId{[0-9]+}/void', async (c) => {
  const id = Number(c.req.param('shipmentId'));
  const row = await voidLabel(id);
  return c.json(row);
});

export default app;
