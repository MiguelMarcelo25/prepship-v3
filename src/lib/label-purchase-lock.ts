// PS-248 (Card 3): serialize concurrent label PURCHASES for a single order.
//
// Without this, a double-click / double-request both pass the not-yet-shipped check in createLabelV2
// and BUY TWO labels (double postage) for the same order. We take a per-order pg SESSION advisory lock
// on a RESERVED connection (so the matching unlock runs on the SAME connection — pool-safe) BEFORE the
// buy and release it after persist. It is NON-BLOCKING: if a purchase for this order is already in
// flight, the second caller is rejected immediately with LABEL_PURCHASE_IN_PROGRESS rather than queued
// — no double postage, no waiting. Best-effort unlock; the reserved connection is ALWAYS released, and
// a session advisory lock also auto-releases when its connection closes, so a crash can't strand it.
import { sql } from '../db/client';
import { advisoryLockKeyPair } from './advisory-lock';

export type LabelPurchaseLock = { release: () => Promise<void> };

/** Thrown when another label purchase for the same order holds the lock (operator-safe 409). */
export class LabelPurchaseInProgressError extends Error {
  readonly code = 'LABEL_PURCHASE_IN_PROGRESS' as const;
  constructor(orderId: number) {
    super(`A label purchase is already in progress for order ${orderId}`);
    this.name = 'LabelPurchaseInProgressError';
  }
}

export async function acquireLabelPurchaseLock(orderId: number): Promise<LabelPurchaseLock> {
  const [classid, objid] = advisoryLockKeyPair(`label_purchase:order:${orderId}`);
  const reserved = await sql.reserve();
  let acquired = false;
  try {
    const rows = await reserved`SELECT pg_try_advisory_lock(${classid}, ${objid}) AS locked`;
    acquired = rows[0]?.locked === true;
  } catch (err) {
    reserved.release();
    throw err;
  }
  if (!acquired) {
    reserved.release();
    throw new LabelPurchaseInProgressError(orderId);
  }
  return {
    release: async () => {
      try {
        await reserved`SELECT pg_advisory_unlock(${classid}, ${objid})`;
      } catch {
        /* best-effort: the session lock auto-releases when the connection closes */
      } finally {
        reserved.release();
      }
    },
  };
}
