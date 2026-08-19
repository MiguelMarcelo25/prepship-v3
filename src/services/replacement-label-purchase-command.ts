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
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { env } from '../lib/env.js';
import { loadClientCredentials } from '../lib/shipstation/credentials.js';
import { shipments, type Shipment } from '../db/schema/shipments';
import {
  replacementActivityEvents,
  replacementLabelPurchaseIntents,
  replacements,
  type ReplacementLabelPurchaseIntentRow,
  type ReplacementRow,
} from '../db/schema/replacements';
import { findFrozenLineDrift } from './replacement-drift-resolution';
import { enterReplacementReview } from './replacement-lifecycle-command';
import { freezeReplacementCustomerShippingMoney } from './customer-shipping-money';
import { resolveOutboundPackageSelection } from './package-consumption';
import {
  resolveReplacementPurchaseRequest,
  type ReplacementPurchaseInputs,
  type ResolvedPurchaseRequest,
} from './replacement-purchase-request';
import { isReplacementStatus, type ReplacementStatus } from './replacement-state-machine';
import { selectReplacementProviderCredentialAuthority } from './replacement-provider-credential-authority';

const REPLACEMENT_ORDER_LOCK_CLASS = 36423;

/** Purchasing, voiding, and reconciling replacement labels share one command capability. */
export const REPLACEMENT_LABEL_PERMISSION = 'replacements:label';

/** Only these may purchase. `label_failed` is the explicit recovery state. */
const PURCHASABLE_STATUSES: readonly ReplacementStatus[] = ['approved', 'label_failed'];

export type ReplacementLabelErrorCode =
  | 'REPLACEMENT_LABEL_FEATURE_DISABLED'
  | 'REPLACEMENT_LABEL_FORBIDDEN'
  | 'REPLACEMENT_NOT_FOUND'
  | 'REPLACEMENT_NOT_PURCHASABLE'
  | 'REPLACEMENT_STATE_CONFLICT'
  | 'REPLACEMENT_SOURCE_LINE_CHANGED'
  | 'REPLACEMENT_SHIPMENT_REQUIRED'
  | 'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH'
  | 'REPLACEMENT_SHIPMENT_REQUEST_MISMATCH'
  | 'REPLACEMENT_PACKAGE_UNRESOLVED'
  | 'REPLACEMENT_PROVIDER_CREDENTIAL_UNAVAILABLE'
  | 'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED'
  | 'REPLACEMENT_LABEL_RETRY_REASON_REQUIRED'
  | 'REPLACEMENT_LABEL_RETRY_ACTOR_REQUIRED'
  | 'REPLACEMENT_RECORDED_RECEIPT_INCOMPLETE'
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
  actor: {
    email: string | null;
    type: string;
    /** Optional in the DTO for compatibility; absence fails closed at the command boundary. */
    permissions?: readonly string[];
  };
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

export type RetryFailedReplacementLabelInput = PurchaseReplacementLabelInput & {
  expectedFailedIntentId: number;
  expectedPurchaseAttempt: number;
  retryReason: string;
};

export type RecordedReplacementLabelResult = {
  intentId: number;
  shipmentId: number;
  /** Current lifecycle state when the durable receipt was read. */
  status: string;
  receipt: ProviderLabelReceipt;
  /** False when another purchase/reconciliation already recorded the same fact. */
  recordedNow: boolean;
};

export type ReplacementLabelIntentSnapshot = {
  intentId: number;
  replacementId: number;
  shipmentId: number;
  providerIdempotencyKey: string;
  state: string;
  recorded: RecordedReplacementLabelResult | null;
};

type Conn = Pick<typeof db, 'transaction'>;

type ReplacementLabelContext = {
  intent: ReplacementLabelPurchaseIntentRow;
  replacement: ReplacementRow;
  shipment: Shipment;
};

function finiteReceiptMoney(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsedPositiveProviderShipmentId(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumericProviderShipmentId(value: unknown): number {
  const parsed = parsedPositiveProviderShipmentId(value);
  if (parsed == null) {
    throw new ReplacementLabelError(
      'REPLACEMENT_RECORDED_RECEIPT_INCOMPLETE',
      'the provider receipt has no positive numeric shipment identity; it cannot be bound to '
        + 'the shared shipment record safely',
      409,
    );
  }
  return parsed;
}

function durableReceiptFromContext(context: ReplacementLabelContext): ProviderLabelReceipt {
  const shipmentCost = finiteReceiptMoney(context.shipment.cost);
  const otherCost = finiteReceiptMoney(context.shipment.otherCost);
  const providerShipmentId = parsedPositiveProviderShipmentId(context.intent.providerShipmentId);
  if (
    context.intent.state !== 'purchased'
    || !context.intent.providerTransactionId
    || providerShipmentId == null
    || context.shipment.labelShipmentId !== providerShipmentId
    || context.shipment.voided
    || shipmentCost == null
    || otherCost == null
    || context.shipment.labelCreatedAt == null
    || context.replacement.labelCreatedAt == null
  ) {
    throw new ReplacementLabelError(
      'REPLACEMENT_RECORDED_RECEIPT_INCOMPLETE',
      `replacement ${context.replacement.reference} has a purchased intent without one complete `
        + 'durable shipment receipt. Reconcile it; never manufacture missing receipt values.',
      409,
      { intentId: context.intent.id, shipmentId: context.shipment.id },
    );
  }
  return {
    providerTransactionId: context.intent.providerTransactionId,
    providerLabelId: context.intent.providerLabelId,
    providerShipmentId: context.intent.providerShipmentId,
    trackingNumber: context.shipment.labelTracking ?? context.shipment.trackingNumber,
    labelUrl: context.shipment.labelUrl,
    shipmentCost,
    otherCost,
  };
}

/**
 * Lock and validate the one relational owner chain before touching a purchase intent.
 *
 * Per user override unlock shipped data on 2026-08-19: PS-502 reads and records only the
 * explicitly addressed replacement shipment. The authoritative intent relation supplies the
 * order lock; caller-provided ids are validation inputs, never lock or ownership authority.
 */
async function loadReplacementLabelContextInTransaction(
  tx: any,
  input: { intentId: number; replacementId?: number; shipmentId?: number },
): Promise<ReplacementLabelContext> {
  // Every path takes the order lock BEFORE the intent row lock/mutation. Derive it through the
  // intent itself so a mismatched caller cannot make us lock one order and mutate another.
  await tx.execute(sql`
    select pg_advisory_xact_lock(${REPLACEMENT_ORDER_LOCK_CLASS}, r.order_id)
    from replacement_label_purchase_intents i
    join replacements r on r.id = i.replacement_id
    where i.id = ${input.intentId}
  `);

  const [intent] = await tx.select().from(replacementLabelPurchaseIntents)
    .where(eq(replacementLabelPurchaseIntents.id, input.intentId))
    .limit(1)
    .for('update');
  if (!intent) {
    throw new ReplacementLabelError(
      'REPLACEMENT_NOT_FOUND', `purchase intent ${input.intentId} does not exist`, 404,
    );
  }

  const [replacement] = await tx.select().from(replacements)
    .where(eq(replacements.id, intent.replacementId)).limit(1);
  if (!replacement) {
    throw new ReplacementLabelError(
      'REPLACEMENT_NOT_FOUND', `replacement ${intent.replacementId} does not exist`, 404,
    );
  }
  if (intent.replacementShipmentId == null) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
      `purchase intent ${intent.id} has no replacement shipment`, 409,
      { intentId: intent.id, replacementId: replacement.id },
    );
  }

  const [shipment] = await tx.select().from(shipments)
    .where(eq(shipments.id, intent.replacementShipmentId)).limit(1);
  const ownershipMatches = shipment != null
    && (input.replacementId == null || input.replacementId === replacement.id)
    && (input.shipmentId == null || input.shipmentId === shipment.id)
    && replacement.replacementShipmentId === intent.replacementShipmentId
    && shipment.orderId === null
    && shipment.clientId === replacement.clientId
    && shipment.orderNumber === replacement.reference
    && shipment.source === 'replacement';
  if (!ownershipMatches) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
      `purchase intent ${intent.id}, replacement ${replacement.id}, and shipment `
        + `${intent.replacementShipmentId} do not form one replacement-owned chain`,
      409,
      {
        intentId: intent.id,
        expectedReplacementId: input.replacementId ?? null,
        actualReplacementId: replacement.id,
        expectedShipmentId: input.shipmentId ?? null,
        intentShipmentId: intent.replacementShipmentId,
        replacementShipmentId: replacement.replacementShipmentId,
      },
    );
  }

  return {
    intent: intent as ReplacementLabelPurchaseIntentRow,
    replacement: replacement as ReplacementRow,
    shipment: shipment as Shipment,
  };
}

function recordedResultFromContext(
  context: ReplacementLabelContext,
  recordedNow: boolean,
): RecordedReplacementLabelResult {
  return {
    intentId: context.intent.id,
    shipmentId: context.shipment.id,
    status: context.replacement.status,
    receipt: durableReceiptFromContext(context),
    recordedNow,
  };
}

/** Canonical read used by ordinary replay and provider-confirmed recovery losers. */
export async function readReplacementLabelIntentInTransaction(
  tx: any,
  input: { intentId: number; replacementId?: number; shipmentId?: number },
): Promise<ReplacementLabelIntentSnapshot> {
  const context = await loadReplacementLabelContextInTransaction(tx, input);
  return {
    intentId: context.intent.id,
    replacementId: context.replacement.id,
    shipmentId: context.shipment.id,
    providerIdempotencyKey: context.intent.providerIdempotencyKey,
    state: context.intent.state,
    recorded: context.intent.state === 'purchased'
      ? recordedResultFromContext(context, false)
      : null,
  };
}

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

async function resolveFrozenReplacementPurchaseRequest(
  tx: any,
  replacement: Pick<ReplacementRow, 'id' | 'clientId' | 'replacementShipmentId' | 'reference'>,
  purchaseInputs: PurchaseReplacementLabelInput['purchaseInputs'],
): Promise<ResolvedPurchaseRequest> {
  if (replacement.replacementShipmentId == null) {
    throw new ReplacementLabelError(
      'REPLACEMENT_SHIPMENT_REQUIRED',
      `replacement ${replacement.reference} has no attached shipment`,
    );
  }

  let credentials: Awaited<ReturnType<typeof loadClientCredentials>>;
  try {
    credentials = await loadClientCredentials(replacement.clientId, { conn: tx });
  } catch {
    throw new ReplacementLabelError(
      'REPLACEMENT_PROVIDER_CREDENTIAL_UNAVAILABLE',
      `replacement ${replacement.reference}'s ShipStation credential owner is unavailable; `
        + 'nothing was sent to the provider',
      409,
    );
  }
  const selected = selectReplacementProviderCredentialAuthority({
    requestedClientId: replacement.clientId,
    credentials,
    mainApiKeyV2: env.SHIPSTATION_API_KEY_V2,
  });
  if (!selected) {
    throw new ReplacementLabelError(
      'REPLACEMENT_PROVIDER_CREDENTIAL_UNAVAILABLE',
      `replacement ${replacement.reference} has no complete ShipStation V2 credential authority; `
        + 'nothing was sent to the provider',
      409,
    );
  }

  return resolveReplacementPurchaseRequest({
    ...purchaseInputs,
    replacementId: replacement.id,
    replacementShipmentId: replacement.replacementShipmentId,
    replacementReference: replacement.reference,
  }, selected.authority);
}

function frozenRealMatchesRequest(frozen: number | null, requested: number): boolean {
  return frozen != null
    && Number.isFinite(frozen)
    // `shipments` uses PostgreSQL REAL (float4). Compare its canonical float32 value rather
    // than rejecting a value such as 10.1 solely because the database rounded its binary form.
    && Math.fround(frozen) === Math.fround(requested);
}

function assertReplacementShipmentOwnsRequest(
  replacement: ReplacementRow,
  shipment: Shipment | undefined,
  request: ResolvedPurchaseRequest,
): asserts shipment is Shipment {
  const ownsReplacement = shipment != null
    && shipment.id === replacement.replacementShipmentId
    && shipment.source === 'replacement'
    && shipment.orderId === null
    && shipment.clientId === replacement.clientId
    && shipment.orderNumber === replacement.reference;
  if (!ownsReplacement) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
      `shipment ${replacement.replacementShipmentId} is not the dedicated shipment owned by `
        + `replacement ${replacement.reference}`,
      409,
      { replacementId: replacement.id, shipmentId: replacement.replacementShipmentId },
    );
  }

  const mismatchedFields: string[] = [];
  if (shipment.carrierCode !== request.carrier.carrierCode) mismatchedFields.push('carrierCode');
  if (shipment.serviceCode !== request.carrier.serviceCode) mismatchedFields.push('serviceCode');
  if (shipment.providerAccountId !== request.carrier.providerAccountId) {
    mismatchedFields.push('providerAccountId');
  }
  if (shipment.selectedPackageId !== request.package.packageId) {
    mismatchedFields.push('selectedPackageId');
  }
  if (!frozenRealMatchesRequest(shipment.weightOz, request.package.weightOz)) {
    mismatchedFields.push('weightOz');
  }
  if (!frozenRealMatchesRequest(shipment.dimsL, request.package.dimsL)) {
    mismatchedFields.push('dimsL');
  }
  if (!frozenRealMatchesRequest(shipment.dimsW, request.package.dimsW)) {
    mismatchedFields.push('dimsW');
  }
  if (!frozenRealMatchesRequest(shipment.dimsH, request.package.dimsH)) {
    mismatchedFields.push('dimsH');
  }
  if (mismatchedFields.length > 0) {
    throw new ReplacementLabelError(
      'REPLACEMENT_SHIPMENT_REQUEST_MISMATCH',
      `replacement ${replacement.reference}'s label request does not match its attached frozen `
        + `shipment (${mismatchedFields.join(', ')}). Nothing was sent to the provider.`,
      409,
      {
        replacementId: replacement.id,
        shipmentId: shipment.id,
        // Field names are enough to diagnose the conflict. Do not echo an address, account
        // value, or other provider request data through an error response.
        mismatchedFields,
      },
    );
  }
}

/** Phase 1. Everything that must be true before a provider is contacted. */
async function claimPurchase(
  input: PurchaseReplacementLabelInput,
  conn: Conn,
): Promise<
  | {
      replayed: true;
      intent: ReplacementLabelPurchaseIntentRow;
      recorded: RecordedReplacementLabelResult;
    }
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

    // Per user override unlock shipped data on 2026-08-19: the attached replacement shipment
    // is the operational carrier/package/money authority. Lock that exact row during the claim;
    // a fresh route body may never silently replace the snapshot an earlier request attached.
    const [shipment] = await tx.select().from(shipments)
      .where(eq(shipments.id, replacement.replacementShipmentId))
      .limit(1)
      .for('update');

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
    if (purchased) {
      const snapshot = await readReplacementLabelIntentInTransaction(tx, {
        intentId: purchased.id,
        replacementId: replacement.id,
        shipmentId: replacement.replacementShipmentId,
      });
      if (!snapshot.recorded) {
        throw new ReplacementLabelError(
          'REPLACEMENT_RECORDED_RECEIPT_INCOMPLETE',
          `replacement ${replacement.reference} is marked purchased without a durable receipt`,
          409,
          { intentId: purchased.id, shipmentId: replacement.replacementShipmentId },
        );
      }
      return {
        replayed: true,
        intent: purchased as ReplacementLabelPurchaseIntentRow,
        recorded: snapshot.recorded,
      };
    }

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

    const request = await resolveFrozenReplacementPurchaseRequest(
      tx,
      replacement as ReplacementRow,
      input.purchaseInputs,
    );

    // Resolve the local package-consumption authority before postage is at risk. ShipStation
    // deliberately receives its generic custom-package code plus these dimensions; packageId
    // is PrepShip's inventory reference and must resolve exactly the same way the atomic ship
    // consumer will resolve it. A typo/ambiguous code may not buy an unusable label first.
    const packageSelection = await resolveOutboundPackageSelection({
      selectedPackageId: request.package.packageId,
      dimensions: {
        length: request.package.dimsL,
        width: request.package.dimsW,
        height: request.package.dimsH,
      },
    }, tx);
    if (packageSelection.status !== 'matched') {
      throw new ReplacementLabelError(
        'REPLACEMENT_PACKAGE_UNRESOLVED',
        `replacement ${replacement.reference}'s package reference is not one exact consumable `
          + 'PrepShip package. Nothing was sent to the provider.',
        409,
        { reason: packageSelection.reason },
      );
    }

    const [failedAttempt] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'failed_pre_purchase'),
      ))
      .limit(1);
    if (failedAttempt) {
      const sameFrozenRequest = failedAttempt.replacementShipmentId === replacement.replacementShipmentId
        && failedAttempt.requestFingerprint === request.fingerprint;
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED',
        `replacement ${replacement.reference} already has a provider-refused purchase attempt. `
          + 'Starting another attempt requires an explicit audited generation owner; ordinary '
          + 'purchase replay never increments purchase_attempt or mints a new provider key.',
        409,
        {
          replacementId: replacement.id,
          shipmentId: replacement.replacementShipmentId,
          previousIntentId: failedAttempt.id,
          previousPurchaseAttempt: failedAttempt.purchaseAttempt,
          sameFrozenRequest,
        },
      );
    }
    assertReplacementShipmentOwnsRequest(replacement, shipment, request);

    // Generation 1 is the only ordinary purchase generation. A future explicit, audited
    // new-attempt command may own increments; this path must never infer one from changed input.
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
  // Only an explicit typed provider contract can prove no postage was bought. Free-form prose
  // such as "invalid JSON response" can describe a lost/malformed success after the provider
  // already committed; treating words as no-effect authority permits a duplicate purchase.
  if (code === 'PROVIDER_REJECTED') return 'failed_pre_purchase';
  return 'reconcile_required';
}

async function dispatchClaimedReplacementPurchase(
  input: Pick<PurchaseReplacementLabelInput, 'replacementId' | 'actor'>,
  claim: {
    intent: ReplacementLabelPurchaseIntentRow;
    request: ResolvedPurchaseRequest;
    shipmentId: number;
  },
  provider: ReplacementLabelProvider,
  conn: Conn,
): Promise<PurchaseReplacementLabelResult> {
  // ── Phase 2. No transaction, no lock. ──────────────────────────────────────
  let receipt: ProviderLabelReceipt;
  try {
    receipt = await provider.purchase({
      request: claim.request,
      idempotencyKey: claim.intent.providerIdempotencyKey,
    });
  } catch (error) {
    const state = classifyProviderFailure(error);
    // A stale provider failure may not downgrade a receipt that recovery already recorded.
    const winner = await conn.transaction(async (tx) => {
      const before = await readReplacementLabelIntentInTransaction(tx, {
        intentId: claim.intent.id,
        replacementId: input.replacementId,
        shipmentId: claim.shipmentId,
      });
      if (before.recorded) return before.recorded;
      if (before.state !== 'provider_pending' && before.state !== 'reconcile_required') return null;

      const [updated] = await tx.update(replacementLabelPurchaseIntents)
        .set({
          state,
          lastError: String((error as Error)?.message ?? error),
          lastErrorClass: state,
          reconciliationState: state === 'reconcile_required' ? 'unresolved' : null,
          updatedAt: new Date(),
          resolvedAt: state === 'failed_pre_purchase' ? new Date() : null,
        })
        .where(and(
          eq(replacementLabelPurchaseIntents.id, claim.intent.id),
          eq(replacementLabelPurchaseIntents.replacementId, input.replacementId),
          eq(replacementLabelPurchaseIntents.replacementShipmentId, claim.shipmentId),
          sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required')`,
        ))
        .returning({ id: replacementLabelPurchaseIntents.id });
      if (updated) return null;

      const after = await readReplacementLabelIntentInTransaction(tx, {
        intentId: claim.intent.id,
        replacementId: input.replacementId,
        shipmentId: claim.shipmentId,
      });
      return after.recorded;
    });
    if (winner) {
      return {
        intentId: winner.intentId,
        shipmentId: winner.shipmentId,
        purchased: false,
        receipt: winner.receipt,
      };
    }
    if (state === 'reconcile_required') {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
        'the provider outcome is unknown. The intent is held for reconciliation and will NOT '
          + 'be repurchased automatically — a retry after an unseen success buys a second label.',
        409,
        { intentId: claim.intent.id },
      );
    }
    throw error;
  }

  // ── Phase 3. Record what happened. ─────────────────────────────────────────
  return conn.transaction(async (tx) => {
    const recorded = await recordPurchasedReplacementLabelInTransaction(tx, {
      replacementId: input.replacementId,
      intentId: claim.intent.id,
      shipmentId: claim.shipmentId,
      receipt,
      actor: input.actor,
    });
    return {
      intentId: recorded.intentId,
      shipmentId: recorded.shipmentId,
      receipt: recorded.receipt,
      purchased: recorded.recordedNow,
    };
  });
}

export async function purchaseReplacementLabel(
  input: PurchaseReplacementLabelInput,
  provider: ReplacementLabelProvider,
  conn: Conn = db,
): Promise<PurchaseReplacementLabelResult> {
  // BEFORE any database mutation or provider access.
  assertReplacementLabelEnabled();
  if (!input.actor.permissions?.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_FORBIDDEN',
      `purchasing a replacement label requires ${REPLACEMENT_LABEL_PERMISSION}`,
      403,
    );
  }

  const claim = await claimPurchase(input, conn);
  if (claim.replayed) {
    return {
      intentId: claim.recorded.intentId,
      shipmentId: claim.recorded.shipmentId,
      purchased: false,
      receipt: claim.recorded.receipt,
    };
  }

  return dispatchClaimedReplacementPurchase(input, claim, provider, conn);
}

function retryChangedFields(
  previous: ResolvedPurchaseRequest,
  next: ResolvedPurchaseRequest,
): string[] {
  const changed: string[] = [];
  if (JSON.stringify(previous.address) !== JSON.stringify(next.address)) changed.push('address');
  if (previous.carrier.carrierCode !== next.carrier.carrierCode) changed.push('carrierCode');
  if (previous.carrier.serviceCode !== next.carrier.serviceCode) changed.push('serviceCode');
  if (previous.carrier.providerAccountId !== next.carrier.providerAccountId) {
    changed.push('providerAccountId');
  }
  if (previous.package.packageId !== next.package.packageId) changed.push('packageId');
  if (previous.package.weightOz !== next.package.weightOz) changed.push('weightOz');
  if (previous.package.dimsL !== next.package.dimsL) changed.push('dimsL');
  if (previous.package.dimsW !== next.package.dimsW) changed.push('dimsW');
  if (previous.package.dimsH !== next.package.dimsH) changed.push('dimsH');
  if (
    previous.providerCredentialAuthority?.scope
      !== next.providerCredentialAuthority?.scope
  ) changed.push('providerCredentialScope');
  if (
    previous.providerCredentialAuthority?.keyFingerprint
      !== next.providerCredentialAuthority?.keyFingerprint
  ) changed.push('providerCredentialFingerprint');
  return changed;
}

/**
 * Explicit, audited generation after a provider-certain no-purchase result.
 *
 * Ordinary purchase never increments a generation. This owner requires the exact failed
 * intent/attempt, a named actor and written reason; preserves the old intent; and may update
 * only an empty replacement shipment before committing the new durable intent.
 */
export async function retryFailedReplacementLabel(
  input: RetryFailedReplacementLabelInput,
  provider: ReplacementLabelProvider,
  conn: Conn = db,
): Promise<PurchaseReplacementLabelResult> {
  assertReplacementLabelEnabled();
  if (!input.actor.permissions?.includes(REPLACEMENT_LABEL_PERMISSION)) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_FORBIDDEN',
      `retrying a replacement label requires ${REPLACEMENT_LABEL_PERMISSION}`,
      403,
    );
  }
  const retryReason = typeof input.retryReason === 'string' ? input.retryReason.trim() : '';
  if (!retryReason) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_RETRY_REASON_REQUIRED',
      'a replacement-label retry requires a written reason and is audited',
      409,
    );
  }
  if (!input.actor.email) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_RETRY_ACTOR_REQUIRED',
      'a replacement-label retry requires a named actor',
      403,
    );
  }

  const claim = await conn.transaction(async (tx) => {
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
    const status = isReplacementStatus(replacement.status) ? replacement.status : null;
    if (!status || !PURCHASABLE_STATUSES.includes(status)) {
      throw new ReplacementLabelError(
        'REPLACEMENT_NOT_PURCHASABLE',
        `replacement ${replacement.reference} is ${replacement.status}; retry is not allowed`,
      );
    }
    if (replacement.replacementShipmentId == null) {
      throw new ReplacementLabelError(
        'REPLACEMENT_SHIPMENT_REQUIRED',
        `replacement ${replacement.reference} has no attached shipment`,
      );
    }

    const [failed] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.id, input.expectedFailedIntentId),
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
      ))
      .limit(1)
      .for('update');
    const certainNoEffect = failed?.state === 'failed_pre_purchase'
      && failed.resolvedAt != null
      && (
        failed.lastErrorClass === 'failed_pre_purchase'
        || failed.reconciliationState === 'resolved_not_purchased'
      );
    if (!failed || !certainNoEffect || failed.purchaseAttempt !== input.expectedPurchaseAttempt) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED',
        'the expected failed purchase intent/attempt is not provider-certain no-effect',
        409,
        {
          expectedFailedIntentId: input.expectedFailedIntentId,
          expectedPurchaseAttempt: input.expectedPurchaseAttempt,
        },
      );
    }
    if (failed.replacementShipmentId !== replacement.replacementShipmentId) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
        'the failed purchase intent is not attached to this replacement shipment',
      );
    }

    const [shipment] = await tx.select().from(shipments)
      .where(eq(shipments.id, replacement.replacementShipmentId))
      .limit(1)
      .for('update');
    if (!shipment) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
        'the replacement-owned shipment no longer exists',
      );
    }

    const [purchased] = await tx.select({ id: replacementLabelPurchaseIntents.id })
      .from(replacementLabelPurchaseIntents)
      .where(and(
        eq(replacementLabelPurchaseIntents.replacementId, replacement.id),
        eq(replacementLabelPurchaseIntents.state, 'purchased'),
      ))
      .limit(1);
    if (purchased) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED',
        'a purchased label already exists; a failed attempt cannot generate another',
      );
    }

    const request = await resolveFrozenReplacementPurchaseRequest(
      tx,
      replacement as ReplacementRow,
      input.purchaseInputs,
    );
    const packageSelection = await resolveOutboundPackageSelection({
      selectedPackageId: request.package.packageId,
      dimensions: {
        length: request.package.dimsL,
        width: request.package.dimsW,
        height: request.package.dimsH,
      },
    }, tx);
    if (packageSelection.status !== 'matched') {
      throw new ReplacementLabelError(
        'REPLACEMENT_PACKAGE_UNRESOLVED',
        'the retry package does not resolve to one consumable PrepShip package',
        409,
        { reason: packageSelection.reason },
      );
    }

    const previousRequest = failed.resolvedRequest as ResolvedPurchaseRequest | null;
    if (!previousRequest) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
        'the failed attempt has no frozen request to audit against',
      );
    }
    const nextAttempt = input.expectedPurchaseAttempt + 1;
    const providerIdempotencyKey = replacementProviderIdempotencyKey({
      replacementId: replacement.id,
      replacementShipmentId: replacement.replacementShipmentId,
      requestFingerprint: request.fingerprint,
      purchaseAttempt: nextAttempt,
    });

    // Stable replay of the exact explicit generation.
    const [existingNext] = await tx.select().from(replacementLabelPurchaseIntents)
      .where(eq(replacementLabelPurchaseIntents.providerIdempotencyKey, providerIdempotencyKey))
      .limit(1);
    if (existingNext) {
      if (existingNext.state === 'purchased') {
        const snapshot = await readReplacementLabelIntentInTransaction(tx, {
          intentId: existingNext.id,
          replacementId: replacement.id,
          shipmentId: replacement.replacementShipmentId,
        });
        if (!snapshot.recorded) {
          throw new ReplacementLabelError(
            'REPLACEMENT_RECORDED_RECEIPT_INCOMPLETE',
            'the generated attempt is purchased without one complete durable receipt',
          );
        }
        return { replayed: snapshot.recorded } as const;
      }
      if (existingNext.state === 'provider_pending' || existingNext.state === 'reconcile_required') {
        throw new ReplacementLabelError(
          'REPLACEMENT_LABEL_RECONCILE_REQUIRED',
          'the generated attempt has an unresolved provider outcome; reconcile it, never retry it',
          409,
          { intentId: existingNext.id },
        );
      }
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED',
        'the generated attempt already failed; target that newer failed intent explicitly',
        409,
        { intentId: existingNext.id, purchaseAttempt: existingNext.purchaseAttempt },
      );
    }

    const [latest] = await tx.select({ purchaseAttempt: replacementLabelPurchaseIntents.purchaseAttempt })
      .from(replacementLabelPurchaseIntents)
      .where(eq(replacementLabelPurchaseIntents.replacementId, replacement.id))
      .orderBy(sql`${replacementLabelPurchaseIntents.purchaseAttempt} desc`)
      .limit(1);
    if (!latest || latest.purchaseAttempt !== input.expectedPurchaseAttempt) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_ATTEMPT_GENERATION_REQUIRED',
        'the failed attempt is no longer the latest generation',
        409,
        { latestPurchaseAttempt: latest?.purchaseAttempt ?? null },
      );
    }

    const changedFields = retryChangedFields(previousRequest, request);
    const [updatedShipment] = await tx.update(shipments)
      .set({
        carrierCode: request.carrier.carrierCode,
        serviceCode: request.carrier.serviceCode,
        providerAccountId: request.carrier.providerAccountId,
        selectedPackageId: request.package.packageId,
        weightOz: request.package.weightOz,
        dimsL: request.package.dimsL,
        dimsW: request.package.dimsW,
        dimsH: request.package.dimsH,
        updatedAt: new Date(),
      })
      .where(and(
        eq(shipments.id, replacement.replacementShipmentId),
        isNull(shipments.orderId),
        replacement.clientId == null
          ? isNull(shipments.clientId)
          : eq(shipments.clientId, replacement.clientId),
        eq(shipments.orderNumber, replacement.reference),
        eq(shipments.source, 'replacement'),
        eq(shipments.voided, false),
        sql`${shipments.labelCreatedAt} is null`,
        sql`${shipments.labelShipmentId} is null`,
        sql`${shipments.shipDate} is null`,
        sql`${shipments.trackingNumber} is null`,
      ))
      .returning();
    if (!updatedShipment) {
      throw new ReplacementLabelError(
        'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
        'the replacement shipment is no longer empty and cannot be retargeted for a retry',
      );
    }
    assertReplacementShipmentOwnsRequest(replacement as ReplacementRow, updatedShipment as Shipment, request);

    const [intent] = await tx.insert(replacementLabelPurchaseIntents).values({
      replacementId: replacement.id,
      replacementShipmentId: replacement.replacementShipmentId,
      provider: request.carrier.carrierCode,
      providerIdempotencyKey,
      requestFingerprint: request.fingerprint,
      purchaseAttempt: nextAttempt,
      state: 'provider_pending',
      resolvedRequest: request as unknown as Record<string, unknown>,
    }).returning();
    if (!intent) {
      throw new ReplacementLabelError(
        'REPLACEMENT_STATE_CONFLICT',
        'the retry generation did not return a durable purchase intent',
      );
    }
    await tx.insert(replacementActivityEvents).values({
      replacementId: replacement.id,
      shipmentId: replacement.replacementShipmentId,
      eventType: 'replacement_label_purchase_retry_started',
      fromStatus: replacement.status,
      toStatus: replacement.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: JSON.stringify({
        reason: retryReason,
        failedIntentId: failed.id,
        previousPurchaseAttempt: failed.purchaseAttempt,
        newPurchaseAttempt: nextAttempt,
        changedFields,
      }),
      idempotencyKey: `replacement:${replacement.id}:label-retry:${intent.id}`,
    });
    return {
      replayed: null,
      intent: intent as ReplacementLabelPurchaseIntentRow,
      request,
      shipmentId: replacement.replacementShipmentId,
    } as const;
  });

  if (claim.replayed) {
    return {
      intentId: claim.replayed.intentId,
      shipmentId: claim.replayed.shipmentId,
      receipt: claim.replayed.receipt,
      purchased: false,
    };
  }
  return dispatchClaimedReplacementPurchase(input, claim, provider, conn);
}

/**
 * PS-502 — a purchased label becomes RECORDED state. One owner, two callers.
 *
 * ── WHY THIS IS SHARED ──────────────────────────────────────────────────────────────────
 *
 * The normal purchase reached this after dispatching to the provider. The RECOVERY path — a
 * purchase interrupted before its receipt was written, later confirmed by the provider — did
 * only the intent update and stopped. So a real, paid-for label existed while the replacement
 * sat at `approved` with a shipment carrying no tracking, no label URL and no cost: safely
 * blocked from buying a second label, and not recoverable to a shippable state either.
 *
 * Everything below is what "the label happened" MEANS — the intent receipt, the shipment
 * receipt, the drift that may have appeared while the network call was in flight, the guarded
 * transition, and exactly one event. Recovery owes every one of them, so it calls this rather
 * than reimplementing a subset and drifting from it.
 *
 * ── IDEMPOTENCY IS SHARED ON PURPOSE ────────────────────────────────────────────────────
 *
 * The activity event's key is `replacement:<id>:label:<intentId>` for both callers, because
 * they record the SAME fact about the same intent. Whichever arrives first wins and the other
 * cannot double-append.
 *
 * Per user override unlock shipped data on 2026-08-19: this recorder may update only the
 * validated replacement-owned shipment. It never touches the original order's lifecycle or
 * dispatches provider work, and every replay returns the already-durable receipt.
 */
export async function recordPurchasedReplacementLabelInTransaction(
  tx: any,
  input: {
    replacementId: number;
    intentId: number;
    shipmentId: number;
    receipt: ProviderLabelReceipt;
    actor: { email: string | null; type: string };
    reconciliation?: { reason: string };
  },
): Promise<RecordedReplacementLabelResult> {
  const receipt = input.receipt;
  const before = await loadReplacementLabelContextInTransaction(tx, input);
  if (before.intent.state === 'purchased') {
    return recordedResultFromContext(before, false);
  }
  if (before.intent.state !== 'provider_pending' && before.intent.state !== 'reconcile_required') {
    throw new ReplacementLabelError(
      'REPLACEMENT_STATE_CONFLICT',
      `purchase intent ${before.intent.id} is ${before.intent.state}; only an unresolved `
        + 'provider attempt can record a receipt',
      409,
      { intentId: before.intent.id, state: before.intent.state },
    );
  }

  const resolvedAt = new Date();
  const providerShipmentId = positiveNumericProviderShipmentId(receipt.providerShipmentId);
  const [claimed] = await tx.update(replacementLabelPurchaseIntents)
    .set({
      state: 'purchased',
      providerTransactionId: receipt.providerTransactionId,
      providerLabelId: receipt.providerLabelId ?? null,
      providerShipmentId: String(providerShipmentId),
      ...(input.reconciliation ? {
        reconciliationState: 'resolved_purchased',
        reconciledAt: resolvedAt,
      } : {}),
      updatedAt: resolvedAt,
      resolvedAt,
    })
    .where(and(
      eq(replacementLabelPurchaseIntents.id, input.intentId),
      eq(replacementLabelPurchaseIntents.replacementId, input.replacementId),
      eq(replacementLabelPurchaseIntents.replacementShipmentId, input.shipmentId),
      sql`${replacementLabelPurchaseIntents.state} in ('provider_pending', 'reconcile_required')`,
    ))
    .returning({ id: replacementLabelPurchaseIntents.id });

  if (!claimed) {
    const winner = await loadReplacementLabelContextInTransaction(tx, input);
    if (winner.intent.state === 'purchased') return recordedResultFromContext(winner, false);
    throw new ReplacementLabelError(
      'REPLACEMENT_STATE_CONFLICT',
      `purchase intent ${input.intentId} moved while its receipt was being recorded`,
      409,
      { intentId: input.intentId, state: winner.intent.state },
    );
  }

  if (input.reconciliation) {
    await tx.insert(replacementActivityEvents).values({
      replacementId: before.replacement.id,
      shipmentId: before.shipment.id,
      eventType: 'replacement_purchase_reconciled_found',
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: input.reconciliation.reason,
      idempotencyKey: `replacement:${before.replacement.id}:reconcile-found:${before.intent.id}`,
    });
  }

  // The CARRIER receipt. Not a customer-money tuple, and not a raw quote — see the docblock.
  const [recordedShipment] = await tx.update(shipments)
    .set({
      labelUrl: receipt.labelUrl ?? null,
      labelTracking: receipt.trackingNumber ?? null,
      trackingNumber: receipt.trackingNumber ?? null,
      labelCreatedAt: new Date(),
      // ShipStation shipment sync dedupes on this shared numeric identity. Keeping it only on
      // the replacement intent allows the same paid label to be imported as a second shipment
      // and package-consumed twice. Bind the provider identity and canonical label snapshot to
      // the exact replacement shipment in the receipt transaction.
      labelShipmentId: providerShipmentId,
      labelCarrier: before.shipment.carrierCode,
      labelService: before.shipment.serviceCode,
      labelProvider: before.shipment.providerAccountId,
      labelCost: String(receipt.shipmentCost),
      // The shipments table names these cost and otherCost, with selectedRateCost as the
      // normalized total. Keep the schema-owned names so TypeScript checks every receipt write.
      cost: String(receipt.shipmentCost),
      otherCost: String(receipt.otherCost),
      selectedRateCost: String(receipt.shipmentCost + receipt.otherCost),
    })
    .where(and(
      eq(shipments.id, input.shipmentId),
      isNull(shipments.orderId),
      before.replacement.clientId == null
        ? isNull(shipments.clientId)
        : eq(shipments.clientId, before.replacement.clientId),
      eq(shipments.orderNumber, before.replacement.reference),
      eq(shipments.source, 'replacement'),
      eq(shipments.voided, false),
      or(isNull(shipments.labelShipmentId), eq(shipments.labelShipmentId, providerShipmentId)),
    ))
    .returning({ id: shipments.id });
  if (!recordedShipment) {
    throw new ReplacementLabelError(
      'REPLACEMENT_LABEL_OWNERSHIP_MISMATCH',
      `shipment ${input.shipmentId} stopped belonging to replacement ${input.replacementId}`,
      409,
      { intentId: input.intentId, shipmentId: input.shipmentId },
    );
  }

  // ── AC-10. The CUSTOMER money, frozen in the same commit as the label. ──────────────
  //
  // Above is the CARRIER receipt. It is not what the client pays, and until now nothing
  // turned it into what the client pays — so the billing fence refused every replacement,
  // permanently and correctly.
  //
  // Frozen here rather than at billing time because a charge that moves after the goods
  // shipped is not a record of what happened: a markup edited next week must not change
  // what this label cost the client.
  //
  // A FAILURE HERE MUST NOT DISCARD THE RECEIPT. The label is real and already paid for.
  // Throwing would roll back the whole recording, and the same policy failure would repeat
  // on every reconciliation attempt — a paid label stuck forever. So it takes the same
  // treatment drift gets: keep the label, park the replacement for a human, name the reason.
  // Inside a SAVEPOINT, which is the only way this can be attempted-and-recovered. A failed
  // statement marks the whole PostgreSQL transaction aborted, so a plain try/catch here left
  // every subsequent write failing with "current transaction is aborted" — the recovery path
  // was itself unusable. tx.transaction() issues a savepoint, so a failure rolls back the
  // freeze alone and the receipt written above survives.
  let customerMoneyFrozen = true;
  try {
    await tx.transaction(async (sp: never) =>
      freezeReplacementCustomerShippingMoney(input.shipmentId, sp));
  } catch {
    customerMoneyFrozen = false;
  }

  // Phase 2 intentionally releases the order lock. AC-16 can place the replacement in review
  // while the provider is buying the label. The receipt remains real and is persisted above,
  // but neither a money-policy failure nor a later drift check may erase that newer hold by
  // promoting or reclassifying an arbitrary current status. Record the paid label while
  // preserving the blocking lifecycle state and its existing review reason.
  if (!PURCHASABLE_STATUSES.includes(before.replacement.status as ReplacementStatus)) {
    const heldAt = new Date();
    const held = await tx.update(replacements)
      .set({
        labelCreatedAt: heldAt,
        stateVersion: before.replacement.stateVersion + 1,
        updatedAt: heldAt,
      })
      .where(and(
        eq(replacements.id, before.replacement.id),
        eq(replacements.status, before.replacement.status),
        eq(replacements.stateVersion, before.replacement.stateVersion),
      ))
      .returning();
    if (held.length === 0) {
      throw new ReplacementLabelError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${before.replacement.reference} moved while its paid label was being `
          + 'recorded under a lifecycle hold. Reconcile it; never repurchase.',
      );
    }
    await tx.insert(replacementActivityEvents).values({
      replacementId: before.replacement.id,
      shipmentId: input.shipmentId,
      eventType: 'replacement_label_purchased_while_held',
      fromStatus: before.replacement.status,
      toStatus: before.replacement.status,
      actorType: input.actor.type,
      actorEmail: input.actor.email,
      detail: customerMoneyFrozen
        ? 'provider-confirmed postage was retained without clearing the current lifecycle hold'
        : 'provider-confirmed postage was retained under the current lifecycle hold; customer money also requires review',
      idempotencyKey: `replacement:${before.replacement.id}:label-held:${input.intentId}`,
    });
    const recorded = await loadReplacementLabelContextInTransaction(tx, input);
    return recordedResultFromContext(recorded, true);
  }

  if (!customerMoneyFrozen) {
    await enterReplacementReview(tx, before.replacement, {
      reviewReason: 'replacement_customer_money_unavailable',
      eventType: 'replacement_label_purchased_into_review',
      actor: input.actor,
      reason: 'the label was purchased but the client\'s customer-shipping policy could not price it; the label is retained',
      idempotencySuffix: `label-money:${input.intentId}`,
      shipmentId: input.shipmentId,
      extra: { labelCreatedAt: new Date() },
      onConflict: () => new ReplacementLabelError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${before.replacement.reference} moved while an unpriceable label was being `
          + 'recorded into review. The receipt is persisted; reconcile rather than repurchasing.',
      ),
    });
    const recorded = await loadReplacementLabelContextInTransaction(tx, input);
    return recordedResultFromContext(recorded, true);
  }

  // Drift may have appeared WHILE the network call was in flight. The label is real and
  // paid for, so it is preserved: review, never discard, never repurchase.
  const drift = await findFrozenLineDrift(tx, before.replacement);
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
    await enterReplacementReview(tx, before.replacement, {
      reviewReason: 'original_order_line_drift',
      eventType: 'replacement_label_purchased_into_review',
      actor: input.actor,
      reason: 'the source line moved while the purchase was in flight; the label is retained',
      idempotencySuffix: `label-drift:${input.intentId}`,
      shipmentId: input.shipmentId,
      extra: { labelCreatedAt: new Date() },
      // Matches the label_created branch below: on a lost race the whole persist transaction
      // rolls back, the intent stays unresolved, and the next dispatch is BLOCKED rather than
      // repurchasing. Both branches of one transaction must fail the same way.
      onConflict: () => new ReplacementLabelError(
        'REPLACEMENT_STATE_CONFLICT',
        `replacement ${before.replacement.reference} moved while its purchased label was being ` +
          'recorded into review. The receipt is persisted; reconcile rather than repurchasing.',
      ),
    });
    const recorded = await loadReplacementLabelContextInTransaction(tx, input);
    return recordedResultFromContext(recorded, true);
  }

  const moved = await tx.update(replacements)
    .set({
      status: 'label_created',
      labelCreatedAt: new Date(),
      stateVersion: before.replacement.stateVersion + 1,
      updatedAt: new Date(),
    })
    .where(and(
      eq(replacements.id, before.replacement.id),
      eq(replacements.status, before.replacement.status),
      eq(replacements.stateVersion, before.replacement.stateVersion),
    ))
    .returning();
  if (moved.length === 0) {
    throw new ReplacementLabelError(
      'REPLACEMENT_STATE_CONFLICT',
      `replacement ${before.replacement.reference} moved while its label was being recorded. The ` +
        'receipt is persisted; reconcile rather than repurchasing.',
    );
  }

  await tx.insert(replacementActivityEvents).values({
    replacementId: before.replacement.id,
    shipmentId: input.shipmentId,
    eventType: 'replacement_label_created',
    fromStatus: before.replacement.status,
    toStatus: 'label_created',
    actorType: input.actor.type,
    actorEmail: input.actor.email,
    // Shared with the recovery caller on purpose: the same fact about the same intent.
    idempotencyKey: `replacement:${before.replacement.id}:label:${input.intentId}`,
  });

  const recorded = await loadReplacementLabelContextInTransaction(tx, input);
  return recordedResultFromContext(recorded, true);
}
