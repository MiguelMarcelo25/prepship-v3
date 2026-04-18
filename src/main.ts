import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { requireAuth } from './middleware/auth';
import health from './routes/health';
import ordersRoute from './routes/orders';
import shipmentsRoute from './routes/shipments';
import packagesRoute from './routes/packages';
import clientsRoute from './routes/clients';
import ratesRoute from './routes/rates';
import labelsRoute from './routes/labels';
import syncRoute from './routes/sync';
import inventoryRoute from './routes/inventory';
import locationsRoute from './routes/locations';
import settingsRoute from './routes/settings';
import billingRoute from './routes/billing';
import manifestsRoute from './routes/manifests';

const app = new Hono();

const corsOrigins: string | string[] = env.WEB_ORIGIN
  ? env.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : '*';

app.use('*', logger());
app.use('*', cors({ origin: corsOrigins }));

app.route('/health', health);

// Everything below requires a valid Supabase JWT.
app.use('/orders/*', requireAuth);
app.use('/shipments/*', requireAuth);
app.use('/packages/*', requireAuth);
app.use('/clients/*', requireAuth);
app.use('/rates/*', requireAuth);
app.use('/labels/*', requireAuth);
app.use('/sync/*', requireAuth);
app.use('/inventory/*', requireAuth);
app.use('/locations/*', requireAuth);
app.use('/settings/*', requireAuth);
app.use('/billing/*', requireAuth);
app.use('/manifests/*', requireAuth);

app.route('/orders', ordersRoute);
app.route('/shipments', shipmentsRoute);
app.route('/packages', packagesRoute);
app.route('/clients', clientsRoute);
app.route('/rates', ratesRoute);
app.route('/labels', labelsRoute);
app.route('/sync', syncRoute);
app.route('/inventory', inventoryRoute);
app.route('/locations', locationsRoute);
app.route('/settings', settingsRoute);
app.route('/billing', billingRoute);
app.route('/manifests', manifestsRoute);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  const status = (err as { status?: number }).status ?? 500;
  return c.json(
    { error: err.message || 'Internal server error' },
    status as 500
  );
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
