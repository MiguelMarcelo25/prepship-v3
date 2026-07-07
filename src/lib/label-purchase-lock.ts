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

export type LabelPurchaseLock = { release: () => Promise<void> };

const LABEL_PURCHASE_LOCK_TTL_SECONDS = 10 * 60;
let schemaEnsured: Promise<void> | null = null;

/** Thrown when another label purchase for the same order holds the lock (operator-safe 409). */
export class LabelPurchaseInProgressError extends Error {
  readonly code = 'LABEL_PURCHASE_IN_PROGRESS' as const;
  constructor(orderId: number) {
    super(`A label purchase is already in progress for order ${orderId}`);
    this.name = 'LabelPurchaseInProgressError';
  }
}

async function ensureLabelPurchaseLockSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS label_purchase_locks (
        order_id integer PRIMARY KEY,
        token text NOT NULL,
        owner text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS label_purchase_locks_expires_at_idx
        ON label_purchase_locks (expires_at)
    `;
    await sql`ALTER TABLE label_purchase_locks ENABLE ROW LEVEL SECURITY`;
  })().catch((err) => {
    schemaEnsured = null;
    throw err;
  });
  return schemaEnsured;
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
