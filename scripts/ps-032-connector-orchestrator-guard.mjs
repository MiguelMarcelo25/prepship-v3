import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(file) {
  assert(existsSync(file), `missing ${file}`);
  return readFileSync(file, 'utf8');
}

const fulfillmentTypes = read('src/domain/fulfillment/types.ts');
const connectorTypes = read('src/connectors/types.ts');
const storeResolution = read('src/connectors/store-resolution.ts');
const carrierResolution = read('src/connectors/carrier-resolution.ts');
const storeOrchestrator = read('src/services/store-connector-orchestrator.ts');
const carrierOrchestrator = read('src/services/carrier-connector-orchestrator.ts');
const orderSync = read('src/services/order-sync.ts');
const shipStationStoreConnector = read('src/connectors/store/shipstation.ts');
const walmartOrdersRoute = read('api/carriers/walmart/orders.ts');
const ebayOrdersRoute = read('api/carriers/ebay/orders.ts');
const carrierRatesRoute = read('api/carriers/rates.ts');
const walmartStoreConnector = read('src/connectors/store/walmart.ts');
const ebayStoreConnector = read('src/connectors/store/ebay.ts');
const upsCarrierConnector = read('src/connectors/carrier/ups.ts');
const easyPostCarrierConnector = read('src/connectors/carrier/easypost.ts');
const shippCarrierConnector = read('src/connectors/carrier/shipp.ts');
const walmartShippingCarrierConnector = read('src/connectors/carrier/walmart-shipping.ts');
const fedexCarrierConnector = read('src/connectors/carrier/fedex.ts');
const uspsCarrierConnector = read('src/connectors/carrier/usps.ts');
const shipEngineCarrierConnector = read('src/connectors/carrier/shipengine.ts');
const ebayShippingCarrierConnector = read('src/connectors/carrier/ebay-shipping.ts');
const packageJson = JSON.parse(read('package.json'));

assert(
  fulfillmentTypes.includes("from '../../connectors/types'"),
  'fulfillment domain types must re-export the canonical connector contracts from src/connectors/types.ts',
);
assert(
  !fulfillmentTypes.includes('export interface StoreConnector'),
  'fulfillment domain types must not declare a duplicate StoreConnector interface',
);
assert(
  !fulfillmentTypes.includes('export interface CarrierConnector'),
  'fulfillment domain types must not declare a duplicate CarrierConnector interface',
);

for (const symbol of [
  'StoreConnector',
  'CarrierConnector',
  'ShipmentConfirmationInput',
  'ConfirmationResult',
  'NormalizedStoreOrderImportResult',
  'NormalizedCarrierRateQuoteResult',
  'NormalizedCarrierLabelResult',
]) {
  assert(connectorTypes.includes(symbol), `canonical connector types missing ${symbol}`);
}

assert(
  storeResolution.includes("from './types'") && !storeResolution.includes('../domain/fulfillment/types'),
  'store connector resolver must use canonical connector types directly',
);
assert(
  carrierResolution.includes("from './types'"),
  'carrier connector resolver must use canonical connector types directly',
);

for (const required of [
  'resolveStoreConnector',
  'importStoreOrders',
  'syncStoreOrderStatuses',
  'fetchStoreOrder',
  'confirmStoreShipment',
]) {
  assert(storeOrchestrator.includes(required), `store connector orchestrator missing ${required}`);
}

for (const required of [
  'resolveCarrierConnector',
  'quoteCarrierRates',
  'createCarrierLabel',
  'voidCarrierLabel',
  'trackCarrierShipment',
]) {
  assert(carrierOrchestrator.includes(required), `carrier connector orchestrator missing ${required}`);
}

assert(
  orderSync.includes('importStoreOrders'),
  'ShipStation order sync must call StoreConnector import orchestration',
);
assert(
  !orderSync.includes('ssV1Request'),
  'ShipStation order sync must not call ssV1Request directly from core service code',
);
assert(
  shipStationStoreConnector.includes('ssV1Request') &&
    shipStationStoreConnector.includes('importOrders'),
  'ShipStation StoreConnector must own ShipStation order API import calls',
);
assert(
  walmartOrdersRoute.includes('importStoreOrders') &&
    !walmartOrdersRoute.includes('marketplace.walmartapis.com'),
  'Walmart order route must call StoreConnector import orchestration, not Walmart API directly',
);
assert(
  ebayOrdersRoute.includes('importStoreOrders') &&
    !ebayOrdersRoute.includes('api.ebay.com') &&
    !ebayOrdersRoute.includes('api.sandbox.ebay.com'),
  'eBay order route must call StoreConnector import orchestration, not eBay API directly',
);
assert(
  walmartStoreConnector.includes('marketplace.walmartapis.com') &&
    walmartStoreConnector.includes('importOrders'),
  'Walmart StoreConnector must own Walmart order API import calls',
);
assert(
  ebayStoreConnector.includes('api.ebay.com') &&
    ebayStoreConnector.includes('importOrders'),
  'eBay StoreConnector must own eBay order API import calls',
);
assert(
  carrierRatesRoute.includes('quoteCarrierRates') &&
    !carrierRatesRoute.includes('ratesFromUps') &&
    !carrierRatesRoute.includes('onlinetools.ups.com'),
  'UPS rates must route through CarrierConnector orchestration, not direct UPS API calls from api/carriers/rates.ts',
);
assert(
  upsCarrierConnector.includes('onlinetools.ups.com') &&
    upsCarrierConnector.includes('getRates'),
  'UPS CarrierConnector must own UPS rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromEasyPost') &&
    !carrierRatesRoute.includes('api.easypost.com'),
  'EasyPost rates must route through CarrierConnector orchestration, not direct EasyPost API calls from api/carriers/rates.ts',
);
assert(
  easyPostCarrierConnector.includes('api.easypost.com') &&
    easyPostCarrierConnector.includes('getRates'),
  'EasyPost CarrierConnector must own EasyPost rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromShipp') &&
    !carrierRatesRoute.includes('https://shipp.to/api'),
  'Shipp rates must route through CarrierConnector orchestration, not direct Shipp API calls from api/carriers/rates.ts',
);
assert(
  shippCarrierConnector.includes('https://shipp.to/api') &&
    shippCarrierConnector.includes('getRates'),
  'Shipp CarrierConnector must own Shipp rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromWalmartShipping') &&
    !carrierRatesRoute.includes('getWalmartAccessTokenForRates') &&
    !carrierRatesRoute.includes('marketplace.walmartapis.com'),
  'Walmart Shipping rates must route through CarrierConnector/StoreConnector-owned code, not direct Walmart API calls from api/carriers/rates.ts',
);
assert(
  walmartShippingCarrierConnector.includes('/v3/shipping/labels/shipping-estimates') &&
    walmartShippingCarrierConnector.includes('getRates'),
  'Walmart Shipping CarrierConnector must own Walmart Shipping Estimates API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromFedex') &&
    !carrierRatesRoute.includes('getFedexAccessToken') &&
    !carrierRatesRoute.includes('apis.fedex.com'),
  'FedEx rates must route through CarrierConnector orchestration, not direct FedEx API calls from api/carriers/rates.ts',
);
assert(
  fedexCarrierConnector.includes('apis.fedex.com') &&
    fedexCarrierConnector.includes('getRates'),
  'FedEx CarrierConnector must own FedEx rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromUsps') &&
    !carrierRatesRoute.includes('getUspsAccessToken') &&
    !carrierRatesRoute.includes('apis.usps.com'),
  'USPS rates must route through CarrierConnector orchestration, not direct USPS API calls from api/carriers/rates.ts',
);
assert(
  uspsCarrierConnector.includes('apis.usps.com') &&
    uspsCarrierConnector.includes('getRates'),
  'USPS CarrierConnector must own USPS rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromShipEngine') &&
    !carrierRatesRoute.includes('shipEngineCarrierIds') &&
    !carrierRatesRoute.includes('api.shipengine.com'),
  'ShipEngine rates must route through CarrierConnector orchestration, not direct ShipEngine API calls from api/carriers/rates.ts',
);
assert(
  shipEngineCarrierConnector.includes('api.shipengine.com') &&
    shipEngineCarrierConnector.includes('getRates'),
  'ShipEngine CarrierConnector must own ShipEngine rate API calls',
);
assert(
  !carrierRatesRoute.includes('ratesFromEbayShipping') &&
    !carrierRatesRoute.includes('getEbayLogisticsAccessToken') &&
    !carrierRatesRoute.includes('/sell/logistics/v1_beta/shipping_quote'),
  'eBay Shipping rates must route through CarrierConnector orchestration, not direct eBay Logistics API calls from api/carriers/rates.ts',
);
assert(
  ebayShippingCarrierConnector.includes('/sell/logistics/v1_beta/shipping_quote') &&
    ebayShippingCarrierConnector.includes('getRates'),
  'eBay Shipping CarrierConnector must own eBay Logistics rate API calls',
);

assert.equal(
  packageJson.scripts?.['test:ps-032-connector-orchestrators'],
  'node scripts/ps-032-connector-orchestrator-guard.mjs',
  'package.json missing test:ps-032-connector-orchestrators script',
);

console.log('PS-032 connector orchestrator guard passed.');
