import { shipStationCarrierConnector } from './carrier/shipstation';
import { easyPostCarrierConnector } from './carrier/easypost';
import { shippCarrierConnector } from './carrier/shipp';
import { upsCarrierConnector } from './carrier/ups';
import { walmartShippingCarrierConnector } from './carrier/walmart-shipping';
import { fedexCarrierConnector } from './carrier/fedex';
import { uspsCarrierConnector } from './carrier/usps';
import { shipEngineCarrierConnector } from './carrier/shipengine';
import { shipStationStoreConnector } from './store/shipstation';
import { walmartStoreConnector } from './store/walmart';
import { ebayStoreConnector } from './store/ebay';
import { shopifyStoreConnector } from './store/shopify';
import { amazonStoreConnector } from './store/amazon';

export const carrierConnectors = {
  shipstation: shipStationCarrierConnector,
  shipp: shippCarrierConnector,
  easypost: easyPostCarrierConnector,
  walmart_shipping: walmartShippingCarrierConnector,
  ups: upsCarrierConnector,
  fedex: fedexCarrierConnector,
  usps: uspsCarrierConnector,
  shipengine: shipEngineCarrierConnector,
};

export const storeConnectors = {
  shipstation: shipStationStoreConnector,
  walmart: walmartStoreConnector,
  ebay: ebayStoreConnector,
  shopify: shopifyStoreConnector,
  amazon: amazonStoreConnector,
};
