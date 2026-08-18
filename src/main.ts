import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { routePath as matchedRoutePath } from 'hono/route';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import { DEFAULT_CORS_ALLOW_HEADERS, isAllowedCorsOrigin } from './lib/http/cors';
import { observeApiTiming } from './lib/http/api-metrics';
import { appendServerTiming, elapsedMs, nowMs } from './lib/http/timing';
import { logStructured, reportError, runWithLogContext } from './lib/structured-log';
import {
  enforceReadOnlySupportMethods,
  requireAdmin,
  requireAuth,
} from './middleware/auth';
import health from './routes/health';
import ordersRoute from './routes/orders';
import replacementsRoute from './routes/replacements';
import orderHazmatRoute from './routes/order-hazmat';
import hazmatContactsRoute from './routes/hazmat-contacts';
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
import storeAccountsRoute from './routes/store-accounts';
import oauthRoute from './routes/oauth';
import usersRoute from './routes/users';
import workerRoute from './routes/worker';
import observabilityRoute from './routes/observability';
import automationsRoute from './routes/automations';
import storeSourceCutoversRoute from './routes/store-source-cutovers';
import clientPortalIntegrationsRoute from './routes/client-portal/integrations';
import { assertRuntimeSchemaReady } from './services/runtime-schema-readiness.js';
import { createApiProcessLifecycle } from './services/api-process-lifecycle';

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
  await runWithLogContext({ requestId }, next);
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
      path: matchedRoutePath(c) || url.pathname,
      status: c.res.status,
      durationMs,
      responseBytes,
    });

    if (durationMs >= slowThresholdMs) {
      logStructured('info', 'api.request.slow', {
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
    allowHeaders: DEFAULT_CORS_ALLOW_HEADERS,
    exposeHeaders: ['X-Request-Id', 'Server-Timing'],
  })
);

app.route('/health', health);
app.route('/cron', cronRoute);
// PS-128/PS-129: public store/marketplace webhook ingestion. Mounted BEFORE the JWT block
// (providers can't send a Supabase JWT); each event is authenticated by per-provider HMAC.
app.route('/webhooks', webhooksRoute);
// PS-200 S4: eBay OAuth consent callback — the seller's browser arrives via
// redirect from eBay with no session; the single-use eBay auth code (bound to
// the stored keyset) is the auth. See src/routes/oauth.ts.
app.route('/oauth', oauthRoute);

// Everything below requires a valid Supabase JWT.
const protectedPrefixes = [
  '/orders',
  // PS-502: mounting a router does NOT attach requireAuth — this list does. Two features
  // have shipped unauthenticated by missing this line.
  '/replacements',
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
  // PS-200 S4 fix: S1 mounted /store-accounts but missed this allowlist —
  // requireCredentialAccountPermission then saw no auth vars and 403'd every
  // caller. The route was dark since the S1 deploy (same-day catch).
  '/store-accounts',
  '/carriers',
  '/users',
  '/worker',
  '/observability',
  '/automations',
  // Same trap as /store-accounts above: /hazmat/contacts mounted without being
  // listed here, so requireAuth never ran, the auth vars were never set, and
  // requireInternalPermission 403'd every caller with "Permission required"
  // even for an admin.
  '/hazmat',
  '/store-source-cutovers',
  '/client-portal',
];

for (const prefix of protectedPrefixes) {
  app.use(prefix, requireAuth);
  app.use(prefix, enforceReadOnlySupportMethods);
  app.use(`${prefix}/*`, requireAuth);
  app.use(`${prefix}/*`, enforceReadOnlySupportMethods);
}

app.use('/admin', requireAdmin);
app.use('/admin/*', requireAdmin);
app.use('/observability', requireAdmin);
app.use('/observability/*', requireAdmin);

app.route('/orders', ordersRoute);
// PS-502 item 13. The router itself 404s unless REPLACEMENTS_ENABLED, but it is still
// listed in protectedPrefixes below — mounting alone does NOT attach requireAuth, which is
// how /store-accounts and /hazmat each shipped unauthenticated.
app.route('/replacements', replacementsRoute);
app.route('/orders', orderHazmatRoute);
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
app.route('/store-accounts', storeAccountsRoute);
app.route('/users', usersRoute);
app.route('/worker', workerRoute);
app.route('/observability', observabilityRoute);
app.route('/automations', automationsRoute);
app.route('/hazmat/contacts', hazmatContactsRoute);
app.route('/store-source-cutovers', storeSourceCutoversRoute);
app.route('/client-portal', clientPortalIntegrationsRoute);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const status = (err as { status?: number }).status ?? 500;
  const url = new URL(c.req.url);
  reportError('api.request.failed', err, {
    requestId: c.get('requestId'),
    method: c.req.method,
    path: url.pathname,
    status,
  });
  const isSafeClientError = status >= 400 && status < 500;
  const message =
    isSafeClientError && err.message ? err.message : 'Internal server error';
  return c.json({ error: message }, status as 500);
});

async function main(): Promise<void> {
  await assertRuntimeSchemaReady();
  console.log('[runtime] migration-owned schema ready');

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`API listening on http://localhost:${info.port}`);
    // Audit 3.2: the API never owns background cadence. RUN_SYNC_SCHEDULER is
    // consumed only by worker.ts, where pg-boss provides cross-process admission.
    console.log('[runtime] API scheduler disabled; durable cadence is worker-owned');

    if (env.SHIPMENT_SYNC_WATCHDOG_ENABLED) {
      console.log(
        '[runtime] SHIPMENT_SYNC_WATCHDOG_ENABLED=true; starting API-side shipment watchdog'
      );
      void import('./services/shipment-sync-watchdog').then(({ startShipmentSyncWatchdog }) =>
        startShipmentSyncWatchdog()
      );
    } else {
      console.log('[runtime] shipment sync watchdog disabled');
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

  const lifecycle = createApiProcessLifecycle({
    server,
    shutdownTimeoutMs: env.API_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    uncaughtFailureLimit: env.API_UNCAUGHT_FAILURE_LIMIT,
  });
  process.once('SIGINT', (signal) => lifecycle.shutdown(signal));
  process.once('SIGTERM', (signal) => lifecycle.shutdown(signal));
  process.on('unhandledRejection', (reason) => {
    lifecycle.recordUncaughtFailure('unhandled_rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    lifecycle.recordUncaughtFailure('uncaught_exception', error);
  });
}

void main().catch((error) => {
  reportError('runtime.schema_readiness_blocked', error);
  process.exit(1);
});
