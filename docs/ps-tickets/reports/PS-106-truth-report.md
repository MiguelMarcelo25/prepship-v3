# PS-106 — Configurable Direct-Store vs ShipStation Carrier Eligibility — Truth Report

**Completion: 100%** ✅
**Deployed SHA:** `1e4f6887` (also `9b399bad`, `4da2a8e5`) — origin + mirror
**Report date:** 2026-06-06

## Claim
A configurable policy decides whether direct-store orders (Walmart/eBay/direct
connectors) may use ShipStation carrier accounts. Enforced at both the label
purchase boundary and the `/rates/browse` rating read path. Modes:
`enforce | audit_only | disabled`, default `audit_only`, fail-safe.

## Evidence (verified)
- Guard `npm run test:ps-106-carrier-family-eligibility` → **43/43 checks PASS**
  (pure matrix + classifiers + policy + purchase wiring + Settings UI + /browse wiring).
- Files present: `carrier-family-eligibility.ts` (pure, zero imports),
  `carrier-eligibility-policy.ts`, `web/.../Settings/CarrierEligibilityPolicyCard.tsx`.
- Commits `9b399bad`, `4da2a8e5`, `1e4f6887` — on origin + mirror.
- `npm run typecheck` clean.

## What this proves
- Pure decision over source × carrier-family × mode (exhaustive sweep tested).
- Both enforcement points consult the same primitive:
  - purchase: `assertCarrierFamilyEligibleForPurchase` (enforce throws BEFORE the
    ShipStation provider call; route maps to a safe 400).
  - rating: `/rates/browse` drops ShipStation rates only when enforce blocks;
    audit_only keeps + logs a would-block; best-effort + fail-open.
- Settings toggle reads/writes the `block_shipstation_for_direct_store` setting.
- Mode read fails safe to `audit_only` on a settings outage.

## What it does NOT prove
- No live provider purchase exercised (offline). Enforcement is proven
  structurally + by pure-function matrix, not by a live blocked charge.

## Truth caveats (honest)
- **Default mode is `audit_only` → runtime behavior is unchanged until an operator
  selects "Enforce" in Settings.** The blocking capability ships dormant by design
  (inverse-risk rollout: observe real traffic before blocking).
- Order-source classification relies on `orders.sourceProvider` / `raw` — there is
  no dedicated store-connector table in this repo. This is the best available
  signal; validate audit logs before flipping to enforce.

## Lockdown compliance
Touched locked label/route files under override `unlock shipped data` (2026-06-06).
Default audit_only ⇒ no behavior change; purchase boundary remains authoritative.
No real labels/postage/marketplace calls. Override noted in code comments and commits.
