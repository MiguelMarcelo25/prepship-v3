# PS-319 - Rate Convergence Certification Plan

## Goal

Certify the post-PS-313 rate convergence path without creating a second Best
Rate owner. PS-319 should map current backend source-of-truth owners, prove
each caller delegates or blocks, and add a focused regression guard for stale
or non-final purchase proof.

## Source of truth

- Canonical rate universe: `src/services/rates-combined.ts#combineCarrierUniverses`.
- Canonical best-rate selection: `src/services/rates.ts#pickBestRate` and the
  PS-313 finalization guards.
- Purchase proof: `src/services/shipping-workflow/rate-quote-snapshot-store.ts`
  and `src/services/shipping-workflow/rate-fingerprint.ts`.
- Purchase side effects: `src/services/labels.ts#createLabelV2`.
- Queue side effects: `src/services/print-queue.ts` delegating to
  `createLabelV2`.

## Imperfect data injection points

- Rate Browser or cached rows can carry old/missing snapshot refs.
- A quote can be incomplete while the carrier universe is still finalizing.
- A user can select a row that is not the finalized backend Best Rate.
- Print Queue can need to create a missing label later, after the original
  browse/apply context has gone stale.

## Tasks

1. Add `scripts/ps-319-rate-convergence-certification-guard.ts`.
   - Behavioral checks: `resolveRateQuoteForPurchase` and
     `assertRateQuoteForLabelPurchase` block `snapshot_not_final` while
     allowing manual non-best selections from a completed backend quote.
   - Static checks: `labels.ts` proof gate comes before provider purchase;
     Print Queue forwards and classifies proof errors; frontend helpers pass
     through backend proof and do not mint fingerprints.
2. Wire `test:ps-319-rate-convergence-certification` in `package.json`.
3. Run the new guard before adding the certification doc and confirm RED on
   missing PS-319 documentation only.
4. Add `docs/ps-tickets/ps-319-rate-convergence-certification.md` with:
   - owner map,
   - caller convergence matrix,
   - residual canary-gated gaps,
   - proof commands,
   - safety/no-live-side-effect statement.
5. Run the new guard GREEN, then run predecessor/source-of-truth guards and
   type/build checks.
6. Commit locally. Do not move or comment Trello unless separately requested.

## Verification commands

- `npm run test:ps-319-rate-convergence-certification`
- `npm run test:rate-source-of-truth`
- `npm run test:ps-302-apply-best-rate-authority`
- `npm run test:ps-303-print-queue-authority`
- `npm run test:selected-rate-proof-boundary`
- `npm run test:print-to-queue-selected-rate-proof`
- `npm run test:ps-191-retry-eligibility`
- `npm run test:ps-198-rate-quote-proof-passthrough`
- `npm run test:ps-328-rerate-warning-reason`
- `npm run typecheck`
- `npm run build:web`
- `git diff --check`

## Safety

No real labels, postage, marketplace notifications, production mutations, or
shipped/cancelled data mutations. Avoid editing locked shipped/cancelled files.
