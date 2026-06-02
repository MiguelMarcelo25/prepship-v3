/**
 * PS-070 — batch-header PDF certification (in-memory, no DB / network / postage).
 *
 * Renders the Print Queue batch header for a no-SKU eBay fixture using the
 * test-only renderer and scans the emitted PDF bytes to prove the warehouse
 * header no longer shows a confident "UNKNOWN SKU" and instead shows the
 * product title + a safe no-SKU note. Fake recipient names only — no PII, no
 * real labels/postage/marketplace calls.
 *
 *   npx tsx scripts/ps-070-batch-pdf-cert.ts
 */
import zlib from 'node:zlib';
import { renderBatchHeaderPdfForTest } from '../src/services/print-queue';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// pdf-lib Flate-compresses content streams, so the drawn text is not in the raw
// bytes. Inflate every stream and concatenate so we can certify the visible
// pick text. (Read-only; in-memory.)
function extractPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let out = buf.toString('latin1');
  const streamMarker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let idx = 0;
  for (;;) {
    const s = buf.indexOf(streamMarker, idx);
    if (s === -1) break;
    let dataStart = s + streamMarker.length;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    const e = buf.indexOf(endMarker, dataStart);
    if (e === -1) break;
    const chunk = buf.subarray(dataStart, e);
    let inflated = '';
    try {
      inflated = zlib.inflateSync(chunk).toString('latin1');
    } catch {
      try {
        inflated = zlib.inflateRawSync(chunk).toString('latin1');
      } catch {
        inflated = '';
      }
    }
    out += inflated;
    // pdf-lib draws text as hex strings, e.g. `<53616d79616e67> Tj`. Decode
    // every <hex> token to ASCII so the visible pick text is searchable.
    for (const m of inflated.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
      const hex = m[1]!;
      if (hex.length % 2 === 0) {
        try {
          out += Buffer.from(hex, 'hex').toString('latin1');
        } catch {
          /* skip */
        }
      }
    }
    idx = e + endMarker.length;
  }
  return out;
}

async function render(entry: unknown, recipients: Array<{ name: string; orderNumber: string }>): Promise<string> {
  const bytes = await renderBatchHeaderPdfForTest({
    entry: entry as never,
    totalOrders: recipients.length,
    recipients: recipients as never,
    isTest: true,
  });
  check('renderer returns non-empty PDF bytes', bytes.length > 0);
  return extractPdfText(bytes);
}

async function main(): Promise<void> {
  // ── Case 1: single no-SKU eBay order (multi_sku_data null) ────────────────
  const noSkuEntry = {
    queueEntryId: 'qe-1',
    orderId: '1001',
    orderNumber: 'EBAY-1001',
    clientId: 4,
    skuGroupId: 'SKU:NOSKU:samyang buldak variety pack:1',
    primarySku: null,
    itemDescription: 'Samyang Buldak Variety Pack',
    orderQty: 1,
    multiSkuData: null,
  };
  const pdf1 = await render(noSkuEntry, [
    { name: 'Test Picker One', orderNumber: 'EBAY-1001' },
  ]);
  check('case1: PDF does NOT contain "UNKNOWN SKU"', !/UNKNOWN SKU/i.test(pdf1));
  check('case1: PDF shows the product title', pdf1.includes('Samyang'));
  check('case1: PDF shows a no-SKU note', /no SKU/i.test(pdf1));

  // ── Case 2: multi-SKU combo, one real SKU + one no-SKU eBay line ──────────
  const comboEntry = {
    queueEntryId: 'qe-2',
    orderId: '1002',
    orderNumber: 'EBAY-1002',
    clientId: 4,
    skuGroupId: 'COMBO:NOSKU:samyang buldak variety pack:1|SKU:booster-gel-001:1',
    primarySku: 'Booster-gel-001',
    itemDescription: 'Booster Gel',
    orderQty: 2,
    multiSkuData: [
      { sku: 'Booster-gel-001', description: 'Booster Gel', qty: 1 },
      { sku: '', description: 'Samyang Buldak Variety Pack', qty: 1 },
    ],
  };
  const pdf2 = await render(comboEntry, [{ name: 'Test Picker Two', orderNumber: 'EBAY-1002' }]);
  check('case2: combo shows the real SKU', pdf2.includes('Booster-gel-001'));
  check('case2: combo also shows the no-SKU title', pdf2.includes('Samyang'));
  check('case2: combo has no "UNKNOWN SKU"', !/UNKNOWN SKU/i.test(pdf2));

  // ── Case 3: truly unresolved (no sku, no title) ──────────────────────────
  const unresolvedEntry = {
    queueEntryId: 'qe-3',
    orderId: '1003',
    orderNumber: 'EBAY-1003',
    clientId: 4,
    skuGroupId: 'ORDER:1003',
    primarySku: null,
    itemDescription: null,
    orderQty: 1,
    multiSkuData: null,
  };
  const pdf3 = await render(unresolvedEntry, [{ name: 'Test Picker Three', orderNumber: 'EBAY-1003' }]);
  check('case3: unresolved is flagged, not "UNKNOWN SKU"', /UNRESOLVED EBAY ITEM/.test(pdf3) && !/UNKNOWN SKU/i.test(pdf3));

  if (failures > 0) {
    console.error(`\nFAIL PS-070 batch PDF certification (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-070 batch PDF certification');
}

main().catch((e) => {
  console.error('PS-070 PDF cert failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
