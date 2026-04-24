import { Hono } from 'hono';
import { sql } from '../db/client';

const app = new Hono();
const DB_HEALTH_TIMEOUT_MS = 2500;

type CancelableQuery<T> = Promise<T> & { cancel?: () => void };

async function withTimeout<T>(
  query: CancelableQuery<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          query.cancel?.();
          reject(
            new Error(`DB health check timed out after ${timeoutMs}ms`)
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

app.get('/', async (c) => {
  try {
    await withTimeout(sql`select 1`, DB_HEALTH_TIMEOUT_MS);
    return c.json({ status: 'ok', db: 'ok', ts: new Date().toISOString() });
  } catch (err) {
    return c.json(
      { status: 'degraded', db: 'down', error: String(err) },
      503
    );
  }
});

export default app;
