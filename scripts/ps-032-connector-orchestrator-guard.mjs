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
const ratesService = read('src/services/rates.ts');
const labelsService = read('src/services/labels.ts');
const shipStationStoreConnector = read('src/connectors/store/shipstation.ts');
const ratesRoute = read('src/routes/rates.ts');
const packagesRoute = read('src/routes/packages.ts');
const initRoute = read('src/routes/init.ts');
const shipStationCarrierConnector = read('src/connectors/carrier/shipstation.ts');
const walmartOrdersRoute = read('api/carriers/walmart/orders.ts');
const ebayOrdersRoute = read('api/carriers/ebay/orders.ts');
const carrierRatesRoute = read('api/carriers/rates.ts');
const carrierLabelsRoute = read('api/carriers/labels.ts');
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
const amazonShippingCarrierConnector = read('src/connectors/carrier/amazon-shipping.ts');
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
  'listCarrierAccounts',
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
  carrierLabelsRoute.includes("confirmStoreShipment('walmart'") &&
    !carrierLabelsRoute.includes('confirmWalmartOrderShipped') &&
    !carrierLabelsRoute.includes('/v3/orders/${encodeURIComponent(input.purchaseOrderId)}/shipping'),
  'Walmart post-label marketplace confirmation must route through StoreConnector orchestration, not direct Walmart confirmation calls from api/carriers/labels.ts',
);
assert(
  walmartStoreConnector.includes('/v3/orders/${encodeURIComponent(purchaseOrderId)}/shipping') &&
    walmartStoreConnector.includes('confirmShipment'),
  'Walmart StoreConnector must own Walmart marketplace shipment confirmation API calls',
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
  carrierLabelsRoute.includes('createCarrierLabel') &&
    !carrierLabelsRoute.includes('buyLabelUps') &&
    !carrierLabelsRoute.includes('https://onlinetools.ups.com/api/shipments/v2403/ship'),
  'UPS labels must route through CarrierConnector orchestration, not direct UPS label API calls from api/carriers/labels.ts',
);
assert(
  upsCarrierConnector.includes('https://onlinetools.ups.com/api/shipments/v2403/ship') &&
    !upsCarrierConnector.includes('UPS labels are handled by api/carriers/labels.ts'),
  'UPS CarrierConnector must own UPS label API calls',
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
  !carrierLabelsRoute.includes('buyLabelEasyPost') &&
    !carrierLabelsRoute.includes('https://api.easypost.com/v2/shipments'),
  'EasyPost labels must route through CarrierConnector orchestration, not direct EasyPost label API calls from api/carriers/labels.ts',
);
assert(
  easyPostCarrierConnector.includes('/v2/shipments') &&
    easyPostCarrierConnector.includes('/buy') &&
    !easyPostCarrierConnector.includes('EasyPost labels are handled by api/carriers/labels.ts'),
  'EasyPost CarrierConnector must own EasyPost label API calls',
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
  carrierLabelsRoute.includes("createCarrierLabel('shipp'") &&
    !carrierLabelsRoute.includes('buyLabelShipp') &&
    !carrierLabelsRoute.includes('https://shipp.to/api'),
  'Shipp labels must route through CarrierConnector orchestration, not direct Shipp API calls from api/carriers/labels.ts',
);
assert(
  shippCarrierConnector.includes('https://shipp.to/api/shipping/label/create') &&
    !shippCarrierConnector.includes('Shipp labels are handled by api/carriers/labels.ts'),
  'Shipp CarrierConnector must own Shipp label API calls',
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
  carrierLabelsRoute.includes("createCarrierLabel('walmart_shipping'") &&
    !carrierLabelsRoute.includes('buyLabelWalmartShipping') &&
    !carrierLabelsRoute.includes('/v3/shipping/labels/shipping-estimates') &&
    !carrierLabelsRoute.includes('/v3/shipping/labels/carriers/') &&
    !carrierLabelsRoute.includes('/v3/shipping/labels/${encodeURIComponent(labelId)}') &&
    !carrierLabelsRoute.includes("'https://marketplace.walmartapis.com/v3/shipping/labels'"),
  'Walmart Shipping labels must route through CarrierConnector orchestration, not direct Walmart Shipping label API calls from api/carriers/labels.ts',
);
assert(
  walmartShippingCarrierConnector.includes('/v3/shipping/labels') &&
    !walmartShippingCarrierConnector.includes('Walmart Shipping labels are handled by api/carriers/labels.ts'),
  'Walmart Shipping CarrierConnector must own Walmart Shipping label API calls',
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
assert(
  !carrierRatesRoute.includes('ratesFromAmazonBuyShipping') &&
    !carrierRatesRoute.includes('api.amazon.com/auth/o2/token') &&
    !carrierRatesRoute.includes('sellingpartnerapi-na.amazon.com/shipping/v2/shipments/rates'),
  'Amazon Shipping rates must route through CarrierConnector orchestration, not direct Amazon Shipping API calls from api/carriers/rates.ts',
);
assert(
  amazonShippingCarrierConnector.includes('sellingpartnerapi-na.amazon.com/shipping/v2/shipments/rates') &&
    amazonShippingCarrierConnector.includes('getRates'),
  'Amazon Shipping CarrierConnector must own Amazon Shipping rate API calls',
);
assert(
  ratesRoute.includes('listCarrierAccounts') && !ratesRoute.includes('ssRequest'),
  'rates route carrier listing must use CarrierConnector orchestration, not direct ShipStation API calls',
);
assert(
  shipStationCarrierConnector.includes('/v2/carriers') &&
    shipStationCarrierConnector.includes('listCarrierAccounts'),
  'ShipStation CarrierConnector must own ShipStation carrier account listing calls',
);
assert(
  ratesService.includes('listCarrierAccounts') && !ratesService.includes("ssRequest<CarriersResponse>('/v2/carriers'"),
  'rates service carrier discovery must use CarrierConnector orchestration, not direct ShipStation /v2/carriers calls',
);
assert(
  ratesService.includes('quoteCarrierRates') && !ratesService.includes("ssRequest<EstimateRate[] | { rates?: EstimateRate[] }>"),
  'rates service ShipStation estimates must use CarrierConnector orchestration, not direct ShipStation /v2/rates/estimate calls',
);
assert(
  shipStationCarrierConnector.includes('/v2/rates/estimate') &&
    shipStationCarrierConnector.includes('ssRequest<'),
  'ShipStation CarrierConnector must own ShipStation rate estimate API calls',
);
assert(
  packagesRoute.includes('listCarrierAccounts') && !packagesRoute.includes('ssRequest'),
  'packages route ShipStation package sync must use CarrierConnector orchestration, not direct ShipStation API calls',
);
assert(
  initRoute.includes('listCarrierAccounts') && !initRoute.includes('ssRequest'),
  'init route ShipStation carrier bootstrap must use CarrierConnector orchestration, not direct ShipStation API calls',
);
assert(
  labelsService.includes('listCarrierAccounts') &&
    !labelsService.includes("ssRequest<CarriersResponse>('/v2/carriers'"),
  'labels service carrier nickname resolver must use CarrierConnector orchestration, not direct ShipStation /v2/carriers calls',
);
assert(
  labelsService.includes('createCarrierLabel') &&
    !labelsService.includes('ssRequest<Label>(`/v2/labels/rates/${input.rateId}`') &&
    !labelsService.includes("ssRequest<Label>('/v2/labels'"),
  'labels service ShipStation label purchase helpers must use CarrierConnector orchestration, not direct ShipStation label API calls',
);
assert(
  shipStationCarrierConnector.includes('/v2/labels/rates/') &&
    shipStationCarrierConnector.includes("'/v2/labels'") &&
    shipStationCarrierConnector.includes('ssRequest<Label>'),
  'ShipStation CarrierConnector must own legacy ShipStation label purchase API calls',
);

assert.equal(
  packageJson.scripts?.['test:ps-032-connector-orchestrators'],
  'node scripts/ps-032-connector-orchestrator-guard.mjs',
  'package.json missing test:ps-032-connector-orchestrators script',
);

console.log('PS-032 connector orchestrator guard passed.');
