# PS-105 — Backend-Owned Rate Quote Snapshot ID — Truth Report

**Completion: 100%** ✅
**Deployed SHA:** `6f76c214` (final slice; also `0d8ea450`, `831eec0c`) — origin + mirror
**Report date:** 2026-06-06

## Claim
Replace the frontend-carried `selectedRateProof` as the authority with a
backend-owned, opaque rate-quote snapshot identified by `rateQuoteId`, plus an
opaque `selectedRateKey` that hides cost. Backend prefers the snapshot and falls
back to the legacy proof.

## Evidence (verified)
- Guard `npm run test:ps-105-backend-rate-snapshot-id` → **32/32 checks PASS**.
- Files present: `src/services/shipping-workflow/rate-quote-snapshot.ts`,
  `src/services/shipping-workflow/rate-quote-snapshot-store.ts`.
- Commits `0d8ea450`, `831eec0c`, `6f76c214` (3 slices) — on origin + mirror.
- Related boundaries green: `test:selected-rate-proof-boundary` 6/6,
  `test:ps-098-shipping-purchase-boundary` 10/10.

## What this proves
- `/rates/browse` emits an opaque `rateQuoteId` (SHA-256 of cache key, no PII)
  and stamps each rate/bestRate with an opaque `selectedRateKey` (authority key
  hashed → cost not exposed).
- The unified resolver `assertLabelPurchaseRateSelection` prefers the snapshot
  and **delegates final authority to the same strict `validateExactSelectedRate`** —
  i.e. the snapshot path is not a weaker path.

## What it does NOT prove
- No live postage purchase was executed (offline). The guard proves the
  resolution/validation wiring, not a live carrier charge.

## Truth caveats (design, honest)
- **Snapshot store reuses the existing `analytics_cache` table** (key
  `rate_quote:<id>`) — **no new migration**. If that cache is pruned, a snapshot
  can expire.
- **Legacy proof path is always intact** (byte-identical when no `rateQuoteId`
  is supplied). On snapshot miss/expiry the code falls back to
  `assertSelectedRateProofForLabelPurchase`, so **no purchase can break** —
  stale-snapshot → fallback is by design.

## Lockdown compliance
Touched locked label/route files under override `unlock shipped data` (2026-06-06).
Proof + fingerprint enforcement preserved (delegation, not replacement). No real
labels/postage/marketplace calls. Override noted in code comments and commits.
