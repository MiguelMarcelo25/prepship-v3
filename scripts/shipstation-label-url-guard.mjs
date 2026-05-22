import assert from 'node:assert/strict';
import { extractShipstationLabelUrl } from '../src/lib/shipstation/labels.ts';

assert.equal(
  extractShipstationLabelUrl({ pdf: 'https://example.com/label.pdf' }),
  'https://example.com/label.pdf',
  'plain ShipStation PDF URLs must still pass through',
);

assert.equal(
  extractShipstationLabelUrl({ pdf: { href: 'https://example.com/walmart.pdf' } }),
  'https://example.com/walmart.pdf',
  'object-shaped Walmart/ShipStation label downloads must resolve to href',
);

assert.equal(
  extractShipstationLabelUrl({ href: { url: 'https://example.com/fallback.pdf' } }),
  'https://example.com/fallback.pdf',
  'fallback href objects must resolve to url',
);

assert.equal(
  extractShipstationLabelUrl({ pdf: { unexpected: true } }),
  null,
  'unrecognized label download objects must not leak into text columns',
);

console.log('PASS shipstation label URL guard');
