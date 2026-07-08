# PrepShip API Performance Audit — README

**Date:** 2026-07-08 · **Status: diagnosis only — no code changed.** Awaiting go/no-go per phase.
**Scope:** the routes on the "Production API Timing → Hot API Routes" panel, plus everything production data surfaced around them.

## How this was measured

Not guesswork — three evidence sources were cross-checked:

1. **Production database statistics** (Supabase, project `fdkseckgfuvdczzqmnac`): `pg_stat_statements` over a 64-day window (stats reset 2026-05-05), `EXPLAIN` plans, `pg_settings`, table/index inventory. Read-only.
2. **Render service config** for `prepshipv4-api` (`srv-d7qoar7lk1mc73cm4ma0`).
3. **Code trace** of every hot route at commit `d813ff52`, with `file:line` citations throughout.

Caveat when reading the panel: its numbers are **measured in the browser** (`web/src/lib/api.ts` client-timing = auth + fetch), so they include network round-trip to Render Oregon. Server fixes cut the big numbers; they can't go below your network baseline.

---

## The panel, explained route by route

| Route | Panel typical / spike | Diagnosed cause |
|---|---|---|
| `POST /billing/generate` | 1.7s / 3.9s | Non-sargable date filter forces a full orders+shipments lifecycle scan; 8 independent prefetch queries awaited serially; full summary re-aggregate at the tail |
| `GET /billing/generate/status` | 1.4s | Not a status check — 4 heavy uncached queries incl. the same full scan; FE multiplies it per selected client, serially |
| `GET /billing/shipping-margin` | 969ms / 2.9s | Two **unbounded full-table GROUP BYs** every call (grows with history = the spikes); response serialized twice |
| `GET /billing/summary` | 597ms / 1.2s | Cache-hit path still scans watermarks per call; all-or-nothing coverage → one stale client triggers a synchronous DELETE+INSERT rebuild inside the GET |
| `GET /billing/details` | 742ms | 4-way join, no LIMIT, wide JSON per row; full `packages` table reloaded per call |
| `GET /rates/multi` | 1.5s / 2.0s | Live ShipStation `/v2/carriers` call **per connected account per request**, no TTL cache; opens its own DB connection outside the pool |
| `GET /orders` | 562ms | Status filter is a CASE expression **no index can serve**; exact `count(*)` re-runs the same scan every full page; 3 uncached settings reads; per-row `clientName` subquery |
| `GET /settings` | 483ms | The query is trivial — this is **connection-pool starvation** (pool of 4), the clearest symptom of the systemic problem |

---

## Root causes (ranked)

### R1 — The database compute is too small for the data shape *(biggest lever, zero code)*
- Supabase compute ≈ **Small (2 GB)**: `shared_buffers` 512 MB, `max_parallel_workers_per_gather = 1`, `work_mem` 5 MB.
- Database is 855 MB; the `orders` table alone is **415 MB for ~70k rows (~6 KB/row** — wide JSON: `raw`, `items`, rate blobs).
- Proof of starvation: the shipment-watchdog anti-join has a **cheap plan** (cost ≈ 2.8k, index-only scans + hash anti-join — a ~100 ms query on healthy hardware) yet **averages 3.4 s in production**. Good plans, no room to run: one big scan evicts the whole cache.
- Also structural: API in Render **Oregon**, DB in Supabase **us-west-1 (N. California)** — every query pays ~20–30 ms cross-region RTT.

### R2 — Connection pool of 4 + no plan cache *(the systemic amplifier)*
- `DB_POOL_MAX` defaults to **4** ([env.ts:64](../src/lib/env.ts), [client.ts](../src/db/client.ts)); `/orders` holds one connection across ~10–12 sequential round-trips, so a handful of concurrent requests saturate the pool and everything else queues — hence `/settings` at 483 ms.
- `prepare: false` (required for the pooler) means every statement is re-parsed and re-planned — costly for the expensive expressions in R3.

### R3 — The hottest filters are expressions no index can serve
- **Orders status**: `orderLifecycleEffectiveStatusSql()` ([order-lifecycle-status.ts:223](../src/services/order-lifecycle-status.ts)) wraps status in a 5-branch CASE. Every status index leads with raw `order_status` — unused for the filter. The exact `count(*)` ([orders.ts:1583](../src/routes/orders.ts)) then re-runs that scan **again**, sequentially, on every full page.
- **Billing date**: `billingShipDateSql` ([billing.ts:186-204](../src/services/billing.ts)) = `date_trunc(coalesce(ship_date, 3× raw JSON fields, order_date))` — drives full scans in both `/generate` and `/generate/status`.
- **Shipping-margin date**: 5-column `coalesce` used in WHERE and ORDER BY ([shipping-margin-analytics.ts:480-486](../src/services/shipping-margin-analytics.ts)).
- Fix shape for all three: **expression indexes** (additive migrations + runtime-ensure per repo convention) or filter refactors.

### R4 — Read routes doing unbounded work per call
- `/shipping-margin`: `provider_account_names` aggregates **all shipments ever**; `bli` aggregates **all shipping line items ever** ([shipping-margin-analytics.ts:516-535](../src/services/shipping-margin-analytics.ts)) — per call, regardless of window. Plus the whole payload is serialized twice ([billing.ts:491](../src/routes/billing.ts) `{ data: analytics, ...analytics }`).
- `/generate/status`: four heavy serial queries ([billing.ts:339, 363, 393, 429-549](../src/services/billing.ts)); no cache despite `/summary` having a 45-minute cache table.
- `/summary`: watermark `max(created_at)` scan per call ([reporting-metrics.ts:1019-1028](../src/services/reporting-metrics.ts)); one stale client → inline rebuild (a write inside a GET).
- `/details`: no LIMIT; wide JSON per row.

### R5 — Near-static data fetched fresh every time
- `/rates/multi`: live ShipStation fan-out per account per request; fresh `postgres()` connection per request bypassing the pool ([rates-multi.ts:133-164](../src/lib/imported-handlers/rates-multi.ts)).
- `/orders` re-reads carrier markups, marketplace fee rules, and the test-client set on **every request**, serially ([orders.ts:1817, 1833, 1840](../src/routes/orders.ts)).
- `/settings` sends no cache headers. `clientName` is a correlated subquery per returned row ([orders.ts:1305](../src/routes/orders.ts)).

### R6 — Wasteful writes ⚠️ locked surface
- `UPDATE shipments SET provider_account_id … WHERE tracking_number = …`: **1,203,890 executions, 3,078 rows actually changed (0.26%), 7,208 DB-seconds** — the single largest DB consumer. Shipment-sync re-stamps unchanged rows every cycle; needs an "only when different" guard. **`shipments` writes are inside the shipped-data lockdown — this fix requires the explicit `unlock shipped data` override.**

### R7 — Frontend multiplier
- BillingView calls `/generate/status` once per selected client, **serially** ([BillingView.tsx:926-945](../web/src/components/Views/BillingView.tsx)) — N clients × 1.4s before generation even starts.

### Also surfaced (not on the panel)
- **Global order search runs 19–51 s** (`ILIKE '%term%'`, no trigram index; 63 recorded executions averaging 18.9 s) — needs `pg_trgm` GIN or scoped search.
- The `scoped_clients` client-stats CTE: **1.0 s × 1,456 calls**.
- Shipment-sync watchdog: ~5 anti-join queries × ~15 runs/day ≈ 14 s DB per run — plan is fine; resolves with R1.

---

## Fix plan (proposed order)

| Phase | What | Risk | Decision |
|---|---|---|---|
| **0** | Upgrade Supabase compute (Small → Medium+). Consider region colocation later. | ~2 min resize downtime; cost | **DJ** |
| **1** | `DB_POOL_MAX` 4 → 12–15 (Render env — note env-touch auto-deploys); TTL-cache `/rates/multi` + move it to the shared pool; process-cache markups/fees/test-clients; cache headers on `/settings` | Low | go-ahead |
| **2** | Additive index pack: expression indexes (lifecycle status, billing ship-date, margin ship-date), `billing_line_items (client_id, ship_date)` + `created_at`, `shipments (provider_account_id)`, `pg_trgm` for search. Each proven with EXPLAIN before/after; migration + runtime-ensure + guard per repo convention | Low (additive only) | go-ahead |
| **3** | Surgical query fixes: parallelize generate's prefetch + page/count pair; `/generate/status` reuses the summary watermark + FE batches the per-client loop; bound shipping-margin aggregates to the window + drop double serialization; LIMIT `/details`; join `clients` instead of per-row subquery | Medium (behavior-neutral, guard-checked) | go-ahead |
| **4** | Shipments no-op UPDATE guard (**needs `unlock shipped data`**); summary rebuild off the request path; colocation | Gated | **DJ** |

**Invariants for any implementation:** billing money semantics stay byte-identical (all amounts come from pure policy functions — optimizations change *when/how* data is fetched, never *what* is computed); shipped/cancelled lockdown respected (reads fine, the one write fix is override-gated); every slice ships with EXPLAIN proof + zero-new-reds guard sweep, same discipline as the OrdersView track.

---

*Full agent trace reports (pipeline maps, every file:line) are in the session transcript of 2026-07-08. Companion doc: the OrdersView frontend before/after report (same day).*
