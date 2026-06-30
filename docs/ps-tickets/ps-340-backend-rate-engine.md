# PS-340 - Backend Rate Engine

## Backend Owner

The canonical owner for rate fan-out remains `src/services/rates.ts`, with `/rates/browse` in `src/routes/rates.ts` acting as a thin orchestration route and `src/services/rates-backfill.ts` as the backend bulk producer. Rate Browser and Awaiting Shipment may display cached/backend DTOs, but they must not own live quote orchestration, ranking, proof, or persistence.

## Imperfect Data Injection

Bad rate state first enters when one operator action fans out to too many carrier accounts or when a slow provider leaves partial results looking authoritative. PS-345 removed the browser-owned passive live-rate trigger. This PS-340 slice closes the remaining backend fan-out gap: direct-carrier quotes now drain through a bounded backend concurrency cap instead of launching every visible direct account at once.

## PS-340 Number Collision

The repository already has `test:ps-340-ratebrowser-bridge-audit` for an older local cleanup named "Rate Browser frontend bridge audit." The Trello card also uses PS-340 for the backend rate-engine/performance task. To avoid deleting or rewriting the older guard, this slice adds `test:ps-340-backend-rate-engine` and this separate note.

## Current Slice

- ShipStation live rating stays under `RATE_FETCH_CONCURRENCY` plus the ShipStation budget limiter.
- Direct-carrier live rating now uses `DIRECT_CARRIER_RATE_FETCH_CONCURRENCY`, defaulting to the backend rate fetch concurrency.
- `/rates/browse` continues to single-flight identical live provider fan-outs before ranking and proof stamping.
- Recalculate All/backfill remains backend-owned and uses background ShipStation priority.
- Awaiting page load stays passive; Rate Browser open is explicit operator intent
  and starts the backend live workflow with a cache-first preview.

## 2026-06-30 Volume Proof Slice

The backend now exposes limiter snapshots from `src/services/rates.ts` and carries
those snapshots in `rateBrowseTiming.rateEngineLimiter`. This is observability
only: it reports active ShipStation permits, interactive/background waiters,
ShipStation budget usage, and direct-carrier concurrency caps. It does not rank
rates, select carriers, apply markup, persist Best Rate, or change money fields.

The volume proof models DJ/Hermes' high-volume concern without provider calls:
100 selected orders, 9 visible ShipStation accounts, 17 visible direct-carrier
accounts, `RATE_FETCH_CONCURRENCY=4`, `DIRECT_CARRIER_RATE_FETCH_CONCURRENCY=4`,
and live backfill order concurrency of 2. The backend caps the burst to 2 active
orders, 4 total ShipStation carrier calls, and 8 direct-carrier calls across the
active order workers. Awaiting page load remains 0 provider calls; Rate Browser
live work remains explicit and single-flighted; the pending heartbeat refreshes
before the stale-display window so queued rows do not flip into false unavailable
state while the burst drains.

Proof command:

- `npm run test:ps-340-rate-engine-volume-proof -- --no-color`

No shipped/cancelled surfaces are touched. No labels, postage, marketplace notifications, billing, inventory, or production data mutations are performed by this guard.
