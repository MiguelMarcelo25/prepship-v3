export type NormalizedOrderSource = {
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: string;
  sourceOrderNumber: string | null;
  rawSourcePayload: Record<string, unknown>;
};

export function buildShipStationOrderSource(input: {
  orderId: number | string;
  orderNumber?: string | null;
  storeId?: number | null;
  raw: Record<string, unknown>;
}): NormalizedOrderSource {
  return {
    sourceProvider: 'shipstation',
    sourceAccountId: input.storeId != null ? `store:${input.storeId}` : 'shipstation-default',
    sourceOrderId: String(input.orderId),
    sourceOrderNumber: input.orderNumber ?? null,
    rawSourcePayload: input.raw,
  };
}
