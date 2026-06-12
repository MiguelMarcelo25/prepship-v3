// PS-209 re-anchor (2026-06-13): this guard certified the LEGACY Vercel
// direct-label function, which is now a retired no-import 410
// (LEGACY_LABEL_ENDPOINT_RETIRED). Every behavior it protected lives at the
// v4 owners now — same intent, new homes:
//   shared persistence  → src/services/labels.ts persistCreatedLabel tail
//   confirmation        → per-order outbox processing in the same tail
//   provider dispatch   → labels-direct.ts generic createCarrierLabel(provider, input)
//   Walmart PO safety   → PS-199 resolver (walmart-po-resolution.ts) + the
//                         connector's exact customerOrderId match
// The Walmart label-extractor behavioral cases stay (the connector always
// owned them).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const legacy = readFileSync('api/carriers/labels.ts', 'utf8');
const labelsSvc = readFileSync('src/services/labels.ts', 'utf8');
const labelsDirect = readFileSync('src/services/labels-direct.ts', 'utf8');
const walmartConnector = readFileSync('src/connectors/store/walmart.ts', 'utf8');
const poResolution = readFileSync('src/services/walmart-po-resolution.ts', 'utf8');

// The legacy endpoint stays a purchase-free stub.
assert(legacy.includes('LEGACY_LABEL_ENDPOINT_RETIRED'), 'legacy label endpoint must stay the retired 410 stub');
assert(!legacy.includes('CREATE TABLE IF NOT EXISTS shipments'), 'no request-time DDL can return to the stub');
assert(!legacy.includes('INSERT INTO shipments'), 'no ad hoc shipment inserts can return to the stub');

// v4 direct labels use the SAME sanctioned persistence + confirmation tail
// as ShipStation labels.
assert(labelsSvc.includes('persistCreatedLabel'), 'direct labels must use the shared persistence helper (v4 tail)');
assert(/processFulfillmentOutboxOnce\(\{ orderId/.test(labelsSvc), 'the shared tail must process the source confirmation per order');
assert(labelsDirect.includes('createCarrierLabel(provider, input)'),
  'direct providers dispatch generically through the connector orchestrator (no per-provider route branches)');
assert(labelsDirect.includes('persistCreatedLabel'),
  'labels-direct must document/route rows through the sanctioned persist helper');

// Walmart PO safety (PS-199 resolver, labels mode): live verification either
// proves the mapping or stops the purchase — never trusts a cached PO blind.
assert(
  poResolution.includes('live PO verification replaced cached purchaseOrderId'),
  'walmart resolver must log when live PO verification replaces a cached purchaseOrderId',
);
assert(
  poResolution.includes('Could not verify live Walmart PO#'),
  'walmart resolver must stop label purchase when live PO verification cannot prove the mapping',
);
// The connector's lookup selects the EXACT customerOrderId — no first-row fallback.
assert(
  /elements\.find\(\(order\) => firstString\(\(order as any\)\?\.customerOrderId\) === trimmed\)/.test(walmartConnector),
  'walmart connector lookup must select the exact customerOrderId match',
);
assert(
  walmartConnector.includes('order lookup exact customerOrderId match not found'),
  'walmart connector must warn (not fall back) when the exact match is missing',
);

// Walmart label-extractor behavioral cases — connector-owned, unchanged.
const {
  __test_extractWalmartLabelReference,
} = await tsImport('../src/connectors/carrier/walmart-shipping.ts', import.meta.url);

const nestedUrl = __test_extractWalmartLabelReference({
  data: {
    labels: [
      {
        labelUrl: {
          href: 'https://example.test/walmart-label.pdf',
        },
      },
    ],
  },
}, 'url');
assert.equal(nestedUrl.value, 'https://example.test/walmart-label.pdf', 'walmart label extractor must read labelUrl.href in arrays');

const nestedDownloadUrl = __test_extractWalmartLabelReference({
  data: {
    downloadUrl: {
      url: 'https://example.test/downloaded-label.pdf',
    },
  },
}, 'url');
assert.equal(nestedDownloadUrl.value, 'https://example.test/downloaded-label.pdf', 'walmart label extractor must read downloadUrl.url');

const labelDownloadPdfHref = __test_extractWalmartLabelReference({
  label_download: {
    pdf: {
      href: 'https://example.test/label-download-pdf.pdf',
    },
  },
}, 'url');
assert.equal(labelDownloadPdfHref.value, 'https://example.test/label-download-pdf.pdf', 'walmart label extractor must read label_download.pdf.href');

const nestedBase64 = __test_extractWalmartLabelReference({
  data: {
    labelData: {
      pdf: 'JVBERi0xLjQK'.repeat(12),
    },
  },
}, 'base64');
assert.equal(nestedBase64.value, 'JVBERi0xLjQK'.repeat(12), 'walmart label extractor must read data.labelData.pdf');

const dataPdfBase64 = __test_extractWalmartLabelReference({
  data: {
    pdfBase64: 'JVBERi0xLjUK'.repeat(12),
  },
}, 'base64');
assert.equal(dataPdfBase64.value, 'JVBERi0xLjUK'.repeat(12), 'walmart label extractor must read data.pdfBase64');

assert.throws(
  () => __test_extractWalmartLabelReference({ data: { labelData: { pdf: '[object Object]' } } }, 'base64'),
  /labelData\.pdf:string_invalid/,
  'walmart label extractor must reject object-stringified label payloads',
);

assert.throws(
  () => __test_extractWalmartLabelReference({ data: { downloadUrl: { url: 12345 } } }, 'url'),
  /downloadUrl\.url:number_unsupported/,
  'walmart label extractor must reject non-string label URL values with sanitized type summaries',
);

assert.throws(
  () => __test_extractWalmartLabelReference({ data: { pdfBase64: '   ' } }, 'base64'),
  /pdfBase64:string_empty/,
  'walmart label extractor must reject empty label payload strings',
);

console.log('PASS direct-carrier label guard (PS-209 re-anchored to the v4 owners)');
