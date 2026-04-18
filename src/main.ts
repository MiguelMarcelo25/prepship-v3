import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { env } from './lib/env.js';
import health from './routes/health.js';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.route('/health', health);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error(err);
  const status = (err as { status?: number }).status ?? 500;
  return c.json({ error: err.message || 'Internal server error' }, status as 400);
});

export default {
  port: env.PORT,
  fetch: app.fetch,
};

console.log(`API listening on http://localhost:${env.PORT}`);
