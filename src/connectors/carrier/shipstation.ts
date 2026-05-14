import {
  ssCreateLabel,
  ssVoidShipment,
  type CreateExternalLabelInput,
  type CreatedExternalLabel,
} from '../../lib/shipstation/labels';
import type { CarrierConnector } from '../../domain/fulfillment/types';

export function createShipStationCarrierConnector(): CarrierConnector<
  CreateExternalLabelInput,
  CreatedExternalLabel
> {
  return {
    provider: 'shipstation',
    createLabel: ssCreateLabel,
    voidLabel: ssVoidShipment,
  };
}

export const shipStationCarrierConnector = createShipStationCarrierConnector();
