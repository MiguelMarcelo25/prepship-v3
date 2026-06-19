/**
 * PS-294 — SHIPP label 4×6 placement guard (#572 "SHIPP wrong size", folded in).
 *
 * THE BUG (SHIPP "wrong size"): src/connectors/carrier/shipp.ts assembles the SHIPP label PDF by
 * fitting the WHOLE source page/image onto a 288×432 (4×6 @72dpi) canvas with a DUPLICATED
 * Math.min contain-fit in TWO places (appendShippPdfPages + appendShippImagePage). The placement
 * math had no single owner, so the 4×6 invariant + centering can silently drift between the PDF and
 * the image path.
 *
 * SLICE 1 (connector-local): ONE pure owner of the placement math — computeFourBySixPlacement — kept
 * for the RASTER (UPS GIF / PNG) path, where no content-region crop is available offline.
 * SLICE 2 (graft): the PDF path (SHIPP-native + FedEx) now delegates to B's PS-287 CONTENT-AWARE
 * normalizer appendNormalizedLabelPages (print-queue-pdf.ts, the PURE module — NOT the env-dragging
 * print-queue.ts barrel), which crops to the visible artwork bounds (deriveArtworkBounds) and scales
 * it to FILL the 4×6 canvas (placeArtworkOnCanvas) — so an oversized / corner SHIPP label fills 4×6
 * instead of shrinking. This guard pins the 4×6 invariant, the raster placement owner, the PDF-path
 * delegation, AND the visible fill behavior.
 *
 *   npx tsx scripts/ps-294-shipp-4x6-placement-guard.ts
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, rgb } from 'pdf-lib';
import UPNG from '@pdf-lib/upng';
import {
  computeFourBySixPlacement,
  FOUR_BY_SIX_WIDTH_PT,
  FOUR_BY_SIX_HEIGHT_PT,
} from '../src/connectors/carrier/shipp-label-4x6-placement';
// PS-294 slice 2: the SHIPP PDF path grafts onto B's PS-287 content-aware 4×6 normalizer; pin the
// visible fill behavior via the same pure geometry the SHIPP path now delegates to.
import { deriveArtworkBounds, placeArtworkOnCanvas } from '../src/services/print-queue-artwork-fit';
import { __test_normalizeShippLabelPartsToPdfDataUrl } from '../src/connectors/carrier/shipp';

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

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures += 1; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`ok   ${name}`);
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

function dataUrlBytes(dataUrl: string): Uint8Array {
  const [, base64 = ''] = dataUrl.split(',', 2);
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

async function assertFourBySixPdf(name: string, dataUrl: string | null): Promise<void> {
  check(`${name}: returns a PDF data URL`, typeof dataUrl === 'string' && dataUrl.startsWith('data:application/pdf;base64,'));
  if (typeof dataUrl !== 'string') return;
  const out = await PDFDocument.load(dataUrlBytes(dataUrl));
  check(`${name}: produces exactly one page`, out.getPageCount() === 1, `pages=${out.getPageCount()}`);
  const page0 = out.getPage(0);
  check(`${name}: normalizes to 4x6 / 288x432`,
    approx(page0.getWidth(), 288) && approx(page0.getHeight(), 432),
    `${page0.getWidth()}x${page0.getHeight()}`);
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
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = i % 2;
  writer.addFrame(0, 0, width, height, pixels);
  return Buffer.from(buffer.subarray(0, writer.end())).toString('base64');
}

async function main() {
  // ── the 4×6 canvas is the postage standard (4in × 6in @ 72dpi) ───────────────
  check('4×6 canvas is 288×432pt', FOUR_BY_SIX_WIDTH_PT === 288 && FOUR_BY_SIX_HEIGHT_PT === 432,
    `${FOUR_BY_SIX_WIDTH_PT}×${FOUR_BY_SIX_HEIGHT_PT}`);

  // ── pure placement: contain-fit + centered ───────────────────────────────────
  {
    const p = computeFourBySixPlacement({ srcWidth: 288, srcHeight: 432 });
    check('exact-4×6 source fills the canvas with no offset',
      approx(p.drawWidth, 288) && approx(p.drawHeight, 432) && approx(p.x, 0) && approx(p.y, 0),
      JSON.stringify(p));
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 612, srcHeight: 792 }); // US-letter points
    check('oversized source is contained within 4×6', p.drawWidth <= 288.01 && p.drawHeight <= 432.01, JSON.stringify(p));
    check('oversized source preserves aspect ratio', approx(p.drawWidth / p.drawHeight, 612 / 792, 0.001));
    check('oversized source is centered',
      approx(p.x, (288 - p.drawWidth) / 2) && approx(p.y, (432 - p.drawHeight) / 2) && p.x >= 0 && p.y >= 0);
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 144, srcHeight: 216 }); // 2×3, same aspect as 4×6
    check('small same-aspect source scales UP to fill', approx(p.drawWidth, 288) && approx(p.drawHeight, 432), JSON.stringify(p));
  }
  {
    const p = computeFourBySixPlacement({ srcWidth: 0, srcHeight: 0 }); // degenerate
    check('degenerate dims fall back to a finite full canvas (no NaN/negative)',
      Number.isFinite(p.drawWidth) && Number.isFinite(p.drawHeight) && p.drawWidth > 0 && p.drawHeight > 0, JSON.stringify(p));
  }

  // ── wiring: PDF path delegates to B's normalizer; raster path keeps the placement owner ──
  const shipp = readFileSync('src/connectors/carrier/shipp.ts', 'utf8');
  check('shipp.ts imports the raster placement owner (computeFourBySixPlacement)',
    /from '\.\/shipp-label-4x6-placement'/.test(shipp) && /computeFourBySixPlacement/.test(shipp));
  const placementCalls = (shipp.match(/computeFourBySixPlacement\(/g) || []).length;
  check('the raster/image path still uses the placement owner', placementCalls >= 1, `calls=${placementCalls}`);
  check("the PDF path delegates to B's content-aware 4×6 normalizer (appendNormalizedLabelPages)",
    /appendNormalizedLabelPages\s*\(/.test(shipp));
  check('the normalizer is imported from the PURE print-queue-pdf module',
    /from '\.\.\/\.\.\/services\/print-queue-pdf'/.test(shipp));
  check('NOT imported from the env-dragging print-queue.ts barrel',
    !/from '\.\.\/\.\.\/services\/print-queue'/.test(shipp));
  check('the duplicated inline Math.min placement math is gone from shipp.ts',
    !/Math\.min\(SHIPP_LABEL_PAGE_WIDTH \//.test(shipp));

  // ── integration: any source size still yields a 288×432 first page ───────────
  {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([612, 792]); // oversized letter source
    srcPage.drawRectangle({ x: 40, y: 40, width: 120, height: 80, color: rgb(0, 0, 0) }); // real labels carry content
    const srcB64 = Buffer.from(await src.save()).toString('base64');
    const url = await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: srcB64, format: 'application/pdf' }]);
    check('assembled label is a data:application/pdf URL',
      typeof url === 'string' && url.startsWith('data:application/pdf;base64,'));
    if (typeof url === 'string') {
      const out = await PDFDocument.load(Buffer.from(url.split(',')[1]!, 'base64'));
      const page0 = out.getPage(0);
      check('the assembled label page is exactly 4×6 (288×432) regardless of source size',
        approx(page0.getWidth(), 288) && approx(page0.getHeight(), 432),
        `${page0.getWidth()}×${page0.getHeight()}`);
    }
  }

  // ── content-aware FILL: an oversized sheet with a 4×6 label region fills the canvas (PS-287 crop) ──
  {
    // Raster fixtures exercise the real PNG/GIF image path.
    await assertFourBySixPdf(
      'SHIPP PNG raster fixture',
      await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: makePngBase64(500, 700), format: 'image/png' }]),
    );
    await assertFourBySixPdf(
      'SHIPP GIF raster fixture',
      await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: makeGifBase64(120, 180), format: 'image/gif' }]),
    );

    // A 4x6 label centered inside a US-letter sheet (the oversized/corner-label class).
    const oversizedWithCrop = {
      getMediaBox: () => ({ x: 0, y: 0, width: 612, height: 792 }),
      getCropBox: () => ({ x: 162, y: 180, width: 288, height: 432 }),
    };
    const bounds = deriveArtworkBounds(oversizedWithCrop);
    check('deriveArtworkBounds crops to the tight artwork box, not the whole oversized sheet',
      approx(bounds.width, 288) && approx(bounds.height, 432), JSON.stringify(bounds));
    const placed = placeArtworkOnCanvas({ artworkW: bounds.width, artworkH: bounds.height, canvasW: 288, canvasH: 432, margin: 6 });
    check('content-aware placement FILLS the 4×6 canvas (>=90% on each axis)',
      placed.drawWidth >= 288 * 0.9 && placed.drawHeight >= 432 * 0.9, JSON.stringify(placed));
    // the OLD whole-page contain-fit would shrink this same label artwork dramatically
    const naive = computeFourBySixPlacement({ srcWidth: 612, srcHeight: 792 });
    const naiveArtworkW = bounds.width * (naive.drawWidth / 612);
    check('content-aware fill is far larger than the old whole-page contain-fit of the same label',
      placed.drawWidth > naiveArtworkW * 1.5, `fill=${placed.drawWidth.toFixed(1)} vs old=${naiveArtworkW.toFixed(1)}`);
  }

  // ── integration: an oversized source WITH a tight CropBox normalizes to 288×432 end-to-end ──
  {
    const src = await PDFDocument.create();
    const srcPage = src.addPage([612, 792]);
    srcPage.drawRectangle({ x: 180, y: 200, width: 240, height: 380, color: rgb(0, 0, 0) }); // artwork inside the crop
    srcPage.setCropBox(162, 180, 288, 432); // a 4×6 label region inside the letter sheet
    const srcB64 = Buffer.from(await src.save()).toString('base64');
    const url = await __test_normalizeShippLabelPartsToPdfDataUrl([{ base64: srcB64, format: 'application/pdf' }]);
    if (typeof url === 'string') {
      const out = await PDFDocument.load(Buffer.from(url.split(',')[1]!, 'base64'));
      check('a cropped oversized SHIPP PDF normalizes to a 288×432 page (content-aware path runs end-to-end)',
        approx(out.getPage(0).getWidth(), 288) && approx(out.getPage(0).getHeight(), 432),
        `${out.getPage(0).getWidth()}×${out.getPage(0).getHeight()}`);
    } else {
      check('a cropped oversized SHIPP PDF produced a data URL', false);
    }
  }

  if (failures > 0) { console.error(`\nFAIL PS-294 shipp 4×6 placement guard (${failures} failing)`); process.exit(1); }
  console.log('\nPASS PS-294 shipp 4×6 placement guard');
}

void main();
