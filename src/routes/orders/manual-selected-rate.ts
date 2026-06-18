/**
 * PS-291 (slice, card DoD item 6) — persist the SELECTED preview rate onto a
 * saved manual order in the CANONICAL best-rate shape.
 *
 * When the operator picks a rate in the New Order modal's preview and saves,
 * the chosen rate (carrier/service/amount + account nickname) must be carried
 * onto the created order so Create Label / Print Queue reuse it WITHOUT a silent
 * re-rate. The canonical persisted owner of that fact is
 * order_overrides.bestRateJson, normalized by normalizeOrderBestRateDto (the
 * SAME owner the PATCH best-rate path delegates to — ARCHITECTURE.md: rate truth
 * lives in src/services/order-rate-dto.ts, callers delegate, never re-derive).
 *
 * This module is a thin, pure adapter: it maps the modal's selected-rate input
 * into the normalizer's tolerated input keys and returns the canonical DTO (or
 * null when there is no usable selection). It NEVER computes a price, picks a
 * cheapest, or invents a rate — the backend rate quoter already produced the
 * numbers the modal echoed back here.
 */
import {
  normalizeOrderBestRateDto,
  type OrderBestRateDto,
} from '../../services/order-rate-dto';

/**
 * The selected-preview-rate payload the New Order modal sends back. All fields
 * are the verbatim values the backend rate quoter returned for the chosen row;
 * the modal does not reformat or recompute them.
 */
export interface ManualSelectedRateInput {
  carrierCode?: string | null;
  serviceCode?: string | null;
  serviceName?: string | null;
  /** Account nickname shown in the preview (Rate Browser parity). */
  carrierNickname?: string | null;
  /** Provider account id, when the quoted rate carried one. */
  shippingProviderId?: number | null;
  /** Postage cost of the selected rate (USD). */
  shipmentCost?: number | null;
  /** Surcharges/other cost folded by the quoter (USD). */
  otherCost?: number | null;
  /** Pre-summed total, when the modal carried it. */
  cost?: number | null;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the canonical OrderBestRateDto from the operator's selected manual
 * preview rate. Returns null when there is no selection or the selection has no
 * usable carrier/service/cost (the normalizer's own meaningful-field gate).
 *
 * `proofSource: 'manual_preview'` marks the provenance: this best rate came from
 * the New Order modal preview the operator confirmed, not a Rate Browser SAVE
 * or a re-rate. Create Label / Print Queue read bestRateJson the same way
 * regardless of provenance.
 */
export function buildManualSelectedBestRate(
  selected: ManualSelectedRateInput | null | undefined,
): OrderBestRateDto | null {
  if (!selected) return null;

  const shipmentCost = finiteOrUndefined(selected.shipmentCost);
  const otherCost = finiteOrUndefined(selected.otherCost);
  const total = finiteOrUndefined(selected.cost);
  // Fall the postage back to the summed total when the modal only carried `cost`
  // (the preview row's displayed amount = shipmentCost + otherCost).
  const resolvedShipmentCost = shipmentCost ?? total ?? 0;

  return normalizeOrderBestRateDto(
    {
      carrierCode: selected.carrierCode ?? null,
      serviceCode: selected.serviceCode ?? null,
      serviceName: selected.serviceName ?? selected.serviceCode ?? null,
      carrierNickname: selected.carrierNickname ?? null,
      shippingProviderId: selected.shippingProviderId ?? null,
      shipmentCost: resolvedShipmentCost,
      otherCost: otherCost ?? 0,
      totalCost: total ?? null,
      proofSource: 'manual_preview',
    },
    'manualSelectedRate',
  );
}
