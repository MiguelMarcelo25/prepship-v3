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
- Rate Browser open stays cache/display-only; live browse remains explicit operator intent.

No shipped/cancelled surfaces are touched. No labels, postage, marketplace notifications, billing, inventory, or production data mutations are performed by this guard.
