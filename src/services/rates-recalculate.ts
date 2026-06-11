/**
 * rates-recalculate.ts — PS-175 (Phase 3, part 1): backend-owned strict
 * recalculation DECISION.
 *
 * The side-panel Recalculate must be a STRICT live update: any carrier that did
 * not complete live blocks the update; a clean no-rate result CLEARS the saved
 * best rate; only a clean live best with full account/service identity applies.
 * That decision used to live in the frontend (orders-parity
 * planStrictBestRateRecalculate, guard-pinned) — this module is the byte-
 * compatible backend port, computed on /rates/browse when the caller sends
 * `strictRecalculate: true`, so the business rule has a backend owner.
 *
 * Pure (no DB/network) so the offline guard can run the FULL decision matrix —
 * the same fixtures that pin the FE copy, which remains only as a deploy-skew
 * fallback until Phase 6 deletes it. Persist orchestration stays with the
 * existing strict endpoints for now (Phase 3 part 2 moves it server-side).
 */

export type StrictRecalculateCarrierStatus = {
  carrierId?: string | null;
  carrierName?: string | null;
  nickname?: string | null;
  status?: string | null;
};

export type StrictRecalculateDecision =
  | { action: 'blocked'; message: string }
  | { action: 'clear'; message: string }
  | { action: 'apply'; message: string; selectedPid: number; serviceCode: string };

function carrierLabel(status: StrictRecalculateCarrierStatus): string {
  const label =
    (typeof status.nickname === 'string' && status.nickname.trim()) ||
    (typeof status.carrierName === 'string' && status.carrierName.trim()) ||
    (typeof status.carrierId === 'string' && status.carrierId.trim()) ||
    'A carrier';
  return String(label);
}

/**
 * Byte-compatible port of the FE planStrictBestRateRecalculate semantics:
 *   - no carrier statuses at all → blocked (cannot confirm completion)
 *   - any status other than live/unavailable → blocked (cached/loading/error/blocked)
 *   - clean response without a usable positive best → clear
 *   - best missing account or service identity → blocked
 *   - otherwise → apply with the selected identity
 */
export function planStrictRecalculateDecision(input: {
  liveBestAmount: number | null;
  providerAccountId: number | null;
  serviceCode: string | null;
  carrierStatuses: StrictRecalculateCarrierStatus[];
}): StrictRecalculateDecision {
  if (!Array.isArray(input.carrierStatuses) || input.carrierStatuses.length === 0) {
    return { action: 'blocked', message: 'Recalculate could not confirm carrier completion. Try again.' };
  }

  const blockedStatus = input.carrierStatuses.find((carrier) => {
    const status = String(carrier.status ?? '').toLowerCase();
    return status !== 'live' && status !== 'unavailable';
  });
  if (blockedStatus) {
    const status = String(blockedStatus.status ?? 'unknown').toLowerCase();
    return {
      action: 'blocked',
      message: `${carrierLabel(blockedStatus)} did not complete live recalculation (${status}). No rate was updated.`,
    };
  }

  if (input.liveBestAmount == null || input.liveBestAmount <= 0) {
    return { action: 'clear', message: 'No live rates were returned for this shipment.' };
  }

  if (input.providerAccountId == null || !input.serviceCode) {
    return { action: 'blocked', message: 'Live best rate is missing account or service identity. No rate was updated.' };
  }

  return {
    action: 'apply',
    message: 'Live best rate applied.',
    selectedPid: input.providerAccountId,
    serviceCode: input.serviceCode,
  };
}

