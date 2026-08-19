/**
 * PS-502 — void a replacement label, and reconcile an orphaned purchase intent.
 *
 * REQUIRES `unlock shipped data`. Both commands here can reach a provider, and a void is
 * DESTRUCTIVE: sent twice it can cancel a label that a later attempt already replaced.
 *
 * THE SEPARATION THAT MATTERS
 *
 * A provider side effect and a local state transition are different facts, and this file
 * never lets one stand in for the other. A local row saying `voided` when the provider never
 * confirmed is worse than no row at all: the label is still live, the postage is still spent,
 * and every downstream reader believes otherwise.
 *
 * So an unknown outcome becomes `void_reconcile_required` — never `voided`. Nothing infers a
 * destructive result it did not observe.
 *
 * WHAT A VOID NEVER DOES
 *   - alter the ORIGINAL order's status
 *   - restore stock that was never shipped (a voided label moved nothing)
 *   - delete financial evidence — a credit is the billing owner's job, not this one's
 *   - notify a marketplace or a customer
 *   - repurchase anything
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { shipments } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementLabelPurchaseIntentRow,
} from '../db/schema/replacements';
import {
  assertReplacementLabelEnabled,
  REPLACEMENT_LABEL_PERMISSION,
  readReplacementLabelIntentInTransaction,
  recordPurchasedReplacementLabelInTransaction,
  type ProviderLabelReceipt,
  type ReplacementLabelIntentSnapshot,
} from './replacement-label-purchase-command';

export { REPLACEMENT_LABEL_PERMISSION } from './replacement-label-purchase-command';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

export type ReplacementVoidErrorCode =
  | 'REPLACEMENT_LABEL_FEATURE_DISABLED'
  | 'REPLACEMENT_VOID_FORBIDDEN'
  | 'REPLACEMENT_VOID_REASON_REQUIRED'
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_VOID_NO_ACTIVE_LABEL'
  | 'REPLACEMENT_VOID_SCOPE_MISMATCH'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_VOID_RECONCILE_REQUIRED'
  | 'REPLACEMENT_INTENT_NOT_RECONCILABLE';

export class ReplacementVoidError extends Error {
  constructor(
    readonly code: ReplacementVoidErrorCode,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementVoidError';
  }
}

export type ProviderVoidResult = {
  providerVoidId: string;
  /** True only when the provider CONFIRMED the void. Never inferred. */
  voided: boolean;
};

export type ReplacementLabelVoidProvider = {
  voidLabel(input: {
    providerTransactionId: string;
    /** Deterministic, so a retried void is deduped by the provider rather than repeated. */
    idempotencyKey: string;
  }): Promise<ProviderVoidResult>;
  /**
   * Ask the provider what actually happened for a purchase identity.
   *
   * This is what makes an orphaned intent recoverable: the local receipt is missing precisely
   * because we crashed, so the provider is the only authority left. Returning null means the
   * provider is CERTAIN nothing was bought — not that it is unsure.
   */
  lookupPurchase?(input: { idempotencyKey: string }): Promise<ProviderLabelReceipt | null>;
  /** Read-only recovery for an uncertain destructive void. It must never resend the void. */
  lookupVoid?(input: {
    providerTransactionId: string;
    idempotencyKey: string;
  }): Promise<{ disposition: 'voided' | 'active'; providerVoidId?: string | null }>;
};

type Conn = Pick<typeof db, 'transaction'>;

export type VoidReplacementLabelInput = {
  replacementId: number;
  actor: { email: string | null; type: string; permissions: readonly string[] };
  reason: string;
  /** Optimistic concurrency, supplied by the caller that read the row. */
  expectedStatus?: string;
  expectedStateVersion?: number;
};

export type VoidReplacementLabelResult = {
  intentId: number;
  providerVoidId: string;
  /** False when an already-voided label was returned unchanged. */
  voided: boolean;
};

function requireReason(reason: string | null | undefined): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed === '') {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_REASON_REQUIRED',
      'voiding a purchased label requires a written reason and is recorded', 400,
    );
  }
  return trimmed;
}

export function replacementVoidIdempotencyKey(intent: {
  id: number;
  providerIdempotencyKey: string;
}): string {
  return `void:${intent.providerIdempotencyKey}:intent:${intent.id}`;
}

async function markReplacementShipmentVoidedInTransaction(
  tx: any,
  input: {
    shipmentId: number | null;
    replacementReference: string;
    replacementClientId: number | null;
    providerShipmentId: string | null;
  },
): Promise<void> {
  if (input.shipmentId == null) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_SCOPE_MISMATCH',
      'the purchased intent has no replacement shipment to mark voided',
    );
  }
  const providerShipmentId = input.providerShipmentId != null
    && /^[1-9]\d*$/.test(input.providerShipmentId)
    ? Number(input.providerShipmentId)
    : null;
  if (!Number.isSafeInteger(providerShipmentId) || Number(providerShipmentId) <= 0) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_SCOPE_MISMATCH',
      'the purchased intent has no valid provider shipment identity',
    );
  }
  const updated = await tx
    .update(shipments)
    .set({ voided: true, updatedAt: new Date() })
    .where(and(
      eq(shipments.id, input.shipmentId),
      isNull(shipments.orderId),
      input.replacementClientId == null
        ? isNull(shipments.clientId)
        : eq(shipments.clientId, input.replacementClientId),
      eq(shipments.orderNumber, input.replacementReference),
      eq(shipments.source, 'replacement'),
      eq(shipments.labelShipmentId, providerShipmentId!),
    ))
    .returning({ id: shipments.id });
  if (updated.length === 0) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_SCOPE_MISMATCH',
      'the voided intent no longer points at its exact replacement-owned shipment',
      409,
      { shipmentId: input.shipmentId },
    );
  }
}

async function lockReplacementShipmentForVoidInTransaction(
  tx: any,
  input: {
    shipmentId: number | null;
    replacementReference: string;
    replacementClientId: number | null;
    providerShipmentId: string | null;
  },
) {
  const providerShipmentId = input.providerShipmentId != null
    && /^[1-9]\d*$/.test(input.providerShipmentId)
    ? Number(input.providerShipmentId)
    : null;
  if (input.shipmentId == null || !Number.isSafeInteger(providerShipmentId) || Number(providerShipmentId) <= 0) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_SCOPE_MISMATCH',
      'the purchased intent has no exact replacement/provider shipment identity',
    );
  }
  const [shipment] = await tx.select().from(shipments)
    .where(eq(shipments.id, input.shipmentId))
    .limit(1)
    .for('update');
  if (
    !shipment
    || shipment.orderId !== null
    || shipment.clientId !== input.replacementClientId
    || shipment.orderNumber !== input.replacementReference
    || shipment.source !== 'replacement'
    || shipment.labelShipmentId !== providerShipmentId
  ) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_SCOPE_MISMATCH',
      'the purchased intent no longer points at its exact replacement-owned provider shipment',
    );
  }
  return shipment;
}

export async function voidReplacementLabel(
  input: VoidReplacementLabelInput,
  provider: ReplacementLabelVoidProvider,
  conn: Conn = db,
): Promise<VoidReplacementLabelResult> {
  assertReplacementLabelEnabled();

  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_FORBIDDEN',
      `voiding a replacement label requires ${REPLACEMENT_LABEL_PERMISSION}`, 403,
    );
  }
  const reason = requireReason(input.reason);

  // ── Phase 1: claim ────────────────────────────────────────────────────────
  const claim = await conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementVoidError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`, 404,
      );
    }

    if (input.expectedStatus != null && replacement.status !== input.expectedStatus) {
      throw new ReplacementVoidError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${replacement.reference} is ${replacement.status}, not ${input.expectedStatus}`,
        409, { actual: replacement.status },
      );
    }
    if (input.expectedStateVersion != null && replacement.stateVersion !== input.expectedStateVersion) {
      throw new ReplacementVoidError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${replacement.reference} moved under this request`, 409,
        { actual: replacement.stateVersion },
      );
    }

    // SCOPE: the intent must belong to THIS replacement. A caller cannot void another
    // replacement's label by naming its own.
    const [intent] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1);
    if (!intent) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_NO_ACTIVE_LABEL',
        `replacement ${replacement.reference} has no purchased label to void`, 409,
      );
    }
    if (!intent.providerTransactionId) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_SCOPE_MISMATCH',
        'the purchase intent carries no provider identity, so nothing can be voided against it',
      );
    }
    if (
      intent.replacementShipmentId == null
      || intent.replacementShipmentId !== replacement.replacementShipmentId
    ) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_SCOPE_MISMATCH',
        'the purchased intent is not attached to the replacement-owned shipment',
        409,
        {
          intentId: intent.id,
          intentShipmentId: intent.replacementShipmentId,
          replacementShipmentId: replacement.replacementShipmentId,
        },
      );
    }
    const shipment = await lockReplacementShipmentForVoidInTransaction(tx, {
      shipmentId: intent.replacementShipmentId,
      replacementReference: replacement.reference,
      replacementClientId: replacement.clientId,
      providerShipmentId: intent.providerShipmentId,
    });

    // Shipment sync can observe the provider's monotonic void fact before the dedicated intent
    // owner records it. That durable evidence is already a confirmed void: repair the intent
    // and return without ever resending the destructive provider request.
    if (shipment.voided) {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          voidState: 'voided',
          voidedAt: intent.voidedAt ?? new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, intent.id),
          eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
          eq(replacementLabelPurchaseIntents.replacementShipmentId, shipment.id),
          eq(replacementLabelPurchaseIntents.state, 'purchased'),
        ));
      await tx.insert(replacementActivityEvents).values({
        replacementId: replacement.id,
        shipmentId: shipment.id,
        eventType: 'replacement_label_void_repaired_from_shipment',
        actorType: input.actor.type,
        actorEmail: input.actor.email,
        detail: reason,
        idempotencyKey: `replacement:${replacement.id}:void-from-shipment:${intent.id}`,
      }).onConflictDoNothing({ target: replacementActivityEvents.idempotencyKey });
      return {
        alreadyVoided: true as const,
        intent: { ...intent, voidState: 'voided' } as ReplacementLabelPurchaseIntentRow,
      };
    }

    // Already voided: return it rather than sending a second destructive call.
    if (intent.voidState === 'voided') {
      // Repair legacy/process-interrupted state in the same no-provider replay. The intent is
      // confirmed evidence; shipments is the shared durable label record read by manifests,
      // billing, package accounting and aggregates, so the two may not disagree.
      await markReplacementShipmentVoidedInTransaction(tx, {
        shipmentId: intent.replacementShipmentId,
        replacementReference: replacement.reference,
        replacementClientId: replacement.clientId,
        providerShipmentId: intent.providerShipmentId,
      });
      return { alreadyVoided: true as const, intent: intent as ReplacementLabelPurchaseIntentRow };
    }
    if (intent.voidState != null) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_RECONCILE_REQUIRED',
        `replacement ${replacement.reference} already has an unresolved void attempt. `
          + 'Reconcile the provider outcome; a second destructive call is not a retry.',
        409,
        { intentId: intent.id, voidState: intent.voidState },
      );
    }

    const [claimedIntent] = await tx.update(replacementLabelPurchaseIntents)
      .set({ voidState: 'void_pending', updatedAt: new Date() })
      .where(and(
        eq(replacementLabelPurchaseIntents.id, intent.id),
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.replacementShipmentId, shipment.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
        isNull(replacementLabelPurchaseIntents.voidState),
      ))
      .returning({ id: replacementLabelPurchaseIntents.id });
    if (!claimedIntent) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_RECONCILE_REQUIRED',
        'the label void state moved before the provider request; reconcile instead of retrying',
      );
    }

    return { alreadyVoided: false as const, intent: intent as ReplacementLabelPurchaseIntentRow };
  });

  if (claim.alreadyVoided) {
    return {
      intentId: claim.intent.id,
      providerVoidId: claim.intent.providerVoidId ?? '',
      voided: false,
    };
  }

  // ── Phase 2: the destructive call, outside every transaction ──────────────
  const idempotencyKey = replacementVoidIdempotencyKey(claim.intent);
  let result: ProviderVoidResult;
  try {
    result = await provider.voidLabel({
      providerTransactionId: claim.intent.providerTransactionId!,
      idempotencyKey,
    });
  } catch (error) {
    await conn.transaction(async (tx) => {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          voidState: 'void_reconcile_required',
          lastError: String((error as Error)?.message ?? error),
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, claim.intent.id),
          eq(replacementLabelPurchaseIntents.replacementId, input.replacementId),
          eq(replacementLabelPurchaseIntents.voidState, 'void_pending'),
        ));
    });
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_RECONCILE_REQUIRED',
      'the void outcome is unknown. It is held for reconciliation and will NOT be retried ' +
        'automatically — a repeated destructive call can cancel a label a later attempt bought.',
      409, { intentId: claim.intent.id },
    );
  }

  // ── Phase 3: record only what the provider CONFIRMED ──────────────────────
  // The unconfirmed case is COMMITTED and then reported, for the same reason ruling A gave
  // for drift: throwing inside the transaction rolls back the very row that records we do
  // not know the outcome, and the next attempt would find a clean  and try
  // again. I made exactly that mistake here first; the integration suite caught it.
  if (!result.voided) {
    await conn.transaction(async (tx) => {
      await tx.update(replacementLabelPurchaseIntents)
        .set({ voidState: 'void_reconcile_required', updatedAt: new Date() })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, claim.intent.id),
          eq(replacementLabelPurchaseIntents.replacementId, input.replacementId),
          eq(replacementLabelPurchaseIntents.voidState, 'void_pending'),
        ));
    });
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_RECONCILE_REQUIRED',
      'the provider did not confirm the void. A local voided row with a live label is worse ' +
        'than no row at all.',
      409, { intentId: claim.intent.id },
    );
  }

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);
    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementVoidError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`, 404,
      );
    }
    const updatedIntent = await tx.update(replacementLabelPurchaseIntents)
      .set({
        voidState: 'voided',
        providerVoidId: result.providerVoidId,
        voidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacementLabelPurchaseIntents.id, claim.intent.id),
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.replacementShipmentId, claim.intent.replacementShipmentId!),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
        eq(replacementLabelPurchaseIntents.voidState, 'void_pending'),
      ))
      .returning({ id: replacementLabelPurchaseIntents.id });
    if (updatedIntent.length === 0) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_RECONCILE_REQUIRED',
        'the purchased intent moved before the confirmed void could be recorded; reconcile it',
        409,
        { intentId: claim.intent.id },
      );
    }

    await markReplacementShipmentVoidedInTransaction(tx, {
      shipmentId: claim.intent.replacementShipmentId,
      replacementReference: replacement.reference,
      replacementClientId: replacement.clientId,
      providerShipmentId: claim.intent.providerShipmentId,
    });

    await tx.insert(replacementActivityEvents).values({
      replacementId: input.replacementId,
      shipmentId: claim.intent.replacementShipmentId,
      eventType: 'replacement_label_voided',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${input.replacementId}:void:${claim.intent.id}`,
    }).onConflictDoNothing({ target: replacementActivityEvents.idempotencyKey });

    return { intentId: claim.intent.id, providerVoidId: result.providerVoidId, voided: true };
  });
}

export type ReconcileIntentInput = {
  replacementId: number;
  intentId: number;
  actor: { email: string | null; type: string; permissions: readonly string[] };
  reason: string;
};

export type ReconcileIntentResult = {
  intentId: number;
  /** purchased | failed_pre_purchase | still_unknown */
  outcome: 'purchased' | 'failed_pre_purchase' | 'still_unknown';
  shipmentId?: number;
  receipt?: ProviderLabelReceipt;
  recorded?: string;
};

function purchasedReconciliationResult(
  snapshot: ReplacementLabelIntentSnapshot,
): ReconcileIntentResult {
  if (!snapshot.recorded) {
    throw new ReplacementVoidError(
      'REPLACEMENT_INTENT_NOT_RECONCILABLE',
      `intent ${snapshot.intentId} has no complete recorded receipt`, 409,
    );
  }
  return {
    intentId: snapshot.intentId,
    outcome: 'purchased',
    shipmentId: snapshot.recorded.shipmentId,
    receipt: snapshot.recorded.receipt,
    recorded: snapshot.recorded.status,
  };
}

/**
 * The admin path for an orphaned purchase intent.
 *
 * An intent left in `provider_pending` or `reconcile_required` is the residue of a crash
 * between dispatch and persistence. Nobody may guess what happened: the provider is asked,
 * and only a definite answer resolves it.
 *
 * `lookupPurchase` returning null must mean the provider is CERTAIN nothing was bought. A
 * provider that cannot tell must throw, and the intent stays unresolved — an operator chasing
 * a stuck row is a far better outcome than a silent second purchase.
 */
export async function reconcileReplacementPurchaseIntent(
  input: ReconcileIntentInput,
  provider: ReplacementLabelVoidProvider,
  conn: Conn = db,
): Promise<ReconcileIntentResult> {
  assertReplacementLabelEnabled();
  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_FORBIDDEN',
      `reconciling a purchase intent requires ${REPLACEMENT_LABEL_PERMISSION}`, 403,
    );
  }
  const reason = requireReason(input.reason);

  // Per user override unlock shipped data on 2026-08-19: recovery validates the intent's own
  // replacement/shipment chain before provider lookup and takes the same order-before-intent
  // lock order as ordinary Phase 3. It never dispatches a second purchase.
  const intent = await conn.transaction((tx) =>
    readReplacementLabelIntentInTransaction(tx, {
      intentId: input.intentId,
      replacementId: input.replacementId,
    }));
  if (intent.recorded) return purchasedReconciliationResult(intent);
  if (intent.state === 'failed_pre_purchase') {
    return { intentId: intent.intentId, outcome: 'failed_pre_purchase' };
  }
  if (intent.state !== 'provider_pending' && intent.state !== 'reconcile_required') {
    throw new ReplacementVoidError(
      'REPLACEMENT_INTENT_NOT_RECONCILABLE',
      `intent ${intent.intentId} is ${intent.state}; only an unresolved attempt is reconciled`, 409,
    );
  }

  if (!provider.lookupPurchase) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_RECONCILE_REQUIRED',
      'this provider cannot be asked what happened, so the intent cannot be resolved here',
    );
  }

  let found: ProviderLabelReceipt | null;
  try {
    found = await provider.lookupPurchase({ idempotencyKey: intent.providerIdempotencyKey });
  } catch (error) {
    return conn.transaction(async (tx) => {
      const before = await readReplacementLabelIntentInTransaction(tx, {
        intentId: intent.intentId,
        replacementId: intent.replacementId,
        shipmentId: intent.shipmentId,
      });
      if (before.recorded) return purchasedReconciliationResult(before);
      if (before.state === 'failed_pre_purchase') {
        return { intentId: before.intentId, outcome: 'failed_pre_purchase' as const };
      }
      if (before.state !== 'provider_pending' && before.state !== 'reconcile_required') {
        throw new ReplacementVoidError(
          'REPLACEMENT_INTENT_NOT_RECONCILABLE',
          `intent ${before.intentId} moved to ${before.state} during reconciliation`, 409,
        );
      }

      const [updated] = await tx.update(replacementLabelPurchaseIntents)
        .set({
          state: 'reconcile_required',
          reconciliationState: 'unresolved',
          lastError: String((error as Error)?.message ?? error),
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, before.intentId),
          eq(replacementLabelPurchaseIntents.replacementId, before.replacementId),
          eq(replacementLabelPurchaseIntents.replacementShipmentId, before.shipmentId),
          sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required')`,
        ))
        .returning({ id: replacementLabelPurchaseIntents.id });
      if (updated) return { intentId: before.intentId, outcome: 'still_unknown' as const };

      const winner = await readReplacementLabelIntentInTransaction(tx, {
        intentId: before.intentId,
        replacementId: before.replacementId,
        shipmentId: before.shipmentId,
      });
      if (winner.recorded) return purchasedReconciliationResult(winner);
      if (winner.state === 'failed_pre_purchase') {
        return { intentId: winner.intentId, outcome: 'failed_pre_purchase' as const };
      }
      return { intentId: winner.intentId, outcome: 'still_unknown' as const };
    });
  }

  return conn.transaction(async (tx) => {
    if (found) {
      // The label is REAL and paid for. Recording that the intent resolved is not the same as
      // recording that the label happened, and this path used to stop at the first: the
      // shipment kept no tracking, no label URL and no cost, and the replacement stayed at
      // `approved`. Blocked from buying a second label, and not shippable either.
      //
      // The same owner the ordinary purchase uses, so recovery cannot drift from it — it also
      // re-checks drift that appeared while the purchase was lost, and makes the guarded
      // transition into `label_created` or into `review` if the source line moved.
      //
      // In the same transaction as the intent update above: a recovery that recorded the intent
      // and then failed to record the label would recreate exactly the split it is closing.
      const recorded = await recordPurchasedReplacementLabelInTransaction(tx, {
        replacementId: intent.replacementId,
        intentId: intent.intentId,
        shipmentId: intent.shipmentId,
        receipt: found,
        actor: input.actor,
        reconciliation: { reason },
      });
      return {
        intentId: recorded.intentId,
        outcome: 'purchased' as const,
        shipmentId: recorded.shipmentId,
        receipt: recorded.receipt,
        recorded: recorded.status,
      };
    }

    const before = await readReplacementLabelIntentInTransaction(tx, {
      intentId: intent.intentId,
      replacementId: intent.replacementId,
      shipmentId: intent.shipmentId,
    });
    if (before.recorded) return purchasedReconciliationResult(before);
    if (before.state === 'failed_pre_purchase') {
      return { intentId: before.intentId, outcome: 'failed_pre_purchase' as const };
    }
    if (before.state !== 'provider_pending' && before.state !== 'reconcile_required') {
      throw new ReplacementVoidError(
        'REPLACEMENT_INTENT_NOT_RECONCILABLE',
        `intent ${before.intentId} moved to ${before.state} during reconciliation`, 409,
      );
    }

    const [updated] = await tx.update(replacementLabelPurchaseIntents)
      .set({
        state: 'failed_pre_purchase',
        reconciliationState: 'resolved_not_purchased',
        reconciledAt: new Date(),
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacementLabelPurchaseIntents.id, before.intentId),
        eq(replacementLabelPurchaseIntents.replacementId, before.replacementId),
        eq(replacementLabelPurchaseIntents.replacementShipmentId, before.shipmentId),
        sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required')`,
      ))
      .returning({ id: replacementLabelPurchaseIntents.id });
    if (!updated) {
      const winner = await readReplacementLabelIntentInTransaction(tx, {
        intentId: before.intentId,
        replacementId: before.replacementId,
        shipmentId: before.shipmentId,
      });
      if (winner.recorded) return purchasedReconciliationResult(winner);
      if (winner.state === 'failed_pre_purchase') {
        return { intentId: winner.intentId, outcome: 'failed_pre_purchase' as const };
      }
      throw new ReplacementVoidError(
        'REPLACEMENT_INTENT_NOT_RECONCILABLE',
        `intent ${winner.intentId} moved to ${winner.state} during reconciliation`, 409,
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: before.replacementId,
      shipmentId: before.shipmentId,
      eventType: 'replacement_purchase_reconciled_absent',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${before.replacementId}:reconcile-absent:${before.intentId}`,
    });
    return { intentId: before.intentId, outcome: 'failed_pre_purchase' as const };
  });
}

const VOID_ACTIVE_CONFIRMATION_GRACE_MS = 5 * 60 * 1000;

export type ReconcileReplacementVoidInput = {
  replacementId: number;
  intentId: number;
  actor: { email: string | null; type: string; permissions: readonly string[] };
  reason: string;
};

export type ReconcileReplacementVoidResult = {
  intentId: number;
  outcome: 'voided' | 'active' | 'still_unknown';
};

/**
 * Read-only provider reconciliation for a void whose response was lost.
 *
 * It never re-sends the destructive PUT. A provider-confirmed void updates the intent and
 * shared shipment together. An exact active read is accepted only after a consistency grace;
 * 404/transport/early-active observations leave the label held and unshippable.
 */
export async function reconcileReplacementVoidOutcome(
  input: ReconcileReplacementVoidInput,
  provider: ReplacementLabelVoidProvider,
  conn: Conn = db,
): Promise<ReconcileReplacementVoidResult> {
  assertReplacementLabelEnabled();
  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_FORBIDDEN',
      `reconciling a replacement void requires ${REPLACEMENT_LABEL_PERMISSION}`,
      403,
    );
  }
  const reason = requireReason(input.reason);

  const claim = await conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);
    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementVoidError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`, 404,
      );
    }
    const [intent] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.id, input.intentId),
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1)
      .for('update');
    if (!intent || !intent.providerTransactionId) {
      throw new ReplacementVoidError(
        'REPLACEMENT_INTENT_NOT_RECONCILABLE',
        'the addressed purchased intent is not owned by this replacement',
        404,
      );
    }
    if (
      intent.replacementShipmentId == null
      || intent.replacementShipmentId !== replacement.replacementShipmentId
    ) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_SCOPE_MISMATCH',
        'the uncertain void does not point at the replacement-owned shipment',
      );
    }
    const shipment = await lockReplacementShipmentForVoidInTransaction(tx, {
      shipmentId: intent.replacementShipmentId,
      replacementReference: replacement.reference,
      replacementClientId: replacement.clientId,
      providerShipmentId: intent.providerShipmentId,
    });
    if (shipment.voided && intent.voidState !== 'voided') {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          voidState: 'voided',
          voidedAt: intent.voidedAt ?? new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, intent.id),
          eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
          eq(replacementLabelPurchaseIntents.replacementShipmentId, shipment.id),
          eq(replacementLabelPurchaseIntents.state, 'purchased'),
        ));
      await tx.insert(replacementActivityEvents).values({
        replacementId: replacement.id,
        shipmentId: shipment.id,
        eventType: 'replacement_label_void_repaired_from_shipment',
        actorType: input.actor.type,
        actorEmail: input.actor.email,
        detail: reason,
        idempotencyKey: `replacement:${replacement.id}:void-from-shipment:${intent.id}`,
      }).onConflictDoNothing({ target: replacementActivityEvents.idempotencyKey });
      return { already: 'voided' as const, intent: { ...intent, voidState: 'voided' }, replacement };
    }
    if (intent.voidState === 'voided') {
      await markReplacementShipmentVoidedInTransaction(tx, {
        shipmentId: intent.replacementShipmentId,
        replacementReference: replacement.reference,
        replacementClientId: replacement.clientId,
        providerShipmentId: intent.providerShipmentId,
      });
      return { already: 'voided' as const, intent, replacement };
    }
    if (intent.voidState !== 'void_pending' && intent.voidState !== 'void_reconcile_required') {
      throw new ReplacementVoidError(
        'REPLACEMENT_INTENT_NOT_RECONCILABLE',
        `intent ${intent.id} has no uncertain void outcome`,
      );
    }
    return { already: null, intent, replacement };
  });
  if (claim.already === 'voided') return { intentId: claim.intent.id, outcome: 'voided' };
  if (!provider.lookupVoid) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_RECONCILE_REQUIRED',
      'this provider exposes no authoritative read for an uncertain void outcome',
    );
  }

  let observed: Awaited<ReturnType<NonNullable<ReplacementLabelVoidProvider['lookupVoid']>>>;
  try {
    observed = await provider.lookupVoid({
      providerTransactionId: claim.intent.providerTransactionId!,
      idempotencyKey: replacementVoidIdempotencyKey(claim.intent),
    });
  } catch {
    return { intentId: claim.intent.id, outcome: 'still_unknown' };
  }
  const observedAt = new Date();
  if (
    observed.disposition === 'active'
    && observedAt.getTime() - claim.intent.updatedAt.getTime() < VOID_ACTIVE_CONFIRMATION_GRACE_MS
  ) {
    return { intentId: claim.intent.id, outcome: 'still_unknown' };
  }

  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);
    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementVoidError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`, 404,
      );
    }
    const shipment = await lockReplacementShipmentForVoidInTransaction(tx, {
      shipmentId: claim.intent.replacementShipmentId,
      replacementReference: replacement.reference,
      replacementClientId: replacement.clientId,
      providerShipmentId: claim.intent.providerShipmentId,
    });
    // A stale provider read of "active" can arrive after sync durably observed voided. Voids
    // are monotonic; the shared vessel's true value wins and the intent is repaired to match.
    const disposition = shipment.voided ? 'voided' as const : observed.disposition;
    const nextVoidState = disposition === 'voided' ? 'voided' : null;
    const [updated] = await tx.update(replacementLabelPurchaseIntents)
      .set({
        voidState: nextVoidState,
        providerVoidId: disposition === 'voided'
          ? (observed.providerVoidId ?? claim.intent.providerTransactionId)
          : null,
        voidedAt: disposition === 'voided' ? observedAt : null,
        lastError: null,
        updatedAt: observedAt,
      })
      .where(and(
        eq(replacementLabelPurchaseIntents.id, claim.intent.id),
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.replacementShipmentId, claim.intent.replacementShipmentId!),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
        sql`${replacementLabelPurchaseIntents.voidState} in ('void_pending', 'void_reconcile_required')`,
      ))
      .returning({ id: replacementLabelPurchaseIntents.id });
    if (!updated) {
      throw new ReplacementVoidError(
        'REPLACEMENT_VOID_RECONCILE_REQUIRED',
        'the void state moved while its provider observation was being recorded; read it again',
      );
    }
    if (disposition === 'voided') {
      await markReplacementShipmentVoidedInTransaction(tx, {
        shipmentId: claim.intent.replacementShipmentId,
        replacementReference: replacement.reference,
        replacementClientId: replacement.clientId,
        providerShipmentId: claim.intent.providerShipmentId,
      });
    }
    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement.id,
      shipmentId: claim.intent.replacementShipmentId,
      eventType: disposition === 'voided'
        ? 'replacement_label_void_reconciled_voided'
        : 'replacement_label_void_reconciled_active',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${replacement.id}:void-reconcile:${claim.intent.id}:${disposition}`,
    }).onConflictDoNothing({ target: replacementActivityEvents.idempotencyKey });
    return { intentId: claim.intent.id, outcome: disposition };
  });
}
