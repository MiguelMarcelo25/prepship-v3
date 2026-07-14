import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../lib/env.js';
import * as schema from './schema/index.js';

// Per user override unlock shipped data on 2026-07-14: DATABASE_URL uses the
// Supabase transaction pooler. Its transaction proxy can wedge when postgres.js
// pipelines a large burst on one socket, so keep four sockets available while
// serializing the queries sent through each socket.
const transactionPoolerCompatibility = { max_pipeline: 1 } as const;

const sql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  // Audit 1.9 (2026-07-13): recycle connections every 15 min so a session that
  // captured a read-only role GUC during a Supabase disk event (2026-07-13
  // incident: poisoned sessions kept failing INSERTs for ~2h after the window
  // lifted) is bounded, not left to postgres.js's default 30-60 min recycle.
  max_lifetime: env.DB_MAX_LIFETIME_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  // Per-query timeout sent to Postgres via SET statement_timeout. Kills any
  // query that runs longer than 15s at the DB level, so the connection is
  // returned to the pool cleanly. Without this, slow queries can stack up,
  // exhaust the pool, and starve fast queries (like the /clients lookup
  // that was timing out on Render despite being a trivial SELECT).
  // 12s is well under Supabase's pooler hard-kill (typically 20-60s) but
  // long enough for legitimate analytical queries like /daily-stats.
  connection: { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
  ...transactionPoolerCompatibility,
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });
export { sql };
