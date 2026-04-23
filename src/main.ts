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
import analysisRoute from './routes/analysis';
import cronRoute from './routes/cron';
import printQueueRoute from './routes/print-queue';
import parentSkusRoute from './routes/parent-skus';
import productsRoute from './routes/products';
import initRoute from './routes/init';
import adminRoute from './routes/admin';

const app = new Hono();

const corsOrigins: string | string[] = env.WEB_ORIGIN
  ? env.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : '*';

app.use('*', logger());
app.use('*', cors({ origin: corsOrigins }));

app.route('/health', health);
app.route('/cron', cronRoute);

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
app.use('/analysis/*', requireAuth);
app.use('/print-queue/*', requireAuth);
app.use('/parent-skus/*', requireAuth);
app.use('/products/*', requireAuth);
app.use('/init/*', requireAuth);
app.use('/admin/*', requireAuth);

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
app.route('/analysis', analysisRoute);
app.route('/print-queue', printQueueRoute);
app.route('/parent-skus', parentSkusRoute);
app.route('/products', productsRoute);
app.route('/init', initRoute);
app.route('/admin', adminRoute);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  const status = (err as { status?: number }).status ?? 500;
  return c.json(
    { error: err.message || 'Internal server error' },
    status as 500
  );
});

// Keep the process alive on unhandled rejections / uncaught exceptions.
// Node v25 crashes on unhandled rejections by default — that's the right
// default for scripts, but a long-running API server has many background
// promise chains (the sync scheduler, rate backfill, mock-label persist,
// connection-level postgres.js events) where a single Postgres timeout or
// ShipStation error shouldn't take the entire service down. Hono's
// app.onError already responds 500 to the HTTP caller; these handlers
// catch anything that escapes the request lifecycle.
//
// Render's health check (/health) will start returning non-200 only if the
// process truly can't respond — which is what we want. Silent timeouts on
// a single query should log and continue.
process.on('unhandledRejection', (reason) => {
  const msg =
    reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : String(reason);
  console.error('[unhandledRejection]', msg);
  if (reason instanceof Error && reason.stack) console.error(reason.stack);
});

process.on('uncaughtException', (err) => {
  console.error(
    '[uncaughtException]',
    err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  );
  if (err instanceof Error && err.stack) console.error(err.stack);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
  // Start the 3-minute in-process sync scheduler (v2 parity). GitHub Actions
  // cron remains as a 10-min safety net for when this process is asleep.
  void import('./services/sync-scheduler').then(({ startSyncScheduler }) =>
    startSyncScheduler()
  );
});
