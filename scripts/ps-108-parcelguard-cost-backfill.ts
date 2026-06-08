import 'dotenv/config';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../src/db/client';
import { shipments } from '../src/db/schema/shipments';
import { orders } from '../src/db/schema/orders';
import { loadClientCredentials } from '../src/lib/shipstation/credentials';
import { ssGetShipmentV1 } from '../src/lib/shipstation/labels';
import {
  planParcelGuardBackfillRow,
  summarizeBackfillPlans,
  type LocalShipmentAccounting,
  type ParcelGuardBackfillPlan,
} from '../src/services/shipping-workflow/parcelguard-backfill';
import type {
  BilledInsuranceCost,
  InsuranceCostBilledSource,
} from '../src/services/shipping-workflow/insurance-cost';

/**
 * PS-108 Phase 3 — HUGRAB ParcelGuard shipped-cost reconciliation.
 *
 * Reconciles shipped HUGRAB orders whose local shipment recorded a POSTAGE-ONLY cost
 * while ShipStation billed a ParcelGuard premium (insurance) on top. It reads the
 * AUTHORITATIVE billed breakdown from ShipStation (v1 /shipments shipmentCost+otherCost),
 * compares it to the local accounting, and reports the minimal update plan.
 *
 * SAFETY (per CLAUDE.md shipped/cancelled lockdown + PS-108 guardrails):
 *   - DRY-RUN by default. Prints a sanitized plan; writes NOTHING.
 *   - `--apply` is INTENTIONALLY NOT WIRED in this PR. PS-108 is not covered by the
 *     existing `unlock shipped data` override (that override is scoped to PS-016..021).
 *     Apply-mode refuses and explains how to authorize, rather than mutating shipped rows.
 *   - Read-only ShipStation calls only. No labels created/voided, no postage bought, no
 *     marketplace notifications, no address/item/dims/status mutation.
 *   - No PII: prints order number, local/SS shipment ids, and money only.
 *   - main() runs only when invoked directly, so importing this module never connects.
 *
 *   npm run shipstation:parcelguard-costs:dry-run
 *   npm run shipstation:parcelguard-costs:apply   (refuses — gated)
 */

const HUGRAB_CLIENT_IDS = [4];
const SEED_ORDER_NUMBER = '1247';
const SEED_SS_SHIPMENT_ID = 292074298;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? null;
  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** ShipStation BILLED-cost source: v1 /shipments exposes shipmentCost (postage) and
 *  otherCost (ParcelGuard premium). See docs/ps-108-shipstation-parcelguard-cost-source.md. */
const shipStationBilledSource: InsuranceCostBilledSource = {
  async resolveBilledCost(args): Promise<BilledInsuranceCost | null> {
    if (args.shipmentId == null) return null;
    const v1 = await ssGetShipmentV1(args.shipmentId, {
      apiKey: args.apiKeyV1 ?? undefined,
      apiSecret: args.apiSecretV1 ?? undefined,
    });
    if (!v1) return null;
    const postageAmount = Number(v1.shipmentCost ?? 0);
    const insuranceAmount = Number(v1.otherCost ?? 0);
    return {
      postageAmount,
      insuranceAmount,
      totalAmount: Number((postageAmount + insuranceAmount).toFixed(2)),
      provenance: 'shipstation_v1_shipment',
    };
  },
};

async function loadAffectedRows(limit: number): Promise<LocalShipmentAccounting[]> {
  // HUGRAB shipped shipments that are not voided and carry a label. Seed order #1247 is
  // included explicitly so it is always evaluated even if its client mapping differs.
  const rows = await db
    .select({
      shipmentId: shipments.id,
      orderId: shipments.orderId,
      orderNumber: shipments.orderNumber,
      ssShipmentId: shipments.labelShipmentId,
      cost: shipments.cost,
      otherCost: shipments.otherCost,
      carrierCode: shipments.carrierCode,
      serviceCode: shipments.serviceCode,
      orderStatus: orders.orderStatus,
    })
    .from(shipments)
    .leftJoin(orders, eq(shipments.orderId, orders.id))
    .where(
      and(
        eq(shipments.voided, false),
        or(
          inArray(shipments.clientId, HUGRAB_CLIENT_IDS),
          eq(shipments.orderNumber, SEED_ORDER_NUMBER),
          eq(shipments.labelShipmentId, SEED_SS_SHIPMENT_ID),
        ),
      ),
    )
    .limit(limit);

  return rows
    .filter((row) => row.orderStatus == null || row.orderStatus === 'shipped')
    .map((row) => ({
      shipmentId: row.shipmentId,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      ssShipmentId: row.ssShipmentId,
      cost: row.cost != null ? Number(row.cost) : null,
      otherCost: row.otherCost != null ? Number(row.otherCost) : null,
      carrierCode: row.carrierCode,
      serviceCode: row.serviceCode,
    }));
}

async function main(): Promise<void> {
  const apply = hasFlag('apply');
  const asJson = hasFlag('json');
  const limit = Number(argValue('limit') ?? '500') || 500;

  if (apply) {
    console.error(
      [
        'PS-108 apply-mode is GATED and intentionally not wired.',
        '',
        'Writing shipped HUGRAB orders/shipments rows is governed by the CLAUDE.md',
        'shipped/cancelled lockdown. PS-108 is not covered by the existing',
        '`unlock shipped data` override (PS-016..021 only). To apply:',
        '  1. DJ authorizes by typing `unlock shipped data` for PS-108, AND',
        '  2. an engineer wires the reviewed UPDATE (shipments.otherCost +',
        '     selectedRateJson patch) using the plan this dry-run prints.',
        '',
        'Re-run without --apply to see the dry-run reconciliation plan.',
      ].join('\n'),
    );
    process.exit(2);
    return;
  }

  const creds = await loadClientCredentials(HUGRAB_CLIENT_IDS[0] ?? null);
  const rows = await loadAffectedRows(limit);

  const plans: ParcelGuardBackfillPlan[] = [];
  for (const row of rows) {
    let billed: BilledInsuranceCost | null = null;
    try {
      billed = await shipStationBilledSource.resolveBilledCost({
        shipmentId: row.ssShipmentId,
        apiKeyV2: creds.apiKeyV2,
        apiKeyV1: creds.apiKey,
        apiSecretV1: creds.apiSecret,
      });
    } catch (err) {
      console.warn(
        `[ps-108] billed-cost read failed for shipment ${row.shipmentId} (ss ${row.ssShipmentId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    plans.push(planParcelGuardBackfillRow(row, billed));
  }

  const affected = plans.filter((plan) => plan.affected);
  const summary = summarizeBackfillPlans(plans);

  if (asJson) {
    console.log(JSON.stringify({ mode: 'dry-run', summary, affected }, null, 2));
  } else {
    console.log('PS-108 ParcelGuard shipped-cost reconciliation — DRY RUN (no writes)\n');
    console.log(
      `Scanned ${summary.total} HUGRAB shipment(s): ${summary.affected} need correction, ` +
        `${summary.alreadyReconciled} already reconciled, ${summary.noBilledCost} without billed cost.`,
    );
    console.log(`Total premium to reconcile: $${(summary.totalPremiumCents / 100).toFixed(2)}\n`);
    for (const plan of affected) {
      console.log(
        [
          `order ${plan.orderNumber ?? '?'} (shipment ${plan.shipmentId}, ss ${plan.ssShipmentId ?? '?'})`,
          `  local: postage $${plan.localPostage.toFixed(2)} + other $${plan.localOtherCost.toFixed(2)} = $${plan.localTotal.toFixed(2)}`,
          `  ShipStation: postage $${plan.billedPostage.toFixed(2)} + premium $${plan.billedPremium.toFixed(2)} = $${plan.billedTotal.toFixed(2)} (${plan.provenance})`,
          `  would update: shipments.otherCost -> ${plan.updates?.otherCost}; selectedRateJson += {insuranceCost:${plan.updates?.selectedRateJsonPatch.insuranceCost}, totalCost:${plan.updates?.selectedRateJsonPatch.totalCost}}`,
        ].join('\n'),
      );
    }
    if (!affected.length) console.log('No postage-only HUGRAB shipments needing reconciliation.');
  }

  process.exit(0);
}

// Only run when invoked directly so importing this module in a test never connects.
const invokedDirectly =
  process.argv[1] != null && /ps-108-parcelguard-cost-backfill\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[ps-108] backfill failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { planParcelGuardBackfillRow, shipStationBilledSource };
