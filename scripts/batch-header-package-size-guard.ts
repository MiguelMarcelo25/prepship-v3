/**
 * Guard: the print-queue batch header shows the selected package size.
 *
 * Under the "QTY: N total unit(s) per order" line, the batch header PDF must
 * render "Package: LxWxH" (e.g. 11x8x6) sourced from the order's label
 * dimensions, so the packer knows what size box to use. Dimensions come from
 * the latest active shipment (read-only display join).
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { formatPackageDims, renderBatchHeaderPdfForTest } from '../src/services/print-queue';

const source = readFileSync('src/services/print-queue.ts', 'utf8');

// Mirror scripts/ps-070-batch-pdf-cert.ts: inflate Flate streams and decode
// pdf-lib's hex `<...> Tj` text so we can assert on the rendered PDF content.
function extractPdfText(buf: Buffer): string {
  let out = buf.toString('latin1');
  for (const m of out.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const chunk = Buffer.from(m[1], 'latin1');
    let inflated = '';
    try { inflated = zlib.inflateSync(chunk).toString('latin1'); }
    catch { try { inflated = zlib.inflateRawSync(chunk).toString('latin1'); } catch { inflated = ''; } }
    out += inflated;
    for (const h of inflated.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
      try { out += Buffer.from(h[1], 'hex').toString('latin1'); } catch { /* ignore */ }
    }
  }
  return out;
}

let failures = 0;
function check(name: string, condition: boolean) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL ${name}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ── formatPackageDims (pure) ──
check('integer dims format as LxWxH', formatPackageDims(11, 8, 6) === '11x8x6');
check('fractional dims are preserved', formatPackageDims(11, 8.5, 6) === '11x8.5x6');
check('trailing .0 is dropped', formatPackageDims(11.0, 8.0, 6.0) === '11x8x6');
check('missing dimension yields null (line omitted)', formatPackageDims(11, null, 6) === null);
check('zero/negative dimension yields null', formatPackageDims(11, 0, 6) === null && formatPackageDims(11, -2, 6) === null);

// ── source structure ──
check(
  'header draws a "Package: <dims>" line',
  /drawText\(\s*safePdfText\(`Package: \$\{packageDims\}`\)/.test(source),
);
check(
  'package line is drawn after the QTY total-units line',
  source.indexOf('total unit') >= 0 &&
    source.indexOf('`Package: ${packageDims}`') > source.indexOf('total unit'),
);
check(
  'drawHeader accepts a packageDims parameter',
  /packageDims: string \| null = null/.test(source),
);
check(
  'merge job loads package dims per order and passes them to the header',
  /const packageDimsByOrderId = await loadPackageDimsByOrderId\(entriesByGroup\)/.test(source) &&
    /packageDimsByOrderId\.get\(Number\(e\.orderId\)\) \?\? null/.test(source),
);
check(
  'dims are read from the latest active (non-voided, non-return) shipment',
  /\.from\(shipments\)[\s\S]{0,200}?eq\(shipments\.voided, false\)[\s\S]{0,80}?eq\(shipments\.isReturn, false\)/.test(source),
);

// ── rendered PDF (end-to-end) ──
async function renderChecks() {
  const entry = {
    id: 'e1', clientId: 9, orderId: '1', orderNumber: '111-1', labelUrl: 'mock://x',
    skuGroupId: 'g1', primarySku: 'B,S,M,C 4P', itemDescription: 'BINGGRAE MILK 4 FLAVORS',
    orderQty: 1, multiSkuData: null, status: 'queued', printCount: 0, queuedAt: new Date(),
  } as unknown as Parameters<typeof renderBatchHeaderPdfForTest>[0]['entry'];
  const recipients = [{ name: 'DELORES LOMONACO', orderNumber: '111-1' }];

  const withDims = extractPdfText(Buffer.from(
    await renderBatchHeaderPdfForTest({ entry, totalOrders: 1, recipients, packageDims: '11x8x6' }),
  ));
  check('rendered PDF shows "Package: 11x8x6" when dims are known', withDims.includes('Package: 11x8x6'));

  const noDims = extractPdfText(Buffer.from(
    await renderBatchHeaderPdfForTest({ entry, totalOrders: 1, recipients }),
  ));
  check('rendered PDF omits the Package line when dims are unknown', !noDims.includes('Package:'));
}

renderChecks()
  .then(() => {
    if (failures > 0) {
      console.error(`\nFAIL batch header package size guard (${failures} failing)`);
      process.exit(1);
    }
    console.log('\nPASS batch header package size guard');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
