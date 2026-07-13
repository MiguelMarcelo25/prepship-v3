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

export async function withAdvisoryTransactionLock<T>(
  name: string,
  fn: (transaction: AdvisoryLockTransaction) => Promise<T>,
): Promise<T> {
  const [classid, objid] = advisoryLockKeyPair(name);
  return advisoryLockSql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(${classid}, ${objid})`;
    return fn(transaction);
  }) as Promise<T>;
}
