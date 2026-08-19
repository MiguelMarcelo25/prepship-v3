import { sql as pg } from '../../db/client.js';
import { ensureOrderCompetitiveRateSchema } from '../../db/ensure-order-competitive-rate.js';
import { shippingMarginPolicyForClient } from '../house-account-opt-in.js';
import { normalizeOrderBestRateDto } from '../order-rate-dto.js';
import { planRealizedHouseCapture } from './house-margin-derivation.js';

// PS-220 — REALIZED house-margin capture (slice 3). At SHIPP label purchase, freeze the captured
// margin into the order_competitive_rate sidecar. It READS the projected next-best stamp written at
// best-rate SAVE (best_rate_json.nextBestNonHouseRate/houseMargin) — never re-fetches rates, never
// trusts the ephemeral purchase proof. drp_cost is the ACTUAL purchased SHIPP cost; customer_rate is
// the projected competitor (or = drp_cost when there was no competitor — pass-through, margin 0).

/**
 * PS-508: the two pure derivers moved to ./house-margin-derivation.js so they can be imported
 * without executing db/client (this module's first line does). Re-exported here so labels.ts and
 * the five PS-220/PS-292/PS-295 guards that import them from this path keep working unchanged.
 */
export {
  houseMarginFromProjection,
  planRealizedHouseCapture,
  type RealizedHouseMargin,
} from './house-margin-derivation.js';

/** Best-effort realized capture. A failure NEVER affects the already-committed label (caller backgrounds it). */
export async function captureRealizedHouseMargin(input: {
  orderId: number;
  shipmentId: number;
  clientId: number | null;
  drpCost: number;
}): Promise<void> {
  // Cheap gates first to avoid the best_rate_json read when we already know we won't write:
  // invalid cost (free) then the opt-in check (one query). The pure planner re-validates them so
  // the full gate is provable offline; live behavior + ordering stay byte-identical.
  if (!Number.isFinite(input.drpCost) || input.drpCost <= 0) return;
  const shippingMarginPolicy = await shippingMarginPolicyForClient(input.clientId);
  if (shippingMarginPolicy.mode !== 'next_best_customer_rate') return;
  const rows = (await pg`
    SELECT best_rate_json FROM order_overrides WHERE order_id = ${input.orderId} LIMIT 1
  `) as Array<{ best_rate_json?: unknown }>;
  const best = normalizeOrderBestRateDto(rows[0]?.best_rate_json ?? null);
  const realized = planRealizedHouseCapture({
    drpCost: input.drpCost,
    optedIn: shippingMarginPolicy.legacyHouseAccountEnabled,
    shippingMarginPolicy,
    best,
  });
  if (!realized) return; // gate said skip -> not a captured house order
  await ensureOrderCompetitiveRateSchema();
  await pg`
    INSERT INTO order_competitive_rate
      (order_id, shipment_id, client_id, drp_cost, customer_rate, margin, source,
       source_carrier, source_service, source_provider_account_id, competitor_count, is_house_order, quote_fingerprint)
    VALUES (
      ${input.orderId}, ${input.shipmentId}, ${input.clientId},
      ${input.drpCost.toFixed(2)}, ${realized.customerRate.toFixed(2)}, ${realized.margin.toFixed(2)}, 'realized',
      ${realized.sourceCarrier}, ${realized.sourceService}, ${realized.sourceProviderAccountId},
      ${realized.competitorCount}, true, ${best?.requestFingerprint ?? null}
    )
    ON CONFLICT (order_id, shipment_id) WHERE shipment_id IS NOT NULL DO NOTHING
  `;
}
