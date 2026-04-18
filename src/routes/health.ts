import { Hono } from 'hono';
import { sql } from '../db/client';

const app = new Hono();

app.get('/', async (c) => {
  try {
    await sql`select 1`;
    return c.json({ status: 'ok', db: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    return c.json(
      { status: 'degraded', db: 'down', error: String(err) },
      503
    );
  }
});

export default app;
