PS-204 update:
Branch: ps-204-canonical-rate-source
PR: (paste this file as the PR body — `gh` CLI is not installed on the dev machine)

Summary:
Order 1484 (HUGRAB) exposed the money-path split-brain: the panel charged `shippingProviderId=10000025` (Shipp synthetic) while the proof/winning rate belonged to ShipStation `se-565377`, and the failed path emitted `carrier_id: "se-10000025"` to ShipStation. Nothing compared the rate-proof account, the displayed account, the purchase-payload account, and the queue route. This PR binds them, in four layers:

1. **Purchase boundary (backend, canonical)** — `assertLabelPurchaseRateSelection` now enforces that the validated proof rate's provider-account identity matches the payload's `shippingProviderId` on **both** proof paths (snapshot-resolved and legacy carried). Mismatch throws the existing `SelectedRateProofError` class before any provider call, with actionable codes: `DIRECT_CARRIER_ON_SHIPSTATION_PATH` (synthetic payload on a ShipStation proof — the 1484 shape) or `SELECTED_RATE_ACCOUNT_MISMATCH`. Absent either side, the binding skips — never weaker than the pre-PS-204 boundary.
2. **Last mile (backend)** — `buildSsLabelRequestBody` asserts the carrier_id is not a synthetic id: PrepShip can no longer *emit* `se-10000025` to ShipStation, whatever upstream routing produced it.
3. **Proof construction (frontend, thin consumer)** — panel, batch-queue, and batch-create payloads filter proof/quote-ref candidates to the account they charge (`rate-proof.ts` owns the rule; no-options behavior is byte-identical — the ps-198 behavior suite still passes). A mixed-source attempt now shows "Browse Rates for <account>" instead of failing server-side with a generic error.
4. **Display/routing honesty (frontend)** — switching Ship Acct drops a preview rate that belongs to another account (no `$7.66 · Shipp` card backed by an `se-565377` proof), and single-order Print to Queue routes by the **live panel payload** pid when present instead of the stale saved DTO (batch flows keep PS-176 backend-policy routing; the never-buy ladder is untouched).

Display-invariant note (#1 of the card): since PS-203, the Awaiting Best Rate cell, the side panel, and the Rate Browser recommended row all consume the same backend combined-universe winner (`combineCarrierUniverses` → persisted DTO → PS-196 cache-first display). The gap was the *mixed-source composition at purchase time* — closed above; the ps-204 guard pins the canonical identity helpers both sides share.

Architecture/source-of-truth placement:
- Business rule: "a rate proof is only valid for the account it was quoted on."
- Canonical owner: `src/services/shipping-workflow/rate-fingerprint.ts` (pure `validatePurchaseAccountBinding` / `assertPurchaseAccountMatchesProof`), enforced at the single purchase boundary `assertLabelPurchaseRateSelection` (rate-quote-snapshot-store), which runs ahead of BOTH the direct branch and the ShipStation branch in `createLabelV2`.
- Why this layer: the proof validator is already the one purchase gate every label path crosses; the account identity is part of proof validity, so it lives with the proof rules — not in routes, not in the UI.
- Callers updated to delegate: `createLabelV2` passes `body.shippingProviderId`; FE builders pass the charged account into the canonical `rate-proof.ts` filter (display logic stays a pure read of backend-stamped identity).
- Duplicate logic removed: none added — the FE mirrors the backend normalization via one helper (`rateProviderAccountKey`) instead of per-site comparisons.
- Boundary tests added: `scripts/ps-204-account-binding-guard.ts` (30 checks) wired as `test:ps-204-account-binding`.

Files changed:
- src/services/shipping-workflow/rate-fingerprint.ts — pure binding owner + error codes
- src/services/shipping-workflow/rate-quote-snapshot-store.ts — boundary enforces binding on both proof paths
- src/services/labels.ts — createLabelV2 passes the purchase account into the gate
- src/lib/shipstation/labels.ts — `assertSsCarrierIdIsNotSynthetic` last-mile emission block
- web/src/lib/rate-proof.ts — account identity helpers + optional candidate filter
- web/src/components/Views/OrdersView.tsx — account-bound proof/quote-ref at panel/batch/batch-create sites, mixed-source re-rate toast, Ship Acct preview clearing, live-payload queue routing, PS-078 req-4 comment amendment
- web/src/components/Views/orders-parity.ts — `classifyQueueOrderRoute` explicit live-payload input (never-buy rungs unchanged)
- scripts/ps-204-account-binding-guard.ts — NEW (30 checks incl. the 1484 fixture)
- scripts/{selected-rate-proof-purchase-boundary, ps-095, ps-105} guards — re-anchored counts that were stale AT BASE (see follow-ups), now also pinning the account-bound forms
- package.json — test:ps-204-account-binding

Verification:
- npm run lint:parity: UNAVAILABLE (no such script in package.json) — closest equivalents run below (proof-family parity guards)
- npm run typecheck: PASS
- npm run test:ps-204-account-binding: PASS (30 checks)
- npm run test:selected-rate-proof-boundary: PASS (after documented re-anchor; was failing AT BASE)
- npm run test:ps-095-selected-rate-proof-pass-through: PASS (same)
- npx tsx scripts/ps-105-backend-rate-snapshot-id-guard.ts: PASS (same)
- npx tsx scripts/ps-198-rate-quote-proof-passthrough-guard.ts: PASS (behavioral — FE filter changes nothing without options)
- npx tsx scripts/ps-079-best-rate-source-of-truth-guard.ts: PASS
- npm run test:print-to-queue-selected-rate-proof: PASS
- npm run test:ps-104-print-queue-selected-rate-proof-pass-through: PASS
- npm run test:recalculate-best-rate-strict: PASS
- npm run test:ps-203-best-rate-universe: PASS
- npm run test:ps-202-direct-label-owner: PASS
- npm run test:ps-078-connector-matrix: PASS
- npm run test:shipping-roundtrip-certification: PASS
- npm run build:web: PASS

Safety notes:
- no real postage bought (all checks pure/offline; provider calls never reached)
- no duplicate labels created
- no shipped/cancelled production mutations (no DB writes in this change at all)
- selected-rate proof enforcement strictly STRENGTHENED (binding only ever adds a block); stale-rate/fingerprint guards untouched
- no raw provider payloads, tracking, label URLs, PII, or credentials in code/tests/PR

Known follow-ups/blockers:
- Pre-existing discovery: the three re-anchored guards (`selected-rate-proof-boundary`, `ps-095`, `ps-105`) had payload-site counts that were stale at base (failing silently since the PS-178 decomposition; they are not in the cert suite). Re-anchored honestly here with notes — consider adding them to the cert checkpoint so count drift surfaces in CI.
- PS-206 (Rate Browser full scoped coverage) builds on this card's canonical identity; PS-200 S5/S8 will refresh the compatibility-matrix `carrier_vercel` naming.
- The side-panel rate CARD still renders the preview/saved rate's own strings; with this PR it can no longer be cross-account purchasable (filter + toast + backend block), and switching accounts drops the stale preview. A richer visual "stale — re-rate for <account>" badge is a small follow-up if DJ wants it beyond the current behavior.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
