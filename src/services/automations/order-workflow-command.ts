import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orderOverrides, orders } from '../../db/schema/orders.js';
import { advisoryLockKeyPair } from '../../lib/advisory-lock.js';
import { isTerminalAutomationStatus } from './facts.js';

/**
 * Canonical command for idempotent automation-owned order workflow tags.
 * It intentionally owns the awaiting-only status guard so action handlers do
 * not write order_overrides directly or re-derive terminal safety.
 */
export async function addAutomationWorkflowTag(input: {
  orderId: number;
  tag: string;
}): Promise<{ before: string[]; after: string[]; changed: boolean }> {
  const tag = input.tag.trim();
  if (!tag || tag.length > 64) throw new Error('Automation workflow tag must be 1-64 characters');
  const [classId, objectId] = advisoryLockKeyPair(`automation-order:${input.orderId}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${classId}, ${objectId})`);
    const [order] = await tx.select({ status: orders.orderStatus })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);
    if (!order) throw new Error('Order not found');
    if (isTerminalAutomationStatus(order.status)) {
      throw new Error('Terminal orders are immutable; automation action was not applied');
    }
    const [override] = await tx.select({ tags: orderOverrides.tags })
      .from(orderOverrides)
      .where(eq(orderOverrides.orderId, input.orderId))
      .limit(1);
    const before = Array.isArray(override?.tags) ? override.tags.map(String) : [];
    const key = tag.toLowerCase();
    const changed = !before.some((candidate) => candidate.trim().toLowerCase() === key);
    const after = changed ? [...before, tag] : before;
    if (changed) {
      await tx.insert(orderOverrides).values({ orderId: input.orderId, tags: after })
        .onConflictDoUpdate({
          target: orderOverrides.orderId,
          set: { tags: after, updatedAt: new Date() },
        });
    }
    return { before, after, changed };
  });
}
