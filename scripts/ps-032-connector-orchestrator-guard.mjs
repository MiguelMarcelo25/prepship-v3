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

assert.equal(
  packageJson.scripts?.['test:ps-032-connector-orchestrators'],
  'node scripts/ps-032-connector-orchestrator-guard.mjs',
  'package.json missing test:ps-032-connector-orchestrators script',
);

console.log('PS-032 connector orchestrator guard passed.');
