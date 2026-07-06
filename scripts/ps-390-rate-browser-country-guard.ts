/**
 * PS-390 guard - Rate Browser preserves canonical destination country.
 *
 * Offline only: no DB, no network, no provider calls, no labels, no queue mutation.
 * Locks the Canadian/international rate path where the modal may pass a default
 * "US" but /rates/browse must prefer the order's canonical non-US country.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveRateBrowseDestinationCountry } from '../src/services/rate-browse-destination-country';
import { normalizeShippingPostalCode } from '../src/services/shipping-workflow/postal-code';

const modal = readFileSync('web/src/components/RateBrowserModal.tsx', 'utf8');
const ordersView = readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const producer = readFileSync('src/services/rate-browse-response-producer.ts', 'utf8');
const rates = readFileSync('src/services/rates.ts', 'utf8');
const packageJson = readFileSync('package.json', 'utf8');

assert.equal(
  resolveRateBrowseDestinationCountry({ requestedCountry: 'US', canonicalCountry: 'CA' }),
  'CA',
  'order-backed browse must not let a frontend default US erase canonical CA',
);

assert.equal(
  resolveRateBrowseDestinationCountry({ requestedCountry: '', canonicalCountry: 'CA' }),
  'CA',
  'blank requested country must fall back to canonical order country',
);

assert.equal(
  resolveRateBrowseDestinationCountry({ requestedCountry: 'CA', canonicalCountry: 'US' }),
  'CA',
  'explicit non-US operator/user intent must be preserved',
);

assert.equal(
  resolveRateBrowseDestinationCountry({ requestedCountry: 'US', canonicalCountry: null }),
  'US',
  'US fallback remains unchanged when no canonical country exists',
);

assert.deepEqual(
  normalizeShippingPostalCode('V6K 3C6', 'CA'),
  { exact: 'V6K 3C6', zip5: 'V6K 3C6' },
  'Canadian postal code must stay exact and untruncated',
);

assert.deepEqual(
  normalizeShippingPostalCode('11364-2081', 'US'),
  { exact: '11364-2081', zip5: '11364' },
  'US ZIP+4 behavior must stay unchanged',
);

assert.ok(
  /shipTo\?:\s*\{[^}]*postalCode\?:\s*string \| null;[^}]*company\?:\s*string \| null;[^}]*country\?:\s*string \| null;[^}]*\}/s.test(modal),
  'RateBrowserModal order DTO must carry shipTo.country',
);

assert.ok(
  modal.includes('order?.shipTo?.country') && modal.includes('const destinationCountry'),
  'RateBrowserModal must derive destinationCountry from order.shipTo.country',
);

assert.ok(
  /toCountry:\s*destinationCountry/.test(modal),
  'RateBrowserModal browse payload must send the order destination country',
);

assert.ok(
  !/toCountry:\s*['"]US['"]/.test(modal),
  'RateBrowserModal must not hardcode Rate Browser destination country to US',
);

assert.ok(
  /country:\s*shipTo\.country\s*\?\?\s*'US'/.test(ordersView),
  'OrdersView must pass canonical shipTo.country into Rate Browser order data',
);

assert.ok(
  producer.includes("from './rate-browse-destination-country'") &&
    /toCountry:\s*resolveRateBrowseDestinationCountry\(\{[\s\S]*requestedCountry:\s*rest\.toCountry[\s\S]*canonicalCountry:\s*readText\(orderRawShipTo\.country\)[\s\S]*\}\)/.test(producer),
  'backend rate browse producer must resolve destination country from canonical order country',
);

assert.ok(
  /to_country_code:\s*\(input\.toCountry\s*\?\?\s*'US'\)\.toUpperCase\(\)/.test(rates) &&
    /to_postal_code:\s*input\.toZip/.test(rates),
  'ShipStation payload must send resolved country code and exact postal code',
);

assert.ok(
  packageJson.includes('"test:ps-390-rate-browser-country"'),
  'package.json must wire the PS-390 Rate Browser country guard',
);

console.log('PASS PS-390 Rate Browser destination country guard');
