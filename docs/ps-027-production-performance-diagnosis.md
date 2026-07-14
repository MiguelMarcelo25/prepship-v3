# PS-027 Phase 0 Production Performance & Infrastructure Diagnosis

Date: 2026-05-23
Branch: prepshipv4-stable
Latest commit observed: a510b62c Keep print queue entries until confirmed printed

## Summary

Do we migrate now? **partial / not full yet**

Why: the current evidence does not prove that Vercel, Render, or Supabase is the primary root cause. Public production checks are healthy and fast enough at the shell/readiness layer. The strongest risks are inside the application/data workflow: Orders list query shape, DB pool contention during background sync, user-facing requests that still block on external providers, and some frontend polling/status loops that need hard stop limits.

Evidence:
- Vercel shell and route shell smoke passed 8/8 routes with max 560ms.
- Direct Render `/health`, `/health/ready`, and `/health/deep` returned 200 in all samples.
- Deep health component DB/orders/printQueue checks were ~21-26ms in most samples, with one 93ms sample.
- Protected production route timing endpoints require admin auth; p95/p99 hot-route production data could not be collected from this shell without an authorized bearer token.

Fastest stabilizing fixes:
- Confirm Render API has `RUN_SYNC_SCHEDULER=false` and Render worker has `RUN_SYNC_SCHEDULER=true`.
- Pull authenticated `/observability/status` and `/observability/api-timing` during ops hours.
- Add a read-only DB pool/slow-query diagnostic script for Supabase dashboard/SQL editor.
- Optimize the Orders list hot path before a full migration.
- Keep expensive provider calls async/job-backed where possible.

If AWS is justified, recommended staged target:
- Stage 1: keep Vercel frontend; move API/worker only after route/DB evidence proves Render is the bottleneck.
- Stage 2: move Postgres to RDS only if Supabase pool/slow-query evidence shows unavoidable pool pressure after query fixes.
- Stage 3: introduce SQS/ECS/EC2 worker isolation after pg-boss/worker pressure is proven.

What AWS will fix:
- More control over API/worker CPU, memory, restart behavior, private networking, and DB connection topology.

What AWS will not fix:
- Slow SQL, unindexed JSON/search predicates, provider latency, frontend loading loops, or workflows that block on external carrier/marketplace APIs.

Risks/rollback:
- Full AWS migration adds DevOps overhead and can move existing app bottlenecks unchanged.
- Rollback is easiest if migration is staged: frontend unchanged first, then API, then worker, then DB.

## Production Baseline

Probe command shape:

```bash
curl -sS -o BODY -w 'http=%{http_code} total=%{time_total} starttransfer=%{time_starttransfer} size=%{size_download}\n' --max-time 20 URL
```

Five samples were taken per URL from the local shell.

| Target | HTTP | Total ms p50 | Max ms | Size | Notes |
|---|---:|---:|---:|---:|---|
| `https://prepshipv4.vercel.app/` | 200 | 481 | 824 | 1271 | App shell only. |
| `https://prepshipv4.vercel.app/api/health` | 200 | 618 | 1046 | 47 | Vercel rewrite to Render health. |
| `https://prepshipv4-api-l5xc.onrender.com/health` | 200 | 610 | 1025 | 47 | Direct Render lightweight health. |
| `https://prepshipv4-api-l5xc.onrender.com/health/ready` | 200 | 524 | 913 | 338 | Deep components OK. |
| `https://prepshipv4-api-l5xc.onrender.com/health/deep` | 200 | 859 | 1737 | 338 | Deep components OK; one slower network sample. |

`/health/ready` sample body summary:
- `db`: ok, 22-26ms
- `orders`: ok, 21-26ms
- `printQueue`: ok, 22-24ms, `totalCount=19`, `queuedCount=8`
- `eventLoop`: ok, 1-2ms

Credential-free Vercel shell smoke:

| Route | Status | Duration |
|---|---:|---:|
| `/` | 200 | 560ms |
| `/orders/awaiting_shipment` | 200 | 167ms |
| `/orders/shipped` | 200 | 162ms |
| `/inventory/stock-levels` | 200 | 164ms |
| `/dashboard` | 200 | 162ms |
| `/settings` | 200 | 163ms |
| `/billing` | 200 | 159ms |
| `/manifest` | 200 | 161ms |

Important limitation: this proves the Vercel app shell, not authenticated data workflows.

## Architecture Map

- Vercel serves the Vite frontend.
- `vercel.json` rewrites most `/api/*` routes to `https://prepshipv4-api-l5xc.onrender.com/:path`.
- Some Vercel serverless/API routes remain excluded from the rewrite, including carrier/store account and OAuth paths.
- Render API is a Hono app in `src/main.ts`.
- Public `/health` is mounted before auth.
- Protected routes require Supabase JWT; `/observability/*` additionally requires admin.
- Supabase/Postgres is used through `postgres`/Drizzle in `src/db/client.ts`.
- Render worker uses `src/worker.ts` and can run interval scheduler or pg-boss scheduler.
- External providers include ShipStation, Walmart marketplace/direct carrier paths, and store connectors.

## Runtime / Env Verification

Confirmed from code:
- `DB_POOL_MAX` default is 4, max 20.
- `DB_CONNECT_TIMEOUT_SECONDS` default is 8.
- `DB_STATEMENT_TIMEOUT_MS` default is 12000.
- `RUN_SYNC_SCHEDULER` default is true for legacy safety.
- `.env.example` says Render API should set `RUN_SYNC_SCHEDULER=false`.
- `.env.example` says Render worker should set `RUN_SYNC_SCHEDULER=true`, `WORKER_PLACEHOLDER=false`.
- pg-boss is the only supported sync scheduler; the legacy runtime selector was removed in Audit 3.2.
- `PG_BOSS_POOL_MAX` default is 1, max 5.
- `/observability/status` would expose runtime flags, memory, DB status, and route timing, but returned 401 without admin token.

Unknown without dashboards/admin auth:
- Actual Render API env values.
- Actual Render worker env values.
- Render service size/region/runtime metrics.
- Supabase project region, pooler mode, active connection limits, slow query data.
- Vercel deployment region/edge routing behavior.

Required dashboard checks:
- Render API: `RUN_SYNC_SCHEDULER=false`.
- Render worker: `RUN_SYNC_SCHEDULER=true`, `WORKER_PLACEHOLDER=false`.
- Confirm only one scheduler owner is active.
- Supabase: active connections, pooler utilization, slow queries, locks.
- Vercel: production deployment points to the expected API URL/rewrites.

## Hot Route / Workflow Findings

Production p95/p99 for protected data routes could not be fetched without an admin bearer token. Code evidence points to these hotspots:

| Area | Risk |
|---|---|
| Orders list | Wide filters, multiple `ILIKE`, raw JSON search, `EXISTS order_items`, `EXISTS shipments`, optional exact count. |
| Orders enrichment | Additional per-page queries for Walmart duplicates and latest shipments by order ID/order number. |
| Orders export | Up to 5000 orders plus shipment lookups by large ID/order-number lists. |
| Picklist/SKU aggregation | `order_items` joined to `orders`/`clients`, grouped over date ranges. |
| Rates | Live/force refresh can block on provider calls. |
| Labels | Label create/retrieve can block on provider calls. |
| Print queue | Batch send is backgrounded; merge/status has durable timeout guard. |
| Sync status | Queue size/status reads can fan out across pg-boss queues. |

## DB Contention Report

Evidence-based risks:
- Orders list is the highest-probability slow SQL path.
- Search across customer/order fields, JSON raw fields, items, and shipments can defeat simple indexes.
- Exact `count(*)` can be expensive; code has delayed/skipped count protections, but production timing still needs measurement.
- Sync/advisory lock code reserves a Postgres connection while jobs run.
- API and worker share the same database unless environment points them to separate pooler endpoints.
- Shipments V2 enrichment performs repeated updates and has explicit comments about Supabase pooler pressure.

Read-only SQL checks needed in Supabase dashboard:

```sql
select pid, state, wait_event_type, wait_event, now() - query_start as age, left(query, 180) as query
from pg_stat_activity
where datname = current_database()
order by age desc
limit 25;

select locktype, mode, granted, count(*)
from pg_locks
group by locktype, mode, granted
order by count(*) desc;

select query, calls, total_exec_time, mean_exec_time, max_exec_time
from pg_stat_statements
order by total_exec_time desc
limit 20;
```

If `pg_stat_statements` is unavailable, enable it or use Supabase Query Performance dashboard.

## Worker Pressure Report

Known cadence:
- Orders sync: every 3 minutes.
- Shipments sync: every 3 minutes.
- Fulfillment outbox: every 1 minute, up to 25 rows.
- Inventory import from orders: every 30 minutes.
- ShipStation product sync: every 60 minutes.
- Reporting refresh: every 30 minutes.
- Optional rate backfill: every 10 minutes.

Risks:
- If API scheduler is accidentally enabled, API and worker can duplicate or compete for scheduler work.
- Orders/shipments sync can compete with API for DB connections and provider rate limits.
- pg-boss worker serializes active jobs in process, which helps protect DB/provider pressure but can delay lower-priority jobs.
- Worker status heartbeat writes to settings every 30 seconds.

## Provider Latency Report

Provider calls that can affect user experience:
- ShipStation rates and label creation.
- ShipStation carrier/account lookup.
- Walmart marketplace shipment confirmation.
- Direct carrier/Vercel-function rate/label calls.
- ShipStation `markasshipped` from shipped-external path.

Current protections:
- Direct Vercel function calls have explicit 30s read and 60s write timeouts.
- Print queue batch send is backgrounded with status polling.
- Label/queue invalid URL guards prevent object payloads from reaching PDF merge.

Remaining risk:
- User-facing rate/label requests still wait on providers. AWS will not make Walmart/ShipStation faster; these should become async job + status where operator flow allows.

## Frontend Behavior Notes

Confirmed:
- Startup avoids eager `/locations` and shipping-account fetches before user intent.
- Exact totals, daily stats, and column prefs are delayed/noncritical.
- Orders error state has Retry and avoids endless skeletons.
- Print queue polls every 30 seconds only while open.
- Orders query polls every 15 seconds only after error with no cached data.

Risks:
- Queue-send status polling loops until done/error and should gain a max attempt/timeout safety cap.
- `OrdersView.tsx` remains a large render hotspot; filtering/sorting/grouping over visible rows and columns can add client-side lag.
- Browser tests are fixture-based and do not prove real production latency or large live datasets.

## Commands / Checks Run

| Command | Result | Notes |
|---|---|---|
| `git status --short` | pass | Only local untracked `.claude/skills/`, `.gitnexus/` before report edits. |
| `git branch --show-current` | pass | `prepshipv4-stable`. |
| `git log --oneline -5` | pass | Latest was `a510b62c`. |
| `npm run typecheck` | pass | Backend and web TS passed. |
| `npm run test:api-observability-metrics` | pass | 11 checks. |
| `npm run test:observability-alerting` | pass | Request ID/timing/plan checks passed. |
| `npm run test:production-watchdog` | pass | Guard passed. |
| `npm run watchdog:production` | fail/config | Missing `VERCEL_SHELL_URL` and `RENDER_BASE_URL` env locally; script correctly degraded to alert-only. |
| `npm run guard:backend-connectivity` | pass | 166 frontend calls, 219 backend routes. |
| `npm run test:health-deep-readiness` | pass | Deep readiness guard passed. |
| `npm run guard:orders-startup-requests` | pass | Startup gating passed. |
| `npm run test:orders-ux` | pass | Orders UX guard passed. |
| `npm run test:frontend-failure-states` | pass | Failure-state guard passed. |
| `npm run perf:smoke` | fail then pass | Failed against default localhost because no preview server; passed against `PERF_BASE_URL=https://prepshipv4.vercel.app`. |

## Likely Root Causes, Ranked

1. Orders list SQL/query shape and DB pool pressure during live operations.
2. Worker/scheduler contention with API if runtime env split is wrong or DB pool is too small.
3. External provider latency from ShipStation/Walmart/direct carrier calls on user-facing paths.
4. Frontend polling/status loops and large OrdersView render cost.
5. Hosting platform limits. Plausible, but not proven by current public health/shell evidence.

## Immediate Fixes Before Migration

- Verify Render API/worker env split in dashboards.
- Capture authenticated `/observability/status` and `/observability/api-timing` during a slow episode.
- Add or run Supabase slow query/pool report.
- Tune Orders list indexes/query shape before moving databases.
- Add max attempts/timeout safety to queue-send polling.
- Keep provider-heavy actions async where possible.
- Upgrade current Render/Supabase plans first if dashboards show CPU/RAM/pool saturation.

## AWS Recommendation

Do we migrate now? **partial, not full**

Why:
- Current public production evidence does not show a dead/slow platform baseline.
- The riskiest bottlenecks are app/query/provider patterns that AWS will not automatically fix.

Evidence:
- Public health and deep readiness passed all samples.
- App shell smoke passed 8/8 routes.
- Protected timing/DB dashboards still need authorized evidence.

Fastest stabilizing fixes:
- Verify env split, collect authenticated timing/DB evidence, optimize Orders SQL, and harden remaining polling/provider paths.

If AWS is justified, recommended staged target:
- Keep Vercel frontend.
- Move API/worker only after Render resource limits are proven.
- Move DB to RDS only after Supabase pool/slow-query evidence remains bad after query/index fixes.

What AWS will fix:
- More operational control, restart hooks, dedicated resources, private network options, and DB topology control.

What AWS will not fix:
- Slow queries, poor indexes, provider latency, bad polling loops, or large client render costs.

Risks/rollback:
- Big-bang migration increases operational complexity. Stage the migration and keep rollback per component.

## Recommended Next Tasks

- PS-028: Authenticated Production Timing Capture for `/observability/status`, `/observability/api-timing`, and Orders/Print Queue workflows.
- PS-029: Supabase/Postgres Slow Query + Pool Contention Audit.
- PS-030: Orders List Query Optimization and Index Review.
- PS-031: Provider-Blocking Workflow Async Conversion Plan.
