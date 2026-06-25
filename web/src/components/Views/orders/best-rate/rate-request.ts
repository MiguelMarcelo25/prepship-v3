// PS-317: pure Best-Rate request builders, moved verbatim out of OrdersView.
// The FE only shapes the request it sends to the backend rate API; the backend owns the
// rate decision. PS-143: the draft key stays independent of the backend response fingerprint.
import { SHIPPING_SERVICE_ELIGIBILITY_VERSION } from '../../../../../../src/lib/shipping-service-eligibility';
import { residentialForRate as residentialForRateRule } from '../../../../lib/residential-for-rate';
import { normalizeRateZip, rateShipDateBucket } from '../rate-request-normalizers';
import { getShipTo } from '../../orders-items';
import { normalizeConfirmationForRates } from '../../orders-rate-input';
import type { OrderFullDto } from '../../../../types/api';

// The canonical FE rate-request shape (what buildStrictBestRateRequest returns). Named so the
// pure proof/display helpers can type their `request` param without depending on OrdersView.
export type StrictBestRateRequest = {
  detail: OrderFullDto | null;
  dims: { length: number; width: number; height: number };
  dimsLabel: string;
  weightOz: number;
  shipTo: ReturnType<typeof getShipTo>;
  confirmation: ReturnType<typeof normalizeConfirmationForRates>;
  carrierIds: string[];
  insuranceProvider: string;
  insuredValue: number | null;
  draftKey: string;
  key: string;
};

// PS-276/280: forward the backend residential verdict (one FE owner, no drift). The backend
// OWNS the classification; the FE only forwards it; a missing verdict stays residential-safe.
export function residentialForRate(order: any): boolean {
  return residentialForRateRule(order);
}

// PS-143: the FE-local cache/identity key, built from request inputs only — never from the
// backend response fingerprint, so it can't "agree" with a stale rate and reuse a wrong one.
export function buildRateRequestDraftKey(input: {
  weightOz: number;
  dims: { length: number; width: number; height: number };
  shipTo: ReturnType<typeof getShipTo>;
  residential: boolean;
  carrierIds: string[];
  storeId?: number | null;
  clientId?: number | null;
  confirmation?: string | null;
  insuranceProvider?: string | null;
  insuredValue?: number | null;
}) {
  const parts = [
    `v=ground-saver-v2|eligibility=${SHIPPING_SERVICE_ELIGIBILITY_VERSION}`,
    `d=${rateShipDateBucket()}`,
    `w=${Math.round(input.weightOz * 10)}`,
    `z=${normalizeRateZip(input.shipTo.postalCode)}`,
    `co=${(input.shipTo.country ?? 'US').toUpperCase()}`,
  ];
  if (input.shipTo.state) parts.push(`st=${input.shipTo.state.trim().toUpperCase()}`);
  if (input.shipTo.city) parts.push(`ci=${input.shipTo.city.trim().toLowerCase().replace(/\s+/g, '-')}`);
  parts.push(input.residential ? 'r=1' : 'r=0');
  if (input.clientId != null) parts.push(`cl=${input.clientId}`);
  else if (input.storeId != null) parts.push(`st=${input.storeId}`);
  parts.push(`l=${Math.round(input.dims.length * 10)}`);
  parts.push(`dw=${Math.round(input.dims.width * 10)}`);
  parts.push(`h=${Math.round(input.dims.height * 10)}`);
  if (input.confirmation) parts.push(`cf=${input.confirmation}`);
  if (input.insuranceProvider && input.insuranceProvider !== 'none' && input.insuredValue) {
    parts.push(`ip=${input.insuranceProvider}`);
    parts.push(`iv=${Math.round(input.insuredValue * 100)}`);
  }
  if (input.carrierIds.length) parts.push(`c=${[...input.carrierIds].sort().join(',')}`);
  return parts.join('|');
}
