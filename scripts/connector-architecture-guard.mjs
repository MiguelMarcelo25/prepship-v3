import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function read(path) {
  assert(existsSync(path), `missing ${path}`);
  return readFileSync(path, 'utf8');
}

const types = read('src/connectors/types.ts');
const matrix = read('src/connectors/matrix.ts');
const registry = read('src/connectors/registry.ts');
const carrierResolution = read('src/connectors/carrier-resolution.ts');
const migration = read('drizzle/0032_connector_architecture.sql');
const ordersSchema = read('src/db/schema/orders.ts');
const shipmentsSchema = read('src/db/schema/shipments.ts');
const orderSync = read('src/services/order-sync.ts');
const directLabelPersistence = read('src/services/direct-label-persistence.ts');
const carrierLabels = read('api/carriers/labels.ts');
const carrierRates = read('api/carriers/rates.ts');
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

for (const key of ['shipstation', 'walmart']) {
  assert(registry.includes(`${key}:`), `store connector registry missing ${key}`);
}
for (const key of ['shipstation', 'shipp', 'easypost', 'walmart_shipping', 'ups']) {
  assert(registry.includes(`${key}:`), `carrier connector registry missing ${key}`);
}

assert(carrierResolution.includes('resolveCarrierConnector'), 'missing carrier connector resolver');
assert(carrierResolution.includes('carrierConnectors'), 'carrier resolver must use carrier registry');
assert(carrierResolution.includes('connectorCapabilityMatrix'), 'carrier resolver must use capability matrix');

for (const source of [carrierLabels, carrierRates]) {
  assert(source.includes('resolveCarrierConnector'), 'direct carrier endpoint must resolve providers through connector registry');
  assert(source.includes('connectorCapabilities'), 'direct carrier endpoint response metadata must expose connector capabilities');
}

for (const file of [
  'src/connectors/carrier/shipstation.ts',
  'src/connectors/carrier/shipp.ts',
  'src/connectors/carrier/easypost.ts',
  'src/connectors/carrier/ups.ts',
  'src/connectors/carrier/walmart-shipping.ts',
  'src/connectors/store/shipstation.ts',
  'src/connectors/store/walmart.ts',
]) {
  const source = read(file);
  assert(source.includes('capabilities:'), `${file} must declare connector capabilities`);
}

assert.equal(
  packageJson.scripts?.['test:connector-architecture'],
  'node scripts/connector-architecture-guard.mjs',
  'package.json missing test:connector-architecture script',
);
