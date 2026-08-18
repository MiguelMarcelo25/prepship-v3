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
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  replacementActivityEvents,
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementLabelPurchaseIntentRow,
} from '../db/schema/replacements';
import {
  assertReplacementLabelEnabled,
  recordPurchasedReplacementLabelInTransaction,
  type ProviderLabelReceipt,
} from './replacement-label-purchase-command';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/** Purchasing and voiding a replacement label are the same privilege. */
export const REPLACEMENT_LABEL_PERMISSION = 'replacements:label';

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

    // Already voided: return it rather than sending a second destructive call.
    if (intent.voidState === 'voided') {
      return { alreadyVoided: true as const, intent: intent as ReplacementLabelPurchaseIntentRow };
    }

    await tx.update(replacementLabelPurchaseIntents)
      .set({ voidState: 'void_pending', updatedAt: new Date() })
      .where(eq(replacementLabelPurchaseIntents.id, intent.id));

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
        .where(eq(replacementLabelPurchaseIntents.id, claim.intent.id));
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
        .where(eq(replacementLabelPurchaseIntents.id, claim.intent.id));
    });
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_RECONCILE_REQUIRED',
      'the provider did not confirm the void. A local voided row with a live label is worse ' +
        'than no row at all.',
      409, { intentId: claim.intent.id },
    );
  }

  return conn.transaction(async (tx) => {

    await tx.update(replacementLabelPurchaseIntents)
      .set({
        voidState: 'voided',
        providerVoidId: result.providerVoidId,
        voidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replacementLabelPurchaseIntents.id, claim.intent.id));

    await tx.insert(replacementActivityEvents).values({
      replacementId: input.replacementId,
      shipmentId: claim.intent.replacementShipmentId,
      eventType: 'replacement_label_voided',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${input.replacementId}:void:${claim.intent.id}`,
    });

    return { intentId: claim.intent.id, providerVoidId: result.providerVoidId, voided: true };
  });
}

export type ReconcileIntentInput = {
  intentId: number;
  actor: { email: string | null; type: string; permissions: readonly string[] };
  reason: string;
};

export type ReconcileIntentResult = {
  intentId: number;
  /** purchased | failed_pre_purchase | still_unknown */
  outcome: 'purchased' | 'failed_pre_purchase' | 'still_unknown';
};

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
  if (!input.actor.permissions.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementVoidError(
      'REPLACEMENT_VOID_FORBIDDEN',
      `reconciling a purchase intent requires ${REPLACEMENT_LABEL_PERMISSION}`, 403,
    );
  }
  const reason = requireReason(input.reason);

  const intent = await conn.transaction(async (tx) => {
    const [row] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(eq(replacementLabelPurchaseIntents.id, input.intentId)).limit(1);
    if (!row) {
      throw new ReplacementVoidError(
        'REPLACEMENT_NOT_FOUND', `purchase intent ${input.intentId} does not exist`, 404,
      );
    }
    if (row.state !== 'provider_pending' && row.state !== 'reconcile_required') {
      throw new ReplacementVoidError(
        'REPLACEMENT_INTENT_NOT_RECONCILABLE',
        `intent ${row.id} is ${row.state}; only an unresolved attempt is reconciled`, 409,
      );
    }
    return row as ReplacementLabelPurchaseIntentRow;
  });

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
    await conn.transaction(async (tx) => {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          state: 'reconcile_required',
          reconciliationState: 'unresolved',
          lastError: String((error as Error)?.message ?? error),
          updatedAt: new Date(),
        })
        .where(eq(replacementLabelPurchaseIntents.id, intent.id));
    });
    return { intentId: intent.id, outcome: 'still_unknown' };
  }

  return conn.transaction(async (tx) => {
    if (found) {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          state: 'purchased',
          providerTransactionId: found.providerTransactionId,
          providerLabelId: found.providerLabelId ?? null,
          providerShipmentId: found.providerShipmentId ?? null,
          reconciliationState: 'resolved_purchased',
          reconciledAt: new Date(),
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(replacementLabelPurchaseIntents.id, intent.id));
      await tx.insert(replacementActivityEvents).values({
        replacementId: intent.replacementId,
        eventType: 'replacement_purchase_reconciled_found',
        actorType: input.actor.type,
        actorEmail: input.actor.email,
        detail: reason,
        idempotencyKey: `replacement:${intent.replacementId}:reconcile-found:${intent.id}`,
      });

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
      const outcome = await recordPurchasedReplacementLabelInTransaction(tx, {
        replacementId: intent.replacementId,
        intentId: intent.id,
        shipmentId: intent.replacementShipmentId!,
        receipt: found,
        actor: input.actor,
      });
      return { intentId: intent.id, outcome: 'purchased' as const, recorded: outcome };
    }

    await tx.update(replacementLabelPurchaseIntents)
      .set({
        state: 'failed_pre_purchase',
        reconciliationState: 'resolved_not_purchased',
        reconciledAt: new Date(),
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replacementLabelPurchaseIntents.id, intent.id));
    await tx.insert(replacementActivityEvents).values({
      replacementId: intent.replacementId,
      eventType: 'replacement_purchase_reconciled_absent',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: reason,
      idempotencyKey: `replacement:${intent.replacementId}:reconcile-absent:${intent.id}`,
    });
    return { intentId: intent.id, outcome: 'failed_pre_purchase' as const };
  });
}
