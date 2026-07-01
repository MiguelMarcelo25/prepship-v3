/**
 * PS-099 guard - separate Create+Print from Print Queue and normalize SHIPP
 * label output to 4x6 PDF.
 *
 * Static + in-memory only: no DB, no provider calls, no labels/postage, no
 * marketplace notifications, and no shipped/cancelled mutations.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import UPNG from '@pdf-lib/upng';

import {
  __test_normalizeShippLabelPartsToPdfDataUrl,
  __test_shippLabelUrl,
} from '../src/connectors/carrier/shipp';

const require = createRequire(import.meta.url);
const UPNG_API = (UPNG as any).default ?? (UPNG as any);
const { GifWriter } = require('omggif') as {
  GifWriter: new (
    buffer: Uint8Array,
    width: number,
    height: number,
    options: { palette: number[] },
  ) => {
    addFrame: (x: number, y: number, width: number, height: number, indexedPixels: Uint8Array) => void;
    end: () => number;
  };
};

const ordersView = fs.readFileSync('web/src/components/Views/OrdersView.tsx', 'utf8');
const shippConnector = fs.readFileSync('src/connectors/carrier/shipp.ts', 'utf8');
const packageJson = fs.readFileSync('package.json', 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const [, base64 = ''] = dataUrl.split(',', 2);
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function near(value: number, expected: number, tolerance = 0.75): boolean {
  return Math.abs(value - expected) <= tolerance;
}

async function assertFourBySixPdf(name: string, dataUrl: string | null): Promise<void> {
  assert(dataUrl, `${name} did not return a label URL`);
  assert(dataUrl!.startsWith('data:application/pdf;base64,'), `${name} must return a PDF data URL`);
  assert(!dataUrl!.startsWith('data:image/'), `${name} must not return an image label URL`);
  const pdf = await PDFDocument.load(dataUrlBytes(dataUrl!));
  assert.equal(pdf.getPageCount(), 1, `${name} should produce one test page`);
  const { width, height } = pdf.getPage(0).getSize();
  assert(near(width, 288) && near(height, 432), `${name} must normalize to 4x6 / 288x432, got ${width}x${height}`);
}

async function makePdfBase64(width: number, height: number): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([width, height]);
  page.drawText('PS-099 label fixture', { x: 12, y: Math.max(12, height - 32), size: 12, font, color: rgb(0, 0, 0) });
  return Buffer.from(await pdf.save()).toString('base64');
}

function makePngBase64(width: number, height: number): string {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 20;
    rgba[i + 1] = 80;
    rgba[i + 2] = 160;
    rgba[i + 3] = 255;
  }
  const buffer = rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength);
  return Buffer.from(UPNG_API.encode([buffer], width, height, 0)).toString('base64');
}

function makeGifBase64(width: number, height: number): string {
  const buffer = new Uint8Array(1024 * 1024);
  const writer = new GifWriter(buffer, width, height, { palette: [0xffffff, 0x111827] });
  const pixels = Array.from({ length: width * height }, (_, i) => i % 2);
  writer.addFrame(0, 0, width, height, pixels);
  return Buffer.from(buffer.subarray(0, writer.end())).toString('base64');
}

const singleCreateOrQueue = sliceBetween(ordersView, "async function createOrQueueLabel(mode: 'print' | 'queue' | 'test'", 'async function saveSkuDefaults');
assert(singleCreateOrQueue.includes("const labelPopup = mode === 'queue' ? null : openLabelPdfPlaceholder()"), 'single-order queue path must not open a label popup');
assert(singleCreateOrQueue.includes("if (mode === 'queue')"), 'single-order queue branch must be explicit');
assert(singleCreateOrQueue.includes('sendOrdersToQueueBackend([order]'), 'single-order queue branch must use queue/recovery backend');
assert(singleCreateOrQueue.includes('openLabelPdfUrl(queueableLabelUrl, labelPopup)'), 'single-order Create+Print must open the created label');

const batchAction = sliceBetween(ordersView, "async function handleBatchAction(mode: 'print' | 'queue')", '// Batch Mark-as-Shipped');
// PS-360: batch queue delegates to the backend queue/recovery owner and returns before
// the legacy label-create tail; the remaining tail is Create+Print only.
const queueEarlyReturnStart = batchAction.indexOf("if (mode === 'queue')");
const queueEarlyReturnBoundary = queueEarlyReturnStart >= 0
  ? /return\r?\n    }\r?\n\r?\n    setBatchBusy\(true\)/.exec(batchAction.slice(queueEarlyReturnStart))
  : null;
const printOnlyBatchTailStart = queueEarlyReturnBoundary
  ? queueEarlyReturnStart + queueEarlyReturnBoundary.index + queueEarlyReturnBoundary[0].lastIndexOf('setBatchBusy(true)')
  : -1;
const queueEarlyReturnBlock = printOnlyBatchTailStart >= 0
  ? batchAction.slice(queueEarlyReturnStart, printOnlyBatchTailStart)
  : '';
const printOnlyBatchTail = printOnlyBatchTailStart >= 0 ? batchAction.slice(printOnlyBatchTailStart) : '';
assert(
  queueEarlyReturnBlock.includes('sendOrdersToQueueBackend(batchOrders') && /\breturn\b/.test(queueEarlyReturnBlock),
  'batch Print to Queue must delegate to the backend queue/recovery owner and return before label-create tail',
);
assert(
  !printOnlyBatchTail.includes('apiClient.addToQueue(buildQueueAddPayload(order, queueableLabelUrl))'),
  'batch Print to Queue must not keep the unreachable createLabel-then-addToQueue tail',
);
assert(
  printOnlyBatchTail.includes('await apiClient.createLabel(payload)') &&
    printOnlyBatchTail.includes('await apiClient.openLabelPdf(queueableLabelUrl)'),
  'batch Create+Print must create labels and open PDFs from the print-only tail',
);

assert(!singleCreateOrQueue.includes("mode === 'print' &&") || !singleCreateOrQueue.includes('addToQueue'), 'single-order Create+Print must not add to print queue');
assert(packageJson.includes('"test:ps-099-create-print-shipp-label-output"'), 'package.json must register the PS-099 guard');

assert(shippConnector.includes("format: 'image/gif'"), 'SHIPP UPS GIF labels must be recognized as GIF parts');
assert(shippConnector.includes('__test_normalizeShippLabelPartsToPdfDataUrl'), 'SHIPP normalizer test export must exist');
assert(shippConnector.includes('SHIPP_LABEL_PAGE_WIDTH = 288') && shippConnector.includes('SHIPP_LABEL_PAGE_HEIGHT = 432'), 'SHIPP output must target 4x6 pages');

await assertFourBySixPdf(
  'SHIPP PDF part',
  await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: await makePdfBase64(612, 792), format: 'application/pdf' }]),
);
await assertFourBySixPdf(
  'SHIPP PNG part',
  await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: makePngBase64(500, 700), format: 'image/png' }]),
);
await assertFourBySixPdf(
  'SHIPP GIF part',
  await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: makeGifBase64(120, 180), format: 'image/gif' }]),
);
await assertFourBySixPdf(
  'SHIPP UPS branch',
  await __test_shippLabelUrl({
    ShipmentResponse: {
      ShipmentResults: {
        PackageResults: {
          ShippingLabel: {
            GraphicImage: makeGifBase64(120, 180),
          },
        },
      },
    },
  }, 'ups'),
);

console.log('PASS PS-099 Create+Print separation + SHIPP 4x6 label output guard');
