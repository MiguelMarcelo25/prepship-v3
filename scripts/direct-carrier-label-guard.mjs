import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const labels = readFileSync('api/carriers/labels.ts', 'utf8');

assert(labels.includes('persistDirectCarrierLabel'), 'direct labels must use shared persistence helper');
assert(!labels.includes('CREATE TABLE IF NOT EXISTS shipments'), 'direct labels must not create shipments table at request time');
assert(!labels.includes('INSERT INTO shipments'), 'direct labels must not perform ad hoc shipment inserts');
assert(labels.includes('enqueueShipmentConfirmationSql'), 'direct labels must enqueue source confirmation');
for (const provider of ['shipp', 'walmart_shipping', 'ups', 'easypost']) {
  assert(labels.includes(`providerKey === '${provider}'`), `direct labels missing ${provider} branch`);
}
