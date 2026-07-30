// Serialize cross-process read-modify-write work with a transaction advisory lock.
// Transaction locks are required for Supavisor transaction pooling: session locks
// can be acquired and released on different PostgreSQL sessions and become stranded.
import postgres from 'postgres';
import { advisoryLockKeyPair } from './advisory-lock';
import { env } from './env';

const advisoryLockSql = postgres(env.DATABASE_URL, {
  prepare: false,
  max: 2,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  // Audit 1.9: bound read-only-poisoned session lifetime (see db/client.ts).
  max_lifetime: env.DB_MAX_LIFETIME_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
  connection: { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS },
});

export type AdvisoryLockTransaction = postgres.TransactionSql;

/** Outcome of a non-blocking acquire. `acquired: false` means someone else holds it. */
export type AdvisoryTryResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; value: null };

// PS-471: bound how long THIS transaction may sit idle waiting on a client that
// has gone away. Set with SET LOCAL rather than a pool startup parameter,
// because startup params are not reliably honoured through Supavisor
// transaction pooling -- see the note on DB_IDLE_IN_TRANSACTION_TIMEOUT_MS.
// SET LOCAL takes no bind parameters, so the value is interpolated; it is a
// zod-validated positive int, re-truncated here so this stays safe if that
// schema is ever loosened.
async function boundIdleInTransaction(transaction: AdvisoryLockTransaction): Promise<void> {
  const ms = Math.trunc(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await transaction.unsafe(`SET LOCAL idle_in_transaction_session_timeout = ${ms}`);
}

/**
 * Blocking acquire. Use for read-modify-write correctness, where a second
 * writer MUST wait rather than skip (combo defaults, account-state snapshot,
 * billing storage). Do not use for periodic work -- see the try variant.
 */
export async function withAdvisoryTransactionLock<T>(
  name: string,
  fn: (transaction: AdvisoryLockTransaction) => Promise<T>,
): Promise<T> {
  const [classid, objid] = advisoryLockKeyPair(name);
  return advisoryLockSql.begin(async (transaction) => {
    await boundIdleInTransaction(transaction);
    await transaction`SELECT pg_advisory_xact_lock(${classid}, ${objid})`;
    return fn(transaction);
  }) as Promise<T>;
}

/**
 * Non-blocking acquire. Use for PERIODIC work (watchdog/cron ticks), where the
 * lock already being held means the same work is in flight and this round
 * should be skipped.
 *
 * PS-471: the blocking variant is what turned one stranded transaction into a
 * 90-minute outage on 2026-07-30. Each queued tick waited on the zombie and
 * pinned a pooler connection for the duration, so capacity bled away tick by
 * tick until no request could reach the database. A skipped tick costs nothing;
 * a queued tick costs a connection.
 */
export async function tryAdvisoryTransactionLock<T>(
  name: string,
  fn: (transaction: AdvisoryLockTransaction) => Promise<T>,
): Promise<AdvisoryTryResult<T>> {
  const [classid, objid] = advisoryLockKeyPair(name);
  return advisoryLockSql.begin(async (transaction) => {
    await boundIdleInTransaction(transaction);
    const rows = await transaction<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${classid}, ${objid}) AS acquired
    `;
    if (rows[0]?.acquired !== true) return { acquired: false, value: null };
    return { acquired: true, value: await fn(transaction) };
  }) as Promise<AdvisoryTryResult<T>>;
}
