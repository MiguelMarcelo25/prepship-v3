// PS-476: a rule status change must wake the orders it affects.
//
// DJ: "make it automatic" -- pausing a rule should untick its orders, resuming
// should re-tick them, without an operator running anything by hand.
//
// PS-475 taught the engine HOW to retract. This is the missing trigger. Pausing
// a rule updated the rule row and enqueued nothing, so no order was ever
// re-evaluated: orders 3240/3241 sat 5+ minutes with zero runs while paused.
// Before PS-469 the ambient no-op sync writes hid this -- 3240 alone logged 85
// runs an hour -- but with idempotency fixed, an order only re-evaluates when
// something actually fires an event. Nothing did.
//
// Why NOT the existing reprocess job: outbox-worker.ts:161 refuses any job whose
// rule is not `active`, so a paused rule can never be reprocessed, and :181
// evaluates that ONE rule in isolation rather than all active rules. It applies
// a rule; it cannot converge away from one. Plain fact events take the normal
// path (evaluateOrderAutomationFactEvent) which loads every active rule, which
// is exactly what convergence needs.
import { and, eq, sql } from 'drizzle-orm';
import { automationOutbox } from '../../db/schema/automations.js';
import { orderHazmatDeclarations } from '../../db/schema/hazmat.js';
import { orders } from '../../db/schema/orders.js';
import type { AutomationRule } from '../../db/schema/automations.js';

/**
 * Upper bound on orders woken by one status change. PS-469 is the cautionary
 * tale: unbounded automation runs produced 322,962 runs and 791 MB in four days.
 * A global-scope rule on a large account could otherwise enqueue thousands in a
 * single click. Truncation is logged, never silent.
 */
export const RULE_STATUS_CONVERGENCE_CAP = 500;

/**
 * `order_facts_updated`, deliberately, NOT `manual_reprocess`.
 *
 * The hazmat add handler treats `manual_reprocess` as permission to overwrite a
 * MANUAL declaration (hazmat-action.ts). Waking orders with that trigger would
 * mean re-enabling a rule silently re-declares an order a human had cleared by
 * hand -- order 3242 is exactly that case. `order_facts_updated` preserves the
 * manual decision in both directions, and is proven to drive hazmat adds: it is
 * how 3240/3241/3242 were declared in the first place.
 */
const CONVERGENCE_TRIGGER = 'order_facts_updated';

type Tx = {
  select: (typeof import('../../db/client.js'))['db']['select'];
  insert: (typeof import('../../db/client.js'))['db']['insert'];
};

/**
 * Enqueue re-evaluation for the non-terminal orders a rule covers.
 *
 * Only `awaiting_shipment` is woken. Shipped and cancelled orders are terminal:
 * their declarations are compliance records, and PS-475 refuses to touch them
 * anyway -- waking them would burn runs to reach a guaranteed no-op.
 */
export async function enqueueRuleStatusConvergence(
  tx: Tx,
  rule: Pick<AutomationRule, 'id' | 'clientId' | 'storeId' | 'status' | 'updatedAt'>,
): Promise<{ queued: number; capped: boolean }> {
  // Wake ONLY orders that can actually converge to something different.
  //
  // The first cut woke every awaiting order in scope, capped at 500. That was
  // calibrated against the ~22 shown in the sidebar -- which is DATE-FILTERED.
  // The real number is 29,258, so a single toggle enqueued 500 mostly-irrelevant
  // evaluations and two toggles made 1,000. Same shape as PS-469, for the same
  // reason: a number taken at face value instead of measured.
  //
  // Retraction is the only convergence the engine performs -- pausing a tag rule
  // does not remove tags, pausing a package rule does not unset packages -- so
  // an order with no active automation-written hazmat declaration has nothing to
  // converge, and waking it burns a run to reach a guaranteed no-op. Today that
  // narrows 500 to 2.
  const predicates = [
    eq(orders.orderStatus, 'awaiting_shipment'),
    eq(orderHazmatDeclarations.status, 'active'),
    eq(orderHazmatDeclarations.decisionSource, 'automation'),
  ];
  if (rule.clientId != null) predicates.push(eq(orders.clientId, rule.clientId));
  if (rule.storeId != null) predicates.push(eq(orders.storeId, rule.storeId));

  const rows = await tx.select({ id: orders.id })
    .from(orders)
    .innerJoin(orderHazmatDeclarations, eq(orderHazmatDeclarations.orderId, orders.id))
    .where(and(...predicates))
    .orderBy(sql`${orders.id} desc`)
    .limit(RULE_STATUS_CONVERGENCE_CAP + 1);

  const capped = rows.length > RULE_STATUS_CONVERGENCE_CAP;
  const targets = rows.slice(0, RULE_STATUS_CONVERGENCE_CAP);
  if (targets.length === 0) return { queued: 0, capped: false };

  // Stamp the key with the status transition so repeated toggles each enqueue,
  // while a duplicate call for the SAME transition is deduped by the unique
  // index rather than doubling the work.
  const stamp = `${rule.status}:${rule.updatedAt?.toISOString() ?? 'now'}`;
  await tx.insert(automationOutbox).values(
    targets.map((row) => ({
      eventKey: `automation-rule-status:${rule.id}:${stamp}:${row.id}`,
      eventType: 'order_facts_changed' as const,
      aggregateType: 'order' as const,
      aggregateId: String(row.id),
      payload: {
        orderId: row.id,
        trigger: CONVERGENCE_TRIGGER,
        sourceEventId: `rule-status:${rule.id}:${stamp}:${row.id}`,
      },
    })),
  ).onConflictDoNothing();

  if (capped) {
    // No silent caps: an operator who changes a rule must be able to find out
    // that some orders were not woken and still carry the old outcome.
    console.warn(
      `[automation-rule-status] rule ${rule.id} -> ${rule.status}: woke `
      + `${targets.length} orders (CAP ${RULE_STATUS_CONVERGENCE_CAP}); more matched and were NOT woken`,
    );
  }
  return { queued: targets.length, capped };
}

export { CONVERGENCE_TRIGGER };
