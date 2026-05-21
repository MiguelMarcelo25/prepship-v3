import {
  ssCreateLabel,
  ssVoidShipment,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels';
import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createShipStationCarrierConnector(): CarrierConnector<
  unknown,
  unknown,
  CreateExternalLabelInput,
  CreatedExternalLabel
> {
  return {
    provider: 'shipstation',
    capabilities: ['rates.quote', 'labels.create', 'labels.void', 'tracking.read'],
    getRates: async () => {
      throw new Error('ShipStation connector rates are handled by the existing rate service');
    },
    createLabel: ssCreateLabel,
    voidLabel: ssVoidShipment,
  };
}

export const shipStationCarrierConnector = createShipStationCarrierConnector();
