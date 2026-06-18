/**
 * PS-287 Guard — content-aware Print Queue label normalization (centered 4×6).
 *
 * Before this slice `appendNormalizedLabelPages()` only did PAGE-SIZE
 * normalization: a page already near 4×6 (within tolerance) was copied
 * byte-for-byte, so a label whose visible artwork sits in a smaller, off-center
 * region of the page (e.g. a UPS Ground Saver / USPS handoff label with excess
 * whitespace) printed un-normalized — small and shifted.
 *
 * This slice makes the standard-4×6 branch CONTENT-AWARE: it derives the
 * visible-artwork bounds from the PDF box hints (CropBox / TrimBox vs the
 * MediaBox) and uses a pure placeArtworkOnCanvas() helper to scale-to-fit +
 * center that artwork on a fresh 288×432 (4×6 @72dpi) canvas — aspect
 * preserved, with a small safe margin — instead of copying the page as-is.
 *
 * Display/PDF-rendering only: no DB, no carrier IO, never buys/fetches a real
 * label, no shipped-data write, no postage. Synthetic in-memory PDFs only.
 *
 *   npx tsx scripts/ps-287-print-queue-label-normalization-guard.ts
 */
import { PDFDocument, degrees } from 'pdf-lib';
import { appendNormalizedLabelPages } from '../src/services/print-queue.js';
import {
  deriveArtworkBounds,
  placeArtworkOnCanvas,
} from '../src/services/print-queue-artwork-fit.js';
import { deriveLabelContentRegion } from '../src/services/print-queue-artwork-region.js';

let failures = 0;
function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

function near(value: number, target: number, tol = 0.75): boolean {
  return Math.abs(value - target) <= tol;
}

const TARGET_W = 288;
const TARGET_H = 432;

(async () => {
  // ── 1) Pure placeArtworkOnCanvas() geometry ────────────────────────────────
  {
    // A perfectly 2:3 artwork (same aspect as 288×432) fills the canvas minus
    // the safe margin on the limiting axis, stays centered, aspect preserved.
    const placed = placeArtworkOnCanvas({
      artworkW: 200,
      artworkH: 300,
      canvasW: TARGET_W,
      canvasH: TARGET_H,
      margin: 6,
    });
    check('placeArtworkOnCanvas preserves aspect ratio (2:3 stays 2:3)',
      near(placed.drawWidth / placed.drawHeight, 200 / 300, 0.01));
    check('placeArtworkOnCanvas centers the artwork horizontally',
      near(placed.x + placed.drawWidth / 2, TARGET_W / 2));
    check('placeArtworkOnCanvas centers the artwork vertically',
      near(placed.y + placed.drawHeight / 2, TARGET_H / 2));
    check('placeArtworkOnCanvas leaves a safe margin (never edge-to-edge)',
      placed.drawWidth <= TARGET_W - 6 * 2 + 0.01 && placed.drawHeight <= TARGET_H - 6 * 2 + 0.01);
    check('placeArtworkOnCanvas scales UP a small artwork to fill the canvas',
      placed.drawHeight > 300);
  }
  {
    // A wide artwork is limited by width; it must not overflow the canvas.
    const placed = placeArtworkOnCanvas({
      artworkW: 600,
      artworkH: 200,
      canvasW: TARGET_W,
      canvasH: TARGET_H,
      margin: 6,
    });
    check('placeArtworkOnCanvas keeps a wide artwork inside the canvas width',
      placed.drawWidth <= TARGET_W - 6 * 2 + 0.01 && placed.x >= 6 - 0.01);
    check('placeArtworkOnCanvas keeps a wide artwork inside the canvas height',
      placed.drawHeight <= TARGET_H - 6 * 2 + 0.01 && placed.y >= 0 - 0.01);
    check('placeArtworkOnCanvas preserves aspect for a wide artwork',
      near(placed.drawWidth / placed.drawHeight, 600 / 200, 0.01));
  }

  // ── 2) deriveArtworkBounds() reads box hints (CropBox/TrimBox vs MediaBox) ──
  {
    const doc = await PDFDocument.create();
    const page = doc.addPage([TARGET_W, TARGET_H]);
    // Visible artwork sits in a smaller, off-center region of the page.
    page.setCropBox(40, 80, 180, 270);
    const bounds = deriveArtworkBounds(page);
    check('deriveArtworkBounds picks the smaller CropBox over the MediaBox',
      near(bounds.width, 180) && near(bounds.height, 270));
    check('deriveArtworkBounds reports the artwork origin (x/y offset)',
      near(bounds.x, 40) && near(bounds.y, 80));
  }
  {
    // No meaningful CropBox/TrimBox: fall back to the full MediaBox.
    const doc = await PDFDocument.create();
    const page = doc.addPage([TARGET_W, TARGET_H]);
    const bounds = deriveArtworkBounds(page);
    check('deriveArtworkBounds falls back to MediaBox when no smaller box hint',
      near(bounds.width, TARGET_W) && near(bounds.height, TARGET_H));
  }

  // ── 2b) No box-hint content-region heuristic (CropBox == MediaBox) ─────────
  // The most common real failure: a carrier returns the 4×6 label printed in a
  // CORNER of a full letter/A4 sheet but leaves CropBox == MediaBox, so there
  // is no trim signal. The full-MediaBox fallback would shrink the whole sheet
  // (mostly whitespace) into the 4×6 canvas and the actual label prints tiny.
  // deriveLabelContentRegion() must derive a conservative 4×6-aspect corner
  // region (top-left, the standard PDF label anchor) for such pages, and leave
  // a genuine 4×6 / near-4×6 page untouched.
  {
    // Pure helper: a US-letter sheet (612×792) with no trim hint -> a top-left
    // 4×6-aspect (2:3) region, NOT the whole sheet.
    const region = deriveLabelContentRegion({ width: 612, height: 792 });
    check('content-region: letter sheet yields a tighter-than-page region',
      region.width < 612 - 1 || region.height < 792 - 1);
    check('content-region: letter region keeps the 4×6 (2:3) aspect',
      near(region.width / region.height, TARGET_W / TARGET_H, 0.02));
    check('content-region: letter region is anchored to the page TOP-LEFT',
      near(region.x, 0) && near(region.y, 792 - region.height));
  }
  {
    // Second standard page size: ISO A4 (595.28 × 841.89 pt) behaves the same.
    const region = deriveLabelContentRegion({ width: 595.28, height: 841.89 });
    check('content-region: A4 sheet yields a tighter-than-page region',
      region.width < 595.28 - 1 || region.height < 841.89 - 1);
    check('content-region: A4 region keeps the 4×6 (2:3) aspect',
      near(region.width / region.height, TARGET_W / TARGET_H, 0.02));
    check('content-region: A4 region is anchored to the page TOP-LEFT',
      near(region.x, 0) && near(region.y, 841.89 - region.height));
  }
  {
    // A genuine 4×6 page (and a near-4×6 page) carry NO sub-region signal: the
    // heuristic must return the full page unchanged so we never crop real art.
    const exact = deriveLabelContentRegion({ width: TARGET_W, height: TARGET_H });
    check('content-region: exact 4×6 page is returned whole (no spurious crop)',
      near(exact.width, TARGET_W) && near(exact.height, TARGET_H) && near(exact.x, 0) && near(exact.y, 0));
    const near46 = deriveLabelContentRegion({ width: 300, height: 444 });
    check('content-region: near-4×6 page is returned whole (no spurious crop)',
      near(near46.width, 300) && near(near46.height, 444));
  }
  {
    // deriveArtworkBounds delegates to the heuristic when there is no box hint:
    // a letter page with CropBox == MediaBox now yields the corner 4×6 region.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const bounds = deriveArtworkBounds(page);
    check('deriveArtworkBounds uses the content-region heuristic on a hint-less letter sheet',
      (bounds.width < 612 - 1 || bounds.height < 792 - 1)
        && near(bounds.width / bounds.height, TARGET_W / TARGET_H, 0.02));
  }

  // ── 3) Content-aware normalization end-to-end ──────────────────────────────
  // A near-4×6 page whose artwork is a small, off-center region must now be
  // re-centered + scaled onto a clean 288×432 page (NOT copied byte-for-byte).
  {
    const merged = await PDFDocument.create();
    const label = await PDFDocument.create();
    const page = label.addPage([TARGET_W, TARGET_H]);
    // small (3"x4"-ish) artwork pushed toward a corner with lots of whitespace.
    page.setCropBox(20, 30, 150, 220);
    await appendNormalizedLabelPages(merged, label);
    const pages = merged.getPages();
    check('content-aware near-4×6 => exactly 1 output page', pages.length === 1);
    const { width, height } = pages[0]!.getSize();
    check('content-aware output page is a clean 288×432', near(width, TARGET_W) && near(height, TARGET_H));
  }

  // A page that is ALREADY centered/full-bleed at 4×6 still lands on 288×432.
  {
    const merged = await PDFDocument.create();
    const label = await PDFDocument.create();
    label.addPage([TARGET_W, TARGET_H]);
    await appendNormalizedLabelPages(merged, label);
    const { width, height } = merged.getPages()[0]!.getSize();
    check('already-4×6 full-bleed normalizes to a 288×432 page', near(width, TARGET_W) && near(height, TARGET_H));
  }

  // Oversized letter-size label still normalizes (existing behavior preserved).
  {
    const merged = await PDFDocument.create();
    const label = await PDFDocument.create();
    label.addPage([612, 792]);
    await appendNormalizedLabelPages(merged, label);
    const { width, height } = merged.getPages()[0]!.getSize();
    check('oversized letter still normalizes to 288×432', near(width, TARGET_W) && near(height, TARGET_H));
  }

  // A rotated page is still copied as-is (orientation never altered).
  {
    const merged = await PDFDocument.create();
    const label = await PDFDocument.create();
    const page = label.addPage([612, 792]);
    page.setRotation(degrees(90));
    await appendNormalizedLabelPages(merged, label);
    const { width, height } = merged.getPages()[0]!.getSize();
    check('rotated label preserved as-is (not force-normalized)', near(width, 612) && near(height, 792));
  }

  // Header pages already in the merged doc are untouched by appending.
  {
    const merged = await PDFDocument.create();
    merged.addPage([TARGET_W, TARGET_H]); // pretend batch header
    const label = await PDFDocument.create();
    const page = label.addPage([TARGET_W, TARGET_H]);
    page.setCropBox(20, 30, 150, 220);
    await appendNormalizedLabelPages(merged, label);
    const pages = merged.getPages();
    check('batch header page is preserved when appending', pages.length === 2);
    const { width, height } = pages[0]!.getSize();
    check('batch header page kept at 288×432 (untouched)', near(width, TARGET_W) && near(height, TARGET_H));
  }

  if (failures > 0) {
    console.error(`\nFAIL PS-287 print-queue label normalization guard (${failures} failing)`);
    process.exit(1);
  }
  console.log('\nPASS PS-287 print-queue label normalization guard');
})().catch((err) => {
  console.error('FAIL PS-287 guard threw:', err instanceof Error ? err.message : err);
  process.exit(1);
});
