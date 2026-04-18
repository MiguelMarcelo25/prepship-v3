import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env';
import health from './routes/health';
import ordersRoute from './routes/orders';
import shipmentsRoute from './routes/shipments';
import packagesRoute from './routes/packages';
import clientsRoute from './routes/clients';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.route('/health', health);
app.route('/orders', ordersRoute);
app.route('/shipments', shipmentsRoute);
app.route('/packages', packagesRoute);
app.route('/clients', clientsRoute);

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
