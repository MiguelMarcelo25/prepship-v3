import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { ensureOrderItemsStorage } from './order-items';

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

export async function getAnalyticsCache<T>(cacheKey: string): Promise<T | null> {
  try {
    await ensureOrderItemsStorage();
    const [row] = await db.execute<{ payload: T }>(sql`
      select payload
      from analytics_cache
      where cache_key = ${cacheKey}
        and expires_at > now()
      limit 1
    `);
    return row?.payload ?? null;
  } catch (err) {
    console.warn(
      '[analytics-cache] read failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function setAnalyticsCache(
  cacheKey: string,
  payload: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await ensureOrderItemsStorage();
    await db.execute(sql`
      insert into analytics_cache (cache_key, payload, expires_at, updated_at)
      values (${cacheKey}, ${JSON.stringify(payload)}::jsonb, now() + (${ttlSeconds}::int * interval '1 second'), now())
      on conflict (cache_key) do update set
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = now()
    `);
  } catch (err) {
    console.warn(
      '[analytics-cache] write failed:',
      err instanceof Error ? err.message : err
    );
  }
}
