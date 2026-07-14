export type ShipStationDeletedAwaitingCandidate = {
  id: number;
  externalOrderId: string | null;
  orderStatus: string | null;
  canonicalStatus: string | null;
  externallyShipped: boolean | null;
  sourceProvider: string | null;
  hasActiveShipment: boolean;
};

const SHIPSTATION_ORDER_ID = /^\d+$/;

/**
 * Selects local awaiting rows that are absent from a complete ShipStation
 * awaiting snapshot and are safe to verify by exact provider id.
 */
export function selectShipStationDeletedAwaitingCandidates(
  rows: readonly ShipStationDeletedAwaitingCandidate[],
  liveSourceOrderIds: ReadonlySet<string>,
  limit = 1,
): ShipStationDeletedAwaitingCandidate[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  return rows
    .filter((row) => {
      const externalOrderId = String(row.externalOrderId ?? '').trim();
      return (
        row.orderStatus === 'awaiting_shipment' &&
        row.canonicalStatus !== 'cancelled' &&
        row.externallyShipped !== true &&
        row.sourceProvider === 'shipstation' &&
        row.hasActiveShipment === false &&
        SHIPSTATION_ORDER_ID.test(externalOrderId) &&
        !liveSourceOrderIds.has(externalOrderId)
      );
    })
    .slice(0, boundedLimit);
}
