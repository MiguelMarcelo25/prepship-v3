import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { requireAdmin, requireAuth } from './middleware/auth';
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
import dashboardRoute from './routes/dashboard';
import cronRoute from './routes/cron';
import printQueueRoute from './routes/print-queue';
import parentSkusRoute from './routes/parent-skus';
import productsRoute from './routes/products';
import initRoute from './routes/init';
import adminRoute from './routes/admin';
import carrierAccountsRoute from './routes/carrier-accounts';
import carriersRoute from './routes/carriers';
import usersRoute from './routes/users';
import workerRoute from './routes/worker';

const app = new Hono();

const configuredCorsOrigins = env.WEB_ORIGIN
  ? env.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const isDevelopmentLocalOrigin = (origin: string) => {
  if (env.NODE_ENV === 'production') return false;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;

    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  } catch {
    return false;
  }
};

const isAllowedCorsOrigin = (origin: string) => {
  if (configuredCorsOrigins.includes(origin)) return true;
  if (isDevelopmentLocalOrigin(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'https:') return false;

    return (
      hostname === 'prepshipv4.vercel.app' ||
      hostname === 'prepshipv4.drprepperusa.com' ||
      hostname === 'prepshipv3.vercel.app' ||
      hostname === 'prepshipv3.drprepperusa.com' ||
      hostname === 'prepshipv3-dr-prepper-usas-projects.vercel.app' ||
      hostname.endsWith('-dr-prepper-usas-projects.vercel.app')
    );
  } catch {
    return false;
  }
};

app.use('*', logger());
app.use('*', async (c, next) => {
  const startedAt = Date.now();
  try {
    await next();
  } finally {
    const durationMs = Date.now() - startedAt;
    const thresholdMs = Number.parseInt(process.env.API_TIMING_LOG_MS ?? '750', 10);
    const slowThresholdMs = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : 750;
    c.header('Server-Timing', `app;dur=${durationMs}`);

    if (durationMs >= slowThresholdMs) {
      const url = new URL(c.req.url);
      const contentLength = c.res.headers.get('content-length');
      const responseBytes =
        contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
      console.info('[api:timing]', {
        method: c.req.method,
        path: url.pathname,
        status: c.res.status,
        durationMs,
        responseBytes,
      });
    }
  }
});
app.use(
  '*',
  cors({
    origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
  })
);

app.route('/health', health);
app.route('/cron', cronRoute);

// Everything below requires a valid Supabase JWT.
const protectedPrefixes = [
  '/orders',
  '/shipments',
  '/packages',
  '/clients',
  '/rates',
  '/labels',
  '/sync',
  '/inventory',
  '/locations',
  '/settings',
  '/billing',
  '/manifests',
  '/analysis',
  '/dashboard',
  '/print-queue',
  '/parent-skus',
  '/products',
  '/init',
  '/admin',
  '/carrier-accounts',
  '/carriers',
  '/users',
  '/worker',
];

for (const prefix of protectedPrefixes) {
  app.use(prefix, requireAuth);
  app.use(`${prefix}/*`, requireAuth);
}

app.use('/admin', requireAdmin);
app.use('/admin/*', requireAdmin);

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
app.route('/dashboard', dashboardRoute);
app.route('/print-queue', printQueueRoute);
app.route('/parent-skus', parentSkusRoute);
app.route('/products', productsRoute);
app.route('/init', initRoute);
app.route('/admin', adminRoute);
app.route('/carrier-accounts', carrierAccountsRoute);
app.route('/carriers', carriersRoute);
app.route('/users', usersRoute);
app.route('/worker', workerRoute);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  const status = (err as { status?: number }).status ?? 500;
  const isSafeClientError = status >= 400 && status < 500;
  const message =
    isSafeClientError && err.message ? err.message : 'Internal server error';
  return c.json({ error: message }, status as 500);
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
  // Runtime split: the Web API should serve user traffic, while the Render
  // Worker owns sync/reporting jobs once RUN_SYNC_SCHEDULER is disabled here.
  if (env.RUN_SYNC_SCHEDULER) {
    console.log('[runtime] RUN_SYNC_SCHEDULER=true; starting API scheduler');
    void import('./services/sync-scheduler').then(({ startSyncScheduler }) =>
      startSyncScheduler({ mode: 'api-scheduler' })
    );
  } else {
    console.log('[runtime] RUN_SYNC_SCHEDULER=false; API scheduler disabled');
  }

  const runMaintenance =
    env.RUN_ORDERS_PERFORMANCE_MAINTENANCE ?? env.RUN_SYNC_SCHEDULER;
  if (runMaintenance) {
    void import('./services/orders-performance-maintenance').then(
      ({ ensureOrdersPerformanceIndexes }) => ensureOrdersPerformanceIndexes()
    );
  } else {
    console.log(
      '[runtime] orders performance maintenance disabled for this process'
    );
  }
});
