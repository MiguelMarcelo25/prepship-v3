// PS-287 (display/PDF-rendering only): pure helpers that make the Print Queue
// label normalization CONTENT-AWARE. These derive the visible-artwork bounds
// from a label page's PDF box hints (CropBox / TrimBox vs the MediaBox) and
// compute the scale-to-fit + centered placement of that artwork on a standard
// 4×6 (288×432 @72dpi) print canvas.
//
// Pure geometry / box-hint reads ONLY — no pdf-lib drawing, no DB, no carrier
// IO, no label bytes, no postage, no shipped/cancelled order or shipment data
// is touched. appendNormalizedLabelPages() (print-queue-pdf.ts) consumes these
// to place a small/off-center label artwork centered on a clean 4×6 page
// instead of copying the page byte-for-byte.

export type ArtworkBounds = { x: number; y: number; width: number; height: number };

// A page box (CropBox/TrimBox/MediaBox) is "meaningful" as an artwork hint only
// when it is positive-sized and strictly TIGHTER than the reference box on at
// least one axis — i.e. it actually trims whitespace. A box equal to (or larger
// than) the MediaBox carries no trim signal and is ignored.
function isTighterBox(
  box: ArtworkBounds | null | undefined,
  reference: ArtworkBounds,
  tol = 0.5,
): box is ArtworkBounds {
  if (!box) return false;
  if (!(box.width > 0) || !(box.height > 0)) return false;
  const tighter = box.width < reference.width - tol || box.height < reference.height - tol;
  const withinReference =
    box.width <= reference.width + tol && box.height <= reference.height + tol;
  return tighter && withinReference;
}

// Minimal structural shape of a pdf-lib PDFPage's box getters, so this stays a
// pure module with no pdf-lib import.
export type BoxHintPage = {
  getMediaBox: () => ArtworkBounds;
  getCropBox?: () => ArtworkBounds;
  getTrimBox?: () => ArtworkBounds;
};

// Derive the visible-artwork bounds for a label page. Prefer the tightest
// meaningful box hint (TrimBox, then CropBox) that actually trims whitespace
// relative to the MediaBox; otherwise fall back to the full MediaBox. The
// returned bounds are in the page's own coordinate space (origin + size), so
// callers can clip/embed exactly that region.
export function deriveArtworkBounds(page: BoxHintPage): ArtworkBounds {
  const media = page.getMediaBox();
  let best: ArtworkBounds = media;

  const candidates: Array<ArtworkBounds | undefined> = [];
  try {
    candidates.push(page.getCropBox?.());
  } catch {
    /* box not present / malformed — ignore */
  }
  try {
    candidates.push(page.getTrimBox?.());
  } catch {
    /* box not present / malformed — ignore */
  }

  for (const box of candidates) {
    if (isTighterBox(box, media) && box.width * box.height < best.width * best.height) {
      best = box;
    }
  }
  return { x: best.x, y: best.y, width: best.width, height: best.height };
}

export type PlaceArtworkInput = {
  artworkW: number;
  artworkH: number;
  canvasW: number;
  canvasH: number;
  // Small safe margin (in points) kept clear on every side so artwork never
  // bleeds to the page edge. Defaults to a conservative 6pt.
  margin?: number;
};

export type PlacedArtwork = { x: number; y: number; drawWidth: number; drawHeight: number };

// Scale-to-fit + center a piece of artwork on a canvas, preserving aspect ratio
// and keeping a small safe margin on every side. Returns the lower-left draw
// origin + the drawn size, ready to hand to pdf-lib's page.drawPage(). Pure
// geometry: it never overflows the (canvas − margin) box and centers on both
// axes.
export function placeArtworkOnCanvas(input: PlaceArtworkInput): PlacedArtwork {
  const margin = Math.max(0, input.margin ?? 6);
  const availW = Math.max(1, input.canvasW - margin * 2);
  const availH = Math.max(1, input.canvasH - margin * 2);
  const artW = Math.max(1, input.artworkW);
  const artH = Math.max(1, input.artworkH);

  const scale = Math.min(availW / artW, availH / artH);
  const drawWidth = artW * scale;
  const drawHeight = artH * scale;

  return {
    x: (input.canvasW - drawWidth) / 2,
    y: (input.canvasH - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}
