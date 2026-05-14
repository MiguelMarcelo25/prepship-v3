import {
  asSSUpstreamOrderId,
  ssMarkOrderShippedV1,
} from '../../lib/shipstation/labels';
import type {
  ConfirmationResult,
  ShipmentConfirmationInput,
  StoreConnector,
} from '../../domain/fulfillment/types';

export function createShipStationStoreConnector(): StoreConnector {
  return {
    provider: 'shipstation',
    async confirmShipment(input: ShipmentConfirmationInput): Promise<ConfirmationResult> {
      const upstreamOrderId = asSSUpstreamOrderId(input.externalOrderId);
      if (!upstreamOrderId) {
        return {
          ok: false,
          provider: 'shipstation',
          retryable: false,
          message: `externalOrderId="${input.externalOrderId ?? '(null)'}" is missing or not a ShipStation order id`,
        };
      }

      await ssMarkOrderShippedV1(
        {
          orderId: upstreamOrderId,
          carrierCode: input.carrierCode,
          trackingNumber: input.trackingNumber,
          shipDate: input.shipDate,
          notifyCustomer: input.notifyCustomer ?? false,
          notifySalesChannel: input.notifyMarketplace ?? true,
        },
        {
          apiKey: input.credentials?.apiKey ?? undefined,
          apiSecret: input.credentials?.apiSecret ?? undefined,
        },
      );

      return { ok: true, provider: 'shipstation' };
    },
  };
}

export const shipStationStoreConnector = createShipStationStoreConnector();
