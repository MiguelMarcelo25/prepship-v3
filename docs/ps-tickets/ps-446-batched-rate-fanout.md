# PS-446 — Batched ShipStation Rate Fan-Out Certification

Trello: https://trello.com/c/EnSMYBMo

Status on 2026-07-21: **GO for Final Review**. After the absent `se-604209`
account was surfaced, the user instructed the rollout to proceed with the
current live ShipStation topology. One all-source run is green across every
available DR PREPPER and KFG account.

## Source-of-Truth Placement

- `src/services/rates.ts` remains the canonical ShipStation fan-out,
  completeness, fallback, and diagnostic owner. It was not changed.
- `src/services/shipstation-rate-batch.ts` remains the canonical batch-response
  attribution owner. It was not changed.
- `scripts/probe-batched-rate-estimate.ts` owns only operator rollout evidence.
  It now compares `service_code`, `package_type`, `shipping_amount`,
  `other_amount`, `insurance_amount`, and `confirmation_amount` independently.
- DR PREPPER auto-selection requires a genuine multi-UPS case and includes
  every live UPS account. It fails if `--max-carriers` would truncate that
  coverage. Known backend-registry IDs are ordering hints, while ShipStation
  carrier discovery is authoritative for current availability and legitimate
  replacement accounts.

## Imperfect-Data Injection Fixed

The restored probe collapsed all four money components into one total. Equal and
opposite component drift could therefore pass. Auto-selection also sorted every
eligible account by ID and sliced the first eight, so it did not guarantee the
ticket's multi-UPS case. A fixed registry count also treated the stopgap mapping
as live availability after ShipStation stopped returning `se-604209`. The probe
now rejects component drift, requires at least two live UPS accounts, and fails
closed unless every currently returned UPS account fits in the probe.

## Live Provider Evidence

The probe called only `GET /v2/carriers` and `POST /v2/rates/estimate`. It made no
label purchase, postage, order/shipment mutation, or marketplace notification.
Request construction reused one per-source base body; only `carrier_ids` varied
between the batch and single-account calls.

- Distinct credential sources discovered: 2 (`env:primary`, `env:kfg`). No
  additional distinct per-client credential source was present.
- Required all-source probe: GO in one run.
- DR PREPPER parity: 65 batch rows matched 65 single rows across every available
  account (five UPS, USPS, and FedEx One Balance).
- KFG parity: 65 batch rows matched 65 single rows across all seven accounts.
- `se-604209`, the former ROCEL account in the stopgap registry, remains absent
  from live ShipStation discovery and is not fabricated as available truth.

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
- Batch limiter wait: 0.01 ms average, 0 ms p95.
- Batch provider duration: 2.98 seconds average, 5.83 seconds p95.
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

## Closure Decision

The operator approved proceeding after the missing account was reported. The
canonical closure command is now green:

```text
npm run probe:shipstation-batched-rate-estimate -- --live --source=all
```

No full production Recalculate All was started merely for certification because
that would write operational rate state. The existing three-day canary provides
the before/after request-volume and limiter evidence without mutating orders,
shipments, labels, billing, inventory, or marketplace state.
