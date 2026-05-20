# PrepShip Raw Error Response Audit

## Executive Summary

This audit tracks PrepShip routes and compatibility handlers that can still expose raw database, provider, or internal error messages to the browser. The global Hono API error handler now returns generic production-safe `500` responses, and credential-account handlers have safer generic errors, but several legacy Vercel/serverless handlers and shipment/label-adjacent routes still need a careful patch pass.

This is a planning and guard deliverable first. It does not change shipped/cancelled order logic, shipment mutation paths, or label side effects.

## Critical Blockers

| Blocker | Risk | Required Outcome | Verification |
|---|---|---|---|
| Legacy Vercel handlers return `err.message` in `500` responses | SQL/provider/schema details can leak to authenticated browsers | Public `500` body uses generic text, full detail logs server-side | Forced-failure tests per handler |
| Label/shipment handlers expose provider messages | Carrier/provider internals can leak during label/rate workflows | User-safe public messages plus support diagnostics | Label/rate failure fixtures |
| Marketplace/order repair handlers expose raw errors | Admin repair endpoints can leak DB internals | Admin-safe generic errors and detailed server logs | Admin forced-failure smoke |

## High-Risk Issues

| Area | Current Risk | Example Files | Required Patch |
|---|---|---|---|
| Direct carrier labels/rates | Carrier/provider messages can be returned as `500` body | `api/carriers/labels.ts`, `api/carriers/rates.ts`, `api/carriers/verify.ts` | Redact public `500` responses; keep provider diagnostic fields only where expected and non-secret |
| Marketplace integrations | Walmart/eBay handlers can return raw upstream/DB errors | `api/carriers/walmart/orders.ts`, `api/carriers/ebay/orders.ts`, `api/carriers/walmart/fees.ts`, `api/cron/sync-walmart-fees.ts` | Use shared safe error response helper |
| Admin repair/migration utilities | Admin-only endpoints can expose SQL details | `api/migrate-from.ts`, `api/admin/fix-marketplace-timestamps.ts` | Return generic admin-safe failure while logging detail |
| Label/shipment routes | Status/side-effect messages may include raw details | `src/routes/labels.ts`, label compatibility handlers | Review separately because they touch locked shipment surfaces |

## Medium-Risk Issues

| Area | Concern | Recommended Patch |
|---|---|---|
| Service warnings | Logs can include raw provider messages | Add log redaction policy before central shipping |
| Expected validation failures | Some `400` responses need specific messages | Preserve validation detail, redact only internal/upstream/DB detail |
| Carrier diagnostics | Operators still need reasons rates fail | Keep sanitized diagnostics like `account unavailable`, `invalid package`, `timeout` |

## Recommended Patches

- [x] Keep global Hono `app.onError` production-safe for generic `500` responses.
- [x] Keep credential-account handlers returning generic `500` public bodies.
- [x] Add `RAW_ERROR_RESPONSE_AUDIT.md`.
- [x] Add `npm run test:raw-error-response-audit`.
- [ ] Create a shared `safePublicError()` / `sendSafeError()` helper for Vercel compatibility handlers.
- [ ] Patch non-shipment Vercel handlers first: marketplace fees/orders, migrate/admin utilities, carrier probe/validate endpoints.
- [ ] Patch direct carrier rate/verify handlers while preserving sanitized operator diagnostics.
- [ ] Review label/shipment-sensitive handlers in a separate shipped-data-safe batch.
- [ ] Add forced-failure tests that confirm public `500` bodies do not include raw SQL/provider text.

## Test Plan

- `npm run test:raw-error-response-audit`
- Future implementation tests:
  - forced DB error returns `{ error: "Internal server error" }`
  - forced provider `500` logs detail server-side but does not expose secrets
  - validation `400` still returns actionable user-safe messages
  - carrier diagnostics remain sanitized and useful

## Deployment / Rollback Notes

- Patch public error bodies in small route groups.
- Keep detailed logs server-side only.
- Do not redact normal user validation messages needed for fixes.
- Label and shipment handlers need separate review because they are operationally sensitive.
- Rollback should restore previous route behavior only if diagnostics become unusable; never reintroduce secret or SQL leakage.
