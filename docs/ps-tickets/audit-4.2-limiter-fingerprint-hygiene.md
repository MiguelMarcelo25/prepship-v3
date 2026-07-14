# Audit 4.2 — limiter configuration and fingerprint hygiene placement

## Architecture placement / source-of-truth gate

- **Business rule/workflow:** ShipStation requests must consume one backend-owned
  admission configuration, and rate-request identity must distinguish destination
  state from store identity. This slice changes no ranking, markup, purchase, or
  carrier-eligibility rule.
- **Canonical owners:** `src/lib/shipstation/rate-limit-config.ts` owns V1/V2
  limiter values and environment parsing. `rate-fingerprint.ts` owns request-axis
  serialization. `rates.ts` owns the cache namespace that invalidates fingerprints
  whose serialization contract changed.
- **Current duplicated/unsafe owners:** The V2 transport parsed five limiter
  constants inline while V1 repeated its 38/minute budget and window arithmetic.
  The fingerprint builder reused `st=` for both destination state and store ID.
- **Earliest imperfect-data entry:** Collision entered when a request without a
  client ID serialized its store ID into the state namespace. A state-like value
  and a store value could therefore produce the same cache/proof identity.
- **Callers that delegate:** Both ShipStation clients import limiter values from
  the shared transport config. All cache/proof callers continue to use
  `buildShippingRateRequestFingerprint`; store identity now serializes as `sid=`.
- **Wrapper/helper logic deleted or forbidden:** ShipStation clients must not
  reparse limiter environment variables or repeat V1 budget/window literals.
  Callers must not mint or rewrite fingerprints outside the canonical builder.
- **Frontend role:** None. The frontend continues to consume backend-issued rate
  DTOs and proof fields and cannot mint selected-rate proof.
- **Backend boundary proof:** `test:audit-limiter-fingerprint-hygiene` executes
  the pure builder to prove distinct `st=`/`sid=` axes, pins the v4 namespace,
  and ensures both transports consume the shared config.
- **Workflow proof:** Existing PS-050, PS-256, priority-limiter, shipping-workflow,
  and rate source-of-truth guards prove limiter admission and proof callers remain
  delegated to their canonical backend owners.

No shipped/cancelled or other protected path is touched. Verification is offline
and performs no configured database write, provider call, label/postage purchase,
marketplace notification, inventory change, or production data mutation.
