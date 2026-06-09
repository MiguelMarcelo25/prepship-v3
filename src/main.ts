import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { isAllowedCorsOrigin } from './lib/http/cors';
import { observeApiTiming } from './lib/http/api-metrics';
import { appendServerTiming, elapsedMs, nowMs } from './lib/http/timing';
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
import webhooksRoute from './routes/webhooks';
import printQueueRoute from './routes/print-queue';
import parentSkusRoute from './routes/parent-skus';
import productsRoute from './routes/products';
import initRoute from './routes/init';
import adminRoute from './routes/admin';
import carrierAccountsRoute from './routes/carrier-accounts';
import carriersRoute from './routes/carriers';
import usersRoute from './routes/users';
import workerRoute from './routes/worker';
import observabilityRoute from './routes/observability';
import automationRoute from './routes/automation';

type AppVars = {
  requestId: string;
  authDurationMs?: number;
};

const app = new Hono<{ Variables: AppVars }>();

function normalizeRequestId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

app.use('*', async (c, next) => {
  const requestId =
    normalizeRequestId(c.req.header('x-request-id')) ??
    normalizeRequestId(c.req.header('x-correlation-id')) ??
    randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});
app.use('*', logger());
app.use('*', async (c, next) => {
  const startedAt = nowMs();
  try {
    await next();
  } finally {
    const durationMs = elapsedMs(startedAt);
    const thresholdMs = Number.parseInt(process.env.API_TIMING_LOG_MS ?? '750', 10);
    const slowThresholdMs = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : 750;
    const authDurationMs = Number(c.get('authDurationMs') ?? 0);
    c.header(
      'Server-Timing',
      appendServerTiming(c.res.headers.get('Server-Timing'), {
        app: durationMs,
        auth: Number.isFinite(authDurationMs) ? authDurationMs : 0,
      })
    );

    const url = new URL(c.req.url);
    const contentLength = c.res.headers.get('content-length');
    const responseBytes =
      contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
    observeApiTiming({
      method: c.req.method,
      path: url.pathname,
      status: c.res.status,
      durationMs,
      responseBytes,
    });

    if (durationMs >= slowThresholdMs) {
      console.info('[api:timing]', {
        requestId: c.get('requestId'),
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
    allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Correlation-Id'],
    exposeHeaders: ['X-Request-Id', 'Server-Timing'],
  })
);

app.route('/health', health);
app.route('/cron', cronRoute);
// PS-128/PS-129: public store/marketplace webhook ingestion. Mounted BEFORE the JWT block
// (providers can't send a Supabase JWT); each event is authenticated by per-provider HMAC.
app.route('/webhooks', webhooksRoute);

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
  '/observability',
  '/automation',
];

for (const prefix of protectedPrefixes) {
  app.use(prefix, requireAuth);
  app.use(`${prefix}/*`, requireAuth);
}

app.use('/admin', requireAdmin);
app.use('/admin/*', requireAdmin);
app.use('/observability', requireAdmin);
app.use('/observability/*', requireAdmin);

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
app.route('/observability', observabilityRoute);
app.route('/automation', automationRoute);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  const url = new URL(c.req.url);
  console.error('[api:error]', {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: url.pathname,
    status,
    error: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error && err.stack) console.error(err.stack);
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

  const runMaintenance = env.RUN_ORDERS_PERFORMANCE_MAINTENANCE === true;
  if (runMaintenance) {
    console.log(
      '[runtime] RUN_ORDERS_PERFORMANCE_MAINTENANCE=true; starting orders performance maintenance'
    );
    void import('./services/orders-performance-maintenance').then(
      ({ ensureOrdersPerformanceIndexes }) => ensureOrdersPerformanceIndexes()
    );
  } else {
    console.log(
      '[runtime] orders performance maintenance disabled for this process; set RUN_ORDERS_PERFORMANCE_MAINTENANCE=true to run explicitly'
    );
  }
});
