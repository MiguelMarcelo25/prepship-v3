import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../lib/env';
import * as schema from './schema/index';

const sql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  // Per-query timeout sent to Postgres via SET statement_timeout. Kills any
  // query that runs longer than 15s at the DB level, so the connection is
  // returned to the pool cleanly. Without this, slow queries can stack up,
  // exhaust the pool, and starve fast queries (like the /clients lookup
  // that was timing out on Render despite being a trivial SELECT).
  // 15s is well under Supabase's pooler hard-kill (typically 20-60s) but
  // long enough for legitimate analytical queries like /daily-stats.
  connection: { statement_timeout: 15_000 },
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });
export { sql };
