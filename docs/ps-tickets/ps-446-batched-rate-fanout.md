# PS-446 — Batched ShipStation Rate Fan-Out Certification

Trello: https://trello.com/c/EnSMYBMo

Status on 2026-07-21: **NO-GO for Final Review**. The comparison contract and
currently available account probes are green, but DR PREPPER exposes five live
UPS accounts and the ticket requires a six-UPS probe.

## Source-of-Truth Placement

- `src/services/rates.ts` remains the canonical ShipStation fan-out,
  completeness, fallback, and diagnostic owner. It was not changed.
- `src/services/shipstation-rate-batch.ts` remains the canonical batch-response
  attribution owner. It was not changed.
- `scripts/probe-batched-rate-estimate.ts` owns only operator rollout evidence.
  It now compares `service_code`, `package_type`, `shipping_amount`,
  `other_amount`, `insurance_amount`, and `confirmation_amount` independently.
- DR PREPPER auto-selection requires at least six live UPS accounts. Known
  backend-registry IDs are prioritized, while ShipStation carrier discovery is
  authoritative for current availability and legitimate replacement accounts.

## Imperfect-Data Injection Fixed

The restored probe collapsed all four money components into one total. Equal and
opposite component drift could therefore pass. Auto-selection also sorted every
eligible account by ID and sliced the first eight, so it did not guarantee the
ticket's six-UPS case. The probe now rejects component drift and fails closed
unless the live DR PREPPER topology contains six UPS accounts.

## Live Provider Evidence

The probe called only `GET /v2/carriers` and `POST /v2/rates/estimate`. It made no
label purchase, postage, order/shipment mutation, or marketplace notification.
Request construction reused one per-source base body; only `carrier_ids` varied
between the batch and single-account calls.

- Distinct credential sources discovered: 2 (`env:primary`, `env:kfg`). No
  additional distinct per-client credential source was present.
- DR PREPPER available-account parity: GO, 65 batch rows matched 65 single rows
  across seven accounts (five UPS, USPS, and FedEx One Balance).
- KFG parity: GO, 65 batch rows matched 65 single rows across seven accounts.
- Required all-source probe: NO-GO before rate calls because DR PREPPER exposes
  five live UPS accounts. `se-604209`, the former ROCEL account in the stopgap
  registry, is absent from the live ShipStation carrier response.

## Existing Canary Diagnostics

The Render API and sync-worker environments already had
`SHIPSTATION_BATCHED_RATE_FANOUT=true` before this work began. Read-only
`rate_cache.diagnostics` evidence for 2026-07-18 06:37 UTC through 2026-07-21
04:53 UTC contained:

- 766 cached requests on the batched path.
- 4,593 batch diagnostics and 187 targeted fallback diagnostics.
- Estimated flag-off provider calls: 4,780.
- Observed flag-on calls (one batch probe per cache row plus fallback calls):
  953, an estimated 80.06% reduction.
- 29 cache rows used fallback. All 187 fallback diagnostics were non-transient;
  49 returned rates, 5 were empty, and 133 were terminal failures.

The existing completeness-safe fallback and cacheability policies remain
unchanged. The production flag was not changed during this certification.

## Verification

- `npm run test:probe-batched-rate-estimate`
- `npm run test:shipstation-batched-rate-fanout`
- `npm run test:rate-source-of-truth`
- `npm run test:ps-050-rate-accuracy`
- `npm run test:ps-050-rate-exactness`
- `npm run test:ps-241-rate-browser-fanout`
- `npm run test:rates-multi-cache`
- `npm run test:rates-multi-durable-snapshot`
- `npm run test:sot-guard-pack` (49/49 commands passed with offline test env)
- `npm run typecheck`

## Remaining Gate

Restore or replace the sixth live DR PREPPER UPS account, then rerun:

```text
npm run probe:shipstation-batched-rate-estimate -- --live --source=all
```

Only a green six-UPS all-source result can close PS-446 and move it to Final
Review - Lawrence.
