import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shipments } from '../db/schema/shipments.js';
import { customerShippingMoneySyncOutcomes } from '../db/schema/customer-shipping-money-sync.js';
import { classifyCustomerShippingMoney } from './customer-shipping-money-classification.js';
import {
  decideCustomerShippingMoneyForRow,
  loadCustomerShippingMoneyRow,
} from './customer-shipping-money.js';
import {
  ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
  CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
  readFrozenCustomerShippingMoney,
  type CustomerShippingRateSource,
  type FrozenCustomerShippingMoney,
} from './customer-shipping-money-snapshot.js';

/**
 * PS-509 — the ONE canonical writer for sync-ingress customer shipping money.
 *
 * ── ONE MONEY AUTHORITY, TWO TRIGGER BOUNDARIES ─────────────────────────────────────────
 *
 * All freezing for ShipStation-synced shipments delegates here: eligibility, policy
 * resolution (through decideCustomerShippingMoneyForRow, the same owner every other
 * freeze uses), snapshot construction, version/provenance, durable named outcomes and
 * idempotency. It is called from the upsertShipmentsBatch INSERT transaction (driven off
 * insertedRows), from the orphan-link transaction in order-sync (link and freeze commit
 * together), and from the retry sweep that re-drives non-terminal outcomes.
 *
 * ── IT THROWS ON THE UNEXPECTED — THE REVERSE OF PS-508's RULE, ON PURPOSE ──────────────
 *
 * freezeOutboundCustomerShippingMoney must never fail a paid-for label, so it skips and
 * its caller savepoints. Sync ingestion is externally replayable: the upstream receipt
 * survives in ShipStation, an aborted INSERT transaction leaves no row and retries as an
 * INSERT next sync, and a conflict-losing insert relies on the winner having written
 * receipt and tuple atomically. A savepoint here would commit the shipment WITHOUT its
 * tuple; the next sync would take the UPDATE path, which never freezes, and the gap would
 * be permanent. So an unexpected failure on an eligible fresh insert propagates and aborts
 * the insert transaction. Ordinary ineligibility is not failure — it returns a durable
 * named outcome. Malformed/unknown pre-existing snapshots are review-only — an operator
 * matter, distinct from infrastructure failure while constructing a NEW tuple.
 *
 * ── SKIPS NEVER WRITE MONEY ─────────────────────────────────────────────────────────────
 *
 * A non-frozen outcome never touches selected_rate_json and never writes a policy-version
 * key. Outcome rows live in their own migration-owned table and carry classification,
 * provenance and timing only.
 */

export type SyncIngressFreezeBoundary = 'sync_insert' | 'orphan_link' | 'retry_sweep';

/** The durable named outcomes, exactly as constrained by migration 0103. */
export type SyncIngressOutcome =
  | 'frozen'
  | 'no_order'
  | 'no_client'
  | 'billing_inactive'
  | 'no_billable_cost'
  | 'return'
  | 'voided'
  | 'test'
  | 'needs_retry'
  | 'needs_review';

export type SyncIngressSkipOutcome =
  | 'no_order'
  | 'no_client'
  | 'billing_inactive'
  | 'no_billable_cost'
  | 'return'
  | 'voided'
  | 'test';

export type SyncIngressFreezeResult =
  | { outcome: 'frozen'; frozen: FrozenCustomerShippingMoney; alreadyFrozen: boolean }
  | { outcome: SyncIngressSkipOutcome }
  | {
      outcome: 'needs_review';
      failureClassification: 'malformed_known_version' | 'unknown_version';
      detail: string;
    }
  /**
   * The row is not this ingress's population (source is not 'shipstation'). Possible only
   * at the link/sweep boundaries — the INSERT branch hardcodes the source. No outcome row
   * is written: the durable-outcome contract covers the sync-ingress population, and a
   * prepship-created orphan that gets linked belongs to the purchase-path contract.
   */
  | { outcome: 'not_sync_ingress'; source: string | null };

type SyncIngressExec = Pick<typeof db, 'execute' | 'update' | 'select' | 'insert'>;

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trimDetail(detail: string): string {
  return detail.length > 480 ? `${detail.slice(0, 480)}…` : detail;
}

type OutcomeEntry = {
  shipmentId: number;
  labelShipmentId: number | null;
  boundary: SyncIngressFreezeBoundary;
  outcome: SyncIngressOutcome;
  orderId: number | null;
  clientId: number | null;
  failureClassification?: string | null;
  detail?: string | null;
};

/**
 * Upsert the durable outcome, one row per shipment. Transitions are monotonic where it
 * matters: migration 0103's trigger refuses to move a 'frozen' outcome anywhere else, so
 * a replay can never demote the record of frozen money. Every other transition
 * (no_order -> frozen at link, needs_retry -> frozen on a successful sweep) is the
 * ordinary business path. Runs on the caller's transaction so tuple and outcome commit
 * atomically at the freeze boundaries.
 */
async function persistSyncIngressOutcome(exec: SyncIngressExec, entry: OutcomeEntry): Promise<void> {
  await exec
    .insert(customerShippingMoneySyncOutcomes)
    .values({
      shipmentId: entry.shipmentId,
      labelShipmentId: entry.labelShipmentId,
      boundary: entry.boundary,
      outcome: entry.outcome,
      policyContract: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
      orderId: entry.orderId,
      clientId: entry.clientId,
      failureClassification: entry.failureClassification ?? null,
      detail: entry.detail != null ? trimDetail(entry.detail) : null,
    })
    .onConflictDoUpdate({
      target: [customerShippingMoneySyncOutcomes.shipmentId],
      set: {
        boundary: entry.boundary,
        outcome: entry.outcome,
        orderId: entry.orderId,
        clientId: entry.clientId,
        failureClassification: entry.failureClassification ?? null,
        detail: entry.detail != null ? trimDetail(entry.detail) : null,
        evaluationCount: sql`${customerShippingMoneySyncOutcomes.evaluationCount} + 1`,
        lastEvaluatedAt: new Date(),
      },
    });
}

/**
 * Best-effort durable record that a transactional freeze could not complete — written
 * OUTSIDE the failed transaction (which rolled back, taking any in-transaction outcome
 * with it). Only meaningful at the link/sweep boundaries: an aborted INSERT leaves no
 * shipment row to key an outcome to, and that is the contract's design — the receipt is
 * durable upstream and the whole row retries as an INSERT next sync.
 *
 * Best-effort ON PURPOSE: this runs inside a catch handler, and throwing here would mask
 * the original failure. A lost needs_retry record self-heals — the retry sweep keys off
 * shipments that gained an order while their outcome stayed non-terminal, and the next
 * evaluation re-persists. Failures are logged with the shipment id so they are countable.
 */
export async function recordSyncIngressFreezeRetry(
  shipmentId: number,
  args: {
    boundary: SyncIngressFreezeBoundary;
    failureClassification: string;
    detail: string;
    database?: typeof db;
  },
): Promise<void> {
  const database = args.database ?? db;
  try {
    const [row] = await database
      .select({
        labelShipmentId: shipments.labelShipmentId,
        orderId: shipments.orderId,
        clientId: shipments.clientId,
      })
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    await persistSyncIngressOutcome(database, {
      shipmentId,
      labelShipmentId: row?.labelShipmentId ?? null,
      boundary: args.boundary,
      outcome: 'needs_retry',
      orderId: row?.orderId ?? null,
      clientId: row?.clientId ?? null,
      failureClassification: args.failureClassification,
      detail: args.detail,
    });
  } catch (error) {
    console.error(
      `[ps-509] could not record needs_retry outcome for shipment ${shipmentId}`
      + ` (${args.boundary}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function freezeSyncIngressCustomerShippingMoney(
  shipmentId: number,
  args: {
    boundary: SyncIngressFreezeBoundary;
    /**
     * The transaction that is inserting the row (sync_insert) or committing the link
     * (orphan_link). Tuple and outcome MUST become true in the same commit as the
     * boundary's own write, or a crash between them leaves durable state that lies.
     */
    exec: SyncIngressExec;
  },
): Promise<SyncIngressFreezeResult> {
  const { boundary, exec } = args;
  const row = await loadCustomerShippingMoneyRow(shipmentId, exec);
  if (!row) {
    // At every boundary the shipment row exists in this transaction's view; a miss is
    // infrastructure failure, not ineligibility. Propagate — the boundary owns rollback.
    throw new Error(`PS-509 sync-ingress freeze: shipment ${shipmentId} not found in-transaction`);
  }
  if (row.source !== 'shipstation') {
    return { outcome: 'not_sync_ingress', source: row.source };
  }

  const outcomeBase = {
    shipmentId,
    labelShipmentId: row.labelShipmentId,
    boundary,
    orderId: row.orderId,
    clientId: row.clientId,
  } as const;

  // Classification FIRST: replay of an already-frozen row must report frozen money —
  // never re-decide it, and never let a later state change (a void arriving after the
  // freeze) demote the durable record of money that exists.
  const classification = classifyCustomerShippingMoney(row.selectedRateJson);
  if (
    classification.kind === 'valid_ps509'
    || classification.kind === 'valid_ps508'
    || classification.kind === 'valid_ps437'
  ) {
    await persistSyncIngressOutcome(exec, { ...outcomeBase, outcome: 'frozen' });
    return { outcome: 'frozen', frozen: classification.frozen, alreadyFrozen: true };
  }
  if (classification.kind === 'malformed_known_version') {
    const detail = `${classification.policyVersion}: ${classification.reason}`;
    await persistSyncIngressOutcome(exec, {
      ...outcomeBase,
      outcome: 'needs_review',
      failureClassification: 'malformed_known_version',
      detail,
    });
    return { outcome: 'needs_review', failureClassification: 'malformed_known_version', detail };
  }
  if (classification.kind === 'unknown_version') {
    await persistSyncIngressOutcome(exec, {
      ...outcomeBase,
      outcome: 'needs_review',
      failureClassification: 'unknown_version',
      detail: classification.rawVersion,
    });
    return {
      outcome: 'needs_review',
      failureClassification: 'unknown_version',
      detail: classification.rawVersion,
    };
  }

  // legacy_absent — the ordinary shape. Forward eligibility, each miss a durable outcome.
  const skip = async (outcome: SyncIngressSkipOutcome): Promise<SyncIngressFreezeResult> => {
    await persistSyncIngressOutcome(exec, { ...outcomeBase, outcome });
    return { outcome };
  };
  if (row.voided) return skip('voided');
  if (row.isReturn) return skip('return');
  if (row.clientIsTest) return skip('test');
  if (row.orderId == null) return skip('no_order');
  if (row.clientId == null) return skip('no_client');
  if (!row.billingActive) return skip('billing_inactive');
  const selectedRateCost = finiteNumber(row.selectedRateCost);
  if (selectedRateCost == null || selectedRateCost <= 0) return skip('no_billable_cost');

  // Policy resolution through the ONE canonical owner. House is by construction never for
  // this ingress (no cShippingRateAmount is supplied, and no 'shipp' carrier exists in the
  // sync population), so the house input stays null always.
  //
  // Hermes 2026-08-22: `exec` MUST be threaded. Under BILLING_PER_ACCOUNT_MARKUP=on the
  // decision loads the per-account markup settings rows, and without `exec` that load falls
  // back to the module-singleton database and its 60s process cache (rates.ts
  // loadCarrierMarkups) — reading the markup that prices this money from a different
  // connection, outside the transaction that is freezing it. Passing `exec` puts the markup
  // read on the same executor as the row load and the tuple write, exactly as the outbound
  // and replacement freezes already do (customer-shipping-money.ts:616 and :817-821). This
  // changes only WHERE the markup fact is read from — no money math, eligibility rule,
  // outcome vocabulary or version string moves.
  const decision = await decideCustomerShippingMoneyForRow(row, {
    policyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
    exec,
  });

  // Provenance mapping is version-owned here, not in the shared resolver: the resolver's
  // 'realized_customer_shipping_rate' names money realized from a label's final purchase
  // cost, and this ingress computed the same FORMULA from a sync receipt instead. The
  // HUGRAB override keeps its own name — the override produced the number, not the markup.
  let customerRateSource: CustomerShippingRateSource;
  if (decision.customerRateSource === 'hugrab_shipping_rate_override') {
    customerRateSource = 'hugrab_shipping_rate_override';
  } else if (decision.customerRateSource === 'realized_customer_shipping_rate') {
    customerRateSource = 'carrier_markup_customer_shipping_rate';
  } else {
    // House money at sync ingress is impossible by contract. Reaching this is a writer
    // defect while constructing a NEW tuple — infrastructure failure, so it aborts.
    throw new Error(
      `PS-509 sync-ingress freeze: impossible provenance ${decision.customerRateSource} `
      + `for shipment ${shipmentId}`,
    );
  }

  const frozen: FrozenCustomerShippingMoney = {
    selectedRateCost: decision.selectedRateCost,
    cShippingRateAmount: decision.cShippingRateAmount,
    shippingMarginAmount: decision.shippingMarginAmount,
    shippingMarginPct: decision.shippingMarginPct,
    customerRateSource,
    // An authoritative receipt observed at first sync ingestion — deliberately NOT
    // label_final_cost, because ShipStation may revise cost later (the
    // receipt_revised_after_freeze review class watches for exactly that).
    rateCostSource: 'shipstation_sync_receipt_cost',
    customerShippingMoneyPolicyVersion: CUSTOMER_SHIPPING_MONEY_POLICY_VERSION_SYNC_INGESTION,
    // Honest timing: these facts existed at ingestion; stability across the
    // purchase->ingestion gap (minutes at steady state) is unprovable without a policy
    // history table, so the tuple names its capture moment instead of claiming purchase.
    customerShippingMoneyCaptureSource: 'shipstation_sync_ingestion',
    // Billing consumes amount AND suffix atomically; description participates in the
    // duplicate-suppression unique index, so a tuple without it reproduces the number
    // but not the line.
    billingDescriptionSuffix: decision.billingDescriptionSuffix,
  };

  // Same one-shot idiom as every other freeze: key-presence predicate, never re-decide.
  // selected_rate_cost is NOT rewritten — the INSERT branch stamped it in this same
  // transaction (PS-381), and it is already the exact value the decision was made from.
  const original = recordOrNull(row.selectedRateJson) ?? {};
  const [updated] = await exec
    .update(shipments)
    .set({
      selectedRateJson: { ...original, ...frozen },
      updatedAt: new Date(),
    })
    .where(and(
      eq(shipments.id, shipmentId),
      eq(shipments.isReturn, false),
      eq(shipments.voided, false),
      sql`not (coalesce(${shipments.selectedRateJson}, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion')`,
    ))
    .returning({ selectedRateJson: shipments.selectedRateJson });

  if (updated) {
    const written = readFrozenCustomerShippingMoney(updated.selectedRateJson, {
      accept: ACCEPTED_CUSTOMER_SHIPPING_MONEY_POLICY_VERSIONS,
    });
    if (!written) {
      // We just wrote it and it does not read back: the case that MAKES malformed rows.
      // On a fresh insert this must abort rather than commit a row whose money is wrong —
      // the upstream receipt is durable and the whole row retries as an INSERT.
      throw new Error(
        `PS-509 sync-ingress freeze: tuple for shipment ${shipmentId} did not read back`,
      );
    }
    await persistSyncIngressOutcome(exec, { ...outcomeBase, outcome: 'frozen' });
    return { outcome: 'frozen', frozen: written, alreadyFrozen: false };
  }

  // The one-shot predicate matched no row. Either a concurrent writer won (their snapshot
  // is the truth) or the row stopped qualifying between read and write.
  const [concurrent] = await exec
    .select({ selectedRateJson: shipments.selectedRateJson })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .limit(1);
  const raced = classifyCustomerShippingMoney(concurrent?.selectedRateJson);
  if (
    raced.kind === 'valid_ps509' || raced.kind === 'valid_ps508' || raced.kind === 'valid_ps437'
  ) {
    await persistSyncIngressOutcome(exec, { ...outcomeBase, outcome: 'frozen' });
    return { outcome: 'frozen', frozen: raced.frozen, alreadyFrozen: true };
  }
  // No valid tuple and no write: an eligible row this transaction could not freeze.
  // Unexpected by construction — abort so the boundary retries from the durable receipt.
  throw new Error(
    `PS-509 sync-ingress freeze: one-shot write matched no row for shipment ${shipmentId} `
    + `and no valid tuple exists (${raced.kind})`,
  );
}
