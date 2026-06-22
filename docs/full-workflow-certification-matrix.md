# PrepShip Full-Workflow Certification Coverage Matrix (PS-035)

Source of truth for what PrepShip's certification actually proves, mapped to the
critical operator workflow: **order ingestion → rates → package/dims/rate
selection → label creation → shipment persistence → print queue → marketplace
confirmation → inventory/billing side effects → recovery/error states →
RBAC/client-store scope → production health.**

Created 2026-05-29 from a full audit of every `test:*` / `guard:*` script and
`web/e2e/*.spec.js` against the PS-035 checkpoints (A–P).

---

## The two certification commands

| Command | What it proves | Needs a server? | Use |
|---|---|---|---|
| `npm run test:full-site-certification` | typecheck + web build + site-action guard + API contracts + label-URL/print-queue guards + **ShipStation v1 sync-window timezone guard** + **6 Playwright browser specs** (workflow/orders/**orders-column-integrity**/inventory/maintenance) + frontend failure states | **Yes** (dev server for Playwright) | The site smoke. PS-036 added the sync-window guard + mandatory orders column-integrity spec. |
| `npm run test:full-workflow-certification` | **superset** — runs `test:full-site-certification`, then `test:workflow-suites` | Yes (inherits full-site) | The complete gate before claiming workflow-ready. |
| `npm run test:workflow-suites` | the **offline behavioral core** — 69 guards across checkpoints A–P, **no server, no live providers, no real DB** | **No** | Runnable in plain CI; the meaningful offline certification. |
| `npm run test:shipping-roundtrip-certification` | **PS-061 official safe shipping gate** — runs the shipping harness guard, fixture label smoke, mock marketplace confirmation, and the offline workflow suites; prints a sanitized client/store matrix and can dry-run the failure notification payload | No | The CI-friendly shipping blocker gate. Use `-- --notify-dry-run` to inspect the sanitized notification payload without sending. |

`test:workflow-suites` runs [scripts/run-workflow-certification.mjs](../scripts/run-workflow-certification.mjs)
(checkpoint-grouped, continue-on-failure, prints a per-checkpoint summary, exits
non-zero if any suite fails). **81/81 offline suites pass** as of 2026-06-22.

> The offline core is not "just static guards": it includes genuinely
> **executable behavioral** guards — inventory ledger-balance math, billing
> formula math, eBay/Walmart confirmation with mocked `fetch`, awaiting-parity
> classification, label-URL extraction, marketplace status normalization,
> California-time math, and the daily-stats/daily-strip computations.

---

## Coverage matrix (A–P)

Legend — **Status**: ✅ covered · 🟡 partial (behavior verified by helpers/specs,
some paths text-asserted only) · ⛔ missing. **Class**: offline (in
`test:workflow-suites`) · browser (server-required, in `test:full-site-certification`) ·
live (DJ-supervised only, excluded).

| # | Checkpoint | Status | Primary coverage (offline unless noted) | Gap / risk | Follow-up |
|---|---|---|---|---|---|
| A | Rate Browser / live rate shopping | 🟡 | `test:rate-system-hardening`, `test:shipp-rate-retry`; browser: PS-034 partial-carrier spec in `site-actions.spec.js` | core `rates.ts` fanout/cache/block-filter only text-asserted | PS-035-F1 |
| O | Package / dims / rate selection | 🟡 | `test:best-rate-dims`, `test:rate-system-hardening`; browser: PS-034 spec | ±0.15in package→dims auto-select & `/rates` zod contract not offline-tested | PS-035-F1 |
| E | Label creation state machine | 🟡 | `test:test-order-queue-label`, `test:shipstation-label-url`, `test:direct-carrier-labels`, `test:order-readiness-preflight`; browser: create/fail/invalid-URL in `site-actions.spec.js` | shipped/cancelled refusal, duplicate-label, void→reset transitions only text-asserted | PS-035-F2 |
| B | Carrier/account credential verification | 🟡 | `test:credential-accounts`, `test:shipstation-carrier-account-identity`, `test:connector-registry/-architecture`, `test:secrets-governance`, `test:status:carriers` | verifier dispatch (`credential-verification.ts` VERIFIERS) never invoked; simulator path is an offline seam | PS-035-F3 |
| C | Source connector / order sync | 🟡 | `test:store-connector-source`, `test:shipstation-awaiting-parity`, `test:shipstation-sync-window`, `test:sync-advisory-lock`, `test:walmart-dual-dedupe`, `test:ps-032-*` | `syncOrders`/`normalizeShipStationOrder` orchestration not run against a mocked connector | PS-035-F4 |
| F | Shipment persistence + status transition | 🟡 | `test:shipstation-awaiting-parity`, `test:shipstation-sync-window`, `test:label-shipment-scope-review`, `test:inventory-auto-deduct` | `upsertShipmentsBatch`/`toOunces`/`enrichProviderAccountIds`/awaiting→shipped only regex-asserted (**riskiest** — shipped lockdown surface) | PS-035-F5 |
| D | Order readiness / preflight | 🟡 | `test:order-readiness-preflight` (**new**), `test:test-order-queue-label`, `test:best-rate-dims` | readiness throw-paths asserted by source presence; `smoke:shipping:preflight` is live/DJ-only | PS-035-F2 |
| G | Print Queue durability | 🟡 | `test:print-queue-durable`, `-persistence`, `-ownership`, `-client-scope` | durable snapshot rehydrate not round-tripped against a DB | PS-035-F6 |
| H | Reprint shipped label | 🟡 | `test:print-queue-invalid-label`, `test:shipstation-label-url`, `test:test-order-queue-label`, `test:queue-label-diagnostics`; browser: shipped panel in `site-actions.spec.js` | no browser click on Reprint / confirm-printed count flow | PS-035-F9 |
| I | Marketplace confirmation / outbox | 🟡 | `test:ebay-confirmation:mocked`, `test:walmart-confirmation:payload`, `test:marketplace-reconciliation`, `test:marketplace-order-auth-cors` | `fulfillment/outbox.ts` enqueue-gating / dedupe-idempotency / retry-backoff / dead-letter not behavior-tested | PS-035-F3 |
| J | Inventory / WMS side effects | ✅ | `test:inventory-auto-deduct`, `-source-of-truth`, `-ledger-balance`, `-history-dedupe`, `-reconciliation-dry-run`, `-client-scope` | in-transaction idempotency skip exercised only via the ledger-balance model | PS-035-F3 (minor) |
| K | Billing / cost capture | 🟡 | `test:billing-formula`, `test:billing-detail-ps040`, `test:billing-client-scope`, `test:billing-best-rate-ui:guard` | server `generateLineItems` money math (billingMode/markup/package/addl-unit) only indirectly covered | PS-035-F7 |
| L | Order table post-shipment behavior | 🟡 | `test:orders-ux`, `test:orders-query-round2`, `test:order-editable-lockdown` (**new**); browser: `orders-ux.spec.js` shipped/cancelled toolbar | UI `isReadOnly=false` by override → safety rests on backend `assertOrderEditable` (now guarded by the new lockdown guard) | — |
| L+ | **Orders column integrity (PS-036)** | ✅ | browser: **`orders-column-integrity.spec.js`** — asserts every required Awaiting + Shipped column against source-of-truth fixtures (not just non-empty); pins the three shipped data-states **external→`Ext. Label`** / **local→carrier+acct+rate** / **missing→`Missing shipment sync`** | covers the cell **content** gap `orders-ux.spec.js` left open (it only checked the selection toolbar / lockdown, never rendered cell values) | — |
| M | Error/recovery states for critical buttons | ✅ | `test:frontend-failure-states`, `test:raw-error-response-audit`, `test:node-handler-response`; browser: label/queue/rate/orders failure variants in `site-actions.spec.js` | queue MERGE/PDF failure variant not driven in browser | PS-035-F9 |
| N | Auth / RBAC / client-store scope | ✅ | `test:rbac-permissions`, `test:auth-coverage`, `test:client-store-scope`, `test:field-level-rbac(-extended)`, `test:jwt-session-policy`, `test:auth-logout`, `test:frontend-auth-cache`, per-view scope guards, `test:client-redaction` | runtime scoped-JWT 403/redaction is fixture-asserted, not executed against the real predicate | PS-035-F8 |
| P | Production / deploy health smoke | 🟡 | `test:health-deep-readiness`, `test:production-watchdog`, `test:production-signoff`, `test:status:carriers`, `test:maintenance-page` | live deploy smoke (Vercel/Render `/health*`) is network-only; no `/version` endpoint exists | PS-035-F10 |

---

## What is intentionally EXCLUDED from the offline cert

- **Browser/server-required** (run via `test:full-site-certification`):
  `test:workflow-certification:browser`, `test:site-actions:browser`,
  `test:orders-ux:browser`, `test:orders-column-integrity:browser`,
  `test:inventory-ux:browser`, `test:maintenance-gate:browser`,
  `test:billing-best-rate-ui`.
- **Live / DJ-supervised only** (real postage / providers / live DB): `smoke:shipping:preflight`,
  `smoke:shipping:test-label`, `smoke:shipping:real-label`, `smoke:marketplace-confirm`,
  `marketplace:reconcile:apply`, `shipstation:awaiting:reconcile:apply`,
  `best-rate:dims:apply`, `billing:repair-shipment-linkage`, `watchdog:production`,
  `test:status:sync` (defaults to the live Render API).
- **PS-034** owns the Rate Browser partial-carrier-failure browser coverage — referenced here, not duplicated.

---

## How to add a future checkpoint

1. Write a focused **offline** guard in `scripts/` (node `.mjs` or `tsx` `.ts`)
   using `node:assert/strict`, ending with a `PASS …` line and a non-zero exit
   on failure. Prefer **executing behavior** (import pure helpers, mock `fetch`,
   feed fixtures) over text-presence assertions. Never call live providers, open
   a real DB connection, or require a running server.
2. Add it as a `test:<name>` script in `package.json`.
3. Add the script name to the right checkpoint group in
   [scripts/run-workflow-certification.mjs](../scripts/run-workflow-certification.mjs).
4. If it needs a browser/server, add it to `test:full-site-certification`
   instead (Playwright spec under `web/e2e/`), and reference it in this matrix.
5. Update this matrix row (status + coverage + follow-up).

**Rule:** a static guard that only greps for symbol names is a placeholder, not
certification. When aggregation surfaces a guard failing because code was
refactored, **verify the behavior is still intact** before updating the guard —
do not edit a guard green if it is catching a real regression.

---

## Recommended follow-up PS tasks (remaining behavioral gaps)

These are the highest-value gaps not closed in this PR (mostly require a fixture
DB, a refactor to extract pure helpers, or a running app/browser):

- **PS-035-F1** Executable rate-shopping guard — extract pure rate rules from
  `rates.ts` into a db-free module, then test `isBlockedRate` / `rateCacheKey` /
  `dedupeRates` / `pickBestRate` on fixtures. (Not done here: `rates.ts` imports
  `db`→`env`, so it can't be imported offline without secrets; refactoring this
  recently-bug-fixed file warrants its own PR.)
- **PS-035-F2** Label state-machine integration test (fixture DB) — execute
  `createLabelV2`/`voidLabelV2` terminal-order, duplicate-label, test-client,
  and void→awaiting transitions.
- **PS-035-F3** Fulfillment-outbox + credential-verifier behavioral guards —
  enqueue gating, dedupe idempotency, retry backoff/dead-letter; simulator
  verifier dispatch with stubbed `fetch`.
- **PS-035-F4** Order-sync orchestration guard — mocked connector pages,
  watermark-not-advanced-on-failure, per-account isolation, status mapping.
- **PS-035-F5** Shipment persistence pure-mapper guard — `toOunces`,
  voided/return no-promote, `providerAccountId`/`createDate` COALESCE, `se-` parse.
- **PS-035-F6** Print-queue durability DB round-trip.
- **PS-035-F7** Billing `generateLineItems` money-math guard.
- **PS-035-F8** Orders scope contract guard — boot Hono app + scoped JWT → 403/redaction.
- **PS-035-F9** Browser additions to `site-actions.spec.js` — shipped Reprint click,
  confirm-printed count, queue MERGE/PDF failure recovery.
- **PS-035-F10** Live production deploy-smoke checklist (DJ-supervised) in
  `OPERATIONAL_RUNBOOKS_AND_DR_PLAN.md`; consider adding a `/version` endpoint
  for automated Vercel/Render version parity.

### Needs DJ confirmation (not a code change)
- **Walmart sidebar count parity** — `/orders` de-dupes Walmart dual-source rows
  for the list, but `/init/counts` counts direct Walmart orders **separately by
  design** (intentional per revert `da0a6936` "Revert 'Show canonical Walmart
  orders in linked store view'"). If the sidebar badge should match the deduped
  list, that is a follow-up; today it is an intentional asymmetry. The
  `test:walmart-dual-dedupe` guard was updated to assert the shared awaiting
  **visibility** predicate instead of the reverted canonical dedupe.

---

## Findings from building this matrix (value delivered)

Aggregating the previously-scattered guards into one command immediately caught
**two guards that were silently failing** on `prepshipv4-stable` (never run by
the old `full-site-certification`) — both **stale string-drift after refactors,
behavior verified intact** and updated to track current code:

1. `test:raw-error-response-audit` — was checking two one-line **re-export shims**
   (`api/carriers/verify.ts`, `src/lib/imported-handlers/carriers-verify.ts`)
   for the safe-500 helper; repointed to the real handler
   `src/connectors/carrier/credential-verification.ts` (which calls
   `sendInternalServerError` at the 500 paths).
2. `test:walmart-dual-dedupe` — `/orders` dedupe was refactored from an inline
   `shouldApplyWalmartDedupe` predicate to a `walmartDirectDuplicates` directRows
   step + `sourceLink` diagnostics; `/init` canonical dedupe was deliberately
   reverted. Updated both assertions to the current implementation.

This is exactly the PS-035 goal: a passing certification that is **meaningful**,
so future regressions in these areas are caught.

---

## Safety

All offline-core guards are read-only static analysis or pure computation. No
guard buys postage, creates labels, sends marketplace notifications, mutates
shipped/cancelled orders, changes carrier credentials, or exposes secrets / PII /
raw provider payloads. Live and DJ-supervised paths are explicitly excluded
(see above).
