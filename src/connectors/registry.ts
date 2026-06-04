import { shipStationCarrierConnector } from './carrier/shipstation.js';
import { easyPostCarrierConnector } from './carrier/easypost.js';
import { shippCarrierConnector } from './carrier/shipp.js';
import { upsCarrierConnector } from './carrier/ups.js';
import { walmartShippingCarrierConnector } from './carrier/walmart-shipping.js';
import { fedexCarrierConnector } from './carrier/fedex.js';
import { uspsCarrierConnector } from './carrier/usps.js';
import { shipEngineCarrierConnector } from './carrier/shipengine.js';
import { ebayShippingCarrierConnector } from './carrier/ebay-shipping.js';
import { amazonShippingCarrierConnector } from './carrier/amazon-shipping.js';
import { shipStationStoreConnector } from './store/shipstation.js';
import { walmartStoreConnector } from './store/walmart.js';
import { ebayStoreConnector } from './store/ebay.js';
import { shopifyStoreConnector } from './store/shopify.js';
import { amazonStoreConnector } from './store/amazon.js';

export const carrierConnectors = {
  shipstation: shipStationCarrierConnector,
  shipp: shippCarrierConnector,
  easypost: easyPostCarrierConnector,
  walmart_shipping: walmartShippingCarrierConnector,
  ups: upsCarrierConnector,
  fedex: fedexCarrierConnector,
  usps: uspsCarrierConnector,
  shipengine: shipEngineCarrierConnector,
  ebay_shipping: ebayShippingCarrierConnector,
  amazon_shipping: amazonShippingCarrierConnector,
};

export const storeConnectors = {
  shipstation: shipStationStoreConnector,
  walmart: walmartStoreConnector,
  ebay: ebayStoreConnector,
  shopify: shopifyStoreConnector,
  amazon: amazonStoreConnector,
};
