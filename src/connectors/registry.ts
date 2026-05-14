import { shipStationCarrierConnector } from './carrier/shipstation';
import { shipStationStoreConnector } from './store/shipstation';
import { walmartStoreConnector } from './store/walmart';

export const carrierConnectors = {
  shipstation: shipStationCarrierConnector,
};

export const storeConnectors = {
  shipstation: shipStationStoreConnector,
  walmart: walmartStoreConnector,
};
