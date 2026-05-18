# PrepShip Rate System Hardening Plan

## Executive Summary

This plan tracks the rate-shopping and Rate Browser hardening work. The target is a fast, reliable operator experience where cached rates can appear immediately, live carrier refreshes happen safely, carrier failures are visible, and one slow or broken carrier never blocks the whole modal.

Some frontend failure-state work is already complete: `fetchRates` no longer converts real request failures into fake empty rate arrays, and Rate Browser improvements have started. The remaining work is to centralize rate cache keys, finish carrier diagnostics, verify bounded concurrency, add negative-result caching, and make bulk cache lookup semantics explicit.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Silent ShipStation carrier failures | operators see "no rates" without the real reason | per-carrier diagnostics for success, empty, failed, cached, loading | one-carrier-fails test and Rate Browser UI check |
| unrestricted carrier fanout | external rate limits, slow modal, circuit breaker cascades | bounded live-rate concurrency | concurrency test and Render log review |
| cache-key mismatch | cached rates can be stale, wrong, or missed | canonical rate cache key or explicit approximate mode | cache hit/miss tests with dims/account/residential changes |
| repeated no-rate calls | impossible shipments can hammer carrier APIs | short negative-result cache with diagnostics | repeated no-rate request test |
| duplicate nicknames | operators cannot tell which account failed | display account/source/ID when names collide | duplicate GG6381-style UI test |

## High-Risk Issues

| Area | Current Concern | Recommended Patch | Test Plan |
|---|---|---|---|
| ShipStation diagnostics | carrier errors can collapse to empty rates | return `carrierDiagnostics` with ID, source, status, error, duration, count | simulate one carrier failure |
| direct-carrier parity | direct carriers and ShipStation diagnostics can differ | normalize diagnostics shape across providers | compare direct and ShipStation error display |
| live concurrency | all carriers can be fetched too aggressively | enforce `RATE_FETCH_CONCURRENCY`, default `4` | inspect logs and unit/integration behavior |
| negative cache | empty results may be re-requested repeatedly | cache no-rate responses for `RATE_NEGATIVE_CACHE_TTL_MS` | repeat same impossible shipment |
| bulk cache | `/rates/cached/bulk` can be weight/zip approximate | use exact keys when supplied or mark approximate | bulk cache regression test |
| Rate Browser UX | cached-only results can show misleading `0` counts | loading/cached/live/unavailable/error states | modal open with cached hit and cache miss |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| carrier account labels | duplicate nicknames hide actual account identity | show nickname plus source/account ID where needed |
| stale best rate | cached best rate can be mistaken for live | show source and age in UI |
| external API outage | ShipStation/direct carrier outage can look like no rates | visible provider outage diagnostic |
| order list rate preload | rough cached reads can be overtrusted | distinguish approximate preload from exact browse rates |
| rate backfill | job state and cache writes need durability | move progress/status to durable job state |

## Recommended Patches

- [x] Do not hide `fetchRates` request failures behind empty arrays.
- [x] Add frontend failure-state guard for rate critical fetches.
- [x] Rate Browser cached/progressive direction started.
- [~] Carrier diagnostics exist in parts of the system but need full ShipStation/direct-carrier parity.
- [ ] Centralize canonical `rateCacheKey`.
- [ ] Mark `/rates/cached/bulk` as approximate unless exact keys are supplied.
- [ ] Verify or enforce `RATE_FETCH_CONCURRENCY`, default `4`.
- [ ] Add `RATE_NEGATIVE_CACHE_TTL_MS`, default `600000`.
- [ ] Cache no-rate diagnostics briefly.
- [ ] Show duplicate carrier nickname disambiguation.
- [ ] Add carrier row states: `cached`, `loading`, `live`, `unavailable`, `error`.
- [ ] Add all-carrier auto-refresh on modal open when weight, dimensions, ZIP, and accounts are valid.

## Target API/Interface Shape

Use a shared diagnostics shape for browse/live/cached rate calls:

```ts
type CarrierRateStatus =
  | 'cached'
  | 'loading'
  | 'live'
  | 'ok'
  | 'empty'
  | 'unavailable'
  | 'failed'
  | 'error';

type CarrierDiagnostic = {
  carrierId: string;
  carrierCode?: string;
  nickname?: string;
  source?: 'shipstation' | 'direct' | 'cache';
  status: CarrierRateStatus;
  rateCount: number;
  durationMs?: number;
  error?: string;
  approximate?: boolean;
};
```

Rate Browser responses should include:

```ts
{
  requestKey: string;
  source: 'cache' | 'live' | 'mixed';
  cacheAgeMs?: number;
  bestRate?: unknown;
  rates: unknown[];
  carrierDiagnostics: CarrierDiagnostic[];
}
```

## Checklist

### Backend

- [ ] one canonical rate cache key builder
- [ ] exact cache lookup when full payload is available
- [ ] approximate flag for weight/zip-only cache hits
- [ ] bounded live carrier concurrency
- [ ] negative-result cache
- [ ] diagnostic result for every carrier/account
- [ ] provider/account-level timeout and failure logging
- [ ] rate backfill writes diagnostics when no rate is available

### Frontend

- [x] `fetchRates` surfaces real failures to callers
- [ ] Rate Browser shows cached rows immediately
- [ ] Rate Browser starts one live refresh automatically
- [ ] sidebar badges show spinner/ellipsis for loading carriers
- [ ] unavailable/error shown only after live check completes
- [ ] duplicate carrier names include account/source detail
- [ ] stale/cached/live labels are visible
- [ ] refresh button remains available for manual re-check

### Production Verification

- [ ] open Rate Browser on cached order
- [ ] open Rate Browser on cache miss
- [ ] click Browse Rates repeatedly and confirm in-flight dedupe
- [ ] change weight/dims/package and confirm old request is ignored or replaced
- [ ] simulate slow/failed carrier and confirm other carriers still show
- [ ] keep Network tab open for 2 minutes and confirm no request storm

## Test Plan

- `npm run typecheck`
- `npm run build:web`
- `npm run test:frontend-failure-states`
- `npm run test:orders-ux`
- backend rate tests for:
  - one carrier failure
  - all carriers empty
  - duplicate carrier nickname
  - exact cache hit
  - approximate cache hit
  - negative cache hit
  - concurrency cap
- browser Rate Browser smoke tests in production after deploy

## Deployment/Rollback Notes

- Roll out diagnostics first because they are additive.
- Roll out concurrency and negative cache behind env defaults:
  - `RATE_FETCH_CONCURRENCY=4`
  - `RATE_NEGATIVE_CACHE_TTL_MS=600000`
- If live rates appear incomplete after rollout, disable/raise concurrency and inspect carrier diagnostics before reverting.
- Do not change label creation behavior in this rate hardening batch.
