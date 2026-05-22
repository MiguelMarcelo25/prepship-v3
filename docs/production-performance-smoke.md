# Production Performance Smoke

PS-011 adds a repeatable, credential-free smoke benchmark for PrepShip page-load readiness. It is designed to prove that the app shell and core protected routes respond safely without exposing secrets, customer data, labels, rates, addresses, or client data.

## Command

Package script:

```powershell
npm run perf:smoke
```

## Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `PERF_BASE_URL` | `http://127.0.0.1:4173` | Base URL to smoke check. |
| `PERF_TIMEOUT_MS` | `10000` | Per-route timeout. |
| `PERF_WARN_MS` | `2500` | Route duration threshold that turns a pass into a warning. |
| `PERF_OUTPUT_JSON` | `reports/perf-smoke-current.json` | JSON artifact path. Use `0` or `false` to disable file output. |
| `PERF_DRY_RUN` | unset | Set to `1` to list routes without network requests. |
| `PERF_ALLOW_FAILURES` | unset | Set to `1` to produce a report without exiting non-zero on route failures. |

## Local Usage

Build and start the local preview server:

```powershell
npm run build:web
npm run preview:web -- --host 127.0.0.1 --port 4173
```

In another terminal:

```powershell
node scripts/perf-smoke.mjs
```

Dry-run mode does not require a server:

```powershell
node scripts/perf-smoke.mjs --dry-run
```

JSON-only output:

```powershell
node scripts/perf-smoke.mjs --json
```

## Staging / Production-Safe Usage

Run only against approved staging or production URLs:

```powershell
$env:PERF_BASE_URL = "https://prepshipv4.vercel.app"
node scripts/perf-smoke.mjs
```

This script intentionally does not send cookies, bearer tokens, Supabase sessions, API keys, or production credentials. Protected pages may return an app shell, login redirect, `401`, or `403`; those are treated as safe auth-gated results. HTTP `5xx`, network errors, and timeouts are failures.

Do not paste full raw HTML, cookies, auth headers, tokens, customer names, addresses, order payloads, labels, or carrier credentials into Discord, GitHub, logs, docs, or PR notes.

## Routes Covered

The smoke benchmark checks:

- `/` root/login app shell
- `/orders/awaiting_shipment`
- `/orders/shipped`
- `/inventory/stock-levels`
- `/dashboard`
- `/settings`
- `/billing`
- `/manifest`

## Thresholds

Initial local/staging thresholds:

- No `5xx` responses.
- No network errors.
- No route timeout over `PERF_TIMEOUT_MS`.
- Route duration above `PERF_WARN_MS` is a warning, not an automatic failure.
- Auth-gated `401` or `403` is acceptable for protected pages because the script is credential-free.
- JSON artifact must contain only route IDs, URLs, HTTP status, timing, response byte count, safe response headers, and short body samples.

Suggested signoff interpretation:

- `fail=0`: acceptable smoke baseline.
- `slow>0`: investigate if repeated across runs or if the route is user-critical.
- `auth-gated>0`: acceptable on production without credentials.
- Any `5xx`: block production signoff until root cause is known.

## Artifacts

Default artifact:

```text
reports/perf-smoke-current.json
```

Attach this artifact to production-readiness evidence only after checking that it contains no secrets or customer/client data.

For production evidence, include:

- command used
- target hostname only, not tokens or cookies
- route summary
- pass/warn/fail counts
- slowest route timing
- artifact path or sanitized artifact

## Deferred Checks

This smoke command is intentionally lightweight. It does not replace:

- authenticated browser smoke tests
- Lighthouse/WebPageTest measurements
- Render/API log review
- Supabase health checks
- real user monitoring
- production worker/sync freshness checks

Those checks require DJ approval, credentials, or production operator access.
