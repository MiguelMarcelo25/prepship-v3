import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ensureOrderItemsStorage } from './order-items.js';

export function analyticsCacheKey(scope: string, input: Record<string, unknown>): string {
  const stableInput = Object.keys(input)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = input[key];
      return acc;
    }, {});
  const digest = createHash('sha256')
    .update(JSON.stringify(stableInput))
    .digest('hex')
    .slice(0, 40);
  return `${scope}:${digest}`;
}

export async function getAnalyticsCacheOrThrow<T>(cacheKey: string): Promise<T | null> {
  await ensureOrderItemsStorage();
  const [row] = await db.execute<{ payload: T }>(sql`
    select payload
    from analytics_cache
    where cache_key = ${cacheKey}
      and expires_at > now()
    limit 1
  `);
  return row?.payload ?? null;
}

export async function getAnalyticsCache<T>(cacheKey: string): Promise<T | null> {
  try {
    return await getAnalyticsCacheOrThrow<T>(cacheKey);
  } catch (err) {
    console.warn(
      '[analytics-cache] read failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function setAnalyticsCacheOrThrow(
  cacheKey: string,
  payload: unknown,
  ttlSeconds: number
): Promise<void> {
  await ensureOrderItemsStorage();
  await db.execute(sql`
    insert into analytics_cache (cache_key, payload, expires_at, updated_at)
    values (${cacheKey}, ${JSON.stringify(payload)}::jsonb, now() + (${ttlSeconds}::int * interval '1 second'), now())
    on conflict (cache_key) do update set
      payload = excluded.payload,
      expires_at = excluded.expires_at,
      updated_at = now()
  `);
}

export async function setAnalyticsCache(
  cacheKey: string,
  payload: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await setAnalyticsCacheOrThrow(cacheKey, payload, ttlSeconds);
  } catch (err) {
    console.warn(
      '[analytics-cache] write failed:',
      err instanceof Error ? err.message : err
    );
  }
}
