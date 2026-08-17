/**
 * PS-502 — the replacement create command.
 *
 * REQUIRES `unlock shipped data`: it reads a SHIPPED original order as operational
 * authority, which the card's lockdown explicitly places outside the read-only exemption
 * ("a production eligibility/business-policy read of shipped orders is not exempt merely
 * because it reads").
 *
 * WHAT IT DOES NOT DO. It creates the replacement RECORD and nothing else — no shipment row,
 * no label, no inventory movement, no billing line, no marketplace notification. Those are
 * later commands. A replacement at `requested` has committed nothing, which is what makes it
 * safe for an operator to create one and a reviewer to reject it.
 *
 * THE FOUR THINGS THAT MUST HAPPEN TOGETHER
 *
 *   1. idempotency  — a retried create returns the SAME replacement, never a second one
 *   2. allowance    — cumulative shipped units cannot exceed what was ordered (decision 5)
 *   3. reference    — 1321-REPLACE, then -2, allocated without collision (AC-12)
 *   4. freezing     — every item's source coordinate is fingerprinted at this instant
 *
 * All four are read-modify-write against the same order, so all four sit inside ONE
 * order-scoped advisory lock and ONE transaction. Splitting them is how two concurrent
 * creates both read "2 remaining" and both ship.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema/orders';
import { orderItems } from '../db/schema/order-items';
import {
  replacementActivityEvents,
  replacementItems,
  replacements,
  type ReplacementRow,
} from '../db/schema/replacements';
import { buildReplacementSourceLineFingerprint } from './replacement-source-line-fingerprint';
import { nextReplacementReference } from './replacement-reference';
import {
  evaluateReplacementAllowance,
  type AllowanceRow,
} from './replacement-allowance';
import { evaluateBillabilityChange, type ReplacementLiabilityOwner } from './replacement-billability';
import { REPLACEMENT_ERROR_CODES } from './replacement-state-machine';

/**
 * Order-scoped advisory lock class.
 *
 * Distinct from billing's 36421 (client) and 36422 (idempotency key) so a replacement create
 * never contends with a billing close on the same integer by accident — two unrelated
 * resources sharing a lock id serialise for no reason and deadlock for subtle ones.
 */
const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/** The only order status a replacement may be created against. */
const REPLACEABLE_ORDER_STATUS = 'shipped';

export type ReplacementCreateErrorCode =
  | 'REPLACEMENT_ORDER_NOT_FOUND'
  | 'REPLACEMENT_ORDER_NOT_SHIPPED'
  | 'REPLACEMENT_ORDER_CANCELLED'
  | 'REPLACEMENT_NO_ITEMS'
  | 'REPLACEMENT_ALLOWANCE_EXCEEDED'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_BILLABLE_FORBIDDEN_FOR_OPERATOR_LIABILITY'
  | 'REPLACEMENT_BILLABLE_FROZEN'
  | 'REPLACEMENT_BILLABLE_FINALIZED'
  | 'REPLACEMENT_BILLABLE_FORBIDDEN'
  | 'REPLACEMENT_BILLABLE_REASON_REQUIRED';

export class ReplacementCreateError extends Error {
  constructor(
    readonly code: ReplacementCreateErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementCreateError';
  }
}

export type CreateReplacementItemInput = {
  /** The frozen source coordinate — (ordinality - 1) on the original order. */
  orderLineIndex: number;
  quantity: number;
};

export type CreateReplacementInput = {
  orderId: number;
  /** damaged | wrong_item | lost_in_transit | other */
  reason: string;
  liabilityOwner: ReplacementLiabilityOwner;
  items: readonly CreateReplacementItemInput[];
  /** Creation is idempotent on this. A retry with the same key returns the same row. */
  requestIdempotencyKey: string;
  actor: {
    email: string | null;
    /** 'operator' | 'admin' | 'system' — recorded on the activity event. */
    type: string;
    permissions: readonly string[];
  };
  /** Only meaningful when liabilityOwner === 'client'; see replacement-billability.ts. */
  requestedBillable?: boolean;
  billabilityReason?: string | null;
  /** Present only when the caller is knowingly exceeding the cumulative cap. */
  override?: { hasOverridePermission: boolean; reason: string | null };
};

export type CreateReplacementResult = {
  replacement: ReplacementRow;
  /** False when an existing replacement was returned for a repeated idempotency key. */
  created: boolean;
};

export async function createReplacement(
  input: CreateReplacementInput,
): Promise<CreateReplacementResult> {
  if (!input.items || input.items.length === 0) {
    throw new ReplacementCreateError(
      'REPLACEMENT_NO_ITEMS',
      'a replacement must name at least one line of the original order',
      400,
    );
  }

  return db.transaction(async (tx) => {
    // Everything below is a read-modify-write against this order: the allowance, the
    // reference sequence and the idempotency check all decide based on rows a concurrent
    // create could be writing.
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, ${input.orderId})`);

    // Idempotency INSIDE the lock. Outside it, two retries of the same request both miss and
    // both insert, and only the UNIQUE index stops the second — turning a safe retry into a
    // 500 the caller has to interpret.
    const [existing] = await tx
      .select()
      .from(replacements)
      .where(eq(replacements.requestIdempotencyKey, input.requestIdempotencyKey))
      .limit(1);
    if (existing) return { replacement: existing, created: false };

    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        clientId: orders.clientId,
        orderStatus: orders.orderStatus,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .limit(1);

    if (!order) {
      throw new ReplacementCreateError(
        'REPLACEMENT_ORDER_NOT_FOUND',
        `order ${input.orderId} does not exist`,
        404,
      );
    }

    // A cancelled original has its OWN review path (AC-16) and must not be reported as a
    // generic eligibility failure — the two lead an operator to different actions.
    if (order.orderStatus === 'cancelled') {
      throw new ReplacementCreateError(
        'REPLACEMENT_ORDER_CANCELLED',
        `order ${order.orderNumber} is cancelled; a cancelled order is handled by the ` +
          'cancellation path, not by creating a replacement',
        409,
      );
    }
    if (order.orderStatus !== REPLACEABLE_ORDER_STATUS) {
      throw new ReplacementCreateError(
        'REPLACEMENT_ORDER_NOT_SHIPPED',
        `order ${order.orderNumber} is ${order.orderStatus}. A replacement re-ships goods that ` +
          'already went out; an unshipped order is corrected by editing it, not re-shipping it.',
        409,
        { orderStatus: order.orderStatus },
      );
    }

    // Billability is decided at `requested`, which is inside the editable window.
    const billability = evaluateBillabilityChange({
      liabilityOwner: input.liabilityOwner,
      status: 'requested',
      requestedBillable: input.requestedBillable ?? false,
      actor: { permissions: input.actor.permissions },
      reason: input.billabilityReason,
    });
    if (!billability.allowed) {
      // 403, not 409: the request is well-formed and the state is fine — the ACTOR is the
      // problem, and a 409 would send them looking for a conflict that does not exist.
      throw new ReplacementCreateError(billability.code, billability.detail, 403);
    }

    const requestedIndexes = input.items.map((item) => item.orderLineIndex);
    const currentLines = await tx
      .select({
        orderId: orderItems.orderId,
        lineIndex: orderItems.lineIndex,
        sku: orderItems.sku,
        name: orderItems.name,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(and(eq(orderItems.orderId, order.id), inArray(orderItems.lineIndex, requestedIndexes)));

    // Prior replacement items for THIS order, with the parent status and shipped_at the
    // allowance rule needs. Scoped to the order rather than to a fingerprint so the frozen
    // coordinate — not the query — decides what counts.
    const priorRows = await tx
      .select({
        sourceLineFingerprint: replacementItems.sourceLineFingerprint,
        quantity: replacementItems.quantity,
        status: replacements.status,
        shippedAt: replacements.shippedAt,
      })
      .from(replacementItems)
      .innerJoin(replacements, eq(replacementItems.replacementId, replacements.id))
      .where(eq(replacementItems.orderId, order.id));

    const frozen = input.items.map((item) => {
      const line = currentLines.find((candidate) => candidate.lineIndex === item.orderLineIndex);
      if (!line) {
        // Nothing at that coordinate. Refusing here rather than freezing a placeholder is the
        // same rule as the drift check: never guess which line was meant.
        throw new ReplacementCreateError(
          REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED,
          `order ${order.orderNumber} has no line at index ${item.orderLineIndex}`,
          409,
          { orderLineIndex: item.orderLineIndex },
        );
      }

      const originalOrderedQuantity = Math.max(0, Math.trunc(Number(line.quantity)));
      const fingerprint = buildReplacementSourceLineFingerprint({
        orderId: order.id,
        orderLineIndex: line.lineIndex,
        sku: line.sku,
        name: line.name,
        originalOrderedQuantity,
      });

      const verdict = evaluateReplacementAllowance({
        originalOrderedQuantity,
        sourceLineFingerprint: fingerprint,
        rows: priorRows as AllowanceRow[],
        requestedQuantity: item.quantity,
        override: input.override,
      });
      if (!verdict.allowed) {
        throw new ReplacementCreateError('REPLACEMENT_ALLOWANCE_EXCEEDED', verdict.detail, 409, {
          orderLineIndex: line.lineIndex,
          sku: line.sku,
          remaining: verdict.allowance.remaining,
          consumed: verdict.allowance.consumed,
        });
      }

      return {
        orderLineIndex: line.lineIndex,
        sourceLineFingerprint: fingerprint,
        sku: line.sku,
        name: line.name,
        originalOrderedQuantity,
        quantity: Math.trunc(item.quantity),
        usedOverride: verdict.viaOverride,
      };
    });

    // Allocated under the lock, from the references that exist right now. The UNIQUE index on
    // `reference` is still the final arbiter; the lock is what keeps the common path from
    // needing it.
    const existingReferences = await tx
      .select({ reference: replacements.reference })
      .from(replacements)
      .where(eq(replacements.orderId, order.id));
    const reference = nextReplacementReference(
      order.orderNumber,
      existingReferences.map((row) => row.reference),
    );

    const usedOverride = frozen.some((item) => item.usedOverride);
    const [created] = await tx
      .insert(replacements)
      .values({
        orderId: order.id,
        clientId: order.clientId,
        reference,
        status: 'requested',
        reason: input.reason,
        billable: billability.billable,
        liabilityOwner: input.liabilityOwner,
        requestIdempotencyKey: input.requestIdempotencyKey,
        initiatedBy: input.actor.email,
        adminOverride: usedOverride,
        adminOverrideBy: usedOverride ? input.actor.email : null,
        adminOverrideReason: usedOverride ? (input.override?.reason ?? null) : null,
      })
      .returning();

    if (!created) {
      // Unreachable with RETURNING on a single-row insert, but a silent undefined here would
      // surface much later as a null replacement id on an activity event.
      throw new ReplacementCreateError(
        'REPLACEMENT_ORDER_NOT_FOUND',
        'replacement insert returned no row',
        409,
      );
    }

    await tx.insert(replacementItems).values(
      frozen.map((item) => ({
        replacementId: created.id,
        orderId: order.id,
        orderLineIndex: item.orderLineIndex,
        sourceLineFingerprint: item.sourceLineFingerprint,
        sku: item.sku,
        name: item.name,
        originalOrderedQuantity: item.originalOrderedQuantity,
        quantity: item.quantity,
      })),
    );

    // Keyed on the request, not on the replacement id: a retry that reaches here has already
    // been filtered by the idempotency check above, and keying on the request makes the event
    // replay-safe even if that check is ever bypassed.
    await tx.insert(replacementActivityEvents).values({
      replacementId: created.id,
      eventType: 'replacement_requested',
      fromStatus: null,
      toStatus: 'requested',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      idempotencyKey: `replacement:create:${input.requestIdempotencyKey}`,
    });

    return { replacement: created, created: true };
  });
}
