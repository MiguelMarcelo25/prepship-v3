# PS-348 - Pre-Expiry Rate Refresh Proof

## Backend Owner

The backend owner remains `src/services/rates-backfill.ts`, with refresh
classification delegated to `src/services/rate-preexpiry-refresh-policy.ts` and
progress proof delegated to `src/services/rate-preexpiry-refresh-proof.ts`.
The scheduler only starts `startBackfillBestRates({ mode: 'preexpiry_refresh' })`.

## Scheduler Proof

Pre-expiry scheduler runs are cache-friendly backend backfills. They select
Awaiting rows whose saved rate proof is stale, missing, incomplete, expired, or
near-expiry before the hard purchase TTL. The job snapshot now carries
`preExpiryRefresh`, including selected reason counts, refreshed/skipped counts,
`pushedForward`, and `tupleRefreshed`.

`pushedForward` proves the refreshed backend tuple has a later `cacheExpiresAt`
than the previous visible tuple. `tupleRefreshed` proves the customer-facing
`customerRateAmount` and internal `rateCostAmount` are present together on the
same backend-finalized Best Rate tuple. This is diagnostic proof only; it does
not rank, choose, persist, or mutate rates outside the existing backfill owner.

## Safety

No shipped/cancelled surfaces are touched. No labels, postage, marketplace
notifications, billing, inventory, customer data, shipment history, or provider
purchases are performed by this proof guard.
