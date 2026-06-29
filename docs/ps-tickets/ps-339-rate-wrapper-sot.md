# PS-339 - Rate Wrapper SOT Guard

## Scope

This PS-339 card adds a static CI guard against rate source-of-truth bypass
wrappers. It does not refactor the product path and does not buy labels, rate
providers, mutate production orders, or touch shipped/cancelled locked surfaces.

The backend rate owner remains authoritative for Best Rate selection, Rate
Browser canonical best emission, quote proof, freshness, money aliases, House
Rate, Rate Cost, shipping margin, and Best Rate Final/second-best facts.

## PS-339 Number Collision

The repo already has `test:ps-339-ebay-api-testing-certification` and
`docs/ps-tickets/ps-339-ebay-api-testing-certification.md` for an older local
PS-339 eBay certification slice. This Trello PS-339 is tracked separately as
`test:ps-339-rate-wrapper-sot` and this document. The older eBay guard is not
renamed or overwritten.

## Forbidden Wrapper Patterns

The guard fails if the protected frontend/rate-adapter surfaces add these
patterns:

- Rate Browser locally ranking by display total and emitting/persisting the
  sorted first row as the official Best Rate.
- v2-apiClient or shared adapters minting `amount`, `shipmentCost`,
  `bestRate`, `secondBestRate`, `rateQuoteId`, `selectedRateKey`,
  `requestFingerprint`, `proofSource`, cache freshness, customer/house/rate
  cost, or margin truth instead of passing backend DTO fields through.
- `useOrders`, orders-row display helpers, or rate helper paths searching many
  legacy shapes to create authoritative Best Rate truth.
- Wrapper helpers such as `withBestRateOverride`, `withoutStaleBestRate`,
  `bestRateLegacy`, `displayBestRate`, or local proof/fingerprint hashing.

## Allowed Thin Helpers

These helpers are allowed when they stay thin:

- Formatting-only helpers such as money/date/label display.
- Provider or backend DTO field-name translators that do not rank, select,
  persist, mint proof, or silently substitute stale truth.
- React state, request intent, in-flight de-duplication, and backend DTO
  pass-through.
- Display ordering by backend rank. If an amount fallback exists, it is only for
  row ordering and cannot feed `onBestRateResolved`, `emitBestRateResolved`,
  `applyBestRate`, or any official Best Rate write.

## Existing Debt Allowlist

| ID | File | Symbol | Owner | Removal condition |
| --- | --- | --- | --- | --- |
| PS339-DEBT-v2-legacy-display-translator | `web/src/lib/v2-apiClient/shared.ts` | `translateRateToLegacyDisplayShape` | PS-320/PS-342 | Delete when legacy Rate Browser and calculator callers consume backend DTO rows directly. |
| PS339-DEBT-useorders-selected-rate-normalizer | `web/src/hooks/useOrders.ts` | `normalizeRateForV2` | PS-341/PS-344 | Delete when order rows no longer need v2 selected-rate compatibility shape. |
| PS339-DEBT-row-second-best-shape-reader | `web/src/components/Views/orders-row-display.tsx` | `getCachedSecondBestRate` | PS-334/Best Rate Final | Delete when backend row DTO emits one canonical bestRateFinal/secondBest display field. |
| PS339-DEBT-row-second-best-money-reader | `web/src/components/Views/orders-row-display.tsx` | `readRateTotalAmount` | PS-334/Best Rate Final | Delete when backend row DTO emits the numeric bestRateFinal amount directly. |
| PS339-DEBT-rate-proof-metadata-wrapper | `web/src/components/Views/orders/best-rate/rate-proof.ts` | `withRateRequestMetadata` | PS-317/PS-341 | Delete when Apply/label/queue payloads can pass backend proof DTOs verbatim. |
| PS339-DEBT-ratebrowser-proof-lifter | `web/src/components/RateBrowserModal.tsx` | `rateBackendProof` | PS-198/PS-321 | Delete when Rate Browser row DTO and applied-rate DTO share one backend proof shape. |
| PS339-DEBT-ratebrowser-display-rank-sorter | `web/src/lib/rate-browser-money.ts` | `sortRateRowsByBackendDisplayRank` | PS-321/PS-343 | Delete amount fallback when backend displayRank is present on every Rate Browser row. |

This allowlist is a ratchet. New debt requires a file, symbol, owner PS card,
why it is not source-of-truth, and a removal condition before it can be added.

## Required Proof

Run these before moving the Trello card forward:

```bash
npm run test:ps-339-rate-wrapper-sot
npm run test:ps-314-no-sot-bypass-wrappers
npm run test:ps-316-backend-truth-law
npm run test:rate-source-of-truth
npm run test:ps-320-v2-api-client-transport
npm run test:ps-321-ratebrowsermodal-thin-ui
npm run test:ps-333-hugrab-current-rate-sot
npm run test:ps-334-house-rate-column
npm run typecheck
```
