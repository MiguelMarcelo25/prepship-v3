import { sql as pg } from '../../db/client.js';
import { ensureOrderCompetitiveRateSchema } from '../../db/ensure-order-competitive-rate.js';
import { clientHouseAccountEnabled } from '../house-account-opt-in.js';
import { normalizeOrderBestRateDto, type OrderBestRateDto } from '../order-rate-dto.js';

// PS-220 — REALIZED house-margin capture (slice 3). At SHIPP label purchase, freeze the captured
// margin into the order_competitive_rate sidecar. It READS the projected next-best stamp written at
// best-rate SAVE (best_rate_json.nextBestNonHouseRate/houseMargin) — never re-fetches rates, never
// trusts the ephemeral purchase proof. drp_cost is the ACTUAL purchased SHIPP cost; customer_rate is
// the projected competitor (or = drp_cost when there was no competitor — pass-through, margin 0).

export type RealizedHouseMargin = {
  customerRate: number;
  margin: number;
  competitorCount: number;
  sourceCarrier: string | null;
  sourceService: string | null;
  sourceProviderAccountId: number | null;
};

/**
 * Pure: derive the realized house-margin record from the projected best-rate stamp + the actual
 * SHIPP cost paid. Returns null when the order carries no projected house stamp (houseMargin == null)
 * — i.e. it was not captured as a house order (rated before opt-in / not a SHIPP-winning save).
 */
export function houseMarginFromProjection(best: OrderBestRateDto | null, drpCost: number): RealizedHouseMargin | null {
  if (!best || best.houseMargin == null) return null;
  const competitor = best.nextBestNonHouseRate;
  const customerRate = competitor ? competitor.totalCost : drpCost; // no competitor => pass-through
  const margin = Math.max(0, Number((customerRate - drpCost).toFixed(2)));
  return {
    customerRate: Number(customerRate.toFixed(2)),
    margin,
    competitorCount: competitor ? 1 : 0,
    sourceCarrier: competitor?.carrierCode ?? null,
    sourceService: competitor?.serviceCode ?? null,
    sourceProviderAccountId: competitor?.providerAccountId ?? null,
  };
}

/** Best-effort realized capture. A failure NEVER affects the already-committed label (caller backgrounds it). */
export async function captureRealizedHouseMargin(input: {
  orderId: number;
  shipmentId: number;
  clientId: number | null;
  drpCost: number;
}): Promise<void> {
  if (!Number.isFinite(input.drpCost) || input.drpCost <= 0) return;
  if (!(await clientHouseAccountEnabled(input.clientId))) return;
  const rows = (await pg`
    SELECT best_rate_json FROM order_overrides WHERE order_id = ${input.orderId} LIMIT 1
  `) as Array<{ best_rate_json?: unknown }>;
  const best = normalizeOrderBestRateDto(rows[0]?.best_rate_json ?? null);
  const realized = houseMarginFromProjection(best, input.drpCost);
  if (!realized) return; // no projected house stamp -> not a captured house order
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
