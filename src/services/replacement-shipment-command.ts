/**
 * PS-502 — insert the replacement's own outbound shipment row.
 *
 * REQUIRES `unlock shipped data`: this writes to `shipments`.
 *
 * WHAT IT DOES NOT DO. It does not buy a label, move inventory, consume packaging, write a
 * billing line, or touch the ORIGINAL order's shipments, status or marketplace record. It
 * creates the empty vessel a label will later be attached to. `createLabelV2` is deliberately
 * not reused: `fulfillment/shipping-safety.ts:107` blocks label purchase when an order is
 * already `shipped` ("never buy a second label"), which is correct for the original order and
 * fatal for a replacement against it.
 *
 * WHY THE REPLACEMENT SHIPMENT CARRIES THE REPLACEMENT'S REFERENCE
 *
 * `shipments.orderNumber` is set to `replacement.reference` (1321-REPLACE), not to the
 * original's number. Two shipment rows both claiming to be "1321" are indistinguishable in
 * every shipment view, export and reconciliation, and the second one looks like a duplicate
 * label on the original order — which is exactly the alarm shipping-safety exists to raise.
 * `orderId` still points at the original, so the relational link is intact.
 *
 * WHY DRIFT IS RE-RESOLVED HERE
 *
 * The card requires re-resolution "before approval AND before label purchase". This is the
 * last step before a label exists, so it is the last cheap place to catch a source line that
 * moved under a pending replacement.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orderItems } from '../db/schema/order-items';
import { shipments } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementItems,
  replacements,
  type ReplacementRow,
} from '../db/schema/replacements';
import {
  currentSourceLineFingerprint,
} from './replacement-source-line-fingerprint';
import {
  evaluateReplacementSourceLineDrift,
  isReplacementStatus,
  REPLACEMENT_ERROR_CODES,
  type ReplacementStatus,
} from './replacement-state-machine';

/** Same class as the create command: both serialise on the same order. */
const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/**
 * States a shipment may be attached in.
 *
 * `label_failed` is included because a failed purchase leaves a usable shipment row and the
 * retry must not mint a second one; `approved` is the ordinary path. `requested` is excluded
 * — attaching a shipment before approval would let an unreviewed request accumulate
 * operational artefacts.
 */
const SHIPMENT_ATTACHABLE_STATUSES: readonly ReplacementStatus[] = ['approved', 'label_failed'];

export type ReplacementShipmentErrorCode =
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_NOT_ATTACHABLE';

export class ReplacementShipmentError extends Error {
  constructor(
    readonly code: ReplacementShipmentErrorCode,
    message: string,
    readonly httpStatus: 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementShipmentError';
  }
}

export type InsertReplacementShipmentInput = {
  replacementId: number;
  actor: { email: string | null; type: string };
  /** Operational snapshot for the label that will follow. All optional. */
  shipment?: {
    carrierCode?: string | null;
    serviceCode?: string | null;
    weightOz?: number | null;
    dimsL?: number | null;
    dimsW?: number | null;
    dimsH?: number | null;
    providerAccountId?: number | null;
    selectedPackageId?: string | null;
  };
};

export type InsertReplacementShipmentResult = {
  shipmentId: number;
  replacement: ReplacementRow;
  /** False when the replacement already had a shipment and it was returned unchanged. */
  created: boolean;
};

type DriftOutcome =
  | { drifted: true; orderLineIndex: number; reference: string }
  | { drifted: false; replacement: ReplacementRow; existingShipmentId: number | null };

/**
 * Phase 1 — re-resolve drift, and PERSIST a review if it is found.
 *
 * Returns rather than throws on drift, deliberately. The card requires a mismatch to produce
 * BOTH `status=review` and a 409, and those fight each other inside one transaction: throwing
 * rolls the review back, so the operator sees an error while the replacement stays `approved`
 * and drifts again on the next attempt, forever, with nothing recorded. The review has to
 * COMMIT while the operation FAILS, so the throw happens after this transaction closes.
 */
async function resolveDriftAndMaybeReview(
  input: InsertReplacementShipmentInput,
  /** Injected so the command is testable against an embedded Postgres; defaults to the real pool. */
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<DriftOutcome> {
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx
      .select()
      .from(replacements)
      .where(eq(replacements.id, input.replacementId))
      .limit(1);
    if (!replacement) {
      throw new ReplacementShipmentError(
        'REPLACEMENT_NOT_FOUND',
        `replacement ${input.replacementId} does not exist`,
        404,
      );
    }

    // Already attached: idempotent, and nothing below should re-run.
    //
    // ⚠ THIS PATH SKIPS DRIFT RE-RESOLUTION. That is correct here — the shipment already
    // exists and nothing further is written — but it means the LABEL PURCHASE command must
    // re-resolve drift itself immediately before buying, and must not assume this command
    // checked. A line can move between attaching a shipment and purchasing against it.
    if (replacement.replacementShipmentId != null) {
      return { drifted: false, replacement, existingShipmentId: replacement.replacementShipmentId };
    }

    const status = isReplacementStatus(replacement.status) ? replacement.status : null;
    if (!status || !SHIPMENT_ATTACHABLE_STATUSES.includes(status)) {
      throw new ReplacementShipmentError(
        'REPLACEMENT_NOT_ATTACHABLE',
        `a shipment may be attached at ${SHIPMENT_ATTACHABLE_STATUSES.join(' or ')}; ` +
          `replacement ${replacement.reference} is ${replacement.status}`,
        409,
        { status: replacement.status },
      );
    }

    const frozenItems = await tx
      .select({
        orderLineIndex: replacementItems.orderLineIndex,
        sourceLineFingerprint: replacementItems.sourceLineFingerprint,
      })
      .from(replacementItems)
      .where(eq(replacementItems.replacementId, replacement.id));

    const currentLines = await tx
      .select({
        orderId: orderItems.orderId,
        lineIndex: orderItems.lineIndex,
        sku: orderItems.sku,
        name: orderItems.name,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, replacement.orderId));

    for (const item of frozenItems) {
      const verdict = evaluateReplacementSourceLineDrift({
        frozenFingerprint: item.sourceLineFingerprint,
        currentFingerprint: currentSourceLineFingerprint(currentLines, {
          orderId: replacement.orderId,
          orderLineIndex: item.orderLineIndex,
        }),
      });
      if (verdict.matches) continue;

      // Persisted, then reported. Never silently retargeted.
      //
      // The predicate carries the EXPECTED STATUS as well as the version, and the result is
      // checked. Without both, a concurrent transition could move the replacement while this
      // update matched nothing, and the drift event below would then be appended describing a
      // transition that never happened — a false entry in an append-only audit log is worse
      // than a missing one, because it is trusted.
      const reviewed = await tx
        .update(replacements)
        .set({
          status: 'review',
          reviewReason: verdict.reviewReason,
          reviewRequestedAt: new Date(),
          stateVersion: replacement.stateVersion + 1,
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacements.id, replacement.id),
          eq(replacements.status, replacement.status),
          eq(replacements.stateVersion, replacement.stateVersion),
        ))
        .returning();

      if (reviewed.length === 0) {
        throw new ReplacementShipmentError(
          'REPLACEMENT_STATE_CONFLICT',
          `replacement ${replacement.reference} moved while drift was being recorded; ` +
            'no review was written and no event was appended.',
          409,
          { expectedStatus: replacement.status, expectedStateVersion: replacement.stateVersion },
        );
      }

      await tx.insert(replacementActivityEvents).values({
        replacementId: replacement.id,
        eventType: 'replacement_source_line_drift',
        fromStatus: replacement.status,
        toStatus: 'review',
        actorType: input.actor.type,
        actorEmail: input.actor.email,
        idempotencyKey:
          `replacement:${replacement.id}:drift:${item.orderLineIndex}:v${replacement.stateVersion}`,
      });

      return { drifted: true, orderLineIndex: item.orderLineIndex, reference: replacement.reference };
    }

    return { drifted: false, replacement, existingShipmentId: null };
  });
}

export async function insertReplacementShipment(
  input: InsertReplacementShipmentInput,
  /** Injected so the command is testable against an embedded Postgres; defaults to the real pool. */
  conn: Pick<typeof db, 'transaction'> = db,
): Promise<InsertReplacementShipmentResult> {
  const outcome = await resolveDriftAndMaybeReview(input, conn);
  if (outcome.drifted) {
    throw new ReplacementShipmentError(
      REPLACEMENT_ERROR_CODES.SOURCE_LINE_CHANGED,
      `the source line at index ${outcome.orderLineIndex} on ${outcome.reference} no longer ` +
        'matches what was frozen. The replacement is in review; resolve or remap it under ' +
        'audited override rather than shipping against a line that moved.',
      409,
      { orderLineIndex: outcome.orderLineIndex },
    );
  }
  if (outcome.existingShipmentId != null) {
    return { shipmentId: outcome.existingShipmentId, replacement: outcome.replacement, created: false };
  }

  const before = outcome.replacement;
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, ${before.orderId})`);

    const [shipment] = await tx
      .insert(shipments)
      .values({
        orderId: before.orderId,
        clientId: before.clientId,
        // The replacement's own identity, so it is never mistaken for a second label on the
        // original order.
        orderNumber: before.reference,
        // Free-form provenance marker. A replacement is an OUTBOUND re-ship, so `isReturn`
        // stays false — conflating the two would invert its direction in every report.
        source: 'replacement',
        carrierCode: input.shipment?.carrierCode ?? null,
        serviceCode: input.shipment?.serviceCode ?? null,
        weightOz: input.shipment?.weightOz ?? null,
        dimsL: input.shipment?.dimsL ?? null,
        dimsW: input.shipment?.dimsW ?? null,
        dimsH: input.shipment?.dimsH ?? null,
        providerAccountId: input.shipment?.providerAccountId ?? null,
        selectedPackageId: input.shipment?.selectedPackageId ?? null,
        createDate: new Date(),
      })
      .returning({ id: shipments.id });

    if (!shipment) {
      throw new ReplacementShipmentError(
        'REPLACEMENT_STATE_CONFLICT',
        'shipment insert returned no row',
        409,
      );
    }

    // Optimistic concurrency across the gap between the two transactions. If anything moved
    // the replacement in between — another attach, a cancel, a review — zero rows update and
    // this rolls back, taking the orphan shipment with it.
    const linked = await tx
      .update(replacements)
      .set({
        replacementShipmentId: shipment.id,
        stateVersion: before.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacements.id, before.id),
        eq(replacements.status, before.status),
        eq(replacements.stateVersion, before.stateVersion),
      ))
      .returning();

    if (linked.length === 0) {
      throw new ReplacementShipmentError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${before.reference} moved while its shipment was being created; ` +
          'nothing was attached.',
        409,
        { expectedStatus: before.status, expectedStateVersion: before.stateVersion },
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: before.id,
      shipmentId: shipment.id,
      eventType: 'replacement_shipment_created',
      fromStatus: before.status,
      toStatus: before.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      idempotencyKey: `replacement:${before.id}:shipment:v${before.stateVersion}`,
    });

    return { shipmentId: shipment.id, replacement: linked[0]!, created: true };
  });
}
