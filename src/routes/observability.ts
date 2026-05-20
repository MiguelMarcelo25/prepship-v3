import { Hono } from 'hono';
import { getApiTimingSnapshot } from '../lib/http/api-metrics';

const app = new Hono();

app.get('/api-timing', (c) => c.json(getApiTimingSnapshot()));

export default app;
