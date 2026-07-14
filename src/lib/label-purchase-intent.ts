// Per user override unlock shipped data on 2026-07-13 (audit C2 / AUDIT-2026-07-13.md
// item 1.20): durable label PURCHASE-INTENT record.
//
// The crash window: createLabelV2 buys postage at the provider, then persists the
// shipment in a separate DB transaction. A worker killed between those two steps
// left postage spent with ZERO local record — and because recovery could only match
// a label through an existing shipments row, the automatic pg-boss redelivery
// repurchased the order outright. The 45-min lock TTL (audit C2 interim) makes that
// redelivery fail closed; THIS module makes the window airtight for any horizon:
//
//   1. An intent row is written BEFORE the provider call (state 'provider_pending').
//   2. The persist tail resolves it ('completed' + shipment id).
//   3. A buy error resolves it by classification: provably-pre-purchase failures
//      (4xx validation rejects, 429, circuit-open) -> 'failed_pre_purchase';
//      unknown outcomes (5xx, timeout, network, unknown connector errors) ->
//      'reconcile_required' — the label MAY exist at the provider.
//   4. A persist failure AFTER a successful buy -> 'reconcile_required' (the label
//      definitely exists and is unrecorded).
//   5. Every new purchase for the order first flips crashed 'provider_pending'
//      rows (possible only for a dead predecessor — the purchase lock serializes
//      live ones) to 'reconcile_required', then FAILS CLOSED with
//      LABEL_PURCHASE_RECONCILE_REQUIRED while any unresolved intent exists.
//      No automatic re-buy, ever. The operator resolves via the existing
//      recovery / PS-406 duplicate-label audit flow, then marks the intent.
//
// Table is deliberately additive and OUTSIDE the Drizzle schema index (same
// pattern as label_purchase_locks); mirrored on prod by migration
// audit_2026_07_13_label_purchase_intents.
import { sql } from '../db/client';
import { assertRuntimeSchemaReady } from '../services/runtime-schema-readiness.js';

export type LabelPurchaseIntentState =
  | 'provider_pending'
  | 'completed'
  | 'failed_pre_purchase'
  | 'reconcile_required'
  | 'resolved_by_operator';

export type UnresolvedLabelPurchaseIntent = {
  id: number;
  provider: string;
  state: string;
  error: string | null;
  createdAt: string;
};

export class LabelPurchaseReconcileRequiredError extends Error {
  readonly code = 'LABEL_PURCHASE_RECONCILE_REQUIRED' as const;
  constructor(
    orderId: number,
    public readonly intents: UnresolvedLabelPurchaseIntent[],
  ) {
    super(
      `Order ${orderId} has ${intents.length} unresolved label purchase attempt(s) ` +
        `(oldest ${intents[0]?.createdAt ?? 'unknown'}, provider ${intents[0]?.provider ?? 'unknown'}). ` +
        'A previous purchase may have bought a label that was never recorded locally — ' +
        'verify at the provider (recovery / duplicate-label audit) before buying again. ' +
        'No automatic repurchase will be attempted.',
    );
    this.name = 'LabelPurchaseReconcileRequiredError';
  }
}

export function isLabelPurchaseReconcileRequiredError(
  err: unknown,
): err is LabelPurchaseReconcileRequiredError {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'LABEL_PURCHASE_RECONCILE_REQUIRED'
  );
}

async function ensureLabelPurchaseIntentSchema(): Promise<void> {
  // Per user override unlock shipped data on 2026-07-14: migration 0062 owns
  // purchase-intent schema; purchase flow only verifies readiness before use.
  await assertRuntimeSchemaReady();
}

export async function createLabelPurchaseIntent(input: {
  orderId: number;
  provider: string;
  requestFingerprint?: string | null;
}): Promise<number> {
  await ensureLabelPurchaseIntentSchema();
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO label_purchase_intents (order_id, provider, request_fingerprint, state)
    VALUES (${input.orderId}, ${input.provider}, ${input.requestFingerprint ?? null}, 'provider_pending')
    RETURNING id
  `;
  return Number(rows[0]!.id);
}

export async function resolveLabelPurchaseIntent(
  intentId: number,
  input: { state: Exclude<LabelPurchaseIntentState, 'provider_pending'>; shipmentId?: number | null; error?: string | null },
): Promise<void> {
  await ensureLabelPurchaseIntentSchema();
  await sql`
    UPDATE label_purchase_intents
    SET state = ${input.state},
        shipment_id = coalesce(${input.shipmentId ?? null}, shipment_id),
        error = coalesce(${input.error ?? null}, error),
        updated_at = now()
    WHERE id = ${intentId}
  `;
}

/**
 * Classify a provider-call error for intent resolution. Conservative: anything
 * that cannot be PROVEN pre-purchase is treated as an unknown outcome.
 */
export function classifyBuyErrorForIntent(err: unknown): 'failed_pre_purchase' | 'reconcile_required' {
  const e = err as { name?: unknown; status?: unknown; code?: unknown } | null | undefined;
  // Circuit open: the request never left the process.
  if (!!e && String(e.code) === 'SHIPSTATION_CIRCUIT_OPEN') return 'failed_pre_purchase';
  if (!!e && e.name === 'ShipStationError') {
    const status = Number(e.status);
    // 4xx (including 429): ShipStation rejected the request without creating a
    // label. 5xx: the label may exist behind the gateway error (C1 made these
    // single-attempt for exactly that reason) — unknown outcome.
    if (Number.isFinite(status) && status >= 400 && status < 500) return 'failed_pre_purchase';
    return 'reconcile_required';
  }
  // Timeouts, aborts, network failures, and unknown direct-connector errors:
  // assume the worst. Operator friction on a genuine pre-purchase failure is
  // acceptable; a silent double-buy is not.
  return 'reconcile_required';
}

/**
 * Fail closed while any unresolved purchase intent exists for the order.
 * Caller MUST hold the order's purchase lock: under the lock, any
 * 'provider_pending' row belongs to a DEAD predecessor (crashed before
 * resolution) and is flipped to 'reconcile_required' here.
 */
export async function assertNoUnresolvedLabelPurchaseIntent(orderId: number): Promise<void> {
  await ensureLabelPurchaseIntentSchema();
  await sql`
    UPDATE label_purchase_intents
    SET state = 'reconcile_required',
        error = coalesce(error, 'process died between provider purchase and shipment persist'),
        updated_at = now()
    WHERE order_id = ${orderId}
      AND state = 'provider_pending'
  `;
  const unresolved = await sql<UnresolvedLabelPurchaseIntent[]>`
    SELECT id, provider, state, error, created_at::text AS "createdAt"
    FROM label_purchase_intents
    WHERE order_id = ${orderId}
      AND state = 'reconcile_required'
    ORDER BY created_at ASC
  `;
  if (unresolved.length > 0) {
    throw new LabelPurchaseReconcileRequiredError(orderId, unresolved);
  }
}
