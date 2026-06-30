# PS-345 - Rate Loading Orchestration Source-Of-Truth Cleanup

## Goal

Stop Awaiting Shipment and Rate Browser from quietly starting broad live rate
work from frontend wrappers. The frontend may render backend/cached rate state
and send explicit operator intent, but live fan-out, best-rate selection,
freshness proof, and backfill orchestration belong to the backend rate owner.

## Backend Owners

- `src/routes/rates.ts` owns `/rates/browse`, `/rates/cached/bulk`, and
  `/rates/backfill-best` request boundaries.
- `src/services/rates.ts` owns carrier eligibility, markup/insurance-applied
  rate ranking, canonical best rate, and quote proof fields.
- `src/services/rates-backfill.ts` owns backend bulk/backfill orchestration.
- `src/services/shipping-workflow/best-rate-workflow-dto.ts` owns row freshness
  and workflow facts shown by Awaiting Shipment.

## Imperfect Data Injection

The bad input was not a provider payload. It was frontend request churn:

- `OrdersView.tsx` passively browsed live rates for visible Awaiting rows on
  page mount and silently kicked backend backfill for overflow rows.
- `RateBrowserModal.tsx` opened with a cached-only probe that could leave the
  operator on partial proofless rows such as `7 of 9 carriers checked`.

Those calls could refresh row rates, change display state, and compete with the
interactive Rate Browser even when the operator only opened the page or modal.

## First Slice

- Remove browser-owned passive live-rate constants, counters, workers, and
  overflow backfill handoff from `OrdersView.tsx`.
- Add a read-only Awaiting observer for backend/sync-started rate backfill
  jobs. It reads `/rates/backfill-best/latest`, attaches active jobs to the
  existing job poller, and refetches rows as the backend resolves them without
  starting hidden frontend live-rate work.
- Keep explicit manual controls: Recalculate All, per-row Retry, and side-panel
  Recalculate may still ask backend rate endpoints for live work.
- Treat opening Rate Browser as explicit operator intent. The modal starts the
  backend live workflow across all scoped carrier accounts instead of stopping
  at cached-only partial coverage. Cached partial rows may display while the
  backend workflow continues, but final selection still requires backend proof.
- No shipped/cancelled surfaces are touched.

## Guard

Run:

```bash
npm run test:ps-345-rate-loading-sot
```

The guard proves:

- Awaiting no longer has a page-mount passive live-rate drain;
- Awaiting observes backend/sync-started rate backfill jobs and reuses the
  existing row-refresh poller;
- Awaiting retry delegates to an explicit backend recalculate path;
- Rate Browser open starts the backend live workflow for all scoped carriers;
- the Refresh Live Rates button remains an explicit retry of that workflow;
- the ticket ledger and this SOT note stay registered.
