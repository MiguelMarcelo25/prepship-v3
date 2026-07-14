# Audit 5.1 — Rate on ingest with exact signature cache

## Architecture placement / source-of-truth gate

- **Business rule/workflow being changed:** A genuinely new awaiting source
  order should enter bounded backend rating immediately after its authoritative
  import and package-fact materialization, while rate reuse remains exact and
  never promotes a coarse zone/package class into official Best Rate truth.
- **Canonical backend/domain/read-model/policy owner:**
  `src/services/store-order-import.ts` owns the post-import admission event;
  `src/services/rates-backfill.ts` owns bounded background execution and calls
  the existing combined rate authority; `rate_cache.cache_key`, built by
  `buildShippingRateRequestFingerprint`, remains the exact cache owner.
- **Current duplicated/unsafe owners:** New orders wait for the periodic
  PS-348/backfill sweep. Direct provider work in import code or a second cache
  keyed only by coarse zone/weight/dims classes would duplicate rate authority.
- **Where bad/stale/incomplete data can enter:** Admission can occur before
  combo/package facts are materialized, repeated sync pages can be mistaken for
  new orders, targeted IDs can be dropped behind an active backfill, or an
  approximate signature can reuse money across different destination
  surcharge/account facts.
- **Callers that must delegate to the owner:** Every normalized store connector
  already delegates persistence to `upsertNormalizedStoreOrders`; that owner
  admits only newly inserted awaiting identities to the rate-backfill queue,
  which delegates cache/live selection and combined Best Rate to existing rate
  services.
- **Wrapper/resolver/helper logic to delete or explicitly forbid:** Provider
  calls from store import, frontend auto-rating authority, coarse-signature
  official-rate reuse, duplicate queued IDs, and unbounded ingest batches are
  forbidden.
- **Frontend role: display/action only; no authoritative business logic:** No
  frontend changes. Existing Orders DTOs continue to display backend rating
  state and backend-issued Best Rate proof.
- **Backend boundary tests required:** The focused guard behaviorally proves
  queue deduplication and 100-order drip batches; it also proves exact cache
  identity changes for ZIP, weight, dimensions, options, residential state, and
  eligible account set while remaining order-independent.
- **Workflow/UI proof required:** Store-import, targeted backfill, PS-348,
  fingerprint, rate-source-of-truth, strict typecheck, production build, and
  mandatory SOT guards pass.

## Exactness decision

The audit shorthand proposed a `zone/weight/dims-class/options` signature. That
shape is unsafe as official money truth because carrier delivery-area and other
destination surcharges can differ inside a broad zone/class. PrepShip therefore
reuses the existing exact request fingerprint instead: exact destination and
origin, exact weight and dimensions, confirmation/insurance options,
residential state, ship-date/version policy, and eligible account identity. It
provides every requested isolation axis with stricter granularity. A new order
can reuse a complete current cache row only when those exact facts match.

The process-local ingest queue is an admission optimization, not durable job
truth; the existing scheduled backfill remains the crash/restart safety net.
Fleet-wide admission remains Phase 5.5.

Per the user's current-conversation override `unlock shipped data`, the shared
import owner reads the terminal-preserved post-upsert status and admits only
`awaiting_shipment` rows. It does not alter terminal status, shipments, labels,
postage, inventory, or marketplace confirmation.
