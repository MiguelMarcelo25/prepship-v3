# PS-294 SHIPP 4x6 label status

Date: 2026-06-22

## Current status

Current completion estimate: PS-294 90%.

PS-294 is Final Review-ready after the focused guards pass. SHIPP-specific PDF
labels delegate to the shared content-aware 4x6 normalizer, while the raster
PNG/GIF path keeps the connector-local placement owner. The proof covers
oversized PDF pages, cropped PDF pages, PNG raster labels, GIF raster labels,
and the 288 x 432 point 4x6 canvas invariant.

This is not a live-label claim. A sanitized production label artifact would be
useful extra evidence, but the current offline fixture proof is enough for
Final Review because it exercises the same pure normalization owners used by
SHIPP Create+Print and Print Queue output.

## Evidence now wired

- `test:ps-287-print-queue-label-normalization`
- `test:ps-287-print-queue-label-normalization-closeout`
- `test:ps-294-shipp-4x6-placement`
- `test:ps-294-shipp-4x6-closeout`

## What is proven

- SHIPP PDF output imports `appendNormalizedLabelPages` from the pure
  `print-queue-pdf` module, not the env-heavy print-queue barrel.
- SHIPP PDF output uses the shared PS-287 content-aware crop/fill path.
- SHIPP raster output still delegates placement math to
  `computeFourBySixPlacement`.
- All normalized fixture outputs produce a single 4x6 PDF page.
- The guard proves the content-aware fill is materially larger than the old
  whole-page contain-fit behavior for oversized SHIPP labels.

## Missing before 100%

- Optional sanitized production artifact proof if DJ wants a real captured SHIPP
  sample attached to the card.
- Trello move/comment only after explicit `task update`.

## Safety

This proof is offline-only. It does not run live labels, buy postage, mutate
queues, call providers, send marketplace notifications, update production
orders, or mutate shipped/cancelled data.
