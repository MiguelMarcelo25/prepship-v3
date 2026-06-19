// PS-294 — the SINGLE owner of where a SHIPP label's source page/image is drawn on the 4×6
// (288×432pt = 4in×6in @72dpi) postage canvas. Extracted from the DUPLICATED Math.min contain-fit
// that lived inline in shipp.ts's appendShippPdfPages + appendShippImagePage, so the 4×6 invariant +
// centering now have ONE testable owner.
//
// Behavior: contain-fit (the whole source fits inside 4×6, aspect preserved) + centered — byte-
// identical to the prior inline math. PS-294 GRAFT POINT: when PS-287's content-aware artwork-bounds
// normalizer lands as a shared owner, the {srcWidth, srcHeight} fed here become the CROPPED artwork
// box (so an oversized / corner label fills the canvas instead of shrinking) — this function stays
// the place/center math.
//
// Pure (no pdf-lib / IO) so the PS-294 guard verifies the geometry offline.

export const FOUR_BY_SIX_WIDTH_PT = 288; // 4in @72dpi
export const FOUR_BY_SIX_HEIGHT_PT = 432; // 6in @72dpi

export type FourBySixPlacement = {
  /** width to draw the source at, in points (≤ targetWidth) */
  drawWidth: number;
  /** height to draw the source at, in points (≤ targetHeight) */
  drawHeight: number;
  /** x offset of the drawn source on the canvas (centers it horizontally) */
  x: number;
  /** y offset of the drawn source on the canvas (centers it vertically) */
  y: number;
};

export function computeFourBySixPlacement(input: {
  srcWidth: number;
  srcHeight: number;
  targetWidth?: number;
  targetHeight?: number;
}): FourBySixPlacement {
  const targetWidth = input.targetWidth ?? FOUR_BY_SIX_WIDTH_PT;
  const targetHeight = input.targetHeight ?? FOUR_BY_SIX_HEIGHT_PT;
  // A non-positive source dimension (corrupt/empty label part) can't be fit — fall back to the full
  // canvas so the assembled page is never NaN- or negative-sized.
  if (!(input.srcWidth > 0) || !(input.srcHeight > 0)) {
    return { drawWidth: targetWidth, drawHeight: targetHeight, x: 0, y: 0 };
  }
  const scale = Math.min(targetWidth / input.srcWidth, targetHeight / input.srcHeight);
  const drawWidth = input.srcWidth * scale;
  const drawHeight = input.srcHeight * scale;
  return {
    drawWidth,
    drawHeight,
    x: (targetWidth - drawWidth) / 2,
    y: (targetHeight - drawHeight) / 2,
  };
}
