import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const labelsService = readFileSync('src/services/labels.ts', 'utf8');
assert(
  labelsService.includes('extractShipstationLabelUrl') &&
    labelsService.includes('const labelUrl = extractShipstationLabelUrl(label.label_download)') &&
    labelsService.includes('labelUrl,'),
  'persistLabelFromRate must normalize ShipStation label_download into a plain URL before writing shipments',
);

console.log('PASS shipstation label URL guard');
