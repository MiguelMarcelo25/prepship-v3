import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const registry = readFileSync('src/connectors/registry.ts', 'utf8');
for (const key of ['shipstation', 'shipp', 'easypost', 'walmart_shipping', 'ups']) {
  assert(registry.includes(`${key}:`), `carrierConnectors missing ${key}`);
}
for (const key of ['shipstation', 'walmart']) {
  assert(registry.includes(`${key}:`), `storeConnectors missing ${key}`);
}
