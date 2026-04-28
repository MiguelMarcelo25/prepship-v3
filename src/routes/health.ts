import { Hono } from 'hono';
import postgres from 'postgres';
import { env } from '../lib/env';

const app = new Hono();
const DB_HEALTH_TIMEOUT_MS = env.DB_HEALTH_TIMEOUT_MS;
const DB_HEALTH_STATEMENT_TIMEOUT_MS = Math.max(1_000, DB_HEALTH_TIMEOUT_MS - 1_000);
const DB_HEALTH_CONNECT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(DB_HEALTH_TIMEOUT_MS / 1_000));

const healthSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 1,
  idle_timeout: 10,
  connect_timeout: DB_HEALTH_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: DB_HEALTH_STATEMENT_TIMEOUT_MS },
});

type CancelableQuery<T> = Promise<T> & { cancel?: () => void };

type DbHealth =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: string };

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

async function checkDbHealth(): Promise<DbHealth> {
  const startedAt = Date.now();
  try {
    await withTimeout(healthSql`select 1`, DB_HEALTH_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: String(err),
    };
  }
}

app.get('/', async (c) => {
  const dbHealth = await checkDbHealth();
  if (dbHealth.ok) {
    return c.json({
      status: 'ok',
      db: 'ok',
      latencyMs: dbHealth.latencyMs,
      ts: new Date().toISOString(),
    });
  }

  return c.json({
    status: 'ok',
    db: 'unavailable',
    latencyMs: dbHealth.latencyMs,
    warning: dbHealth.error,
    ts: new Date().toISOString(),
  });
});

app.get('/ready', async (c) => {
  const dbHealth = await checkDbHealth();
  if (dbHealth.ok) {
    return c.json({
      status: 'ready',
      db: 'ok',
      latencyMs: dbHealth.latencyMs,
      ts: new Date().toISOString(),
    });
  }

  return c.json(
    {
      status: 'degraded',
      db: 'down',
      latencyMs: dbHealth.latencyMs,
      error: dbHealth.error,
      ts: new Date().toISOString(),
    },
    503
  );
});

export default app;
