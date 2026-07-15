# Audit 5.2 — Advisory local tariff engine with nightly calibration

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** PrepShip may maintain a bounded,
  local empirical estimate from nightly live quotes for drift diagnostics and
  future capacity planning. The estimate is advisory evidence only; it is not a
  quote, Best Rate, selected rate, or purchase input.
- **Canonical backend/domain/read-model/policy owner:** Official quote
  normalization and markup remain in `src/services/rates.ts`; combined-universe
  ranking remains solely in
  `src/services/rates-combined.ts#combineCarrierUniverses`. The pure
  `src/services/local-tariff-engine.ts` owns only non-purchasable interpolation
  inside an exactly calibrated route/package/residential lane.
- **Current duplicated/unsafe owners:** A frontend estimator, a local cheapest
  selector, a provider-fallback wrapper, or local values shaped as official
  `Rate` rows would duplicate backend rate authority. None is introduced.
- **Where bad/stale/incomplete data can enter:** A probe can see a transient
  provider response, account or markup changes, an invalid probe matrix, an
  empty service set, or an expired calibration model. The worker therefore
  probes sequentially at background priority, requires every bounded point to
  return priced rates, publishes atomically only after a complete run, expires
  the rebuildable model after eight days, and never extrapolates.
- **Callers that must delegate to the owner:** The nightly worker delegates
  address/account normalization to `resolveRateInput`, provider reads to
  `fetchLiveRatesWithDiagnostics`, customer amounts to `applyMarkups` and the
  canonical money normalizer, and durable cadence to pg-boss. There is no
  production quote, browse, backfill, proof, or label caller of the local model.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Converting
  an estimate into a `Rate`, calling `pickBestRate`, adding estimates to
  `combineCarrierUniverses`, minting selected-rate proof, extrapolating beyond
  live weight evidence, silently falling back to the model, or reading it from
  label/billing workflows is forbidden.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend change and no frontend endpoint. The model never becomes a `Rate`
  or a browser-visible official price.
- **Backend boundary tests required:** The focused guard proves exact-lane
  matching, exact and bounded linear interpolation, no extrapolation, explicit
  `advisory_only` / `purchasable:false` / null-proof output, canonical live
  normalization calls, background priority, default-OFF scheduling, and absence
  from official selection and protected order/shipment/label code.
- **Workflow/UI proof required:** The focused Audit 5.2 guard,
  `test:rate-source-of-truth`, mandatory SOT guard pack, strict typecheck, and
  production web build pass. No UI proof is required because this is a
  worker-only derived diagnostic with no frontend surface.

## Operational shape

The durable pg-boss worker schedules calibration at `08:00 UTC` only when
`ENABLE_LOCAL_TARIFF_CALIBRATION_SCHEDULER=true` and a ShipStation v2 key is
present. It is disabled by default, so deploying the code makes zero new live
provider calls. The default matrix is four destination ZIPs × three weights =
12 sequential, read-only rate probes using one 12×10×6 residential package.
Environment values can change the destinations and weights, but the validated
maximum remains 20 by default (hard maximum 40).

The published model is one rebuildable `analytics_cache` row with an eight-day
expiry. Calibration does not write `rate_cache`, orders, shipments, labels,
proof snapshots, or billing data. It compares a prior model when available and
logs the maximum observed drift before atomically replacing the advisory model.
No live calibration was run while implementing this audit item; production
enablement remains a separate operator go/no-go because it consumes provider
rate budget.
