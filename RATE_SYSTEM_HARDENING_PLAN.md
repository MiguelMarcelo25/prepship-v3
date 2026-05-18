# PrepShip Rate System Hardening Plan

## Executive Summary

This plan tracks the rate-shopping and Rate Browser hardening work. The target is a fast, reliable operator experience where cached rates can appear immediately, live carrier refreshes happen safely, carrier failures are visible, and one slow or broken carrier never blocks the whole modal.

Some frontend failure-state work is already complete: `fetchRates` no longer converts real request failures into fake empty rate arrays, and Rate Browser improvements have started. Phase 11 Batch 2 adds a static guard for rate hardening, persists carrier diagnostics in `rate_cache`, keeps exact `cacheKey` hits authoritative, and explicitly marks legacy weight/ZIP bulk hits as approximate.

Current progress: 72%. This is not 100% because browser verification, duplicate carrier-name UX polish, provider/account metrics, and durable rate-backfill job status still need implementation or production confirmation.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Silent ShipStation carrier failures | operators see "no rates" without the real reason | per-carrier diagnostics for success, empty, failed, cached, loading | one-carrier-fails test and Rate Browser UI check |
| unrestricted carrier fanout | external rate limits, slow modal, circuit breaker cascades | bounded live-rate concurrency | concurrency test and Render log review |
| cache-key mismatch | cached rates can be stale, wrong, or missed | canonical rate cache key or explicit approximate mode | `npm run test:rate-system-hardening` plus browser cache hit/miss checks |
| repeated no-rate calls | impossible shipments can hammer carrier APIs | short negative-result cache with diagnostics | diagnostics migration and guard; production repeat check still needed |
| duplicate nicknames | operators cannot tell which account failed | display account/source/ID when names collide | duplicate GG6381-style UI test |

## High-Risk Issues

| Area | Current Concern | Recommended Patch | Test Plan |
|---|---|---|---|
| ShipStation diagnostics | carrier errors can collapse to empty rates | [x] return and cache `carrierDiagnostics` with ID, status, error, duration, count | guard plus simulated carrier failure |
| direct-carrier parity | direct carriers and ShipStation diagnostics can differ | [x] normalize diagnostics shape across providers in Rate Browser client | compare direct and ShipStation error display |
| live concurrency | all carriers can be fetched too aggressively | [x] enforce `RATE_FETCH_CONCURRENCY`, default `4` | static guard plus Render log review |
| negative cache | empty results may be re-requested repeatedly | [x] cache no-rate responses and diagnostics for `RATE_NEGATIVE_CACHE_TTL_MS` | repeat same impossible shipment |
| bulk cache | `/rates/cached/bulk` can be weight/zip approximate | [x] use exact keys when supplied; mark rough matches approximate | `npm run test:rate-system-hardening` |
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
- [x] Carrier diagnostics exist for ShipStation and are normalized with direct-carrier diagnostics in Rate Browser.
- [x] Centralize canonical `rateCacheKey`.
- [x] Mark `/rates/cached/bulk` as approximate unless exact keys are supplied.
- [x] Verify/enforce `RATE_FETCH_CONCURRENCY`, default `4`.
- [x] Add `RATE_NEGATIVE_CACHE_TTL_MS`, default `600000`.
- [x] Cache no-rate diagnostics briefly.
- [x] Add `npm run test:rate-system-hardening`.
- [ ] Show duplicate carrier nickname disambiguation.
- [x] Add carrier row states: `cached`, `loading`, `live`, `unavailable`, `error`.
- [x] Add all-carrier auto-refresh on modal open when weight, dimensions, ZIP, and accounts are valid.

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

- [x] one canonical rate cache key builder
- [x] exact cache lookup when `cacheKey` is supplied
- [x] approximate flag for weight/zip-only cache hits
- [x] bounded live carrier concurrency
- [x] negative-result cache
- [x] diagnostic result for every ShipStation/direct carrier in Rate Browser responses
- [ ] provider/account-level timeout and failure logging
- [ ] rate backfill writes diagnostics when no rate is available

### Frontend

- [x] `fetchRates` surfaces real failures to callers
- [x] Rate Browser shows cached rows immediately
- [x] Rate Browser starts one live refresh automatically
- [x] sidebar badges show spinner/ellipsis for loading carriers
- [x] unavailable/error shown only after live check completes
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
- `npm run test:rate-system-hardening`
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
