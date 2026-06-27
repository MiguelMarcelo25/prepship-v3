# PS-341 - Frontend compatibility helper audit

Goal: Stop temporary frontend compatibility bridges from becoming permanent backend-truth resolvers.

Acceptable:
- A helper may read legacy object shapes only for display/back-compat.
- A helper may forward backend-issued proof fields.
- A helper may normalize presentation strings.

Not acceptable:
- A helper may not choose official Best Rate.
- A helper may not mint selected-rate proof or rate fingerprints.
- A helper may not compute label purchase eligibility.
- A helper may not calculate authoritative margin/markup/rate money for real orders.

Target cleanup:
- `getSavedBestRateRecord()` must be tracked as compatibility debt until the backend DTO is single-shape.
- `buildSelectedRateProofPayload()` must keep delegating to `selectProofFromCandidates()` and never mint proof.
- `renderBestRatePrice()` may use backend money tuples and display fallback only.
