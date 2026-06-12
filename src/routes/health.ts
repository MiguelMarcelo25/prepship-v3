import { Hono } from 'hono';
import postgres from 'postgres';
import { performance } from 'node:perf_hooks';
import { env } from '../lib/env';

const app = new Hono();
const DB_HEALTH_TIMEOUT_MS = env.DB_HEALTH_TIMEOUT_MS;
const DB_HEALTH_STATEMENT_TIMEOUT_MS = Math.max(1_000, DB_HEALTH_TIMEOUT_MS - 1_000);
const DB_HEALTH_CONNECT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(DB_HEALTH_TIMEOUT_MS / 1_000));
const EVENT_LOOP_HEALTH_TIMEOUT_MS = 500;
const EVENT_LOOP_DELAY_BUDGET_MS = 250;

const healthSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 3,
  idle_timeout: 10,
  connect_timeout: DB_HEALTH_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: DB_HEALTH_STATEMENT_TIMEOUT_MS },
});

type CancelableQuery<T> = Promise<T> & { cancel?: () => void };

type ReadinessComponentName = 'db' | 'orders' | 'printQueue' | 'eventLoop';

type ReadinessComponent = {
  name: ReadinessComponentName;
  status: 'ok' | 'fail';
  latencyMs: number;
  details?: Record<string, number | string>;
};

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

async function checkComponent(
  name: ReadinessComponentName,
  action: () => Promise<{ details?: Record<string, number | string> } | void>
): Promise<ReadinessComponent> {
  const startedAt = Date.now();
  try {
    const result = await action();
    return {
      name,
      status: 'ok',
      latencyMs: Date.now() - startedAt,
      ...(result?.details ? { details: result.details } : {}),
    };
  } catch {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function checkDeepReadiness() {
  const components = await Promise.all([
    checkComponent('db', async () => {
      await withTimeout(healthSql`select 1`, DB_HEALTH_TIMEOUT_MS);
    }),
    checkComponent('orders', async () => {
      await withTimeout(healthSql`select 1 from orders limit 1`, DB_HEALTH_TIMEOUT_MS);
    }),
    checkComponent('printQueue', async () => {
      const [summary] = await withTimeout(
        healthSql`
          select
            count(*)::int as total_count,
            count(*) filter (where status = 'queued')::int as queued_count
          from print_queue_orders
        `,
        DB_HEALTH_TIMEOUT_MS
      );

      return {
        details: {
          totalCount: Number(summary?.total_count ?? 0),
          queuedCount: Number(summary?.queued_count ?? 0),
        },
      };
    }),
    checkComponent('eventLoop', async () => {
      const startedAt = performance.now();
      await withTimeout(
        new Promise<void>((resolve) => setTimeout(resolve, 0)) as CancelableQuery<void>,
        EVENT_LOOP_HEALTH_TIMEOUT_MS
      );
      const delayMs = Math.round(performance.now() - startedAt);
      if (delayMs > EVENT_LOOP_DELAY_BUDGET_MS) {
        throw new Error('event loop delay budget exceeded');
      }
      return { details: { delayMs, budgetMs: EVENT_LOOP_DELAY_BUDGET_MS } };
    }),
  ]);

  return {
    ok: components.every((component) => component.status === 'ok'),
    components,
  };
}

function readinessResponseBody(readiness: Awaited<ReturnType<typeof checkDeepReadiness>>) {
  return {
    status: readiness.ok ? 'ready' : 'degraded',
    components: readiness.components,
    // PS-215: the external-shipped classifier flags are operational state the
    // Shipped-table invariant depends on (rows resting on "Shipment sync
    // error" usually mean the classifier isn't running). Surfacing them here
    // makes a silently-disabled deploy visible at a glance instead of being
    // discovered through a wall of amber badges.
    externalShippedClassifier: {
      schedulerEnabled: env.ENABLE_EXTERNAL_SHIPPED_CLASSIFIER_SCHEDULER === true,
      autoApplyEnabled: env.ENABLE_EXTERNAL_SHIPPED_AUTO_APPLY === true,
    },
    ts: new Date().toISOString(),
  };
}

app.get('/', (c) =>
  c.json({
    status: 'ok',
    ts: new Date().toISOString(),
  })
);

app.get('/ready', async (c) => {
  const readiness = await checkDeepReadiness();
  return c.json(readinessResponseBody(readiness), readiness.ok ? 200 : 503);
});

app.get('/deep', async (c) => {
  const readiness = await checkDeepReadiness();
  return c.json(readinessResponseBody(readiness), readiness.ok ? 200 : 503);
});

export default app;
