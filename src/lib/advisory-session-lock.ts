// PS-253 (Card 8): serialize a cross-process read-modify-write with a per-name pg SESSION advisory
// lock on a RESERVED connection.
//
// Unlike the label-purchase lock (which is NON-blocking — a duplicate buy must be rejected, not
// queued), a read-modify-write that must NOT lose work (e.g. the combo-default upsert + sibling-order
// apply) needs to SERIALIZE: concurrent callers for the same name run one at a time. pg_advisory_lock
// blocks until acquired; the reserved connection guarantees lock + unlock share one connection
// (pool-safe), and a session lock also auto-releases when its connection closes, so a crash can't
// strand it. Best-effort unlock; the reserved connection is ALWAYS released.
import { sql } from '../db/client';
import { advisoryLockKeyPair } from './advisory-lock';

export async function withAdvisorySessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const [classid, objid] = advisoryLockKeyPair(name);
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${classid}, ${objid})`;
    return await fn();
  } finally {
    try {
      await reserved`SELECT pg_advisory_unlock(${classid}, ${objid})`;
    } catch {
      /* best-effort: the session lock auto-releases when the connection closes */
    } finally {
      reserved.release();
    }
  }
}
