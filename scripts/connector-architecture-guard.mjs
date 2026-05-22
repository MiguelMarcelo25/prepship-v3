import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const types = read('src/connectors/types.ts');
const matrix = read('src/connectors/matrix.ts');
const statusMatrix = read('src/connectors/implementation-status.ts');
const registry = read('src/connectors/registry.ts');
const carrierResolution = read('src/connectors/carrier-resolution.ts');
const storeResolution = read('src/connectors/store-resolution.ts');
const migration = read('drizzle/0032_connector_architecture.sql');
const ordersSchema = read('src/db/schema/orders.ts');
const shipmentsSchema = read('src/db/schema/shipments.ts');
const normalizedOrderPersistence = read('src/services/normalized-order-persistence.ts');
const orderSync = read('src/services/order-sync.ts');
const directLabelPersistence = read('src/services/direct-label-persistence.ts');
const carrierLabels = read('api/carriers/labels.ts');
const carrierRates = read('api/carriers/rates.ts');
const carrierStatus = read('scripts/status-carriers.ts');
const fulfillmentOutbox = read('src/services/fulfillment/outbox.ts');
const packageJson = JSON.parse(read('package.json'));

for (const iface of [
  'StoreConnector',
  'CarrierConnector',
  'MarketplaceConfirmationConnector',
  'InventoryConnector',
  'ProductCatalogConnector',
  'TrackingConnector',
  'ReturnConnector',
  'CredentialAuthConnector',
  'WebhookConnector',
]) {
  assert(types.includes(`interface ${iface}`), `missing connector interface ${iface}`);
}

for (const provider of [
  'shipstation',
  'walmart',
  'walmart_shipping',
  'shipp',
  'easypost',
  'ups',
  'ebay',
  'shopify',
]) {
  assert(matrix.includes(`${provider}:`), `connector matrix missing ${provider}`);
  assert(statusMatrix.includes(`${provider}:`), `implementation status matrix missing ${provider}`);
}

for (const capability of [
  'orders.import',
  'rates.quote',
  'labels.create',
  'shipment.confirm',
  'credentials.verify',
  'webhooks.receive',
]) {
  assert(matrix.includes(capability), `connector matrix missing capability ${capability}`);
}

for (const status of ['live', 'registered_stub', 'blocked_external_contract']) {
  assert(statusMatrix.includes(status), `implementation status matrix missing status ${status}`);
}
assert(statusMatrix.includes('getConnectorImplementationStatus'), 'missing connector implementation status lookup');

for (const table of ['connector_accounts', 'connector_sync_state', 'connector_events']) {
  assert(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `migration missing ${table}`);
}

for (const column of [
  'source_provider',
  'source_account_id',
  'source_order_id',
  'raw_source_payload',
  'carrier_provider',
  'carrier_account_id',
  'label_provider_key',
  'confirmation_provider',
]) {
  assert(migration.includes(column), `migration missing ${column}`);
}

for (const schemaField of [
  'sourceProvider',
  'sourceAccountId',
  'sourceOrderId',
  'sourceOrderNumber',
  'rawSourcePayload',
]) {
  assert(ordersSchema.includes(`${schemaField}:`), `orders schema missing ${schemaField}`);
  assert(orderSync.includes(`${schemaField}:`), `ShipStation order sync must write ${schemaField}`);
}

assert(normalizedOrderPersistence.includes('buildShipStationOrderSource'), 'missing ShipStation normalized order source helper');
assert(normalizedOrderPersistence.includes('sourceProvider'), 'normalized order helper must return sourceProvider');
assert(orderSync.includes('buildShipStationOrderSource'), 'ShipStation order sync must use normalized order source helper');

for (const schemaField of [
  'carrierProvider',
  'carrierAccountId',
  'labelProviderKey',
  'confirmationProvider',
  'confirmationStatus',
]) {
  assert(shipmentsSchema.includes(`${schemaField}:`), `shipments schema missing ${schemaField}`);
}

for (const sqlColumn of [
  'carrier_provider',
  'carrier_account_id',
  'label_provider_key',
  'confirmation_provider',
  'confirmation_status',
]) {
  assert(directLabelPersistence.includes(sqlColumn), `direct label persistence must write ${sqlColumn}`);
}

for (const key of ['shipstation', 'walmart', 'ebay', 'shopify', 'amazon']) {
  assert(registry.includes(`${key}:`), `store connector registry missing ${key}`);
}
for (const key of ['shipstation', 'shipp', 'easypost', 'walmart_shipping', 'ups']) {
  assert(registry.includes(`${key}:`), `carrier connector registry missing ${key}`);
}

assert(carrierResolution.includes('resolveCarrierConnector'), 'missing carrier connector resolver');
assert(carrierResolution.includes('carrierConnectors'), 'carrier resolver must use carrier registry');
assert(carrierResolution.includes('connectorCapabilityMatrix'), 'carrier resolver must use capability matrix');
assert(storeResolution.includes('resolveStoreConnector'), 'missing store connector resolver');
assert(storeResolution.includes('storeConnectors'), 'store resolver must use store registry');
assert(storeResolution.includes('connectorCapabilityMatrix'), 'store resolver must use capability matrix');
assert(fulfillmentOutbox.includes('resolveStoreConnector'), 'fulfillment outbox must resolve confirmation providers through store connector resolver');
assert(fulfillmentOutbox.includes('connectorCapabilities'), 'fulfillment outbox must expose store connector capabilities in logs or payload');

for (const source of [carrierLabels, carrierRates]) {
  assert(source.includes('connectorCapabilities'), 'direct carrier endpoint response metadata must expose connector capabilities');
}
assert(
  carrierLabels.includes('LABEL_CREATE_CONNECTOR_CAPABILITIES') &&
    carrierLabels.includes('labelCreateConnectorCapabilities'),
  'direct carrier label endpoint must keep Vercel-safe inline connector capability metadata',
);
assert(
  !carrierLabels.includes("from '../../src/connectors/carrier-resolution.js'"),
  'direct carrier label endpoint must not import connector registry at Vercel cold start',
);
assert(
  carrierRates.includes('DIRECT_CARRIER_CONNECTOR_CAPABILITIES'),
  'direct carrier rates endpoint must keep Vercel-safe inline connector capability metadata',
);
assert(
  !carrierRates.includes("from '../../src/connectors/carrier-resolution.js'"),
  'direct carrier rates endpoint must not import connector registry at Vercel cold start',
);

for (const file of [
  'src/connectors/carrier/shipstation.ts',
  'src/connectors/carrier/shipp.ts',
  'src/connectors/carrier/easypost.ts',
  'src/connectors/carrier/ups.ts',
  'src/connectors/carrier/walmart-shipping.ts',
  'src/connectors/store/shipstation.ts',
  'src/connectors/store/walmart.ts',
  'src/connectors/store/ebay.ts',
  'src/connectors/store/shopify.ts',
  'src/connectors/store/amazon.ts',
]) {
  const source = read(file);
  assert(source.includes('capabilities:'), `${file} must declare connector capabilities`);
}

assert.equal(
  packageJson.scripts?.['test:connector-architecture'],
  'node scripts/connector-architecture-guard.mjs',
  'package.json missing test:connector-architecture script',
);
assert.equal(
  packageJson.scripts?.['status:carriers'],
  'tsx scripts/status-carriers.ts',
  'package.json missing status:carriers script',
);
assert.equal(
  packageJson.scripts?.['test:status:carriers'],
  'tsx scripts/status-carriers.ts --check',
  'package.json missing test:status:carriers script',
);
assert(carrierStatus.includes('connectorCapabilityMatrix'), 'carrier status checker must read connector capability matrix');
assert(carrierStatus.includes('connectorImplementationStatus'), 'carrier status checker must read connector implementation status');
assert(carrierStatus.includes('carrierConnectors'), 'carrier status checker must inspect carrier registry keys');
assert(carrierStatus.includes('storeConnectors'), 'carrier status checker must inspect store registry keys');
assert(carrierStatus.includes('--json'), 'carrier status checker must support JSON output');
assert(carrierStatus.includes('--check'), 'carrier status checker must support check mode');
