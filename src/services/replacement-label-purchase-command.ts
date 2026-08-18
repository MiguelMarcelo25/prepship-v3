/**
 * PS-502 — buy the replacement's label.
 *
 * REQUIRES `unlock shipped data`. This is the first replacement command that spends money at
 * a provider, and the only one whose failure can cost real postage.
 *
 * THREE PHASES, AND THE MIDDLE ONE IS NOT IN A TRANSACTION
 *
 *   1. CLAIM      one transaction: gate, lock, verify state, re-resolve drift, freeze the
 *                 resolved request, write a durable purchase intent, COMMIT
 *   2. DISPATCH   no transaction, no lock: the provider call
 *   3. PERSIST    one transaction: re-resolve drift again, record the receipt, link the
 *                 shipment, transition once to label_created
 *
 * Holding a transaction or an advisory lock across the network call is the mistake this shape
 * exists to avoid: a slow provider would pin a connection and block every other replacement
 * on that order, and a timeout would roll back the very intent that proves a purchase may
 * have happened.
 *
 * THE DURABLE INTENT IS THE POINT. It is committed BEFORE dispatch, so a crash between
 * dispatch and persistence leaves proof that a purchase may exist. Recovery reads that
 * intent; it never infers "the purchase failed" from a missing local receipt.
 *
 * WHAT IT NEVER DOES
 *   - reuse createLabelV2 (shipping-safety blocks a second label on a shipped order)
 *   - use the ORIGINAL order's purchase identity
 *   - write the original order's status
 *   - call a marketplace connector or any customer-notification owner
 *   - move inventory, consume packaging or write a billing line — those belong to `shipped`
 *   - repurchase automatically on an unknown outcome
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../lib/env.js';
import { shipments } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementLabelPurchaseIntentRow,
} from '../db/schema/replacements';
import { findFrozenLineDrift } from './replacement-drift-resolution';
import { enterReplacementReview } from './replacement-lifecycle-command';
import {
  resolveReplacementPurchaseRequest,
  type ReplacementPurchaseInputs,
  type ResolvedPurchaseRequest,
} from './replacement-purchase-request';
import { isReplacementStatus, type ReplacementStatus } from './replacement-state-machine';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/** Only these may purchase. `label_failed` is the explicit recovery state. */
const PURCHASABLE_STATUSES: readonly ReplacementStatus[] = ['approved', 'label_failed'];

export type ReplacementLabelErrorCode =
  | 'REPLACEMENT_LABEL_FEATURE_DISABLED'
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_NOT_PURCHASABLE'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_SHIPMENT_REQUIRED'
  | 'REPLACEMENT_LABEL_RECONCILE_REQUIRED';

export class ReplacementLabelError extends Error {
  constructor(
    readonly code: ReplacementLabelErrorCode,
    message: string,
    readonly httpStatus: 403 | 404 | 409 = 409,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ReplacementLabelError';
  }
}

/** What a provider must return. Stable identity, never a tracking number alone. */
export type ProviderLabelReceipt = {
  providerTransactionId: string;
  providerLabelId?: string | null;
  providerShipmentId?: string | null;
  trackingNumber?: string | null;
  labelUrl?: string | null;
  /** The CUSTOMER-facing money tuple, frozen here for the billing owner. */
  shipmentCost: number;
  otherCost: number;
};

/**
 * The provider seam.
 *
 * Injected so tests drive it with a fake and no real postage is ever reachable from this
 * repository's test suites. The adapter receives an already-resolved request and makes no
 * business-policy choice: by the time it runs, which address, which service and which package
 * have all been answered and attributed.
 */
export type ReplacementLabelProvider = {
  purchase(input: {
    request: ResolvedPurchaseRequest;
    /** Deterministic, replacement-scoped. The provider must dedupe on this. */
    idempotencyKey: string;
  }): Promise<ProviderLabelReceipt>;
};

export type PurchaseReplacementLabelInput = {
  replacementId: number;
  actor: { email: string | null; type: string };
  /** Fully resolved and attributed by replacement-purchase-request.ts. */
  purchaseInputs: Omit<ReplacementPurchaseInputs, 'replacementId' | 'replacementShipmentId' | 'replacementReference'>;
};

export type PurchaseReplacementLabelResult = {
  intentId: number;
  shipmentId: number;
  receipt: ProviderLabelReceipt;
  /** False when an existing receipt was returned for a replayed purchase. */
  purchased: boolean;
};

type Conn = Pick<typeof db, 'transaction'>;

/**
 * Deterministic provider identity.
 *
 * Replacement id + its shipment + the frozen request fingerprint + the attempt generation.
 * NEVER the original order's key: two replacements against one order would otherwise share a
 * purchase identity, and a provider deduping on it would hand the second one the first one's
 * label.
 *
 * The attempt generation is bumped only by an explicit, audited new attempt — an ordinary
 * retry reuses the key, which is what makes the provider's own dedupe protect us.
 */
export function replacementProviderIdempotencyKey(input: {
  replacementId: number;
  replacementShipmentId: number;
  requestFingerprint: string;
  purchaseAttempt: number;
}): string {
  return [
    'replacement', input.replacementId,
    'shipment', input.replacementShipmentId,
    'attempt', input.purchaseAttempt,
    'request', createStableHash(input.requestFingerprint),
  ].join(':');
}

/** Short, stable, non-cryptographic. The fingerprint itself is the authority; this shortens it. */
function createStableHash(value: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0');
}

export function assertReplacementLabelEnabled(): void {
  if (env.REPLACEMENTS_LABEL_ENABLED !== true) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_FEATURE_DISABLED',
      'REPLACEMENTS_LABEL_ENABLED is off. Replacement label purchase is dark until DJ freezes ' +
        'decisions 1-4 and the live-postage canary passes.',
      403,
    );
  }
}

/** Phase 1. Everything that must be true before a provider is contacted. */
async function claimPurchase(
  input: PurchaseReplacementLabelInput,
  conn: Conn,
): Promise<
  | { replayed: true; intent: ReplacementLabelPurchaseIntentRow }
  | { replayed: false; intent: ReplacementLabelPurchaseIntentRow; request: ResolvedPurchaseRequest; shipmentId: number }
> {
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);
    if (!replacement) {
      throw new ReplacementLabelError(
        'REPLACEMENT_NOT_FOUND', `replacement ${input.replacementId} does not exist`, 404,
      );
    }
    if (replacement.replacementShipmentId == null) {
      throw new ReplacementLabelError(
        'REPLACEMENT_SHIPMENT_REQUIRED',
        `replacement ${replacement.reference} has no shipment to buy a label for`,
      );
    }

    // An unresolved intent means a previous attempt may already have spent money. Reaching a
    // provider again without reconciling it is how a second label gets bought.
    const [unresolved] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required')`,
      ))
      .limit(1);
    if (unresolved) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
        `replacement ${replacement.reference} has an unresolved purchase attempt ` +
          `(${unresolved.state}). Reconcile it before dispatching again — a missing local ` +
          'receipt is not proof that no purchase happened.',
        409,
        { intentId: unresolved.id, state: unresolved.state },
      );
    }

    // Already bought. Replay returns the existing receipt rather than buying again.
    const [purchased] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1);
    if (purchased) return { replayed: true, intent: purchased as ReplacementLabelPurchaseIntentRow };

    const status = isReplacementStatus(replacement.status) ? replacement.status : null;
    if (!status || !PURCHASABLE_STATUSES.includes(status)) {
      throw new ReplacementLabelError(
        'REPLACEMENT_NOT_PURCHASABLE',
        `a label may be bought at ${PURCHASABLE_STATUSES.join(' or ')}; ` +
          `${replacement.reference} is ${replacement.status}`,
        409,
        { status: replacement.status },
      );
    }

    // Immediately before the claim, per the card: this is the last cheap moment.
    const drift = await findFrozenLineDrift(tx, replacement);
    if (drift) {
      throw new ReplacementLabelError(
        'REPLACEMENT_SOURCE_LINE_CHANGED',
        `the source line at index ${drift.effectiveOrderLineIndex} on ${replacement.reference} ` +
          'no longer matches what was frozen. Nothing was purchased.',
        409,
        { replacementItemId: drift.replacementItemId },
      );
    }

    const request = resolveReplacementPurchaseRequest({
      ...input.purchaseInputs,
      replacementId: replacement.id,
      replacementShipmentId: replacement.replacementShipmentId,
      replacementReference: replacement.reference,
    });

    const purchaseAttempt = 1;
    const [intent] = await tx.insert(replacementLabelPurchaseIntents).values({
      replacementId: replacement.id,
      replacementShipmentId: replacement.replacementShipmentId,
      provider: request.carrier.carrierCode,
      providerIdempotencyKey: replacementProviderIdempotencyKey({
        replacementId: replacement.id,
        replacementShipmentId: replacement.replacementShipmentId,
        requestFingerprint: request.fingerprint,
        purchaseAttempt,
      }),
      requestFingerprint: request.fingerprint,
      purchaseAttempt,
      state: 'provider_pending',
      resolvedRequest: request as unknown as Record<string, unknown>,
    }).returning();

    return {
      replayed: false,
      intent: intent as ReplacementLabelPurchaseIntentRow,
      request,
      shipmentId: replacement.replacementShipmentId,
    };
  });
}

/**
 * Classify a dispatch failure.
 *
 * The distinction that matters is whether we KNOW no purchase happened. A refusal before the
 * provider acted is recoverable; anything else — a timeout, a dropped connection, an
 * unparseable response — must become `reconcile_required` rather than be retried, because a
 * retry after an unseen success buys a second label.
 */
export function classifyProviderFailure(error: unknown): 'failed_pre_purchase' | 'reconcile_required' {
  const code = (error as { code?: string })?.code;
  const message = String((error as Error)?.message ?? '').toLowerCase();
  if (code === 'PROVIDER_REJECTED' || message.includes('rejected') || message.includes('invalid')) {
    return 'failed_pre_purchase';
  }
  return 'reconcile_required';
}

export async function purchaseReplacementLabel(
  input: PurchaseReplacementLabelInput,
  provider: ReplacementLabelProvider,
  conn: Conn = db,
): Promise<PurchaseReplacementLabelResult> {
  // BEFORE any database mutation or provider access.
  assertReplacementLabelEnabled();

  const claim = await claimPurchase(input, conn);
  if (claim.replayed) {
    const intent = claim.intent;
    return {
      intentId: intent.id,
      shipmentId: intent.replacementShipmentId!,
      purchased: false,
      receipt: {
        providerTransactionId: intent.providerTransactionId!,
        providerLabelId: intent.providerLabelId,
        providerShipmentId: intent.providerShipmentId,
        shipmentCost: 0,
        otherCost: 0,
      },
    };
  }

  // ── Phase 2. No transaction, no lock. ──────────────────────────────────────
  let receipt: ProviderLabelReceipt;
  try {
    receipt = await provider.purchase({
      request: claim.request,
      idempotencyKey: claim.intent.providerIdempotencyKey,
    });
  } catch (error) {
    const state = classifyProviderFailure(error);
    await conn.transaction(async (tx) => {
      await tx.update(replacementLabelPurchaseIntents)
        .set({
          state,
          lastError: String((error as Error)?.message ?? error),
          lastErrorClass: state,
          reconciliationState: state === 'reconcile_required' ? 'unresolved' : null,
          updatedAt: new Date(),
          resolvedAt: state === 'failed_pre_purchase' ? new Date() : null,
        })
        .where(eq(replacementLabelPurchaseIntents.id, claim.intent.id));
    });
    if (state === 'reconcile_required') {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
        'the provider outcome is unknown. The intent is held for reconciliation and will NOT ' +
          'be repurchased automatically — a retry after an unseen success buys a second label.',
        409,
        { intentId: claim.intent.id },
      );
    }
    throw error;
  }

  // ── Phase 3. Record what happened. ─────────────────────────────────────────
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, (
      select order_id from replacements where id = ${input.replacementId}
    ))`);

    const [replacement] = await tx.select().from(replacements)
      .where(eq(replacements.id, input.replacementId)).limit(1);

    await tx.update(replacementLabelPurchaseIntents)
      .set({
        state: 'purchased',
        providerTransactionId: receipt.providerTransactionId,
        providerLabelId: receipt.providerLabelId ?? null,
        providerShipmentId: receipt.providerShipmentId ?? null,
        updatedAt: new Date(),
        resolvedAt: new Date(),
      })
      .where(eq(replacementLabelPurchaseIntents.id, claim.intent.id));

    // The frozen CUSTOMER money tuple, for the billing owner. Not a raw quote.
    await tx.update(shipments)
      .set({
        labelUrl: receipt.labelUrl ?? null,
        labelTracking: receipt.trackingNumber ?? null,
        trackingNumber: receipt.trackingNumber ?? null,
        labelCreatedAt: new Date(),
        // The shipments table names these  and , with selectedRateCost as
        // the normalized total. An earlier draft wrote a  column that does not
        // exist; the `as never` cast silenced the compiler and the integration suite caught
        // it. The cast is gone so the schema checks this.
        cost: String(receipt.shipmentCost),
        otherCost: String(receipt.otherCost),
        selectedRateCost: String(receipt.shipmentCost + receipt.otherCost),
      })
      .where(eq(shipments.id, claim.shipmentId));

    // Drift may have appeared WHILE the network call was in flight. The label is real and
    // paid for, so it is preserved: review, never discard, never repurchase.
    const drift = await findFrozenLineDrift(tx, replacement!);
    if (drift) {
      // DELEGATED to enterReplacementReview, the one writer of this move.
      //
      // THIS COPY CARRIED A LOST UPDATE. It matched on `eq(replacements.id, ...)` ALONE — no
      // expected status, no expected state_version, and no row-count check — while the two
      // other copies of the same write carried all three, and while the label_created branch
      // twenty lines below carries them against this very row. A transition landing between the
      // SELECT above and this write was silently overwritten, and the event was appended anyway,
      // describing a move from a status the row no longer held.
      //
      // The `before` row is the one SELECTed above under the order's advisory lock, so its
      // observed stateVersion is the same value the label_created branch already predicates on.
      // Nothing new had to be read to close this.
      //
      // Two things the shared writer does not do by default, passed explicitly rather than lost:
      // labelCreatedAt (this path DID earn a label, and review must not erase that it exists),
      // and the event's shipmentId (which shipment the retained label belongs to).
      //
      // The idempotency key gains the writer's `:v${stateVersion}` suffix. It stays unique per
      // intent and is strictly narrower; nothing has been released against the old shape, and a
      // replay cannot reach here twice anyway — the second attempt loses the predicate race.
      await enterReplacementReview(tx, replacement!, {
        reviewReason: 'original_order_line_drift',
        eventType: 'replacement_label_purchased_into_review',
        actor: input.actor,
        reason: 'the source line moved while the purchase was in flight; the label is retained',
        idempotencySuffix: `label-drift:${claim.intent.id}`,
        shipmentId: claim.shipmentId,
        extra: { labelCreatedAt: new Date() },
        // Matches the label_created branch below: on a lost race the whole persist transaction
        // rolls back, the intent stays unresolved, and the next dispatch is BLOCKED rather than
        // repurchasing. Both branches of one transaction must fail the same way.
        onConflict: () => new ReplacementLabelError(
          'REPLACEMENT_STATE_CONFLICT',
          `replacement ${replacement!.reference} moved while its purchased label was being ` +
            'recorded into review. The receipt is persisted; reconcile rather than repurchasing.',
        ),
      });
      return {
        intentId: claim.intent.id, shipmentId: claim.shipmentId, receipt, purchased: true,
      };
    }

    const moved = await tx.update(replacements)
      .set({
        status: 'label_created',
        labelCreatedAt: new Date(),
        stateVersion: replacement!.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(replacements.id, replacement!.id),
        eq(replacements.status, replacement!.status),
        eq(replacements.stateVersion, replacement!.stateVersion),
      ))
      .returning();
    if (moved.length === 0) {
      throw new ReplacementLabelError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${replacement!.reference} moved while its label was being recorded. The ` +
          'receipt is persisted; reconcile rather than repurchasing.',
      );
    }

    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement!.id,
      shipmentId: claim.shipmentId,
      eventType: 'replacement_label_created',
      fromStatus: replacement!.status,
      toStatus: 'label_created',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      idempotencyKey: `replacement:${replacement!.id}:label:${claim.intent.id}`,
    });

    return { intentId: claim.intent.id, shipmentId: claim.shipmentId, receipt, purchased: true };
  });
}
