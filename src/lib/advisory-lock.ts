// PS-253 (Card 8): a deterministic pg advisory-lock key from a string name.
//
// pg_advisory_xact_lock(int4, int4) serializes a read-modify-write across processes
// for the transaction's duration (auto-released on commit). We hash a stable name to
// two signed 32-bit ints so the SAME logical resource always maps to the SAME lock.
// Pure (crypto only) — no DB import, so it's trivially unit-testable.
import { createHash } from 'node:crypto';

/** Two signed-int4 keys for pg_advisory_*lock(classid, objid) derived from `name`. */
export function advisoryLockKeyPair(name: string): [number, number] {
  const hex = createHash('sha256').update(name).digest('hex');
  // `| 0` coerces each 32-bit chunk into the signed int4 range Postgres expects.
  const classid = parseInt(hex.slice(0, 8), 16) | 0;
  const objid = parseInt(hex.slice(8, 16), 16) | 0;
  return [classid, objid];
}
