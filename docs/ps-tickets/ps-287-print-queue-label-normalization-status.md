# PS-287 Print Queue label normalization status

Date: 2026-06-22

## Current status

Current completion estimate: PS-287 92%.

PS-287 is Final Review-ready after the focused guards pass. The shared Print
Queue label normalizer now has content-aware 4x6 placement evidence for tight
PDF box hints, no-box oversized sheets, exact and near-4x6 pages, oversized
4x6-aspect pages, label-width pages with asymmetric vertical whitespace,
rotated pages, and batch header preservation.

## Evidence

- `test:ps-287-print-queue-label-normalization`
- `test:ps-287-print-queue-label-normalization-closeout`

## What is proven

- `appendNormalizedLabelPages()` writes unrotated carrier labels onto a clean
  288x432 canvas.
- The normalizer derives artwork bounds from CropBox/TrimBox when available.
- No-box letter/A4 carrier sheets derive a conservative top-left 4x6 region
  instead of scaling the whole whitespace-heavy page.
- Genuine exact/near/oversized 4x6 labels are kept whole and not corner-cropped.
- A 288-wide sheet with extra top/bottom whitespace is re-centered as a 4x6
  band.
- Rotated labels are still copied as-is so orientation is not altered.
- Batch header pages already in the merged document are preserved.
- The proof is offline only: no real labels, postage, provider calls, print
  queue writes, marketplace notifications, production data repair, or
  shipped/cancelled data mutation.

## Remaining before 100%

Optional next evidence: add real captured carrier PDFs as sanitized fixtures if
DJ wants production-artifact proof. This is not blocking Final Review because the
current guards already exercise the geometry classes without live provider
calls.
