# PS-200 — Legacy Vercel `api/` decommission: inventory + surface plan

Date: 2026-06-12 · Updated: 2026-06-27 · Status: S1/S2/S3 guarded locally; S4-S8 remain gated · Owner ticket: PS-200

## Current routing (verified from `vercel.json` + code)

- `vercel.json` rewrites proxy `/api/:path` → Render (`prepshipv4-api-l5xc.onrender.com`)
  **except** the exclusion list: `carrier-accounts | carriers/ | store-accounts | oauth/ |
  admin/` — those still execute the legacy serverless
  functions under `api/`.
- No Vercel `crons` block remains, and `/api/cron/*` now proxies to the Render `/cron/*`
  route. The removed `/api/cron/sync-walmart-fees` job is owned by the v4 worker.
- S1/S2 v4 cutover guarded locally: FE account CRUD, carrier verify, Settings rate probe,
  marketplace order pulls, and Walmart fees pulls use the shared `api` client against v4
  routes (`/carrier-accounts`, `/store-accounts`, `/carriers/verify`, `/carriers/rates`,
  `/carriers/walmart/orders`, `/carriers/ebay/orders`, `/carriers/walmart/fees`).
- `web/src/lib/vercelFunction.ts` is deleted and `web/src` has no live
  `callVercelFunction(...)` or same-origin `fetch("/api/...")` transport calls.
- Guard: `test:ps-200-v4-account-carrier-ops-cutover`.
- Guard: `test:ps-200-walmart-fees-worker-cron-cutover`.

## Load-bearing discoveries

1. **The two backends already share one service layer.** `api/carrier-accounts.ts` imports
   `src/services/credential-accounts`, `src/lib/credential-accounts`, `src/lib/auth/verify-supabase-jwt`;
   `api/carriers/verify.ts` and `src/lib/imported-handlers/carriers-verify.ts` are 1-line re-export
   shims of the SAME `src/connectors/carrier/credential-verification`. The split-brain is a
   *deployment* split, not a logic fork — cutover risk is far lower than the card feared.
2. **v4 mounts the S1/S2 account and carrier-op surfaces**: `/carrier-accounts`,
   `/store-accounts`, `/carriers/verify`, `/carriers/rates`, `/carriers/walmart/orders`,
   `/carriers/ebay/orders`, and `/carriers/walmart/fees`. These routes either delegate to the
   same imported handler/service layer as the legacy function or to the backend-owned v4
   probe/sync service.
3. **Reverse dependency:** `src/lib/imported-handlers/carrier-accounts.ts` imports
   `sendInternalServerError` **from `api/_lib/safe-error`** — v4 build depends on `api/_lib`.
   The `_lib` relocation (surface 6) MUST land before the `api/` directory deletion (surface 8).
4. **The FE's biggest legacy money call is already dead.** `fetchDirectCarrierRates`
   (formerly `POST /api/carriers/rates`) has zero callers since PS-203 moved the combined rate
   universe to the backend. The Settings "test rates" probe now posts to the v4
   `/carriers/rates` route.
5. **`api/admin/fix-marketplace-timestamps.ts` can UPDATE `orders.order_date`** (including
   shipped rows) and double-shifts if re-run — deleting it strengthens the shipped-data lockdown.

## Endpoint inventory

| Legacy function | Callers today (evidence) | v4 equivalent | Action → surface |
|---|---|---|---|
| `api/carrier-accounts.ts` | No FE legacy transport caller; FE uses v4 `/carrier-accounts` through `api` client | `/carrier-accounts` route (imported handler, same services) | **S1 locally guarded**; legacy twin retained until S8 |
| `api/store-accounts.ts` | No FE legacy transport caller; FE uses v4 `/store-accounts` through `api` client | `/store-accounts` route (imported handler, same services) | **S1 locally guarded**; legacy twin retained until S8 |
| `api/carriers/verify.ts` | No FE legacy transport caller; FE uses v4 `/carriers/verify` through `api` client | `/carriers/verify` (same module) | **S1 locally guarded**; legacy twin retained until S8 |
| `api/carriers/rates.ts` | No FE legacy transport caller; Settings test probe uses v4 `/carriers/rates`; `fetchDirectCarrierRates` fan-out is deleted | v4 owns Settings probe (`src/services/carrier-rates-probe.ts`) and order-bound rates (`rates.ts` + `rates-combined.ts`, PS-203) | **S2 locally guarded**; legacy file deletion w/ labels → **S8** |
| `api/carriers/labels.ts` | none (PS-202 deleted the FE branch) | `createLabelV2` + `labels-direct.ts` | Delete after PS-202 verification (DJ gate) → **S5** |
| `api/carriers/walmart/orders.ts` | No FE legacy transport caller; Settings uses v4 `/carriers/walmart/orders` | v4 route delegates to imported Walmart handler; PS-199 live lookup owns, `store_orders` = cache | **S2 locally guarded**; legacy twin retained until S8 |
| `api/carriers/ebay/orders.ts` | No FE legacy transport caller; Settings uses v4 `/carriers/ebay/orders` | v4 route delegates to imported eBay handler | **S2 locally guarded**; legacy twin retained until S8 |
| `api/carriers/walmart/fees.ts` | No FE legacy transport caller; Settings uses v4 `/carriers/walmart/fees` | v4 route delegates to `src/connectors/store/walmart-fees.ts` | **S2 locally guarded**; legacy twin retained until S8 |
| `api/carriers/walmart/probe-carriers.ts` | none | connector probe still exists where needed | **Deleted in S2** |
| `api/carriers/ups/probe.ts` | none | connector probe still exists where needed | **Deleted in S2** |
| `api/carriers/validate-address.ts` | none | USPS validator still exists where needed | **Deleted in S2** |
| `api/cron/sync-walmart-fees.ts` + crons block | none; `api/cron` is deleted and `vercel.json` has no crons block | v4 worker `runWalmartFeesTick` in both `sync-scheduler.ts` and `sync-job-queue.ts` | **S3 locally guarded** |
| `api/oauth/ebay/callback.ts` | **external**: eBay redirect URI registered to the Vercel domain | none | Port + keep `/oauth` reachable (thin proxy or DJ re-registers URI on eBay dev portal) → **S4, DJ gate** |
| `api/debug-env.ts` | none ("remove once migration verified") | — | **Deleted in part 2** |
| `api/migrate-from.ts` | none ("remove after migration") | — | **Deleted in part 2** |
| `api/admin/fix-marketplace-timestamps.ts` | none (one-shot, double-shift hazard, writes `orders.order_date`) | — | **Deleted in part 2** (lockdown-positive) |
| `api/_lib/*` (safe-error, store-orders-schema, walmart-fees-sync, marketplace-status-reconciliation, shipstation-awaiting-parity) | imported by the above **and by `src/lib/imported-handlers/carrier-accounts.ts`**; `store-orders-schema.ts` is the only `store_orders` schema owner | partial (walmart-fees logic already in src/connectors) | Relocate to `src/lib`/`src/services`; `store_orders` → Drizzle schema (read/type only, never drop data) → **S6** |

## Surface plan (one PR each, in order)

| # | Surface | Gate |
|---|---|---|
| S1 | ~~Account CRUD cutover: re-sync carrier-accounts handler drift, add v4 `/store-accounts` route, flip FE call sites to the `api` client~~ | **Done locally; pinned by `test:ps-200-v4-account-carrier-ops-cutover`** |
| S2 | ~~Carrier ops cutover: walmart/ebay pulls + walmart fees + Settings rates probe → v4 routes; delete dead `fetchDirectCarrierRates` + probe/validate-address endpoints~~ | **Done locally; pinned by `test:ps-200-v4-account-carrier-ops-cutover`** |
| S3 | ~~`sync-walmart-fees` → v4 worker job in **both** sync-scheduler and sync-job-queue; remove Vercel `crons` ownership and `cron/` rewrite exclusion~~ | **Done locally; pinned by `test:ps-200-walmart-fees-worker-cron-cutover`** |
| S4 | eBay OAuth callback port | **DJ**: confirm redirect URI registered with eBay (re-register vs keep Vercel thin-proxy) |
| S5 | Delete `api/carriers/labels.ts` + `api/carriers/rates.ts` | **DJ**: PS-202 test-mode + canary verification |
| S6 | `api/_lib` relocation + `store_orders` Drizzle adoption (read/type only) | after S2/S3 (last importers gone) |
| S7 | ~~One-shot tools deletion~~ — **done in part 2** | — |
| S8 | Final flip: remove vercel.json exclusions, delete `api/`, new `test:ps-200-legacy-api-decommission` guard (asserts no exclusions, no crons, `api/` absent), re-anchor the guard fleet below | zero Vercel function invocations over a business day |

## Guard re-anchor inventory (scripts reading `api/` files today)

25 scripts pin legacy sources and must be re-anchored (same pins, new homes, documented) as
their surfaces land — the big ones: `ps-032-connector-orchestrator` (11 api files),
`ps-078-connector-matrix` (whitelist equality vs `api/carriers/labels.ts` §1 + §6),
`ps-098`, `ps-051`, `ps-057`, `ps-128-129`, `ps-135a`, `ps-054`, `ps-084`, `ps-103`,
`marketplace-status-reconciliation`, `marketplace-order-auth-cors`, `credential-accounts`,
`connector-architecture`, `carriers-rates-function-hardening`, `direct-carrier-label`,
`carrier-suppression`, `label-coldstart-import`, `raw-error-response-audit` (trimmed in part 2),
`vercel-function-imports` (tree-walk — dies with `api/` at S8), plus `store-connector-source`,
`selected-rate-proof-purchase-boundary`, `ship-from-default-location`, `test-order-queue-label`,
`runtime-ddl` (path strings only). The `compatibility-matrix` `carrier_vercel` endpoint naming
refresh rides with S5/S8.

## Security hardening to carry forward (PS-229 / PS-230 — "both" decision)

Applied to the live Vercel `api/*` handlers now AND must be preserved when those
handlers move to Render (do not regress on the migration):

- **PS-229** — `api/carriers/rates.ts` per-provider catch blocks route through
  `sanitizedProviderRateError(provider, err)`: generic client message + stable
  `code: 'RATE_QUOTE_FAILED'`, full detail logged server-side only. Re-anchor the
  guard `scripts/ps-229-carrier-error-sanitization-guard.ts` to the new home; keep
  `raw-error-response-audit` green.
- **PS-230** — `api/carrier-accounts.ts` + `api/store-accounts.ts` call
  `verifySupabaseJwt` with explicit `{ strictClaims: true, supabaseUrl }`; set
  `STRICT_JWT_CLAIMS=true` in prod (Render + Vercel). The Render-native routes must
  pass the same strict options (the Render middleware already reads
  `env.STRICT_JWT_CLAIMS`).

## Acceptance (from the card)

- No FE call path resolves to a Vercel serverless function (network tab + Vercel invocation logs at zero over a full business day).
- `vercel.json` has no exclusion patterns and no crons.
- `api/` deleted; `store_orders` schema lives in `src/db/schema/`.
- Walmart fees sync + retained pulls run on the v4 worker with cursors visible.
- Guard asserts the end state.
