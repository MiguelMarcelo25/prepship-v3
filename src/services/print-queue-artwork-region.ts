// PS-287 (display/PDF-rendering only): pure no-box-hint content-region
// heuristic for Print Queue label normalization.
//
// Some carriers return the 4×6 shipping label printed in a CORNER of a much
// larger sheet (full US-letter or ISO-A4) but leave CropBox == MediaBox, so the
// box-hint reader in print-queue-artwork-fit.ts finds NO trim signal and would
// fall back to the whole MediaBox. Scaling that whole sheet (mostly whitespace)
// onto the 288×432 print canvas makes the actual label print tiny and shifted.
//
// This helper derives a conservative 4×6-aspect content region for such a page
// WITHOUT reading any box hints: when the page is clearly oversized relative to
// a single 4×6 label, it returns the standard 4×6 label rectangle anchored to
// the page's TOP-LEFT corner (the conventional PDF label anchor — high y in
// PDF's bottom-left origin space). A genuine 4×6 / near-4×6 page carries no
// sub-region signal, so the full page is returned unchanged and real artwork is
// never cropped.
//
// Pure geometry only — no pdf-lib import, no DB, no carrier IO, no label bytes,
// no postage, no shipped/cancelled order or shipment data is touched.

export type Region = { x: number; y: number; width: number; height: number };

// Two more bounded box-geometry cases (oversized-but-4×6 page; label-width sheet
// with asymmetric top/bottom whitespace) live in their own small module and are
// delegated to from deriveLabelContentRegion below. Imported at the bottom of
// the file is not possible (ESM hoists), so import here.
import { oversized4x6AspectRegion, recenteredLabelBandRegion } from './print-queue-artwork-oversize.js';

// Standard 4×6 label @72dpi (the print-queue canvas target) and its aspect.
// Sourced from a leaf dims module so sibling helpers can share them without a
// circular import; re-exported here to keep existing import sites working.
import { LABEL_4X6_W, LABEL_4X6_H, LABEL_4X6_ASPECT } from './print-queue-label-4x6-dims.js';
export { LABEL_4X6_W, LABEL_4X6_H };
const LABEL_ASPECT = LABEL_4X6_ASPECT; // 2:3

// A page whose total area is within this multiple of a 4×6 label's area AND
// whose aspect is already close to 4×6 is treated as a single label (returned
// whole). Above this, the page is an oversized sheet (letter/A4/…) holding a
// corner label, so we derive the 4×6 corner region. 1.6× comfortably keeps a
// near-4×6 page (e.g. 300×444 ≈ 1.07×) whole while rejecting letter (≈3.9×).
const OVERSIZE_AREA_RATIO = 1.6;
// Aspect tolerance for "this page is itself ~4×6 shaped". Deliberately tight so
// the standard oversized SHEET sizes — US-letter (0.773) and ISO-A4 (1:√2 ≈
// 0.707) — are NOT mistaken for a 4×6 label (0.667), while a true 4×6 page at
// any DPI (and a near-4×6 page such as 300×444 ≈ 0.676) is still left whole.
const ASPECT_TOL = 0.03;

function aspectIsNear4x6(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height - LABEL_ASPECT) <= ASPECT_TOL;
}

// Largest 4×6-aspect rectangle that fits inside (w, h), capped at the standard
// 288×432 label so a very large sheet still yields a label-sized region rather
// than a blown-up one. Returns width/height only (placement handled by caller).
function labelSizedRegion(pageW: number, pageH: number): { width: number; height: number } {
  // Start from the standard 4×6 label; clamp to the page if (unusually) smaller.
  let width = Math.min(LABEL_4X6_W, pageW);
  let height = width / LABEL_ASPECT;
  if (height > pageH) {
    height = Math.min(LABEL_4X6_H, pageH);
    width = height * LABEL_ASPECT;
  }
  return { width, height };
}

// Derive the visible-label content region for a page that has NO usable box
// hint. Oversized sheets yield a conservative 4×6-aspect region anchored to the
// page top-left; genuine 4×6 / near-4×6 pages are returned whole.
export function deriveLabelContentRegion(page: { width: number; height: number }): Region {
  const pageW = page.width;
  const pageH = page.height;
  if (!(pageW > 0) || !(pageH > 0)) {
    return { x: 0, y: 0, width: Math.max(0, pageW), height: Math.max(0, pageH) };
  }

  const labelArea = LABEL_4X6_W * LABEL_4X6_H;
  const pageArea = pageW * pageH;
  const oversized = pageArea > labelArea * OVERSIZE_AREA_RATIO;

  // Case (a): a page that is itself 4×6-shaped (any size, oversized or not) is
  // the label — return it whole so the downstream scale-to-fit + center keeps it
  // intact and never corner-crops a genuine (possibly high-DPI) 4×6 page.
  const oversized4x6 = oversized4x6AspectRegion({ width: pageW, height: pageH });
  if (oversized4x6) return oversized4x6;

  // Already a single 4×6-ish label (right size AND right shape): leave whole.
  if (!oversized || aspectIsNear4x6(pageW, pageH)) {
    // Case (b): a label-WIDTH sheet (≈288 wide) that is too TALL has its
    // 4×6-aspect band sitting with asymmetric top/bottom whitespace — re-center
    // the band vertically instead of returning the whole whitespace-heavy page.
    const band = recenteredLabelBandRegion({ width: pageW, height: pageH });
    if (band) return band;
    return { x: 0, y: 0, width: pageW, height: pageH };
  }

  const { width, height } = labelSizedRegion(pageW, pageH);
  // Anchor top-left: PDF origin is bottom-left, so the page TOP edge is at
  // y = pageH; the region's bottom edge sits at pageH − height.
  return { x: 0, y: pageH - height, width, height };
}
