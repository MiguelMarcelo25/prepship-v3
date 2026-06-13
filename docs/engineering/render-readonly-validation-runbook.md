# Render read-only validation runbook

**Audience:** DJ / operators validating PrepShip v4 against the live backend.

**Golden rule:** there is **no staging Render** — `prepshipv4-api-l5xc.onrender.com`
is **production**. Everything in this runbook is **read-only** (GET / SELECT
only): no labels, no postage, no marketplace notifications, no order mutations.
Anything that writes lives in a separate, explicitly-gated runbook and is never
run casually against prod.

---

## TL;DR — the one command

```powershell
npm run status:sync
```

Hits the **Render API** (`https://prepshipv4-api-l5xc.onrender.com`), GET-only.
With no token set it checks public `/health` and **skips** the protected checks
(prints a `WARN`, not a `FAIL`). CI-friendly variant returns a non-zero exit on
failure:

```powershell
npm run test:status:sync   # = status-sync.ts --check
```

Expected healthy output:

```
PASS public health: HTTP 200 {"status":"ok","ts":"..."}
WARN protected sync checks: Set PREPSHIP_API_TOKEN or SUPABASE_ACCESS_TOKEN ...
```

---

## Why "test against Render" ≠ "run the Playwright e2e on Render"

Three different classes of test script — only one of them is a live Render check:

| Class | Examples | Targets Render? |
|---|---|---|
| **Offline cert + guards** | `test:shipping-roundtrip-certification`, the `*-guard` scripts, `typecheck`, `build:web` | **No** — pure source/logic checks, zero network. Stay local; that's correct. |
| **Browser e2e (Playwright)** | the 13 `web/e2e/*.spec.js` specs | **No** — they **mock** every API call (`page.route` → `route.fulfill`) and assert on synthetic fixtures (e.g. order `970001`) with a fake injected auth token. They are deterministic UI *contract* tests. They cannot be repointed at Render without real data + real auth + stripping the mocks, and some endpoints (e.g. `/api/carrier-accounts`) are legacy Vercel functions excluded from the Render rewrite (`vercel.json`). |
| **Live scripts** | `status:sync`, `smoke:shipping:preflight`, `smoke:marketplace-confirm` | **Yes** — this runbook. |

If you want to eyeball *real-data UI behavior* (e.g. the Awaiting "best rate"
custcarrier cell), open the **deployed app** in a browser — the Vercel front end
proxies `/api/*` to Render. That is a manual eyeball check, not one of these
scripts.

---

## Tier 1 — Render API health/status (no DB creds needed)

```powershell
npm run status:sync
```

- **What it does:** GET `/health` (public). With a token, also GET
  `/sync/status`, `/worker/status`, and an orders-freshness probe.
- **Target override:** `PREPSHIP_API_URL` (defaults to the prod Render host).
- **Unlocking the protected checks (optional):** set a valid Supabase access
  token for an authorized user **in your own shell** — never commit it, never
  paste it into chat/PRs:

  ```powershell
  $env:PREPSHIP_API_TOKEN = "<your-supabase-access-token>"
  npm run status:sync
  Remove-Item Env:\PREPSHIP_API_TOKEN   # clear when done
  ```

  With the token set you get worker heartbeat, scheduler mode, last-sync
  timestamps, and the "orders since" gap count. All GET-only.

## Tier 2 — Read-only DB inspectors (need `DATABASE_URL` + an order id)

These SELECT directly from prod Postgres (not the Render API). They require
`DATABASE_URL` in your env and an order id. SELECT-only; they refuse to write.

```powershell
npm run smoke:shipping:preflight -- --order-id <id>
npm run smoke:marketplace-confirm -- --order-id <id>
```

- `smoke:shipping:preflight` — is this order safe/ready to label? (awaiting
  status, complete ship-to, weight, client/store mapping, no active shipment).
  `READ_ONLY_PREFLIGHT = true`.
- `smoke:marketplace-confirm` — inspects `fulfillment_outbox` + `shipments`
  confirmation state for an order. `READ_ONLY_BY_DEFAULT = true`; it **refuses**
  `--process-once` (live) and only accepts `--mock-process-once` (in-memory
  fixture).

## Tier 3 — Diagnostics (read-only, heavier)

```powershell
npm run diagnose:production-timing   # capture-production-timing.ts
```

GET probes + read-only SQL (`pg_stat_activity`, `pg_locks`,
`pg_stat_statements`). Read-only but noisier; use when chasing latency.

---

## What is explicitly NOT in this runbook (mutating — prod-only, gated)

Do **not** run these as part of "testing against Render" without an explicit,
per-run decision, a designated test order, and scope:

- `smoke-shipping-real-label.ts` — **POST `/labels`, buys real postage.** Gated
  behind `--live-approved` + a required (no-default) `PREPSHIP_API_BASE_URL`.
- `reconcile-shipstation-awaiting.ts` — can **cancel orders** with
  `--apply --resolve-deleted`. Dry-run by default; refuses to write without
  `--order-numbers`/`--store-ids` scope.

These touch money, customer notifications, and shipped/cancelled data. Treat
every run as a production change.
