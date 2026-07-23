export type ShipmentSyncFairnessCandidate<T> = {
  account: T;
  accountId: string;
  watermarkMs: number | null;
};

/**
 * Oldest durable progress gets the next bounded turn. Accounts without a
 * watermark sort first, so each initial catalog/account is visited before a
 * recently completed account loops again.
 */
export function orderShipmentSyncAccountsByWatermark<
  T extends ShipmentSyncFairnessCandidate<unknown>,
>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const leftWatermark = left.watermarkMs ?? Number.NEGATIVE_INFINITY;
    const rightWatermark = right.watermarkMs ?? Number.NEGATIVE_INFINITY;
    if (leftWatermark !== rightWatermark) return leftWatermark - rightWatermark;
    return left.accountId.localeCompare(right.accountId);
  });
}
