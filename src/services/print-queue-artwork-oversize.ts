// PS-287 (display/PDF-rendering only): pure box-geometry helpers for TWO more
// bounded content-region cases that the corner-crop heuristic in
// print-queue-artwork-region.ts does NOT cover:
//
//   (a) OVERSIZED-but-already-4×6-aspect — a page that is itself 4×6 shaped
//       (e.g. a 600×900 label exported at 2× DPI) but far larger than a single
//       288×432 label. This must NOT be corner-cropped: the whole page IS the
//       label, so the region is the full page (centered scale-to-fit happens
//       downstream in placeArtworkOnCanvas).
//
//   (b) ASYMMETRIC margins around a centred-able label band — an oversized,
//       non-4×6 sheet whose 4×6-aspect label band is the same WIDTH as a 4×6
//       label but has uneven top/bottom whitespace. Re-center that band
//       vertically instead of slamming it to the top-left corner, so the label
//       lands centred when the band height ≈ a real 4×6 label.
//
// PURE GEOMETRY using PDF BOX dimensions (MediaBox/CropBox/TrimBox sizes) ONLY —
// no pdf-lib import, no DB, no carrier IO, no label bytes, no postage, no
// shipped/cancelled order or shipment data is touched.
//
// NOTE: full pixel/raster whitespace detection (to find a label that floats at
// an arbitrary offset with no box hint) needs a render lib not available
// offline; that is a deliberate follow-on slice. These helpers use box geometry
// only.

import { type Region } from './print-queue-artwork-region';
import { LABEL_4X6_W, LABEL_4X6_ASPECT } from './print-queue-label-4x6-dims';

const LABEL_ASPECT = LABEL_4X6_ASPECT; // 2:3
// Same aspect tolerance the region module uses to call a page "4×6 shaped".
const ASPECT_TOL = 0.03;

function aspectIsNear4x6(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height - LABEL_ASPECT) <= ASPECT_TOL;
}

// Case (a): the page is itself 4×6-shaped (within tolerance). Whatever its size,
// the entire page is the label — return the full page so the downstream
// scale-to-fit + center on 288×432 keeps it whole and centred. Returns null when
// the page is not 4×6-shaped (so the caller falls through to other handling).
export function oversized4x6AspectRegion(page: { width: number; height: number }): Region | null {
  if (!aspectIsNear4x6(page.width, page.height)) return null;
  return { x: 0, y: 0, width: page.width, height: page.height };
}

// Case (b): an oversized, non-4×6 sheet whose label band is a 4×6-aspect
// rectangle the same width as a real 4×6 label (so it is NOT a half-page split),
// but sits with asymmetric top/bottom whitespace. Re-center that band
// vertically on the page (the band stays a 4×6-aspect rectangle), instead of
// anchoring it to the top-left corner. Returns null when the page is wider than
// a label-band would be (a true oversized sheet, handled by the corner crop) so
// the caller keeps the existing top-left behaviour for those.
export function recenteredLabelBandRegion(page: { width: number; height: number }): Region | null {
  const { width: pageW, height: pageH } = page;
  if (!(pageW > 0) || !(pageH > 0)) return null;
  // Only re-center when the page width matches a real 4×6 label width (within a
  // small tolerance): that means the artwork is a vertical band with even side
  // margins and only the TOP/BOTTOM margins are asymmetric. A genuinely wider
  // sheet (letter/A4) keeps the conservative top-left corner crop.
  const widthTol = 1;
  if (Math.abs(pageW - LABEL_4X6_W) > widthTol) return null;
  const bandHeight = pageW / LABEL_ASPECT; // 4×6-aspect band at the page width
  if (!(bandHeight < pageH)) return null; // nothing to re-center
  // Center the band vertically: equal whitespace above and below.
  const y = (pageH - bandHeight) / 2;
  return { x: 0, y, width: pageW, height: bandHeight };
}
