# Audit 3.8 — Structured money-path logging placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** Backend failures emit one machine-parseable log
  carrying the active request identifier and, when the operation is order
  scoped, its order identifier. Expected operator rejections remain warnings;
  unexpected failures use the shared error sink.
- **Canonical backend owner:** `src/lib/structured-log.ts` owns JSON log shape,
  async context propagation, error normalization, and duplicate suppression.
- **Current duplicated/unsafe owners:** API, Billing, Rates, Labels, and legacy
  Node handlers wrote unrelated `console.error` / `console.warn` shapes. Several
  caught failures returned HTTP 500 or continued with a fallback without any
  shared sink. `requestId` existed only in `main.ts` and was not available to
  service logs.
- **Earliest imperfect-data entry:** Context is first lost after request ID
  creation when route/service async work starts. Error evidence is first lost
  when a catch block converts a failure into a response or fallback.
- **Callers that delegate:** API request context and global errors, Billing
  route/service failures, rate browse/shopify failures, label purchase failures,
  and the legacy safe-error adapter delegate to the shared owner.
- **Logic deleted or forbidden:** Scoped money paths must not invent new error
  log shapes or print Error objects directly. They add business identifiers and
  delegate; logging never decides rates, labels, billing, or persistence.
- **Frontend role:** None. The frontend continues consuming backend responses
  and owns no logging or money truth.
- **Backend boundary proof:** `test:audit-structured-money-logging` proves async
  request/order propagation, JSON shape, canonical-field protection, error
  normalization, duplicate suppression, and source delegation.
- **Workflow proof:** Existing billing, rate source-of-truth, label-owner,
  typecheck, build, SOT-pack, and lockdown guards cover integrated paths.

## Deferred boundary

External log transport and alert routing remain deployment concerns. This slice
establishes one in-process sink without adding a vendor SDK or runtime flag.
