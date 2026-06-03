# `/api/carriers/rates` — FUNCTION_INVOCATION_FAILED hardening

**Symptom:** the Awaiting Shipment rate cells showed errors; the Network panel
showed `/api/carriers/rates` returning **HTTP 500 `FUNCTION_INVOCATION_FAILED`**
(`A server error has occurred … sin1::459zs-…`). PS-071 surfaced this cleanly as
"Rate unavailable · Retry" — this packet fixes the underlying serverless crash.

---

## What was happening

`vercel.json` routes most `/api/*` to the Render backend but keeps `carriers/*`
as Vercel serverless functions, so the frontend's `fetchRates` →
`callVercelFunction('/carriers/rates', …)` hits the standalone function
`api/carriers/rates.ts` (direct-carrier rate quoting: UPS-direct, Walmart
Shipping, eBay/Amazon shipping). ShipStation rates use a different path
(Render `/rates/multi`), which is why only some rate cells failed.

`FUNCTION_INVOCATION_FAILED` = the function crashed/timed out **before** sending
a response, so Vercel returned its platform error instead of the app's JSON.

### Root-cause surfaces (all now closed)

1. **Auth verification ran outside the try/catch.** `verifySupabaseJwt` does a
   remote **JWKS fetch** (`createRemoteJWKSet`) and can *throw* on a network
   blip; it executed before the function's main `try`, so a transient
   verification failure crashed the whole function (matching the intermittent
   pattern — some requests 500, some OK).
2. **Body parsing ran outside the try/catch.** `readBody(req)` can reject on a
   malformed/aborted stream — also a pre-try uncaught throw.
3. **No timeout on the upstream carrier call.** `connector.getRates(...)` (real
   UPS/Walmart/ShipStation APIs) had no timeout; a hung provider ran the
   function to the platform limit → also surfaced as `FUNCTION_INVOCATION_FAILED`
   (the `(pending)` rate request in the report is consistent with this).
4. **Region.** The failing invocation ran in **`sin1` (Singapore)** while the
   database is in the US — every sequential SQL query + the carrier call paid
   cross-Pacific latency, pushing borderline requests over the limit.

---

## Fix

`api/carriers/rates.ts`
- **Guard `verifySupabaseJwt`** in try/catch → a JWKS/network throw returns a
  clean `503 Auth verification temporarily unavailable` (logged, redacted),
  never a function crash. Normal bad tokens still return `401`.
- **Guard `readBody`** in try/catch → a malformed body returns `400 Invalid JSON
  body`.
- **`withRateTimeout(connector.getRates(...), provider, 20s)`** bounds every
  upstream quote. A hung carrier becomes a caught `"Rate request to <provider>
  timed out"` error (→ `ok:false`), so the function always responds well before
  any platform limit. The losing race branch attaches a no-op `.catch` so a late
  rejection can't surface as an unhandled rejection (which would itself crash
  the function).

`vercel.json`
- **`"regions": ["iad1"]`** pins serverless functions to US-East (near the DB).
  Best-guess for a Supabase `us-east-1` database; trivially changeable to
  `sfo1`/`pdx1` if the DB is US-West. Either is vastly better than `sin1`.

Net effect: `/api/carriers/rates` can no longer emit
`FUNCTION_INVOCATION_FAILED`. Any real failure returns a clean JSON status that
PS-071 renders as "Rate unavailable · Retry"; transient carrier/region/JWKS
slowness is bounded.

---

## Files changed
- `api/carriers/rates.ts` — auth/body guards + `withRateTimeout`.
- `vercel.json` — `regions: ["iad1"]`.
- `scripts/carriers-rates-function-hardening-guard.mjs` (new) + `package.json`
  script `test:carriers-rates-hardening`.

## Commands run — pass/fail
| Command | Result |
|---|---|
| `npm run typecheck` (backend + web) | ✅ PASS |
| `node scripts/carriers-rates-function-hardening-guard.mjs` | ✅ PASS |
| `node scripts/vercel-function-imports-guard.mjs` | ✅ PASS (lazy connector loading intact) |
| `node scripts/raw-error-response-audit-guard.mjs` | ✅ PASS (35 checks — error redaction intact) |

## Confirm the original cause (operator)
Vercel dashboard → project → **Logs**, search invocation
`459zs-1780446466406-3c88ced7e32f` (or filter `/api/carriers/rates` + 500). An
uncaught-exception line confirms #1/#2; a duration ≈ the limit confirms #3.

## Safety
- No labels/postage purchased, no marketplace notifications, no shipped/cancelled
  or DB mutations — this only changes error handling, a request timeout, and a
  deploy region.
- Auth is **not** weakened: a verified-bad token still returns 401; a
  verification *outage* now fails closed with 503 instead of crashing.
- No secrets/PII/tokens/payloads/label URLs added to logs or responses (errors
  go through the existing redacted `sendInternalServerError` / `logServerError`).
