/**
 * PS-084 Guard — print-queue label size normalization.
 *
 * Every label in the merged print PDF must land on the standard 4x6 (288x432)
 * page, so an oversized carrier label (e.g. FedEx Home Delivery) prints the same
 * size as the USPS/UPS labels instead of dwarfing them. Labels already at 4x6
 * are content-fitted to the canvas; rotated labels have their /Rotate baked onto
 * the 4x6 canvas (PS-287, 2026-06-23); oversized labels are scaled to fit.
 *
 *   npx tsx scripts/ps-084-label-size-normalize-guard.ts
 *
 * Read-only: no DB, no carrier IO, never buys/fetches a real label — builds
 * synthetic PDFs in memory only.
 */
import { PDFDocument, degrees } from 'pdf-lib';
import { appendNormalizedLabelPages } from '../src/services/print-queue.js';

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

async function labelDoc(width: number, height: number, rotation = 0): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  if (rotation) page.setRotation(degrees(rotation));
  return doc;
}

function near(value: number, target: number, tol = 0.75): boolean {
  return Math.abs(value - target) <= tol;
}

(async () => {
  // A label already at 4x6 is preserved exactly.
  {
    const merged = await PDFDocument.create();
    await appendNormalizedLabelPages(merged, await labelDoc(288, 432));
    const pages = merged.getPages();
    check('standard 4x6 => 1 page', pages.length === 1);
    const { width, height } = pages[0]!.getSize();
    check('standard 4x6 page preserved at 288x432', near(width, 288) && near(height, 432));
  }

  // An oversized letter-size label is normalized onto a 4x6 page.
  {
    const merged = await PDFDocument.create();
    await appendNormalizedLabelPages(merged, await labelDoc(612, 792));
    const pages = merged.getPages();
    check('oversized letter => 1 page', pages.length === 1);
    const { width, height } = pages[0]!.getSize();
    check('oversized letter normalized to a 288x432 page', near(width, 288) && near(height, 432));
  }

  // An oversized 4x8 label (e.g. some FedEx variants) also lands on a 4x6 page.
  {
    const merged = await PDFDocument.create();
    await appendNormalizedLabelPages(merged, await labelDoc(288, 576));
    const { width, height } = merged.getPages()[0]!.getSize();
    check('oversized 4x8 normalized to a 288x432 page', near(width, 288) && near(height, 432));
  }

  // PS-287 (Per user override unlock shipped data on 2026-06-23): a rotated label now ALSO
  // normalizes — its /Rotate is baked onto the clean 4x6 canvas so it prints upright at
  // 288x432 like every other label (no longer copied byte-for-byte at its original size).
  {
    const merged = await PDFDocument.create();
    await appendNormalizedLabelPages(merged, await labelDoc(612, 792, 90));
    const { width, height } = merged.getPages()[0]!.getSize();
    check('rotated label normalized to a 288x432 page', near(width, 288) && near(height, 432));
  }

  // A multi-page label PDF normalizes every page.
  {
    const merged = await PDFDocument.create();
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    await appendNormalizedLabelPages(merged, doc);
    const pages = merged.getPages();
    check('multi-page label => 2 pages', pages.length === 2);
    check('multi-page both normalized to 288x432', pages.every((p) => {
      const { width, height } = p.getSize();
      return near(width, 288) && near(height, 432);
    }));
  }

  // Appending preserves earlier pages (e.g. a batch header already added).
  {
    const merged = await PDFDocument.create();
    merged.addPage([288, 432]); // pretend batch header
    await appendNormalizedLabelPages(merged, await labelDoc(612, 792));
    check('existing pages are preserved when appending', merged.getPages().length === 2);
  }

  if (failures > 0) {
    console.error(`\nFAIL PS-084 label size normalize guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-084 label size normalize guard');
})().catch((err) => {
  console.error('FAIL PS-084 guard threw:', err instanceof Error ? err.message : err);
  process.exit(1);
});
