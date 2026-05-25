export type NormalizedOrderSource = {
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: string;
  sourceOrderNumber: string | null;
  rawSourcePayload: Record<string, unknown>;
};

export function buildNormalizedOrderSource(input: {
  sourceProvider: string;
  sourceAccountId: string;
  sourceOrderId: number | string;
  sourceOrderNumber?: string | null;
  raw: Record<string, unknown>;
}): NormalizedOrderSource {
  return {
    sourceProvider: input.sourceProvider,
    sourceAccountId: input.sourceAccountId,
    sourceOrderId: String(input.sourceOrderId),
    sourceOrderNumber: input.sourceOrderNumber ?? null,
    rawSourcePayload: input.raw,
  };
}

export function buildShipStationOrderSource(input: {
  orderId: number | string;
  orderNumber?: string | null;
  storeId?: number | null;
  raw: Record<string, unknown>;
}): NormalizedOrderSource {
  return buildNormalizedOrderSource({
    sourceProvider: 'shipstation',
    sourceAccountId: input.storeId != null ? `store:${input.storeId}` : 'shipstation-default',
    sourceOrderId: input.orderId,
    sourceOrderNumber: input.orderNumber ?? null,
    raw: input.raw,
  });
}
