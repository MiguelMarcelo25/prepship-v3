import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shipments } from '../db/schema/shipments.js';
import { customerShippingMoneyReceiptRevisions } from '../db/schema/customer-shipping-money-sync.js';
import { roundMoney } from '../lib/money.js';
import { classifyCustomerShippingMoney } from './customer-shipping-money-classification.js';

/**
 * PS-509 — receipt_revised_after_freeze detection.
 *
 * The sync UPDATE branch writes shipments.cost from the provider payload but deliberately
 * never touches selected_rate_cost or the frozen tuple. So when ShipStation revises a
 * shipment's cost after ingestion, the carrier receipt and the frozen customer money
 * disagree — and before this detector, nothing noticed. Measured base rate: 0 of 2,748
 * stamped sync rows in 90 days, so a hit is genuinely exceptional and worth an operator's
 * attention.
 *
 * THE FROZEN MONEY IS NEVER TOUCHED. No auto-reprice, no overwrite — a disagreement
 * becomes a durable review record with reconciliation state. One OPEN record per shipment
 * (partial unique index): repeated passes update the open record's current values and
 * detection count rather than accumulating rows. Detection is idempotent and re-runs on
 * every sync UPDATE pass, so a missed pass self-heals — which is why the caller may treat
 * a detector failure as loggable rather than sync-fatal.
 */
export async function detectReceiptRevisionsAfterFreeze(
  shipmentIds: readonly number[],
  options: { database?: typeof db } = {},
): Promise<{ checked: number; revised: number }> {
  const database = options.database ?? db;
  if (!shipmentIds.length) return { checked: 0, revised: 0 };

  const rows = await database
    .select({
      id: shipments.id,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      clientId: shipments.clientId,
      source: shipments.source,
      selectedRateJson: shipments.selectedRateJson,
    })
    .from(shipments)
    .where(and(
      inArray(shipments.id, [...shipmentIds]),
      // Only rows that carry a version-keyed tuple can disagree with their receipt.
      sql`coalesce(${shipments.selectedRateJson}, '{}'::jsonb) ? 'customerShippingMoneyPolicyVersion'`,
    ));

  let revised = 0;
  for (const row of rows) {
    const classification = classifyCustomerShippingMoney(row.selectedRateJson);
    if (
      classification.kind !== 'valid_ps509'
      && classification.kind !== 'valid_ps508'
      && classification.kind !== 'valid_ps437'
    ) {
      // Malformed/unknown tuples have no trustworthy frozen cost to compare against;
      // they are already review states through their own lane.
      continue;
    }
    const currentPostage = Number(row.cost);
    const currentOther = Number(row.otherCost);
    const currentReceipt = roundMoney(
      (Number.isFinite(currentPostage) ? currentPostage : 0)
      + (Number.isFinite(currentOther) ? currentOther : 0),
    );
    const frozenCost = roundMoney(classification.frozen.selectedRateCost);
    const delta = roundMoney(currentReceipt - frozenCost);
    if (Math.abs(delta) < 0.005) continue;

    revised += 1;
    await database
      .insert(customerShippingMoneyReceiptRevisions)
      .values({
        shipmentId: row.id,
        policyVersion: classification.policyVersion,
        previousFrozenSelectedCost: frozenCost.toFixed(2),
        currentPostageCost: Number.isFinite(currentPostage) ? currentPostage.toFixed(2) : null,
        currentOtherCost: Number.isFinite(currentOther) ? currentOther.toFixed(2) : null,
        deltaSigned: delta.toFixed(2),
        deltaAbs: Math.abs(delta).toFixed(2),
        clientId: row.clientId,
        source: row.source,
      })
      .onConflictDoUpdate({
        // Matches the csm_receipt_revisions_open_unq partial unique index: at most one
        // OPEN record per shipment. Resolved records stay behind as history, so a later,
        // distinct revision opens a fresh row.
        target: [customerShippingMoneyReceiptRevisions.shipmentId],
        targetWhere: sql`reconciliation_state = 'open'`,
        set: {
          currentPostageCost: Number.isFinite(currentPostage) ? currentPostage.toFixed(2) : null,
          currentOtherCost: Number.isFinite(currentOther) ? currentOther.toFixed(2) : null,
          deltaSigned: delta.toFixed(2),
          deltaAbs: Math.abs(delta).toFixed(2),
          detectionCount: sql`${customerShippingMoneyReceiptRevisions.detectionCount} + 1`,
          lastDetectedAt: new Date(),
        },
      });
  }

  if (revised > 0) {
    console.warn(
      `[ps-509] receipt_revised_after_freeze: ${revised} shipment(s) now disagree with `
      + 'their frozen customer money — durable review records written, money untouched',
    );
  }
  return { checked: rows.length, revised };
}
