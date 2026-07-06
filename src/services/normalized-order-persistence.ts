import { buildOrderSourceIdentity } from './order-source-identity';

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
  const identity = buildOrderSourceIdentity(input);
  if (!identity) {
    throw new Error('Normalized order source requires sourceProvider, sourceAccountId, and sourceOrderId');
  }
  return {
    sourceProvider: identity.sourceProvider,
    sourceAccountId: identity.sourceAccountId,
    sourceOrderId: identity.sourceOrderId,
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
