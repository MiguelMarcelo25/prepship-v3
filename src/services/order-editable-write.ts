// Per user override unlock shipped data on 2026-07-14: this is the canonical
// final write-boundary guard for order edits. It strengthens the existing route
// preflight by locking and re-reading lifecycle truth in the write transaction.
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import {
  resolveOrderLifecycleStatus,
  type OrderLifecycleStatusResult,
} from './order-lifecycle-status';

export type OrderEditWriteAuthorization = Readonly<{
  /** True only after assertOrderEditable has audited an admin ?force=1 override. */
  allowTerminal: boolean;
}>;

export type OrderEditWriteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OrderEditWriteFailure =
  | { ok: false; reason: 'not_found' }
  | {
      ok: false;
      reason: 'locked';
      lifecycle: OrderLifecycleStatusResult;
    };

export type OrderEditWriteResult<T> = { ok: true; value: T } | OrderEditWriteFailure;

/**
 * Serialize an order edit with lifecycle transitions and re-check the canonical
 * effective lifecycle after the row lock is acquired. A concurrent label
 * purchase/status sync that commits first therefore makes this write fail closed.
 */
export async function withOrderEditableWrite<T>(
  orderId: number,
  authorization: OrderEditWriteAuthorization,
  write: (tx: OrderEditWriteTransaction) => Promise<T>,
): Promise<OrderEditWriteResult<T>> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: orders.id,
        orderStatus: orders.orderStatus,
        canonicalStatus: orders.canonicalStatus,
        externallyShipped: orders.externallyShipped,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
      .for('update');

    if (!row) return { ok: false, reason: 'not_found' };

    const lifecycle = resolveOrderLifecycleStatus({
      orderStatus: row.orderStatus,
      canonicalStatus: row.canonicalStatus,
      externallyShipped: row.externallyShipped === true,
    });
    if (lifecycle.isTerminal && !authorization.allowTerminal) {
      return { ok: false, reason: 'locked', lifecycle };
    }

    return { ok: true, value: await write(tx) };
  });
}
