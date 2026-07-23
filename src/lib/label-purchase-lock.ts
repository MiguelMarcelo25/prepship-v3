// PS-248 (Card 3): serialize concurrent label PURCHASES for a single order.
//
// Without this, a double-click / double-request both pass the not-yet-shipped check in createLabelV2
// and BUY TWO labels (double postage) for the same order. We take a per-order durable DB lease BEFORE
// the buy and release it after persist. It is NON-BLOCKING: if a purchase for this order is already in
// flight, the second caller is rejected immediately with LABEL_PURCHASE_IN_PROGRESS rather than queued
// — no double postage, no waiting. The lease expires if a worker is killed mid-purchase, so pooled DB
// sessions cannot strand an order behind a stale session advisory lock.
import { randomUUID } from 'node:crypto';
import { sql } from '../db/client';
import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

export type LabelPurchaseLock = { release: () => Promise<void> };

// Per user override unlock shipped data on 2026-07-13 (audit C2 interim): the TTL
// must outlive every AUTOMATIC retry horizon that can re-enter a purchase for the
// same order. pg-boss re-delivers a hung print-queue send job after expireInSeconds
// = 30 min (src/services/print-queue-worker.ts) — with the old 10-min TTL the lease
// was already expired by then, so a worker killed between the provider buy and the
// shipment persist was silently REPURCHASED on redelivery. 45 min > 30 min + slack
// makes that redelivery fail closed (LABEL_PURCHASE_IN_PROGRESS -> failed_retryable,
// operator-visible) instead of buying postage twice. Overridable for tests via env.
const LABEL_PURCHASE_LOCK_TTL_SECONDS =
  Number(process.env.LABEL_PURCHASE_LOCK_TTL_SECONDS ?? '') || 45 * 60;

/** Thrown when another label purchase for the same order holds the lock (operator-safe 409). */
export class LabelPurchaseInProgressError extends Error {
  readonly code = 'LABEL_PURCHASE_IN_PROGRESS' as const;
  constructor(orderId: number) {
    super(`A label purchase is already in progress for order ${orderId}`);
    this.name = 'LabelPurchaseInProgressError';
  }
}

async function ensureLabelPurchaseLockSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0062 owns
  // label-lock schema; purchase serialization behavior is unchanged.
  await assertRuntimeSchemaReady();
}

export async function acquireLabelPurchaseLock(orderId: number): Promise<LabelPurchaseLock> {
  await ensureLabelPurchaseLockSchema();
  const token = randomUUID();
  const owner = `prepship:${process.pid}:${token}`;
  const rows = await sql<{ token: string }[]>`
    INSERT INTO label_purchase_locks (order_id, token, owner, created_at, expires_at)
    VALUES (
      ${orderId},
      ${token},
      ${owner},
      now(),
      now() + (${LABEL_PURCHASE_LOCK_TTL_SECONDS} * interval '1 second')
    )
    ON CONFLICT (order_id) DO UPDATE SET
      token = EXCLUDED.token,
      owner = EXCLUDED.owner,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at
    WHERE label_purchase_locks.expires_at <= now()
    RETURNING token
  `;
  if (rows.length === 0) throw new LabelPurchaseInProgressError(orderId);

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await sql`
          DELETE FROM label_purchase_locks
          WHERE order_id = ${orderId}
            AND token = ${token}
        `;
      } catch {
        /* best-effort: the lease expires if the worker dies before cleanup */
      }
    },
  };
}

export async function isLabelPurchaseLockActive(orderId: number): Promise<boolean> {
  await ensureLabelPurchaseLockSchema();
  const rows = await sql<{ active: boolean }[]>`
    SELECT true AS active
    FROM label_purchase_locks
    WHERE order_id = ${orderId}
      AND expires_at > now()
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function getActiveLabelPurchaseLockOrderIds(
  orderIds: number[],
): Promise<Set<number>> {
  const unique = [...new Set(orderIds.filter((orderId) => Number.isInteger(orderId) && orderId > 0))];
  if (unique.length === 0) return new Set();
  await ensureLabelPurchaseLockSchema();
  const rows = await sql<{ order_id: number }[]>`
    SELECT order_id
    FROM label_purchase_locks
    WHERE order_id = any(${unique})
      AND expires_at > now()
  `;
  return new Set(rows.map((row) => Number(row.order_id)));
}
