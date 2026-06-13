# PS-200 — Legacy Vercel `api/` decommission: inventory + surface plan

Date: 2026-06-12 · Status: Part 1 (inventory) complete · Owner ticket: PS-200

## Current routing (verified from `vercel.json` + code)

- `vercel.json` rewrites proxy `/api/:path` → Render (`prepshipv4-api-l5xc.onrender.com`)
  **except** the exclusion list: `carrier-accounts | carriers/ | store-accounts | oauth/ |
  debug-env | migrate-from | admin/ | cron/` — those still execute the legacy serverless
  functions under `api/`.
- One Vercel cron remains: `/api/cron/sync-walmart-fees` daily 09:00 UTC.
- The FE reaches the legacy stack two ways: `callVercelFunction()`
  ([vercelFunction.ts](../web/src/lib/vercelFunction.ts) — same-origin `/api/*` + Supabase JWT)
  and one raw `fetch('/api/carrier-accounts?source=admin')` in
  [useShippingAccounts.ts:88](../web/src/hooks/useShippingAccounts.ts).
- The FE reaches v4 directly via the `api` client (`API_BASE` = Render URL, no proxy), so a
  v4 route is consumable the moment it exists — no Vercel deploy needed for FE flips.

## Load-bearing discoveries

1. **The two backends already share one service layer.** `api/carrier-accounts.ts` imports
   `src/services/credential-accounts`, `src/lib/credential-accounts`, `src/lib/auth/verify-supabase-jwt`;
   `api/carriers/verify.ts` and `src/lib/imported-handlers/carriers-verify.ts` are 1-line re-export
   shims of the SAME `src/connectors/carrier/credential-verification`. The split-brain is a
   *deployment* split, not a logic fork — cutover risk is far lower than the card feared.
2. **v4 already mounts three legacy mirrors** (`src/lib/imported-handlers/`): `/carrier-accounts`
   (main.ts:178), `/carriers/verify` (carriers.ts:9), and `rates-multi` inside `/rates`.
   Drift vs legacy: verify = zero (same module); carrier-accounts = diagnostics/log-shape only
   (both delegate to the same services; legacy adds masked POST logging, v4 adds
   `backfillAwaitingSnapshotNickname`); rates-multi = intentionally thinner (PS-203 backend owns
   direct rates).
3. **Reverse dependency:** `src/lib/imported-handlers/carrier-accounts.ts` imports
   `sendInternalServerError` **from `api/_lib/safe-error`** — v4 build depends on `api/_lib`.
   The `_lib` relocation (surface 6) MUST land before the `api/` directory deletion (surface 8).
4. **The FE's biggest legacy money call is already dead.** `fetchDirectCarrierRates`
   (shared.ts:1083 → `POST /api/carriers/rates`) has zero callers since PS-203 moved the
   combined rate universe to the backend. Only the Settings "test rates" probe
   (CarrierIntegrationsCard.tsx:1018) still POSTs `/carriers/rates`.
5. **`api/admin/fix-marketplace-timestamps.ts` can UPDATE `orders.order_date`** (including
   shipped rows) and double-shifts if re-run — deleting it strengthens the shipped-data lockdown.

## Endpoint inventory

| Legacy function | Callers today (evidence) | v4 equivalent | Action → surface |
|---|---|---|---|
| `api/carrier-accounts.ts` | shared.ts:925 (admin list), useShippingAccounts.ts:88 (raw fetch), CarrierIntegrationsCard 820/848/861/892/915/928/1269/1515, PendingClientIntegrationsCard 76/89 (`?source=portal&pending=1`) | `/carrier-accounts` route (imported handler, same services) | Re-sync drift, FE flip → **S1** |
| `api/store-accounts.ts` | shared.ts:926, CarrierIntegrationsCard 820/848/861 (via `endpoint` var), 1519 | **none** | Add v4 route (imported-handler pattern), FE flip → **S1** |
| `api/carriers/verify.ts` | CarrierIntegrationsCard:840 | `/carriers/verify` (same module) | FE flip only → **S1** |
| `api/carriers/rates.ts` | CarrierIntegrationsCard:1018 (Settings test probe) — `fetchDirectCarrierRates` fan-out is dead code | v4 owns direct rates (rates.ts + rates-combined.ts, PS-203) | Delete dead FE fan-out; flip probe to v4 → **S2**; legacy file deletion w/ labels → **S8** |
| `api/carriers/labels.ts` | none (PS-202 deleted the FE branch) | `createLabelV2` + `labels-direct.ts` | Delete after PS-202 verification (DJ gate) → **S5** |
| `api/carriers/walmart/orders.ts` | CarrierIntegrationsCard:950 (Pull Orders) | none as route; PS-199: live lookup owns, `store_orders` = cache | Port as v4 cache-refresh route → **S2** |
| `api/carriers/ebay/orders.ts` | CarrierIntegrationsCard:959 | none | Same → **S2** |
| `api/carriers/walmart/fees.ts` | CarrierIntegrationsCard:991 (Pull fees) | logic already shared: `src/connectors/store/walmart-fees.ts` | Thin v4 route → **S2** |
| `api/carriers/walmart/probe-carriers.ts` | none | — | Delete → **S2** (with the walmart surface) |
| `api/carriers/ups/probe.ts` | none | — | Delete → **S2** |
| `api/carriers/validate-address.ts` | none | — | Delete → **S2** |
| `api/cron/sync-walmart-fees.ts` + crons block | Vercel cron 09:00 UTC | logic shared (walmart-fees.ts) but **no v4 schedule** | v4 worker job (BOTH schedulers) + drop crons block → **S3** |
| `api/oauth/ebay/callback.ts` | **external**: eBay redirect URI registered to the Vercel domain | none | Port + keep `/oauth` reachable (thin proxy or DJ re-registers URI on eBay dev portal) → **S4, DJ gate** |
| `api/debug-env.ts` | none ("remove once migration verified") | — | **Deleted in part 2** |
| `api/migrate-from.ts` | none ("remove after migration") | — | **Deleted in part 2** |
| `api/admin/fix-marketplace-timestamps.ts` | none (one-shot, double-shift hazard, writes `orders.order_date`) | — | **Deleted in part 2** (lockdown-positive) |
| `api/_lib/*` (safe-error, store-orders-schema, walmart-fees-sync, marketplace-status-reconciliation, shipstation-awaiting-parity) | imported by the above **and by `src/lib/imported-handlers/carrier-accounts.ts`**; `store-orders-schema.ts` is the only `store_orders` schema owner | partial (walmart-fees logic already in src/connectors) | Relocate to `src/lib`/`src/services`; `store_orders` → Drizzle schema (read/type only, never drop data) → **S6** |

## Surface plan (one PR each, in order)

| # | Surface | Gate |
|---|---|---|
| S1 | Account CRUD cutover: re-sync carrier-accounts handler drift, add v4 `/store-accounts` route, flip all 14 FE call sites (callVercelFunction → `api` client) | none — same services both sides |
| S2 | Carrier ops cutover: walmart/ebay pulls + walmart fees + Settings rates probe → v4 routes; delete dead `fetchDirectCarrierRates` + probe/validate-address endpoints | none |
| S3 | `sync-walmart-fees` → v4 worker job in **both** sync-scheduler and sync-job-queue (the register-in-one-scheduler miss is the classic bug); remove `crons` block | none |
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
