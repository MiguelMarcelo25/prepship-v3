# PS-320 - v2-apiClient Transport Boundary

## Scope

PS-320 certifies `web/src/lib/v2-apiClient.ts` and
`web/src/lib/v2-apiClient/shared.ts` as the legacy v2 facade over backend
owners. The client may move HTTP requests, auth headers, query/body shapes,
typed response data, redacted errors, download blobs, and compatibility DTO
translation. It must not decide PrepShip business truth.

This work intentionally reuses the PS-314 no-source-of-truth-bypass law,
PS-316 backend-truth law, PS-313 rate source-of-truth guard, PS-317 frontend
buy anti-regression guard, and the older PS-302/303/305/202/124 boundary
guards. PS-320 adds a focused ratchet over v2-apiClient instead of creating a
second governance system.

## v2-apiClient responsibility map

### Transport-only API methods

These methods are allowed because they send operator intent or read requests to
backend routes and return backend DTOs:

| Area | v2-apiClient surface | Backend owner |
| --- | --- | --- |
| Rate browse / quote reads | single internal `postRateBrowseTransport`, public `apiClient.browseRates`, legacy `apiClient.fetchRates` array adapter | `src/routes/rates.ts#/browse`, `src/services/rates-combined.ts`, `src/services/shipping-workflow/rate-quote-snapshot-store.ts` |
| Label purchase intent | `apiClient.createLabel` | `src/services/labels.ts#createLabelV2` |
| Print Queue intent / status | `apiClient.addToQueue`, batch-send/print/confirm methods | `src/services/print-queue.ts` |
| Atomic best-rate apply command | `apiClient.applyBestRate` | orders backend apply-best-rate command plus rate proof owners |
| Billing, dashboard, analysis reads | invoice/download/read methods | backend billing and read-model routes, including `src/services/shipping-workflow/rate-money.ts` |
| Package facts and order display | package/order read and save wrappers | `src/services/package-facts-policy.ts` and backend order routes |
| Inventory DTO reads and writes | inventory/package wrappers | backend inventory routes and read models; stock threshold fallback delegates to `src/lib/inventory-stock-status.ts` |
| Carrier account visibility reads | `apiClient.fetchCarriersForStore` | backend `/rates/carriers-for-store` plus `src/lib/direct-carrier-scope.ts` |

### Compatibility shims / DTO translators

The current v2 facade still keeps these compatibility shims so the bulk-ported
views do not need a wide rewrite:

- `postRateBrowseTransport` is the only frontend POST path to backend
  `/rates/browse`. It normalizes legacy request aliases and applies in-flight
  de-duplication only; it does not alter returned rate money, freshness, proof,
  `bestRate`, or `secondBestRate` fields.
- `apiClient.browseRates` returns the backend `/rates/browse` DTO verbatim.
  Backend `src/routes/rates.ts#/browse` stamps the legacy display aliases
  (`amount`, `shipmentCost`, `otherCost`, carrier/service/account display
  fields) before the response leaves the rate owner.
- `apiClient.fetchRates` is a legacy calculator adapter over the same transport.
  It returns an array for RatesView/NewOrder preview and carries direct-carrier
  warnings for display, but it does not stamp proof/freshness metadata or expose
  a separate best-rate result.
- `apiClient.createLabel` is only `POST /labels`; `src/services/labels.ts#createLabelV2`
  owns proof validation, carrier branch selection, purchase, persistence,
  deductions, and marketplace confirmation.
- `apiClient.addToQueue` is only `POST /print-queue/add`; it enqueues an
  already-owned label URL and does not buy postage or choose a rate.
- `apiClient.applyBestRate` delegates the one-shot persist command to the
  backend instead of composing selected-provider, dims, and best-rate saves in
  the frontend.
- `apiClient.fetchCarriersForStore` starts with the backend
  `/rates/carriers-for-store` DTO and keeps a legacy direct-account merge for
  picker compatibility. Carrier-account scope delegates to
  `src/lib/direct-carrier-scope.ts`; label/rate purchase paths still re-check
  backend gates.
- `translateRatePayloadToV4`, `translateRateToLegacyDisplayShape`,
  `normalizeInventoryDto`, and package/client normalizers translate field names
  and backend DTO aliases only. They must not rank, select, persist, or silently
  substitute business truth.

## Rate Transport Matrix

| Caller | Frontend method | Endpoint | DTO handling | Fields no longer synthesized in v2-apiClient |
| --- | --- | --- | --- | --- |
| Rate Browser / Orders browse flows | `apiClient.browseRates` | `POST /rates/browse` | Verbatim backend DTO pass-through from `postRateBrowseTransport` | `rates`, `bestRate`, `secondBestRate`, `requestFingerprint`, `cacheExpiresAt`, `proofSource`, `amount`, `shipmentCost`, `otherCost` |
| RatesView calculator | `apiClient.fetchRates` | `POST /rates/browse` through `postRateBrowseTransport` | Legacy display array adapter only | backend proof/freshness fields and best-rate object |
| NewOrder preview | `apiClient.fetchRates` | `POST /rates/browse` through `postRateBrowseTransport` | Same legacy display array adapter | backend proof/freshness fields and best-rate object |
| Cached-rate bulk lookup | `apiClient.fetchCachedRatesBulk` | `POST /rates/cached/bulk` | Cached-hit legacy display adapter | live browse `bestRate`/proof/freshness authority |

### Forbidden in v2-apiClient

The client must not contain or add:

- Final/best-rate selection, ranking, or local `combined[0]` logic.
- Direct-carrier rate fan-out or calls to legacy `/carriers/rates`.
- Direct-carrier label purchase orchestration or calls to legacy
  `/carriers/labels`.
- Selected-rate proof/fingerprint minting such as
  `buildShippingRateRequestFingerprint`, `selectedRateAuthorityKey`,
  `createHash`, or local purchase-proof assertions.
- Queue route authority, duplicate-label prevention, marketplace confirmation,
  inventory movement, billing totals, package fact precedence, auth/scope
  decisions, or shipped/cancelled edit safety.
- Wrappers that hide the backend owner. A wrapper is acceptable only when it is
  a thin transport adapter, a DTO compatibility shim, or a direct delegation to
  a canonical owner.

## Safety

This certification is offline and read-only. It performs No real label purchases,
No postage, No marketplace notifications, No production order mutations, and
No shipped/cancelled mutations. It also does not change
`orders.ts`, `shipments.ts`, `OrdersView.tsx`, or any shipped/cancelled lock
surface.

## Required proof

- `npm run test:ps-320-v2-api-client-transport`
- `npm run test:ps-314-no-sot-bypass-wrappers`
- `npm run test:ps-316-backend-truth-law`
- `npm run test:rate-source-of-truth`
- `npm run test:ps-317-fe-buy-anti-regression`
- `npm run test:ps-302-thin-client-apply-delegation`
- `npm run test:ps-303-fe-route-binding`
- `npm run test:ps-305-authority-drift`
- `npm run typecheck`
- `npm run build:web`
