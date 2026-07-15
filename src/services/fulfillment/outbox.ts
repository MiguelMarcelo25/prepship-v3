import { sql as pg } from '../../db/client.js';
import { hydrateMarketplaceConfirmationPayload } from './confirmation-payload.js';
import { loadClientCredentials } from '../../lib/shipstation/credentials.js';
import { resolveStoreConnector } from '../../connectors/store-resolution.js';
import { assertFulfillmentSchemaReady } from './schema-readiness.js';
// Per user override unlock shipped data on 2026-07-14: inventory events share
// only the durable retry lifecycle; confirmation/order state remains isolated.
import {
  INVENTORY_DEDUCTION_OUTBOX_EVENT,
  isInventoryDeductionOutboxEvent,
  processInventoryDeductionOutboxEvent,
} from './inventory-deduction-outbox.js';

type OrderForConfirmation = {
  id: number;
  externalOrderId: string | null;
  sourceProvider?: string | null;
  clientId: number | null;
  orderNumber: string | null;
  // PS-262a: the order's raw payload — the source of the per-marketplace confirmation
  // identity (eBay lineItems/ebayOrderId, Walmart purchaseOrderId, storeAccountId).
  raw?: Record<string, any> | null;
};

type EnqueueShipmentConfirmationInput = {
  order: OrderForConfirmation;
  shipmentId: number;
  trackingNumber: string | null;
  carrierCode: string | null;
  shipDate: string;
  confirmationProvider?: string | null;
  payload?: Record<string, unknown>;
};

type OutboxRow = {
  id: number;
  order_id: number;
  shipment_id: number | null;
  event_type: string;
  provider: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type SqlExecutor = any;

const MAX_ATTEMPTS = 6;
const DEFAULT_MISSING_CONFIRMATION_LOOKBACK_HOURS = 72;
// PS-253 (Card 8): a row is flipped to 'processing' when claimed; the worker is multi-process and
// restart/crash-prone, so if it dies between claim and complete/fail the row would stay 'processing'
// forever — never re-claimed — and the shipment is NEVER confirmed. A 'processing' row whose lease
// (updated_at age) exceeds this is treated as orphaned and reclaimed. A genuine confirm finishes in
// seconds, so a 15-min-stale 'processing' row is crashed, not running.
const OUTBOX_PROCESSING_LEASE_MINUTES = 15;

let schemaEnsured: Promise<void> | null = null;

// PS-136 (Per user override unlock shipped data on 2026-06-09): removed the unused exported
// type ShipmentConfirmationLifecycleStatus (0 repo-wide consumers). The live lifecycle status
// strings are used inline; the sibling ShipmentConfirmationLifecycleCandidate below stays (it
// IS consumed). Pure dead-type removal — no runtime/shipped-data behavior change.
export type ShipmentConfirmationLifecycleCandidate = {
  orderId: number;
  orderNumber: string | null;
  sourceProvider?: string | null;
  externalOrderId?: string | null;
  sourceOrderId?: string | null;
  clientId?: number | null;
  shipmentId: number | null;
  trackingNumber?: string | null;
  carrierCode?: string | null;
  shipDate?: string | Date | null;
  labelShipDate?: string | Date | null;
  labelShipmentId?: number | null;
  providerAccountId?: number | null;
  labelProvider?: number | null;
  confirmationStatus?: string | null;
  outboxExists?: boolean;
  outboxSucceeded?: boolean;
};

export type ShipmentConfirmationLifecyclePlan = {
  orderId: number;
  orderNumber: string | null;
  shipmentId: number | null;
  provider: string | null;
  upstreamOrderId: string | null;
  confirmationStatus: string | null;
  outboxExists: boolean;
  safeToBuyLabel: false;
  notifyMarketplace: boolean;
  plannedAction:
    | 'order_not_found'
    | 'no_active_shipment'
    | 'already_succeeded'
    | 'already_pending'
    | 'create_outbox_pending'
    | 'mark_not_supported'
    | 'mark_not_required'
    | 'mark_not_required_no_tracking';
  reason: string;
};

function textOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveIntegerText(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

export function inferStoreProvider(externalOrderId: string | null | undefined): string {
  if (!externalOrderId) return 'shipstation';
  const match = externalOrderId.match(/^([a-z_]+)-(.+)$/i);
  if (!match) return 'shipstation';
  const provider = match[1]?.toLowerCase() ?? 'shipstation';
  if (provider === 'walmart') return 'walmart';
  if (provider === 'ebay') return 'ebay';
  if (provider === 'amazon') return 'amazon';
  if (provider === 'shopify') return 'shopify';
  return provider;
}

function normalizeSourceProvider(value: string | null | undefined): string | null {
  const provider = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!provider || provider === 'unknown') return null;
  return provider;
}

function isNoMarketplaceProvider(provider: string | null): boolean {
  return provider != null && ['manual', 'manual_orders', 'internal', 'none', 'no_marketplace'].includes(provider);
}

function confirmationProviderForOrder(order: OrderForConfirmation): string | null {
  const sourceProvider = normalizeSourceProvider(order.sourceProvider);
  if (isNoMarketplaceProvider(sourceProvider)) return null;
  if (sourceProvider) return sourceProvider;
  if (!order.externalOrderId) return null;
  return inferStoreProvider(order.externalOrderId);
}

export function resolveShipmentConfirmationProvider(
  candidate: Pick<ShipmentConfirmationLifecycleCandidate, 'sourceProvider' | 'externalOrderId'>,
): string | null {
  const sourceProvider = normalizeSourceProvider(candidate.sourceProvider);
  if (isNoMarketplaceProvider(sourceProvider)) return null;
  if (sourceProvider && sourceProvider !== 'unknown') return sourceProvider;
  if (!candidate.externalOrderId) return null;
  return inferStoreProvider(candidate.externalOrderId);
}

function resolveShipmentConfirmationUpstreamOrderId(
  candidate: Pick<ShipmentConfirmationLifecycleCandidate, 'sourceProvider' | 'externalOrderId' | 'sourceOrderId'>,
  provider: string | null,
): string | null {
  if (provider === 'shipstation') {
    return positiveIntegerText(candidate.sourceOrderId) ?? positiveIntegerText(candidate.externalOrderId);
  }
  return textOrNull(candidate.sourceOrderId) ?? textOrNull(candidate.externalOrderId);
}

export function buildShipmentConfirmationLifecyclePlan(
  candidate: ShipmentConfirmationLifecycleCandidate,
): ShipmentConfirmationLifecyclePlan {
  const provider = resolveShipmentConfirmationProvider(candidate);
  const upstreamOrderId = resolveShipmentConfirmationUpstreamOrderId(candidate, provider);
  const confirmationStatus = textOrNull(candidate.confirmationStatus);
  const outboxExists = candidate.outboxExists === true;
  const base = {
    orderId: candidate.orderId,
    orderNumber: candidate.orderNumber,
    shipmentId: candidate.shipmentId,
    provider,
    upstreamOrderId,
    confirmationStatus,
    outboxExists,
    safeToBuyLabel: false as const,
    notifyMarketplace: provider != null && provider !== 'none',
  };

  if (!candidate.shipmentId) {
    return { ...base, plannedAction: 'no_active_shipment', reason: 'No active local label shipment exists to confirm.' };
  }
  if (confirmationStatus === 'succeeded' || candidate.outboxSucceeded === true) {
    return { ...base, plannedAction: 'already_succeeded', reason: 'Shipment confirmation already succeeded.' };
  }
  if (['pending', 'processing'].includes(confirmationStatus ?? '') || outboxExists) {
    return { ...base, plannedAction: 'already_pending', reason: 'Shipment confirmation lifecycle already exists.' };
  }
  if (!textOrNull(candidate.trackingNumber)) {
    return { ...base, plannedAction: 'mark_not_required_no_tracking', reason: 'Active local label has no tracking number to confirm.' };
  }
  if (!provider) {
    return { ...base, plannedAction: 'mark_not_required', reason: 'No marketplace/source confirmation is required for this shipment.' };
  }
  const resolvedStoreConnector = resolveStoreConnector(provider, 'shipment.confirm');
  if (!resolvedStoreConnector || resolvedStoreConnector.implementation.status !== 'live') {
    const reason = !resolvedStoreConnector
      ? `No shipment confirmation connector registered for ${provider}.`
      : `${provider} shipment confirmation connector is ${resolvedStoreConnector.implementation.status}.`;
    return { ...base, plannedAction: 'mark_not_supported', reason };
  }
  if (provider === 'shipstation' && !upstreamOrderId) {
    return {
      ...base,
      plannedAction: 'mark_not_supported',
      reason: 'ShipStation source order is missing a valid upstream ShipStation order id.',
    };
  }
  return {
    ...base,
    plannedAction: 'create_outbox_pending',
    reason: `Create fulfillment_outbox provider=${provider} and set shipment confirmation_status=pending.`,
  };
}

function sourceOrderId(externalOrderId: string | null | undefined): string | null {
  if (!externalOrderId) return null;
  const match = externalOrderId.match(/^[a-z_]+-(.+)$/i);
  return match?.[1] ?? externalOrderId;
}

export async function ensureFulfillmentSchema(): Promise<void> {
  schemaEnsured ??= (async () => {
    // Per user override unlock shipped data on 2026-05-23: remove
    // request-time shipment/outbox DDL and require migration-owned schema.
    await assertFulfillmentSchemaReady(pg);
  })().catch((error) => {
    // Per user override unlock shipped data on 2026-07-15: do not retain a
    // rejected wrapper memo after the canonical readiness owner resets. A
    // later worker tick can recover without a process restart.
    schemaEnsured = null;
    throw error;
  });

  return schemaEnsured;
}

export async function recordOrderSourceIfNeeded(order: OrderForConfirmation): Promise<void> {
  await ensureFulfillmentSchema();
  const provider = confirmationProviderForOrder(order) ?? 'none';
  await pg`
    UPDATE orders
    SET
      source_provider = COALESCE(source_provider, ${provider}),
      source_order_id = COALESCE(source_order_id, ${sourceOrderId(order.externalOrderId)}),
      source_order_number = COALESCE(source_order_number, ${order.orderNumber}),
      canonical_status = COALESCE(canonical_status, order_status),
      updated_at = NOW()
    WHERE id = ${order.id}
  `;
}

export async function markShipmentConfirmationState(args: {
  shipmentId: number;
  carrierProvider: string;
  carrierAccountId?: string | number | null;
  confirmationProvider: string;
  status: 'not_required' | 'not_supported' | 'pending' | 'processing' | 'succeeded' | 'failed';
  attempts?: number;
  lastError?: string | null;
}, executor: SqlExecutor = pg): Promise<void> {
  await ensureFulfillmentSchema();
  await executor`
    UPDATE shipments
    SET
      carrier_provider = ${args.carrierProvider},
      carrier_account_id = ${args.carrierAccountId == null ? null : String(args.carrierAccountId)},
      confirmation_provider = ${args.confirmationProvider},
      confirmation_status = ${args.status},
      confirmation_attempts = COALESCE(${args.attempts ?? null}, confirmation_attempts),
      confirmation_last_error = ${args.lastError ?? null},
      marketplace_confirmed_at = CASE WHEN ${args.status} = 'succeeded' THEN NOW() ELSE marketplace_confirmed_at END,
      updated_at = NOW()
    WHERE id = ${args.shipmentId}
  `;
}

/**
 * PS-263 (Per user override unlock shipped data on 2026-06-14) — retract a marketplace
 * shipment confirmation when its label is voided.
 *
 * Before this, voidLabelV2 voided the carrier label and reset the order to
 * awaiting_shipment but never touched fulfillment_outbox or shipments.confirmation_status.
 * So a still-pending confirmation could fire AFTER the void (acking the marketplace with a
 * now-dead/voided tracking number), and a re-labeled order enqueued a SECOND confirmation
 * with a different number — a double-confirm with conflicting tracking.
 *
 * This is the single owner that honors a void everywhere a confirmation can still
 * originate. It is BEST-EFFORT: callers wrap it in try/catch — the local void already
 * happened and must never be undone by a retract miss. It touches NO carrier postage,
 * label, or print state and never re-acks a marketplace (it only stops a pending ack and
 * records the lifecycle for reporting).
 */
export async function cancelShipmentConfirmationsForVoid(args: {
  orderId: number | null;
  shipmentId: number;
}): Promise<{ cancelledQueued: number; alreadyConfirmed: boolean }> {
  await ensureFulfillmentSchema();
  const { orderId, shipmentId } = args;

  // 1) Was THIS shipment already confirmed to the marketplace? Read its own lifecycle
  //    BEFORE we restamp it — that is the precise per-shipment signal.
  const [ship] = (await pg`
    SELECT confirmation_status, marketplace_confirmed_at
    FROM shipments WHERE id = ${shipmentId} LIMIT 1
  `) as Array<{ confirmation_status: string | null; marketplace_confirmed_at: string | null }>;
  const alreadyConfirmed =
    ship?.confirmation_status === 'succeeded' || ship?.marketplace_confirmed_at != null;

  // 2) Stop every not-yet-succeeded confirmation from ever firing. claimDueOutboxRows /
  //    claimOutboxRowById only select status IN ('pending','failed'), so flipping these to
  //    'cancelled' (and next_run_at='infinity') makes them permanently unclaimable. A
  //    succeeded row is left intact — it is confirmation history, not a pending send.
  const cancelled = (await pg`
    UPDATE fulfillment_outbox
    SET status = 'cancelled', next_run_at = 'infinity', updated_at = NOW()
    WHERE event_type = 'shipment_confirmation_requested'
      AND status <> 'succeeded'
      AND ${orderId != null ? pg`order_id = ${orderId}` : pg`shipment_id = ${shipmentId}`}
    RETURNING id
  `) as Array<{ id: number }>;

  // 3) Stamp the voided shipment's confirmation lifecycle:
  //      already confirmed → 'void_retract_pending' (the marketplace still holds the dead
  //        tracking; this surfaces in reporting, and a re-label's fresh enqueue re-confirms
  //        with the correct number);
  //      otherwise → 'cancelled' (the pending send we just stopped never fired).
  //    Either non-null value also keeps the missing-confirmation recovery sweep (which
  //    requires confirmation_status IS NULL) from re-enqueuing this voided shipment.
  await pg`
    UPDATE shipments
    SET confirmation_status = ${alreadyConfirmed ? 'void_retract_pending' : 'cancelled'},
        updated_at = NOW()
    WHERE id = ${shipmentId}
  `;

  return { cancelledQueued: cancelled.length, alreadyConfirmed };
}

export async function enqueueShipmentConfirmation(
  input: EnqueueShipmentConfirmationInput,
): Promise<{ queued: boolean; provider: string; outboxId?: number }> {
  await ensureFulfillmentSchema();
  await recordOrderSourceIfNeeded(input.order);

  if (!input.trackingNumber) {
    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: 'unknown',
      confirmationProvider: 'none',
      status: 'not_required',
      lastError: 'No tracking number returned with label',
    });
    return { queued: false, provider: 'none' };
  }

  const provider = input.confirmationProvider ?? confirmationProviderForOrder(input.order);
  if (!provider) {
    // Per user override unlock shipped data on 2026-06-01: shipped labels
    // without a marketplace/source connector must receive an explicit terminal
    // confirmation state, not stay NULL.
    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: String(input.payload?.carrierProvider ?? 'unknown'),
      carrierAccountId: input.payload?.carrierAccountId as string | number | null | undefined,
      confirmationProvider: 'none',
      status: 'not_required',
      lastError: 'No marketplace/source confirmation required for this shipment',
    });
    return { queued: false, provider: 'none' };
  }
  const resolvedStoreConnector = resolveStoreConnector(provider, 'shipment.confirm');
  if (!resolvedStoreConnector || resolvedStoreConnector.implementation.status !== 'live') {
    const reason = !resolvedStoreConnector
      ? `No shipment confirmation connector registered for ${provider}`
      : `${provider} shipment confirmation connector is ${resolvedStoreConnector.implementation.status}`;
    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: String(input.payload?.carrierProvider ?? 'unknown'),
      carrierAccountId: input.payload?.carrierAccountId as string | number | null | undefined,
      confirmationProvider: provider,
      status: 'not_supported',
      lastError: reason,
    });
    return { queued: false, provider };
  }

  const payload = {
    ...input.payload,
    orderId: input.order.id,
    shipmentId: input.shipmentId,
    externalOrderId: input.order.externalOrderId,
    clientId: input.order.clientId,
    orderNumber: input.order.orderNumber,
    trackingNumber: input.trackingNumber,
    carrierCode: input.carrierCode,
    shipDate: input.shipDate,
  };
  const dedupeKey = `shipment_confirmation_requested:${provider}:${input.order.id}:${input.shipmentId}`;
  // Per user override unlock shipped data on 2026-07-15: enqueue and lifecycle
  // projection are one transaction. Re-enqueue never regresses a succeeded
  // outbox/shipment/order back to pending; it reconverges all three surfaces
  // through the same settlement owner used by the worker.
  return pg.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO fulfillment_outbox (
        order_id, shipment_id, event_type, provider, dedupe_key, payload,
        status, attempts, next_run_at, updated_at
      )
      VALUES (
        ${input.order.id}, ${input.shipmentId}, 'shipment_confirmation_requested',
        ${provider}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb, 'pending', 0, NOW(), NOW()
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        payload = CASE
          WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.payload
          ELSE EXCLUDED.payload
        END,
        status = CASE
          WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.status
          ELSE 'pending'
        END,
        next_run_at = CASE
          WHEN fulfillment_outbox.status = 'succeeded' THEN fulfillment_outbox.next_run_at
          ELSE NOW()
        END,
        updated_at = NOW()
      RETURNING id, order_id, shipment_id, event_type, provider, payload, attempts, status
    ` as Array<OutboxRow & { status: string }>;
    const row = rows[0];
    if (!row) throw new Error('Shipment confirmation enqueue returned no outbox row');

    if (row.status === 'succeeded') {
      await settleOutboxRowWithExecutor(row, tx);
      return { queued: false, provider, outboxId: row.id };
    }

    await markShipmentConfirmationState({
      shipmentId: input.shipmentId,
      carrierProvider: String(input.payload?.carrierProvider ?? 'shipstation'),
      carrierAccountId: input.payload?.carrierAccountId as string | number | null | undefined,
      confirmationProvider: provider,
      status: 'pending',
    }, tx);
    await tx`
      UPDATE orders
      SET canonical_status = 'shipped_pending_confirmation', updated_at = NOW()
      WHERE id = ${input.order.id}
    `;
    return { queued: true, provider, outboxId: row.id };
  });
}

type MissingShipmentConfirmationRow = {
  order_id: number;
  external_order_id: string | null;
  source_provider: string | null;
  client_id: number | null;
  order_number: string | null;
  shipment_id: number;
  tracking_number: string | null;
  carrier_code: string | null;
  ship_date: string | Date | null;
  label_ship_date: string | Date | null;
  label_shipment_id: number | null;
  provider_account_id: number | null;
  label_provider: number | null;
};

function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function confirmationProviderForMissingShipment(row: MissingShipmentConfirmationRow): string | null {
  const sourceProvider = normalizeSourceProvider(row.source_provider);
  if (isNoMarketplaceProvider(sourceProvider)) return null;
  if (sourceProvider && sourceProvider !== 'unknown') return sourceProvider;
  if (!row.external_order_id) return null;
  return inferStoreProvider(row.external_order_id);
}

export async function enqueueMissingShipmentConfirmations(options: {
  limit?: number;
  maxAgeHours?: number;
  orderId?: number;
  shipmentId?: number;
} = {}): Promise<{ scanned: number; enqueued: number; failed: number }> {
  await ensureFulfillmentSchema();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const maxAgeHours = Math.max(
    1,
    Math.min(24 * 14, Math.trunc(options.maxAgeHours ?? DEFAULT_MISSING_CONFIRMATION_LOOKBACK_HOURS)),
  );

  // Per user override unlock shipped data on 2026-05-23: automatically recover
  // shipped PrepShip labels that missed the confirmation enqueue step. This
  // creates only fulfillment_outbox work for existing non-voided labels; it
  // never creates/voids labels or rewrites shipment history.
  const rows = await pg`
    SELECT
      o.id AS order_id,
      o.external_order_id,
      o.source_provider,
      o.client_id,
      o.order_number,
      s.id AS shipment_id,
      s.tracking_number,
      s.carrier_code,
      s.ship_date,
      s.label_ship_date,
      s.label_shipment_id,
      s.provider_account_id,
      s.label_provider
    FROM shipments s
    INNER JOIN orders o ON o.id = s.order_id
    WHERE o.order_status = 'shipped'
      AND coalesce(s.voided, false) = false
      AND coalesce(s.is_return, false) = false
      -- Per user override unlock shipped data on 2026-07-13 (audit C3): only
      -- PrepShip-created labels may be confirmation-recovered. PS-286 label-URL
      -- enrichment also fills label_url on ShipStation-SYNCED rows (source
      -- 'shipstation'), which broke this sweep's founding assumption that
      -- "label_url means we made it" and re-notified marketplaces for orders
      -- ShipStation itself shipped (duplicate buyer emails). Allowlist (fail
      -- closed): ShipStation buys persist source 'prepship_v2' (legacy
      -- 'prepship'), direct carriers persist their provider key, tests persist
      -- 'test_offline' (src/services/labels.ts:2285). A NEW direct-carrier
      -- provider key must be added here to get confirmation recovery.
      AND s.source IN ('prepship', 'prepship_v2', 'shipp', 'walmart_shipping', 'test_offline')
      AND s.label_url IS NOT NULL
      AND nullif(trim(coalesce(s.tracking_number, '')), '') IS NOT NULL
      AND s.confirmation_status IS NULL
      AND s.created_at >= NOW() - (${maxAgeHours} || ' hours')::interval
      ${options.orderId ? pg`AND o.id = ${options.orderId}` : pg``}
      ${options.shipmentId ? pg`AND s.id = ${options.shipmentId}` : pg``}
      AND NOT EXISTS (
        SELECT 1
        FROM fulfillment_outbox fo
        WHERE fo.event_type = 'shipment_confirmation_requested'
          AND (
            fo.shipment_id = s.id
            OR (fo.order_id = o.id AND fo.status IN ('pending', 'processing', 'succeeded'))
          )
      )
    ORDER BY s.created_at ASC
    LIMIT ${limit}
  ` as MissingShipmentConfirmationRow[];

  let enqueued = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const confirmationProvider = confirmationProviderForMissingShipment(row);
      if (!confirmationProvider) {
        // Per user override unlock shipped data on 2026-06-01: recovery marks
        // manual/internal shipped labels as not_required instead of mutating
        // label, postage, print, or marketplace state.
        await markShipmentConfirmationState({
          shipmentId: row.shipment_id,
          carrierProvider: String(row.label_provider ?? 'unknown'),
          carrierAccountId: row.provider_account_id ?? row.label_provider ?? null,
          confirmationProvider: 'none',
          status: 'not_required',
          lastError: 'No marketplace/source confirmation required for manual/internal shipment',
        });
        continue;
      }
      const result = await enqueueShipmentConfirmation({
        order: {
          id: row.order_id,
          externalOrderId: row.external_order_id,
          sourceProvider: row.source_provider,
          clientId: row.client_id,
          orderNumber: row.order_number,
        },
        shipmentId: row.shipment_id,
        trackingNumber: row.tracking_number,
        carrierCode: row.carrier_code,
        shipDate: dateOnly(row.ship_date ?? row.label_ship_date),
        confirmationProvider,
        payload: {
          carrierProvider: row.label_provider ?? confirmationProvider,
          carrierAccountId: row.provider_account_id ?? row.label_provider ?? null,
          shipStationShipmentId: row.label_shipment_id,
          notifyCustomer: false,
          notifyMarketplace: true,
          autoRecoveredMissingConfirmation: true,
        },
      });
      if (result.queued) enqueued += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[fulfillment-outbox] auto-enqueue missing confirmation failed orderId=${row.order_id} shipmentId=${row.shipment_id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { scanned: rows.length, enqueued, failed };
}

type ShipmentConfirmationLifecycleRow = {
  order_id: number;
  order_number: string | null;
  external_order_id: string | null;
  source_order_id: string | null;
  source_provider: string | null;
  client_id: number | null;
  shipment_id: number | null;
  tracking_number: string | null;
  carrier_code: string | null;
  ship_date: string | Date | null;
  label_ship_date: string | Date | null;
  label_shipment_id: number | null;
  provider_account_id: number | null;
  label_provider: number | null;
  confirmation_status: string | null;
  outbox_exists: boolean;
  outbox_succeeded: boolean;
};

export type EnsureShipmentConfirmationLifecycleResult = {
  ok: boolean;
  mode: 'dry_run' | 'apply';
  plan: ShipmentConfirmationLifecyclePlan;
  queued: boolean;
  outboxId?: number;
  processed?: { processed: number; succeeded: number; failed: number };
};

function rowToLifecycleCandidate(row: ShipmentConfirmationLifecycleRow): ShipmentConfirmationLifecycleCandidate {
  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    sourceProvider: row.source_provider,
    externalOrderId: row.external_order_id,
    sourceOrderId: row.source_order_id,
    clientId: row.client_id,
    shipmentId: row.shipment_id,
    trackingNumber: row.tracking_number,
    carrierCode: row.carrier_code,
    shipDate: row.ship_date,
    labelShipDate: row.label_ship_date,
    labelShipmentId: row.label_shipment_id,
    providerAccountId: row.provider_account_id,
    labelProvider: row.label_provider,
    confirmationStatus: row.confirmation_status,
    outboxExists: row.outbox_exists,
    outboxSucceeded: row.outbox_succeeded,
  };
}

async function loadShipmentConfirmationLifecycleRow(options: {
  orderId?: number;
  orderNumber?: string;
  shipmentId?: number;
}): Promise<ShipmentConfirmationLifecycleRow | null> {
  const orderNumber = textOrNull(options.orderNumber);
  const rows = await pg`
    SELECT
      o.id AS order_id,
      o.order_number,
      o.external_order_id,
      o.source_order_id,
      o.source_provider,
      o.client_id,
      s.id AS shipment_id,
      s.tracking_number,
      s.carrier_code,
      s.ship_date,
      s.label_ship_date,
      s.label_shipment_id,
      s.provider_account_id,
      s.label_provider,
      s.confirmation_status,
      EXISTS (
        SELECT 1
        FROM fulfillment_outbox fo
        WHERE fo.event_type = 'shipment_confirmation_requested'
          AND (
            fo.shipment_id = s.id
            OR (fo.order_id = o.id AND fo.status IN ('pending', 'processing', 'succeeded'))
          )
      ) AS outbox_exists,
      EXISTS (
        SELECT 1
        FROM fulfillment_outbox fo
        WHERE fo.event_type = 'shipment_confirmation_requested'
          AND fo.status = 'succeeded'
          AND (
            fo.shipment_id = s.id
            OR fo.order_id = o.id
          )
      ) AS outbox_succeeded
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT *
      FROM shipments s
      WHERE s.order_id = o.id
        AND coalesce(s.voided, false) = false
        AND coalesce(s.is_return, false) = false
        AND s.label_url IS NOT NULL
        ${options.shipmentId ? pg`AND s.id = ${options.shipmentId}` : pg``}
      ORDER BY s.id DESC
      LIMIT 1
    ) s ON TRUE
    WHERE
      ${options.orderId ? pg`o.id = ${options.orderId}` : pg`FALSE`}
      ${orderNumber ? pg`OR o.order_number = ${orderNumber}` : pg``}
    ORDER BY o.id DESC
    LIMIT 1
  ` as ShipmentConfirmationLifecycleRow[];
  return rows[0] ?? null;
}

export async function ensureShipmentConfirmationLifecycle(options: {
  orderId?: number;
  orderNumber?: string;
  shipmentId?: number;
  dryRun?: boolean;
  processNow?: boolean;
}): Promise<EnsureShipmentConfirmationLifecycleResult> {
  await ensureFulfillmentSchema();
  const row = await loadShipmentConfirmationLifecycleRow(options);
  if (!row) {
    const plan: ShipmentConfirmationLifecyclePlan = {
      orderId: options.orderId ?? 0,
      orderNumber: options.orderNumber ?? null,
      shipmentId: options.shipmentId ?? null,
      provider: null,
      upstreamOrderId: null,
      confirmationStatus: null,
      outboxExists: false,
      safeToBuyLabel: false,
      notifyMarketplace: false,
      plannedAction: 'order_not_found',
      reason: 'Order was not found.',
    };
    return { ok: false, mode: options.dryRun === false ? 'apply' : 'dry_run', plan, queued: false };
  }

  const candidate = rowToLifecycleCandidate(row);
  const plan = buildShipmentConfirmationLifecyclePlan(candidate);
  const mode = options.dryRun === false ? 'apply' : 'dry_run';
  if (mode === 'dry_run') {
    return { ok: plan.plannedAction !== 'order_not_found', mode, plan, queued: false };
  }

  if (!row.shipment_id) {
    return { ok: false, mode, plan, queued: false };
  }

  // Per user override unlock shipped data on 2026-06-01: PS-064 repair writes
  // only shipment confirmation/outbox metadata for an existing active label.
  // It never creates labels, buys postage, voids labels, or rewrites shipment history.
  if (plan.plannedAction === 'mark_not_required' || plan.plannedAction === 'mark_not_required_no_tracking') {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.label_provider ?? 'unknown'),
      carrierAccountId: row.provider_account_id ?? row.label_provider ?? null,
      confirmationProvider: 'none',
      status: 'not_required',
      lastError: plan.reason,
    });
    return { ok: true, mode, plan, queued: false };
  }

  if (plan.plannedAction === 'mark_not_supported') {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.label_provider ?? plan.provider ?? 'unknown'),
      carrierAccountId: row.provider_account_id ?? row.label_provider ?? null,
      confirmationProvider: plan.provider ?? 'unknown',
      status: 'not_supported',
      lastError: plan.reason,
    });
    return { ok: true, mode, plan, queued: false };
  }

  if (plan.plannedAction !== 'create_outbox_pending') {
    return { ok: true, mode, plan, queued: false };
  }

  const enqueueResult = await enqueueShipmentConfirmation({
    order: {
      id: row.order_id,
      externalOrderId: plan.provider === 'shipstation' ? plan.upstreamOrderId : row.external_order_id,
      sourceProvider: row.source_provider,
      clientId: row.client_id,
      orderNumber: row.order_number,
    },
    shipmentId: row.shipment_id,
    trackingNumber: row.tracking_number,
    carrierCode: row.carrier_code,
    shipDate: dateOnly(row.ship_date ?? row.label_ship_date),
    confirmationProvider: plan.provider,
    payload: {
      carrierProvider: row.label_provider ?? plan.provider,
      carrierAccountId: row.provider_account_id ?? row.label_provider ?? null,
      shipStationShipmentId: row.label_shipment_id,
      sourceOrderId: row.source_order_id,
      upstreamOrderId: plan.upstreamOrderId,
      notifyCustomer: false,
      notifyMarketplace: true,
      ps064ConfirmationLifecycleRepair: true,
    },
  });

  let processed: EnsureShipmentConfirmationLifecycleResult['processed'];
  if (options.processNow === true) {
    processed = await processFulfillmentOutboxOnce({ orderId: row.order_id, limit: 5 });
  }

  return {
    ok: true,
    mode,
    plan,
    queued: enqueueResult.queued,
    outboxId: enqueueResult.outboxId,
    processed,
  };
}

async function loadStoreCredentials(provider: string, payload: Record<string, unknown>, clientId: number | null): Promise<Record<string, string | null | undefined>> {
  if (provider === 'shipstation') {
    const creds = await loadClientCredentials(clientId);
    return {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiKeyV2: creds.apiKeyV2,
    };
  }

  if (provider !== 'walmart' && provider !== 'ebay' && provider !== 'shopify') return {};

  const explicitId = Number(payload.storeAccountId ?? payload.sourceAccountId ?? payload.marketplaceAccountId ?? payload.carrierAccountId);
  let accountId = Number.isFinite(explicitId) && explicitId > 0 ? Math.trunc(explicitId) : null;
  const marketplaceOrderId = String(
    provider === 'walmart'
      ? payload.purchaseOrderId ?? ''
      : provider === 'shopify'
        ? payload.shopifyOrderId ?? payload.sourceOrderId ?? sourceOrderId(String(payload.externalOrderId ?? '')) ?? ''
        : payload.ebayOrderId ?? sourceOrderId(String(payload.externalOrderId ?? '')) ?? '',
  ).trim();
  if (!accountId && marketplaceOrderId) {
    const rows = await pg`
      SELECT carrier_account_id
      FROM store_orders
      WHERE provider = ${provider} AND external_order_id = ${marketplaceOrderId}
      LIMIT 1
    ` as Array<{ carrier_account_id: number | null }>;
    accountId = rows[0]?.carrier_account_id ?? null;
  }
  if (!accountId) return {};

  const storeRows = await pg`
    SELECT credentials FROM store_accounts WHERE id = ${accountId} LIMIT 1
  `.catch(() => []) as Array<{ credentials: Record<string, string | null | undefined> }>;
  if (storeRows[0]?.credentials) return storeRows[0].credentials;

  const carrierRows = await pg`
    SELECT credentials FROM carrier_accounts WHERE id = ${accountId} LIMIT 1
  `.catch(() => []) as Array<{ credentials: Record<string, string | null | undefined> }>;
  return carrierRows[0]?.credentials ?? {};
}

async function claimDueOutboxRows(limit: number, orderId?: number): Promise<OutboxRow[]> {
  await ensureFulfillmentSchema();
  // PS-253 (Per user override unlock shipped data on 2026-06-16): besides due pending/failed rows,
  // RECLAIM orphaned 'processing' rows whose lease has expired (the worker crashed/restarted between
  // claim and complete/fail). FOR UPDATE SKIP LOCKED can't protect this — the row lock is released at
  // claim time, not held during processing — so the lease (updated_at age) is the guard: a row still
  // being processed has a fresh updated_at (< lease) and is left alone. The write path
  // (complete/fail/markShipmentConfirmationState) is UNCHANGED; this only recovers stranded rows into
  // the SAME existing processing so the shipment finally gets confirmed instead of stranding forever.
  return pg`
    UPDATE fulfillment_outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id
      FROM fulfillment_outbox
      WHERE event_type IN ('shipment_confirmation_requested', ${INVENTORY_DEDUCTION_OUTBOX_EVENT})
        AND (
          (status IN ('pending', 'failed') AND next_run_at <= NOW())
          OR (status = 'processing'
              AND updated_at < NOW() - (${OUTBOX_PROCESSING_LEASE_MINUTES} || ' minutes')::interval)
        )
        ${orderId ? pg`AND order_id = ${orderId}` : pg``}
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, order_id, shipment_id, event_type, provider, payload, attempts
  ` as Promise<OutboxRow[]>;
}

async function claimOutboxRowById(options: {
  outboxId: number;
  orderId?: number;
  shipmentId?: number;
  provider?: string;
}): Promise<OutboxRow | null> {
  await ensureFulfillmentSchema();
  const rows = await pg`
    UPDATE fulfillment_outbox
    SET status = 'processing', updated_at = NOW()
    WHERE id IN (
      SELECT id
      FROM fulfillment_outbox
      WHERE id = ${options.outboxId}
        AND event_type = 'shipment_confirmation_requested'
        AND status IN ('pending', 'failed')
        ${options.orderId ? pg`AND order_id = ${options.orderId}` : pg``}
        ${options.shipmentId ? pg`AND shipment_id = ${options.shipmentId}` : pg``}
        ${options.provider ? pg`AND provider = ${options.provider}` : pg``}
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, order_id, shipment_id, event_type, provider, payload, attempts
  ` as OutboxRow[];
  return rows[0] ?? null;
}

function retryDelayMinutes(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

async function settleOutboxRowWithExecutor(row: OutboxRow, executor: SqlExecutor): Promise<void> {
  await executor`
    UPDATE fulfillment_outbox
    SET status = 'succeeded', last_error = NULL, updated_at = NOW()
    WHERE id = ${row.id}
  `;
  // Per user override unlock shipped data on 2026-07-14: inventory events
  // settle only their outbox lifecycle. Marketplace/order confirmation state
  // belongs exclusively to shipment_confirmation_requested events below.
  if (isInventoryDeductionOutboxEvent(row.event_type)) return;
  if (row.shipment_id) {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.payload.carrierProvider ?? 'unknown'),
      carrierAccountId: row.payload.carrierAccountId as string | number | null | undefined,
      confirmationProvider: row.provider,
      status: 'succeeded',
      attempts: row.attempts + 1,
      lastError: null,
    }, executor);
  }
  await executor`
    UPDATE orders
    SET canonical_status = 'shipped', updated_at = NOW()
    WHERE id = ${row.order_id}
  `;
}

async function completeOutboxRow(row: OutboxRow, executor: SqlExecutor = pg): Promise<void> {
  // Per user override unlock shipped data on 2026-07-15: the outbox success,
  // shipment confirmation state, and order canonical state settle atomically.
  // A crash cannot commit one projection while leaving the others wedged.
  await executor.begin((tx: SqlExecutor) => settleOutboxRowWithExecutor(row, tx));
}

export async function reconvergeSucceededShipmentConfirmations(
  limit = 25,
  executor: SqlExecutor = pg,
): Promise<number> {
  if (executor !== pg && process.env.NODE_ENV !== 'test') {
    throw new Error('Fulfillment outbox executor may only be injected in tests');
  }
  await ensureFulfillmentSchema();
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  // Per user override unlock shipped data on 2026-07-15: repair only derived
  // confirmation lifecycle fields for already-succeeded outbox rows. This
  // makes a formerly torn settlement self-heal without re-contacting a
  // marketplace or changing label/postage/shipment history.
  const rows = await executor<OutboxRow[]>`
    SELECT
      f.id,
      f.order_id,
      f.shipment_id,
      f.event_type,
      f.provider,
      f.payload,
      f.attempts
    FROM fulfillment_outbox f
    JOIN orders o ON o.id = f.order_id
    LEFT JOIN shipments s ON s.id = f.shipment_id
    WHERE f.event_type = 'shipment_confirmation_requested'
      AND f.status = 'succeeded'
      AND (
        o.canonical_status IS DISTINCT FROM 'shipped'
        OR (
          f.shipment_id IS NOT NULL
          AND (
            s.confirmation_status IS DISTINCT FROM 'succeeded'
            OR s.marketplace_confirmed_at IS NULL
          )
        )
      )
    ORDER BY f.updated_at ASC, f.id ASC
    LIMIT ${boundedLimit}
  `;
  for (const row of rows) await completeOutboxRow(row, executor);
  if (rows.length > 0) {
    console.info('[fulfillment-outbox] reconverged succeeded confirmation lifecycle', {
      count: rows.length,
    });
  }
  return rows.length;
}

async function failOutboxRow(row: OutboxRow, err: unknown, retryable: boolean): Promise<void> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const shouldRetry = retryable && attempts < MAX_ATTEMPTS;
  await pg`
    UPDATE fulfillment_outbox
    SET
      status = 'failed',
      attempts = ${attempts},
      last_error = ${message},
      next_run_at = CASE
        WHEN ${shouldRetry} THEN NOW() + (${retryDelayMinutes(attempts)} || ' minutes')::interval
        ELSE 'infinity'::timestamptz
      END,
      updated_at = NOW()
    WHERE id = ${row.id}
  `;
  if (isInventoryDeductionOutboxEvent(row.event_type)) return;
  if (row.shipment_id) {
    await markShipmentConfirmationState({
      shipmentId: row.shipment_id,
      carrierProvider: String(row.payload.carrierProvider ?? 'unknown'),
      carrierAccountId: row.payload.carrierAccountId as string | number | null | undefined,
      confirmationProvider: row.provider,
      status: 'failed',
      attempts,
      lastError: message,
    });
  }
  if (!shouldRetry) {
    await pg`
      UPDATE orders
      SET canonical_status = 'confirmation_failed', updated_at = NOW()
      WHERE id = ${row.order_id}
    `;
  }
}

// Per user override unlock shipped data on 2026-06-13 (PS-192): one-shot
// marketplace shipment confirmation for EXTERNALLY-fulfilled orders. The
// manual "mark shipped externally" flow has no local shipment row, so it
// cannot ride the shipment-anchored outbox lifecycle — but its marketplace
// dispatch must still be THE SAME connector call the outbox worker makes
// (resolveStoreConnector + loadStoreCredentials + connector.confirmShipment,
// identical input shape, shipmentId 0 = the worker's own no-shipment
// placeholder). This helper reuses the worker's internals so the two paths
// cannot drift; processOutboxRow below is UNCHANGED. Read-only with respect
// to orders/shipments — it sends the provider notification and reports.
export async function confirmShipmentDirectNow(args: {
  provider: string;
  order: OrderForConfirmation;
  trackingNumber: string;
  carrierCode: string | null;
  shipDate: string;
  notifyCustomer: boolean;
  notifyMarketplace: boolean;
  payload?: Record<string, unknown>;
}): Promise<{ ok: boolean; reason?: string }> {
  const resolvedStoreConnector = resolveStoreConnector(args.provider, 'shipment.confirm');
  if (!resolvedStoreConnector || resolvedStoreConnector.implementation.status !== 'live') {
    const reason = !resolvedStoreConnector
      ? `No shipment confirmation connector registered for ${args.provider}`
      : `${args.provider} shipment confirmation connector is ${resolvedStoreConnector.implementation.status}`;
    return { ok: false, reason };
  }
  // PS-262a: hydrate the per-marketplace identity (lineItems/purchaseOrderId/etc.)
  // from the order BEFORE dispatch. mark-shipped-externally passes no payload, so
  // without this a direct eBay/Walmart confirmation reaches the connector with no
  // identity and fails non-retryably. Any live value already in args.payload wins.
  const hydratedPayload = hydrateMarketplaceConfirmationPayload({
    provider: args.provider,
    order: args.order,
    payload: args.payload,
  });
  const payload: Record<string, unknown> = {
    ...hydratedPayload,
    orderId: args.order.id,
    externalOrderId: args.order.externalOrderId,
    clientId: args.order.clientId,
    orderNumber: args.order.orderNumber,
    trackingNumber: args.trackingNumber,
    carrierCode: args.carrierCode,
    shipDate: args.shipDate,
  };
  const credentials = await loadStoreCredentials(args.provider, payload, args.order.clientId ?? null);
  const result = await resolvedStoreConnector.connector.confirmShipment({
    orderId: args.order.id,
    shipmentId: 0,
    externalOrderId: args.order.externalOrderId,
    clientId: args.order.clientId,
    orderNumber: args.order.orderNumber,
    trackingNumber: args.trackingNumber,
    carrierCode: args.carrierCode,
    shipDate: args.shipDate,
    notifyCustomer: args.notifyCustomer,
    notifyMarketplace: args.notifyMarketplace,
    credentials,
    payload,
  });
  return result.ok ? { ok: true } : { ok: false, reason: result.message ?? 'Confirmation failed' };
}

async function processOutboxRow(row: OutboxRow): Promise<boolean> {
  if (isInventoryDeductionOutboxEvent(row.event_type)) {
    await processInventoryDeductionOutboxEvent({
      orderId: row.order_id,
      payload: row.payload ?? {},
    });
    await completeOutboxRow(row);
    console.info('[fulfillment-outbox] inventory deduction settled', {
      orderId: row.order_id,
      shipmentId: row.shipment_id,
    });
    return true;
  }
  if (row.event_type !== 'shipment_confirmation_requested') {
    await failOutboxRow(row, new Error(`Unsupported fulfillment event ${row.event_type}`), false);
    return false;
  }

  const resolvedStoreConnector = resolveStoreConnector(row.provider, 'shipment.confirm');
  if (!resolvedStoreConnector) {
    await failOutboxRow(row, new Error(`No store connector registered for ${row.provider}`), false);
    return false;
  }
  const { connector, connectorCapabilities } = resolvedStoreConnector;

  let payload: Record<string, unknown> = (row.payload ?? {}) as Record<string, unknown>;
  // PS-262a (Per user override unlock shipped data on 2026-06-14): re-hydrate the
  // marketplace identity from the order before dispatch. Auto-recovery / lifecycle
  // enqueues store a minimal payload, so a direct eBay/Walmart confirmation would
  // otherwise dispatch with no lineItems/purchaseOrderId and fail non-retryably.
  // Any live value already on the stored payload wins (hydrate only fills blanks).
  const hydrateOrderId = Number(payload.orderId ?? row.order_id);
  if (Number.isFinite(hydrateOrderId) && hydrateOrderId > 0) {
    const [orderRow] = await pg<Array<{ external_order_id: string | null; raw: Record<string, unknown> | null }>>`
      SELECT external_order_id, raw FROM orders WHERE id = ${hydrateOrderId} LIMIT 1`;
    if (orderRow) {
      payload = hydrateMarketplaceConfirmationPayload({
        provider: row.provider,
        order: { externalOrderId: orderRow.external_order_id, raw: orderRow.raw },
        payload,
      });
    }
  }
  const credentials = await loadStoreCredentials(
    row.provider,
    payload,
    Number(payload.clientId ?? null) || null,
  );
  const trackingNumber = String(payload.trackingNumber ?? '').trim();
  if (!trackingNumber) {
    await failOutboxRow(row, new Error('Shipment confirmation missing trackingNumber'), false);
    return false;
  }

  // PS-253 (Per user override unlock shipped data on 2026-06-16): idempotency. A crash between the
  // connector ack and completeOutboxRow leaves the row 'processing'; the PS-253 stale-reclaim then
  // re-delivers it — so re-check THIS shipment's confirmation state right before dispatch and DO NOT
  // re-confirm at the marketplace if it already succeeded. Just settle the outbox row. Read-only on
  // shipments here; the settle path (completeOutboxRow) is unchanged.
  const idempotencyShipmentId = Number(payload.shipmentId ?? row.shipment_id ?? 0);
  if (idempotencyShipmentId > 0) {
    const [already] = (await pg`
      SELECT confirmation_status, marketplace_confirmed_at
      FROM shipments WHERE id = ${idempotencyShipmentId} LIMIT 1
    `) as Array<{ confirmation_status: string | null; marketplace_confirmed_at: string | null }>;
    if (already?.confirmation_status === 'succeeded' || already?.marketplace_confirmed_at != null) {
      await completeOutboxRow(row);
      console.info('[fulfillment-outbox] shipment already confirmed; settling row idempotently', {
        orderId: row.order_id,
        shipmentId: row.shipment_id,
        provider: row.provider,
      });
      return true;
    }
  }

  const result = await connector.confirmShipment({
    orderId: Number(payload.orderId ?? row.order_id),
    shipmentId: Number(payload.shipmentId ?? row.shipment_id ?? 0),
    externalOrderId: typeof payload.externalOrderId === 'string' ? payload.externalOrderId : null,
    clientId: Number(payload.clientId ?? null) || null,
    orderNumber: typeof payload.orderNumber === 'string' ? payload.orderNumber : null,
    trackingNumber,
    carrierCode: typeof payload.carrierCode === 'string' ? payload.carrierCode : null,
    shipDate: typeof payload.shipDate === 'string' ? payload.shipDate : new Date().toISOString().slice(0, 10),
    notifyCustomer: payload.notifyCustomer === true,
    notifyMarketplace: payload.notifyMarketplace !== false,
    credentials,
    payload,
  });

  if (result.ok) {
    await completeOutboxRow(row);
    console.info('[fulfillment-outbox] confirmed shipment', {
      orderId: row.order_id,
      shipmentId: row.shipment_id,
      provider: row.provider,
      connectorCapabilities,
    });
    return true;
  }

  await failOutboxRow(row, new Error(result.message ?? 'Confirmation failed'), result.retryable !== false);
  return false;
}

export async function processFulfillmentOutboxOnce(options: {
  limit?: number;
  orderId?: number;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  await reconvergeSucceededShipmentConfirmations(options.limit ?? 25);
  const rows = await claimDueOutboxRows(options.limit ?? 25, options.orderId);
  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (await processOutboxRow(row)) succeeded += 1;
      else failed += 1;
    } catch (err) {
      await failOutboxRow(row, err, true);
      failed += 1;
      console.warn(
        `[fulfillment-outbox] event failed eventType=${row.event_type} orderId=${row.order_id} shipmentId=${row.shipment_id} provider=${row.provider}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { processed: rows.length, succeeded, failed };
}

export async function processFulfillmentOutboxById(options: {
  outboxId: number;
  orderId?: number;
  shipmentId?: number;
  provider?: string;
}): Promise<{ processed: number; succeeded: number; failed: number; message?: string }> {
  // Per user override unlock shipped data on 2026-05-23: exact-row retry is
  // limited to shipment confirmation recovery and preserves shipped locks.
  const row = await claimOutboxRowById(options);
  if (!row) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      message: 'No pending/failed fulfillment outbox row matched the supplied identifiers.',
    };
  }

  try {
    const succeeded = await processOutboxRow(row);
    return { processed: 1, succeeded: succeeded ? 1 : 0, failed: succeeded ? 0 : 1 };
  } catch (err) {
    await failOutboxRow(row, err, true);
    console.warn(
      `[fulfillment-outbox] exact retry failed orderId=${row.order_id} shipmentId=${row.shipment_id} provider=${row.provider}:`,
      err instanceof Error ? err.message : err,
    );
    return { processed: 1, succeeded: 0, failed: 1 };
  }
}
