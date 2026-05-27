import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const labels = readFileSync('api/carriers/labels.ts', 'utf8');

assert(labels.includes('persistDirectCarrierLabel'), 'direct labels must use shared persistence helper');
assert(!labels.includes('CREATE TABLE IF NOT EXISTS shipments'), 'direct labels must not create shipments table at request time');
assert(!labels.includes('INSERT INTO shipments'), 'direct labels must not perform ad hoc shipment inserts');
assert(labels.includes('enqueueShipmentConfirmationSql'), 'direct labels must enqueue source confirmation');
for (const provider of ['shipp', 'walmart_shipping', 'ups', 'easypost']) {
  assert(labels.includes(`providerKey === '${provider}'`), `direct labels missing ${provider} branch`);
}

const {
  __test_selectWalmartOrderByCustomerOrderId,
} = await tsImport('../api/carriers/labels.ts', import.meta.url);
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

const walmartLookupPayload = {
  list: {
    elements: {
      order: [
        {
          customerOrderId: '200014621111111',
          purchaseOrderId: '129114381111111',
        },
        {
          customerOrderId: '200014621589900',
          purchaseOrderId: '129114381893181',
          orderLines: { orderLine: [{ lineNumber: '1' }] },
        },
      ],
    },
  },
};
const exactWalmartOrder = __test_selectWalmartOrderByCustomerOrderId(walmartLookupPayload, '200014621589900');
assert.equal(
  exactWalmartOrder?.purchaseOrderId,
  '129114381893181',
  'walmart live PO lookup must select the exact customerOrderId match',
);
const missingWalmartOrder = __test_selectWalmartOrderByCustomerOrderId(walmartLookupPayload, '200014629999999');
assert.equal(
  missingWalmartOrder,
  null,
  'walmart live PO lookup must not fall back to the first returned order when customerOrderId does not match',
);
assert(
  labels.includes('walmart live PO verification replaced cached purchaseOrderId'),
  'walmart labels must log when live PO verification replaces cached purchaseOrderId',
);
assert(
  labels.includes('Could not verify live Walmart PO#'),
  'walmart labels must stop label purchase when live PO verification cannot prove the mapping',
);
