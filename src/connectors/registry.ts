import { shipStationCarrierConnector } from './carrier/shipstation';
import { easyPostCarrierConnector } from './carrier/easypost';
import { shippCarrierConnector } from './carrier/shipp';
import { upsCarrierConnector } from './carrier/ups';
import { walmartShippingCarrierConnector } from './carrier/walmart-shipping';
import { shipStationStoreConnector } from './store/shipstation';
import { walmartStoreConnector } from './store/walmart';

export const carrierConnectors = {
  shipstation: shipStationCarrierConnector,
  shipp: shippCarrierConnector,
  easypost: easyPostCarrierConnector,
  walmart_shipping: walmartShippingCarrierConnector,
  ups: upsCarrierConnector,
};

export const storeConnectors = {
  shipstation: shipStationStoreConnector,
  walmart: walmartStoreConnector,
};
